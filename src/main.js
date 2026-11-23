import { InstanceBase, InstanceStatus, Regex, TCPHelper } from '@companion-module/base'
import {
	COMMANDS,
	INQUIRIES,
	TERMINATOR,
	encodeNibbles,
	decodeReply,
	buildFrame,
	continuousParams,
	effectiveMax,
} from './commands.js'
import { MODEL_GATED_IDS } from './constants.js'
import updateActions from './actions.js'
import updatePresets from './presets.js'
import updateVariables from './variables.js'
import updateFeedbacks from './feedbacks.js'

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()

// Older camera firmware used to force AE/AWB into Manual as a side effect
// of setting these varIds -- current firmware no longer does. The immediate
// re-confirm is kept anyway: it's a single cheap inquiry and (with polling
// off) the only way the AE/WB toggle buttons notice a mode that changed
// behind our back after one of these values was written. Re-confirm the
// affected mode right after any of these varIds
// is deliberately written (see setKnobValue() and applyInquiryReply()'s
// resyncKnob branch below).
const MODE_SIDE_EFFECT_INQUIRY = {
	gain: 'ae_mode',
	shutter: 'ae_mode',
	rgain: 'wb_mode',
	bgain: 'wb_mode',
	dct_ggain: 'wb_mode',
	dct_wb_temp: 'wb_mode',
}

// The version inquiry's model-id field (commands.js's 'version'
// decode formats it as "...model=0x0000..."/"...model=0x0001..."). Camera
// firmware distinguishes Atom Two vs Atom Two HDR this way.
const CAMERA_MODEL_BY_ID = { '0000': 'atom-two', '0001': 'atom-two-hdr' }
function parseCameraModel(versionText) {
	const m = /model=0x([0-9a-f]+)/i.exec(versionText ?? '')
	return m ? CAMERA_MODEL_BY_ID[m[1].padStart(4, '0').toLowerCase()] : undefined
}

// The color-temp-preset inquiry side (INQUIRIES.color_temp) has no
// inquiry that can answer it -- the camera has no command that reports
// which preset index is currently active, only ones that set it -- so
// it always errors. Left in INQUIRIES so the variable/Companion definition still
// exists (variables.js derives its list from INQUIRIES), but excluded
// from actual polling: sending it every cycle would be a wasted round trip
// AND would keep stomping the optimistic value set below back to 'n/a'.
//
// dct_wb_temp_measure is excluded for a different reason -- it works fine
// (the camera runs a real, fresh capture every request), it's
// just meant to be on-demand only, via the dedicated "WB Kelvin Measure"
// button/action (dct_wb_temp_measure_now), not refreshed automatically on
// every poll tick.
const NO_POLL_INQUIRY_IDS = new Set(['color_temp', 'dct_wb_temp_measure'])
// color_temp_direct (COMMANDS id) is the SET-only counterpart to color_temp --
// since it can never be confirmed via inquiry, it especially depends on the
// 'direct' action's now-unconditional optimistic write (below) to ever show
// anything but 'n/a'.

// How long a param's this.knob target is protected from background-poll
// resync after we last wrote it ourselves (setKnobValue()). Long enough to
// safely cover one full poll cycle's worth of stale-request risk (a poll's
// inquiry enqueued before a burst of rapid actions, replying after several
// more already landed -- see the Color Temp knob bug); short enough that a
// genuinely external change (e.g. AWB actively re-adjusting R/G/B gain,
// another controller) gets picked back up again soon after we stop touching
// that specific param, instead of being ignored forever (see the R/G/B gain
// bug this constant fixes).
const KNOB_LOCK_MS = 2500

// Longest unterminated receive run kept before it is thrown away (see onData()).
const MAX_RX_BYTES = 64

export class DctViscaInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = {} // decoded inquiry values by varId (for feedbacks)
		this.queue = [] // { frame, onReply, timer }
		this.inflight = null
		this.rxbuf = Buffer.alloc(0)
		this.knob = {} // per-varId knob target (relative-adjust state)
		this.knobLockUntil = {} // per-varId: Date.now() ms until which background polling won't resync this.knob (see setKnobValue())
		this.consecutiveTimeouts = 0 // see markNoReply()/markReplyReceived()
		this.linkWarning = false // true once we've downgraded Ok -> UnknownWarning for no replies
		this.confirmedReply = false // first VISCA reply of the current (re)connection seen yet -- gates Ok (see markReplyReceived())
		this.serialReconnectTimer = undefined // see scheduleSerialReconnect()
		this.cameraModel = undefined // 'atom-two'|'atom-two-hdr'|undefined (unknown -> unrestricted), see MODEL_GATED_IDS
		this.tally = { red: false, green: false } // optimistic local state, see TALLY_CYCLE_STATES/dct_tally_cycle (no VISCA inquiry exists to read this back)
		this.params = continuousParams()
		this.paramById = Object.fromEntries(this.params.map((p) => [p.id, p]))
		this.availableSerialPorts = [] // cached SerialPort.list() entries ({path, vendorId, manufacturer}), for the config editor's Serial port dropdown
		this.serialCameras = {} // path -> {camera, at} from probeSerialPorts(), annotates the dropdown
		this.probingPorts = false // re-entrancy guard for probeSerialPorts()
		this.serialProbeInterestUntil = 0 // probe only while the config editor was opened recently (see getConfigFields())
		this.destroyed = false // late async guards (serial probe)

		this.setupActions()
		this.setupFeedbacks()
		this.setupVariables()
		this.setupPresets()
		this.serialPortScanTimer = setInterval(() => void this.periodicSerialScan().catch(() => {}), 5000)
		// TCP users never need the port list; the editor triggers a scan when it opens.
		if (this.config?.conn === 'serial') await this.scanAndProbeSerialPorts()
		await this.initTransport()
		this.startPolling()
	}

	// SerialPort.list() enumerates connected devices on both Windows (COMn)
	// and Linux/macOS (/dev/tty*) via the native bindings -- used to populate
	// the config editor's Serial port dropdown with only ports that actually
	// exist, instead of a free-text field the user has to get exactly right.
	// getConfigFields() can't await this itself (Companion requires it to
	// return synchronously), so this caches the result on the instance and
	// re-scans periodically to catch devices plugged in after startup.
	async refreshSerialPorts() {
		try {
			const { SerialPort } = await import('serialport')
			const ports = await SerialPort.list()
			this.availableSerialPorts = ports
				.map((p) => ({ path: p.path, vendorId: p.vendorId, manufacturer: p.manufacturer }))
				.sort((a, b) => a.path.localeCompare(b.path))
		} catch (_) {
			// serialport not installed/available, or listing failed (e.g. permissions)
			// -- leave whatever list we already had rather than wiping it out.
		}
	}

	// USB-to-serial adapters (the actual thing a camera would be attached
	// through) get a vendorId/manufacturer from the OS; a platform's own
	// fixed ports (Linux /dev/ttyS0-31, Windows onboard COM1/2) report
	// neither and show up whether or not anything is wired to them at all.
	// This is the only cross-platform "is a real device attached" signal
	// SerialPort.list() offers without opening/probing every port.
	// Windows needs the stricter vendorId-only rule: its onboard ACPI/PnP
	// UARTs report SPDRP_MFG "Microsoft" (manufacturer-only, no VID_ in the
	// PnP instance id), which the loose unix test would wave through -- any
	// genuinely USB-attached port always has a vendorId on all three OSes
	// (serialport parses VID_xxxx / USB-ancestor properties for it).
	isSerialAdapterPort(p) {
		return process.platform === 'win32' ? !!p.vendorId : !!(p.vendorId || p.manufacturer)
	}

	// The 5 s timer's tick. Listing ports is not free (on Linux it runs a
	// full udev dump), so only keep the list fresh while the config editor was
	// opened recently -- the only time anyone looks at it.
	async periodicSerialScan() {
		if (Date.now() > this.serialProbeInterestUntil) return
		await this.scanAndProbeSerialPorts()
	}

	async scanAndProbeSerialPorts() {
		await this.refreshSerialPorts()
		await this.probeSerialPorts()
	}

	// A port showing up in SerialPort.list() says nothing about a camera being
	// behind it (bare USB-serial adapters appear whether or not anything is
	// wired), so while no live connection exists we probe candidates directly:
	// open at the configured baud, fire the version inquiry, and any complete
	// frame back within ~1s proves a VISCA device is listening. Results mark
	// the config dropdown with "(camera found)". Probing runs only while the
	// config editor has been opened recently (getConfigFields() is the closest
	// thing to a click event this SDK offers) -- we don't keep opening random
	// ports forever behind the user's back -- never in TCP mode, never on the
	// instance's own configured port (that would race the connect/reconnect
	// loop), and never while already connected.
	async probeSerialPorts() {
		if (this.config?.conn !== 'serial' || this.probingPorts || this.socket?.isConnected) return
		if (Date.now() > this.serialProbeInterestUntil) return
		this.probingPorts = true
		try {
			const filterAdapters = this.config.serialFilterAdapters !== false
			const candidates = (this.availableSerialPorts ?? [])
				.filter((p) => (!filterAdapters || this.isSerialAdapterPort(p)) && p.path !== this.config.serialPort)
				.slice(0, 8)
			const baudRate = Number(this.config.baud) || 115200
			const address = Number(this.config.address) || 1
			for (const p of candidates) {
				if (this.destroyed || this.socket?.isConnected) break // instance gone or user just went live -- stop poking around
				const camera = await this.probeSerialPort(p.path, baudRate, address)
				this.serialCameras[p.path] = { camera, at: Date.now() }
				if (camera) this.log('debug', `serial probe: camera found on ${p.path}`)
			}
		} finally {
			this.probingPorts = false
		}
	}

	async probeSerialPort(path, baudRate, address) {
		let port
		try {
			const { SerialPort } = await import('serialport')
			port = new SerialPort({ path, baudRate, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false })
			port.on('error', () => {}) // swallow "can't open"-style events; open() cb + timeout cover the outcome
			await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())))
			const frame = buildFrame(address, INQUIRIES.version.payload)
			return await new Promise((resolve) => {
				let buf = Buffer.alloc(0)
				const done = (found) => {
					clearTimeout(timer)
					port.off('data', onData)
					resolve(found)
				}
				const onData = (chunk) => {
					buf = Buffer.concat([buf, chunk])
					if (buf.includes(TERMINATOR)) done(true)
				}
				const timer = setTimeout(() => done(false), 1000)
				port.on('data', onData)
				port.write(Buffer.from(frame), (err) => {
					if (err) done(false)
				})
			})
		} catch (_) {
			// can't open (busy/in use by another app) or no reply -- either way,
			// no camera marker; the two are indistinguishable and both unhelpful
			return false
		} finally {
			if (port?.isOpen) port.close(() => {})
		}
	}

	// --- transport ---------------------------------------------------------
	async initTransport() {
		// A pending serial retry belongs to the old transport; never let it outlive a rebuild.
		if (this.serialReconnectTimer) {
			clearTimeout(this.serialReconnectTimer)
			this.serialReconnectTimer = undefined
		}
		this.clearQueue()
		this.rxbuf = Buffer.alloc(0)
		this.rxOverflowLogged = false
		this.consecutiveTimeouts = 0
		this.linkWarning = false
		this.confirmedReply = false // a fresh transport must earn Ok again on the first real reply
		if (this.config?.conn === 'serial') {
			await this.initSerial()
		} else {
			this.initTCP()
		}
	}

	// A terminal reply (Completion 0x50 or Error 0x60 -- see handleFrame())
	// proves something is actually answering on the wire. This is the ONLY
	// thing that earns Ok: a bare TCP/serial link coming up proves nothing
	// about the camera (initTCP()/initSerial() hold at Connecting until this
	// fires; the serial link can even "open" with no adapter wired at all).
	// Also promotes back to Ok after markNoReply() downgraded to Warning.
	markReplyReceived() {
		this.consecutiveTimeouts = 0
		if (this.linkWarning || !this.confirmedReply) {
			this.linkWarning = false
			this.confirmedReply = true
			if (this.socket?.isConnected) this.updateStatus(InstanceStatus.Ok)
		}
	}

	// pump()'s per-command timeout fires when nothing came back at all. A
	// serial port can "open" successfully with no adapter/camera on the
	// other end at all -- a bare UART has no way to detect a peer -- and a
	// TCP connect is no guarantee either if something else is listening on
	// that port. Only downgrades while the transport itself still thinks
	// it's connected, so a real disconnect's own (more specific) status
	// always wins over this.
	markNoReply() {
		if (!this.socket?.isConnected) return
		this.consecutiveTimeouts++
		if (this.consecutiveTimeouts >= 2 && !this.linkWarning) {
			this.linkWarning = true
			this.updateStatus(InstanceStatus.UnknownWarning, 'No response from camera')
		}
	}

	async initSerial() {
		if (this.serialReconnectTimer) {
			clearTimeout(this.serialReconnectTimer)
			this.serialReconnectTimer = undefined
		}
		if (this.socket) {
			// Intentional teardown -- destroy() sets the adapter's closing flag,
			// so its 'close' handler knows this is not a link drop and stays out
			// of the status/reconnect path (which used to flash Disconnected and
			// race the new port opening).
			this.socket.destroy()
			this.socket = undefined
		}
		const path = this.config?.serialPort
		const baudRate = Number(this.config?.baud) || 115200
		if (!path) {
			this.updateStatus(InstanceStatus.BadConfig, 'No serial port')
			return
		}
		// Loaded lazily so a missing/broken native binding never breaks TCP users.
		let SerialPort
		try {
			;({ SerialPort } = await import('serialport'))
		} catch (err) {
			this.updateStatus(InstanceStatus.ConnectionFailure, 'serialport not available')
			this.log('error', `serialport import failed: ${err.message}`)
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		const port = new SerialPort({ path, baudRate, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false })
		// Adapt the SerialPort to the small interface pump()/pollOnce()/feedbacks use.
		const adapter = {
			isConnected: false,
			closing: false, // true once we tear it down on purpose -- see the 'close' handler
			send: (buf) => {
				try {
					port.write(Buffer.from(buf))
				} catch (err) {
					this.log('error', `serial write: ${err.message}`)
				}
			},
			destroy: () => {
				adapter.closing = true
				try {
					if (port.isOpen) port.close(() => {})
				} catch (_) {
					// ignore
				}
			},
		}
		this.socket = adapter
		port.on('open', () => {
			// Half-duplex RS-485 adapters need DTR+RTS asserted or TX never reaches the camera.
			try {
				port.set({ dtr: true, rts: true }, () => {})
			} catch (_) {
				// ignore
			}
			adapter.isConnected = true
			// A serial port "open" proves nothing about the camera -- a bare UART
			// has no peer detection at all -- so hold Connecting until the first
			// real reply (markReplyReceived()); only a known-good session that
			// merely re-opened (this confirmedReply) goes straight back to Ok.
			if (this.confirmedReply) this.updateStatus(InstanceStatus.Ok)
			this.checkFeedbacks('connected')
			this.pump()
			this.pollConnectOnce()
		})
		port.on('data', (chunk) => this.onData(chunk))
		port.on('close', () => {
			if (adapter.closing) return // our own teardown, not a link drop
			adapter.isConnected = false
			this.clearQueue()
			this.confirmedReply = false // a re-opened port must earn Ok again
			this.updateStatus(InstanceStatus.Disconnected)
			this.checkFeedbacks('connected')
			this.scheduleSerialReconnect()
		})
		port.on('error', (err) => {
			this.log('error', `serial error: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
		port.open((err) => {
			if (err) {
				this.log('error', `serial open: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
				// e.g. USB adapter unplugged -- retry on its own instead of
				// sitting dead until a config change or instance toggle.
				this.scheduleSerialReconnect()
			}
		})
	}

	// The serial counterpart of TCPHelper's built-in reconnect_interval: a
	// dropped or unopenable port retries every 2s (Connecting -> open attempt),
	// matching the TCP flow the guidelines describe (error -> retry -> Ok).
	scheduleSerialReconnect() {
		if (this.serialReconnectTimer || !this.config) return
		this.serialReconnectTimer = setTimeout(() => {
			this.serialReconnectTimer = undefined
			if (this.destroyed || this.config?.conn !== 'serial') return
			this.updateStatus(InstanceStatus.Connecting)
			this.initSerial()
		}, 2000)
	}

	initTCP() {
		if (this.socket) {
			this.socket.destroy()
			this.socket = undefined
		}
		const host = this.config?.host
		const port = this.config?.port || 4000
		if (!host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No target host')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		this.socket = new TCPHelper(host, port)
		this.socket.on('status_change', (s, m) => {
			// TCPHelper reports Ok the moment the TCP socket connects, but an
			// open port proves nothing about the camera (something else may be
			// listening, or it may never answer VISCA) -- hold Connecting until
			// the first real reply (markReplyReceived()) earns Ok.
			if (s === InstanceStatus.Ok && !this.confirmedReply) {
				this.updateStatus(InstanceStatus.Connecting)
			} else {
				// Any link loss un-confirms the session, so the next connect's
				// TCPHelper Ok is suppressed until the camera replies again.
				if (s !== InstanceStatus.Ok && s !== InstanceStatus.UnknownWarning) {
					this.confirmedReply = false
					this.clearQueue()
				}
				this.updateStatus(s, m)
			}
			this.checkFeedbacks('connected')
		})
		this.socket.on('error', (err) => {
			this.log('error', `TCP error: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
		this.socket.on('connect', () => {
			this.pump()
			this.pollConnectOnce()
		})
		this.socket.on('data', (chunk) => this.onData(chunk))
	}

	onData(chunk) {
		this.rxbuf = Buffer.concat([this.rxbuf, chunk])
		let idx
		while ((idx = this.rxbuf.indexOf(TERMINATOR)) >= 0) {
			const frame = this.rxbuf.subarray(0, idx + 1)
			this.rxbuf = this.rxbuf.subarray(idx + 1)
			this.handleFrame(frame)
		}
		// A VISCA reply is at most 16 bytes. A longer run with no terminator is
		// not VISCA (wrong host/port, noise): drop it instead of buffering forever.
		if (this.rxbuf.length > MAX_RX_BYTES) {
			if (!this.rxOverflowLogged) {
				this.rxOverflowLogged = true
				this.log(
					'warn',
					`Discarding ${this.rxbuf.length}+ received bytes without a VISCA terminator -- is this a camera?`,
				)
			}
			this.rxbuf = Buffer.alloc(0)
		}
	}

	handleFrame(frame) {
		this.log('debug', `RX ${hex(frame)}`)
		if (frame.length < 2) return
		const kind = frame[1] & 0xf0
		// ACK (0x40) is not terminal; Completion/inquiry-reply (0x50) and error (0x60) are.
		if (kind === 0x50 || kind === 0x60) {
			this.markReplyReceived()
			const entry = this.inflight
			this.inflight = null
			if (entry?.timer) clearTimeout(entry.timer)
			if (entry?.onReply) entry.onReply(frame, kind)
			this.pump()
		}
	}

	// Commands are only ever sent live: with no link they are dropped, never
	// parked. A parked "Gain up" or "Load Settings" would otherwise fire on its
	// own whenever the camera (or a different one after a Target IP change)
	// finally answers.
	enqueue(frame, onReply) {
		if (!this.socket?.isConnected) {
			this.log('debug', `dropped (not connected) ${hex(frame)}`)
			return
		}
		this.queue.push({ frame, onReply })
		this.pump()
	}

	// Forget everything still waiting for the wire: the link dropped or is
	// being rebuilt, and a reply can no longer arrive for any of it.
	clearQueue() {
		this.queue = []
		if (this.inflight?.timer) clearTimeout(this.inflight.timer)
		this.inflight = null
		this.pollFinish?.() // the poll batch it belonged to can never complete
	}

	pump() {
		if (this.inflight || this.queue.length === 0) return
		if (!this.socket?.isConnected) return
		const entry = this.queue.shift()
		this.inflight = entry
		this.socket.send(entry.frame)
		this.log('debug', `TX ${hex(entry.frame)}`)
		// free the queue if the camera never sends a terminal reply
		entry.timer = setTimeout(() => {
			if (this.inflight === entry) {
				this.inflight = null
				this.markNoReply()
				this.pump()
			}
		}, 1500)
	}

	send(payload) {
		this.enqueue(buildFrame(this.config?.address || 1, payload))
	}

	// Decode a single inquiry's reply and push it into state/variable/knob/
	// feedbacks -- shared by pollOnce()'s batch loop and any one-off inquiry
	// (e.g. a RUD action confirming its new value, or a manual "measure now").
	// opts.resyncKnob additionally updates this.knob[q.varId] -- ONLY safe to
	// set for a single, deliberate, user-triggered confirmation (a RUD
	// action's own confirm-read, a knob-press reset), never for a background
	// poll batch: a poll reply landing mid-turn (its request could easily
	// have been queued before a burst of rapid knob turns) would otherwise
	// silently reset the knob's running target backward to an
	// already-superseded value, and continued turning from the wrong base
	// could blow straight through to min/max (see the Color Temp knob bug).
	applyInquiryReply(q, reply, kind, opts = {}) {
		const value = kind === 0x50 ? decodeReply(q.decode, reply.subarray(2, reply.length - 1)) : 'n/a'
		this.state[q.varId] = value
		this.setVariableValues({ [q.varId]: value })
		if (q.decode.type === 'value') {
			const n = parseInt(value, 10)
			// resyncKnob (a single, deliberate, user-triggered confirmation --
			// RUD's own confirm-read, a knob-press reset) always wins, since it
			// IS the authoritative source for the write that started any lock.
			// A background poll reply only gets to resync this.knob if nothing
			// more recent (this exact param's own lock) is still protecting it.
			const locked = (this.knobLockUntil[q.varId] ?? 0) > Date.now()
			if (Number.isFinite(n) && (opts.resyncKnob || !locked)) this.knob[q.varId] = n
		}
		// Same AE/WB mode re-confirm as setKnobValue() -- this
		// covers the RUD/enum confirm-read path (Gain/Shutter/Red/Blue/Green
		// Gain Reset/Up/Down), which never calls setKnobValue() itself.
		// resyncKnob-gated for the same reason as the knob resync above: only
		// a deliberate confirm-read, never a routine background poll of
		// gain/shutter/rgain/bgain/dct_ggain themselves.
		if (opts.resyncKnob && MODE_SIDE_EFFECT_INQUIRY[q.varId])
			this.confirmIfNotPolling(MODE_SIDE_EFFECT_INQUIRY[q.varId])
		if (q.varId === 'ae_mode') this.checkFeedbacks('ae_mode_is', 'cam_ae_display')
		if (q.varId === 'wb_mode') this.checkFeedbacks('wb_mode_is', 'cam_wb_display')
		if (q.varId === 'dct_audio_enable') this.checkFeedbacks('dct_audio_enable_is', 'dct_audio_enable_display')
		if (q.varId === 'dct_sdi_range') this.checkFeedbacks('dct_sdi_range_is', 'dct_sdi_range_display')
		if (q.varId === 'dct_timecode_hold') this.checkFeedbacks('dct_timecode_hold_display')
		if (q.varId === 'version') {
			const model = parseCameraModel(value)
			if (model && model !== this.cameraModel) {
				this.cameraModel = model
				this.setupActions()
				this.setupPresets()
			}
		}
		this.checkFeedbacks('knob_value')
		this.checkFeedbacks('wb_measure_display')
	}

	// Fire a single named inquiry (INQUIRIES key) on demand.
	inquireOnce(qId, opts) {
		const q = INQUIRIES[qId]
		if (!q) return
		this.enqueue(buildFrame(this.config?.address || 1, q.payload), (reply, kind) =>
			this.applyInquiryReply(q, reply, kind, opts),
		)
	}

	// An optimistic local write (e.g. a toggle action) assumes the SET
	// succeeded -- if it actually errored, nothing corrects that unless
	// something re-reads the real value. Background polling already does
	// that on its next cycle if it's running; if it's off, fire a single
	// confirming inquiry instead so the display doesn't silently drift wrong.
	confirmIfNotPolling(qId) {
		if (!(Number(this.config?.pollInterval) > 0)) this.inquireOnce(qId)
	}

	// --- knobs (relative adjust of continuous params) ----------------------
	knobStep() {
		const n = Number(this.config?.knobStep)
		return Number.isFinite(n) && n > 0 ? n : 4
	}

	// Click size of a knob: the parameter's own step, else 1 for the 0-15
	// parameters, else the connection's Knob step.
	knobStepFor(paramId) {
		const p = this.paramById?.[paramId]
		if (!p) return this.knobStep()
		return p.step ?? (effectiveMax(p, this.cameraModel) <= 15 ? 1 : this.knobStep())
	}

	hasValue(varId) {
		return this.knob[varId] !== undefined || Number.isFinite(parseInt(this.state[varId], 10))
	}

	// Whether the camera can report this value at all (the color-temp preset
	// index has no inquiry, so it can only ever be known from our own SETs).
	canRead(varId) {
		return Object.entries(INQUIRIES).some(([id, q]) => q.varId === varId && !NO_POLL_INQUIRY_IDS.has(id))
	}

	readValue(varId) {
		if (this.knob[varId] !== undefined) return this.knob[varId]
		const n = parseInt(this.state[varId], 10)
		return Number.isFinite(n) ? n : 0
	}

	// Optimistically write a value we know exactly (a plain SET or a knob
	// turn, as opposed to a RUD reset whose real landing value has to be
	// confirmed via inquiry) into knob/state/variable, and (re)start this
	// varId's KNOB_LOCK_MS window so a stale background-poll reply already
	// in flight can't immediately stomp it back (see applyInquiryReply()).
	setKnobValue(varId, value) {
		this.knob[varId] = value
		this.state[varId] = String(value)
		this.setVariableValues({ [varId]: String(value) })
		this.knobLockUntil[varId] = Date.now() + KNOB_LOCK_MS
		this.checkFeedbacks('knob_value')
		const modeId = MODE_SIDE_EFFECT_INQUIRY[varId]
		if (modeId) this.confirmIfNotPolling(modeId)
	}

	// Rotary-knob adjust: clamp, send an absolute `direct` set for the param, and
	// optimistically update its value variable so the encoder LCD tracks live.
	adjustParam(paramId, delta) {
		const p = this.paramById?.[paramId]
		if (!p || !Number.isFinite(delta)) return
		// Never count from a guess: with an unknown start (reads still in
		// flight after connect, or a failed read) the turn would send 0 + step
		// and slam the camera to its minimum. Read the real value instead; the
		// next turn then has a base.
		// A value the camera can't report (set-only) starts from the minimum.
		const settable = !this.canRead(p.varId)
		if (!this.hasValue(p.varId) && !settable) {
			const qId = Object.keys(INQUIRIES).find((id) => INQUIRIES[id].varId === p.varId)
			if (qId) this.inquireOnce(qId, { resyncKnob: true })
			return
		}
		const cur = this.hasValue(p.varId) ? this.readValue(p.varId) : p.min
		let raw
		if (p.logScale) {
			// Multiplicative step (delta's sign only -- its magnitude is the
			// linear "step" config, which doesn't apply here) so each turn is a
			// constant *percentage* change, matching how audio level/dB works,
			// instead of a constant raw amount that's huge at the low end of the
			// range and imperceptible at the high end. `minStep` floors how small
			// that percentage step is allowed to get at the low end of the range
			// (where e.g. 5% of a small value would otherwise round to ~1).
			const factor = 1 + (p.stepPercent ?? 5) / 100
			const minStep = p.minStep ?? 1
			if (delta >= 0) {
				raw = Math.round(Math.max(cur, 1) * factor)
				if (raw < cur + minStep) raw = cur + minStep
			} else {
				raw = Math.round(cur / factor)
				if (raw > cur - minStep) raw = Math.max(0, cur - minStep)
			}
		} else {
			raw = cur + delta
		}
		const next = Math.max(p.min, Math.min(effectiveMax(p, this.cameraModel), raw))
		const c = COMMANDS[p.cmd]
		this.send([...c.prefix, ...encodeNibbles(next, c.nibbles)])
		this.setKnobValue(p.varId, next)
	}

	// --- actions -----------------------------------------------------------
	setupActions() {
		updateActions(this)
	}

	// --- presets -----------------------------------------------------------
	setupPresets() {
		updatePresets(this)
	}

	// --- variables + feedbacks --------------------------------------------
	setupVariables() {
		updateVariables(this)
	}

	setupFeedbacks() {
		updateFeedbacks(this)
	}

	// --- inquiry polling ---------------------------------------------------
	startPolling() {
		this.stopPolling()
		const ms = Number(this.config?.pollInterval)
		if (ms > 0) this.pollTimer = setInterval(() => this.pollLiveOnce(), ms)
	}
	stopPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
	}

	// Shared batch-poll engine: sends every inquiry in `entries` through the
	// queue and tracks completion via the one shared `pollBusy` gate --
	// pollOnce()/pollLiveOnce()/pollStartupOnce() all share the same serial
	// queue, so overlapping any combination of them would cause the same
	// backlog problem the gate was built for in the first place (see
	// pollLiveOnce()'s comment). All ~55 INQUIRIES share the one serial send
	// queue (enqueue()/pump()), which only ever has one command in flight --
	// so a full cycle can take far longer than a short poll interval.
	pollBatch(entries) {
		if (!this.socket?.isConnected) return
		if (this.pollBusy) return
		if (!entries.length) return
		this.pollBusy = true
		let remaining = entries.length
		let finished = false
		// Safety net: pump()'s own per-command timeout (main.js) silently frees
		// a stalled slot without ever calling onReply, so a single non-replying
		// inquiry would otherwise leave pollBusy stuck forever.
		const finish = () => {
			if (finished) return
			finished = true
			this.pollBusy = false
			if (this.pollFinish === finish) this.pollFinish = undefined
			clearTimeout(safety)
		}
		this.pollFinish = finish
		const safety = setTimeout(finish, entries.length * 1600)
		const addr = this.config?.address || 1
		for (const q of entries) {
			this.enqueue(buildFrame(addr, q.payload), (reply, kind) => {
				this.applyInquiryReply(q, reply, kind)
				if (--remaining <= 0) finish()
			})
		}
	}

	// "Poll inquiries now" action: an explicit "sync everything" request, so
	// it stays exhaustive -- every inquiry except the ones that can never
	// succeed at all (NO_POLL_INQUIRY_IDS), regardless of the `once` tier.
	pollOnce() {
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		this.pollBatch(
			Object.entries(INQUIRIES)
				.filter(([id]) => !NO_POLL_INQUIRY_IDS.has(id) && !gatedIds.includes(id))
				.map(([, q]) => q),
		)
	}

	// The recurring background cycle (startPolling()'s setInterval). Skips
	// both NO_POLL_INQUIRY_IDS and the `once`-tagged startup-only tier
	// (calibration/setup-style values that don't change on their own during
	// a live session) -- only the "live" tier needs repeated polling, which
	// keeps every cycle shorter than a full pollOnce() would be.
	pollLiveOnce() {
		this.pollBatch(this.liveEntries())
	}

	liveEntries() {
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		return Object.entries(INQUIRIES)
			.filter(([id, q]) => !NO_POLL_INQUIRY_IDS.has(id) && !q.once && !gatedIds.includes(id))
			.map(([, q]) => q)
	}

	// Fired once per successful (re)connection (see initSerial()/initTCP())
	// and by the "System: Poll startup values now" action -- refreshes just
	// the `once`-tagged tier pollLiveOnce() otherwise never touches, in case
	// it changed while disconnected (another controller, a reboot, etc.).
	// Note: on the very first connect, this.cameraModel is still unknown
	// (gatedIds is []), so this batch includes `version` itself (needed to
	// learn the model at all) plus every once-tagged id, gated or not -- a
	// harmless one-time query for whichever ids turn out to be gated. Later
	// calls (reconnect, or the manual "Poll startup values now" action) skip
	// them correctly once the model is known.
	pollStartupOnce() {
		this.pollBatch(this.startupEntries())
	}

	startupEntries() {
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		return Object.values(INQUIRIES).filter((q) => q.once && !gatedIds.includes(q.varId))
	}

	// What every (re)connection reads: the startup tier plus the live tier.
	// The live values (gain, shutter, R/B/G gain, colour temperature, ...)
	// are what knob turns count from, so they must be known even when Poll ms
	// is 0 and no background cycle would ever read them.
	pollConnectOnce() {
		this.pollBatch([...this.startupEntries(), ...this.liveEntries()])
	}

	// --- lifecycle ---------------------------------------------------------
	getConfigFields() {
		// Companion re-invokes getConfigFields() fresh each time the editor
		// opens -- the closest this SDK gets to a "popup was clicked" event.
		// Use it to keep the serial camera probe alive while the user is
		// actually looking at the port dropdown (and kick one immediately;
		// results show up in the dropdown on this or the next editor open).
		// Same fresh-each-open behavior is why toggling the checkbox below
		// takes effect the next time the editor is reopened, not live as it's
		// clicked (dropdown `choices` can't react to a sibling field's
		// in-progress edit, only `isVisibleExpression` gets the live values).
		if (this.config?.conn === 'serial') {
			this.serialProbeInterestUntil = Date.now() + 30000
			void this.scanAndProbeSerialPorts().catch(() => {})
		}
		const filterAdapters = this.config?.serialFilterAdapters !== false
		const filteredPorts = (this.availableSerialPorts ?? []).filter(
			(p) => !filterAdapters || this.isSerialAdapterPort(p),
		)
		// When the scan finds no ports at all, fall back to the last saved one
		// (only if it looks like a path on THIS platform -- otherwise a
		// connection created (or last saved) on Windows shows a stray "COM3"
		// as if it were a live port on a Linux box that's never had a COM3 in
		// its life, and vice versa), else a neutral type-manually placeholder:
		// modern Windows assigns COM numbers dynamically per device (anything
		// 1-255), so a "default port" hint like "COM3" would be a misleading
		// guess rather than a helpful one.
		const isPlausiblePortPath = (path) =>
			process.platform === 'win32' ? /^COM\d+$/i.test(path) : path.startsWith('/dev/')
		const savedPort = this.config?.serialPort
		const serialPortChoices = filteredPorts.length
			? filteredPorts.map((p) => p.path)
			: [savedPort && isPlausiblePortPath(savedPort) ? savedPort : '']
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'DCT VISCA',
				value:
					'Raw VISCA over TCP or serial (RS-485/RS-232). For serial, run Companion on the machine wired to the camera.',
			},
			{
				type: 'dropdown',
				id: 'conn',
				label: 'Connection',
				width: 4,
				default: 'tcp',
				choices: [
					{ id: 'tcp', label: 'TCP' },
					{ id: 'serial', label: 'Serial (COM)' },
				],
			},
			// No pre-filled host on a fresh instance (empty until the user picks
			// one -- initSerial/initTCP then report BadConfig until it's set);
			// whatever was entered on the first save is remembered in the config
			// itself, which the editor shows over this default on every reopen.
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 5,
				default: '',
				regex: Regex.IP,
				isVisibleExpression: "$(options:conn) != 'serial'",
			},
			{
				type: 'number',
				id: 'port',
				label: 'TCP port',
				width: 3,
				default: 4000,
				min: 1,
				max: 65535,
				isVisibleExpression: "$(options:conn) != 'serial'",
			},
			{
				type: 'dropdown',
				id: 'serialPort',
				label: 'Serial port',
				width: 5,
				// Same "blank first time, remembered afterwards" rule as host
				// above: nothing pre-selected on a fresh instance (the saved
				// value wins over this default once one exists), and a scan
				// that found no ports only offers the plausible-path hint.
				// Ports the probe saw answer a VISCA inquiry get a "(camera
				// found)" marker; the id stays the bare path.
				default: '',
				choices: serialPortChoices.map((p) => ({
					id: p,
					label: this.serialCameras?.[p]?.camera
						? `${p} (camera found)`
						: p || '(no adapters found -- enter port manually)',
				})),
				allowCustom: true,
				isVisibleExpression: "$(options:conn) == 'serial'",
			},
			{
				type: 'checkbox',
				id: 'serialFilterAdapters',
				label: 'Only show USB serial adapters',
				width: 3,
				default: true,
				isVisibleExpression: "$(options:conn) == 'serial'",
			},
			{
				type: 'dropdown',
				id: 'baud',
				label: 'Baudrate',
				width: 3,
				default: 115200,
				choices: [
					{ id: 115200, label: '115200' },
					{ id: 57600, label: '57600' },
				],
				isVisibleExpression: "$(options:conn) == 'serial'",
			},
			{ type: 'number', id: 'address', label: 'Camera address (1-7)', width: 2, default: 1, min: 1, max: 7 },
			{
				type: 'number',
				id: 'pollInterval',
				label: 'Poll ms (0=off, min 2000)',
				width: 2,
				default: 0,
				min: 0,
				max: 60000,
			},
			{ type: 'number', id: 'knobStep', label: 'Knob step (1-255 params)', width: 3, default: 4, min: 1, max: 128 },
		]
	}

	async configUpdated(config) {
		const prev = this.config
		// The Knob step field's min:1 is a Companion "visual hint only" (per the
		// SDK's own docs, true of every field's min/max/regex) -- Companion
		// never actually rejects an entered 0, it just persists it as typed.
		// knobStep() already falls back to 4 at every use site, so 0 can never
		// take effect, but correct the saved value too (saveConfig() is a
		// one-way push to the host, it doesn't re-trigger configUpdated) so the
		// editor shows 4 next time it's opened instead of silently diverging
		// from what's actually in use.
		if (!(Number.isFinite(Number(config.knobStep)) && Number(config.knobStep) > 0)) {
			this.log('warn', `Knob step must be greater than 0 -- resetting "${config.knobStep}" to 4`)
			config = { ...config, knobStep: 4 }
			this.saveConfig(config)
		}
		// Same "field min is a visual hint only" story as Knob step above: 0
		// (off) is still valid, but any nonzero interval faster than 2000ms
		// gets corrected up to the floor and pushed back so the editor doesn't
		// silently disagree with what's actually polling.
		const pollMs = Number(config.pollInterval)
		if (pollMs !== 0 && (!Number.isFinite(pollMs) || pollMs < 2000)) {
			this.log('warn', `Poll ms must be 0 (off) or at least 2000 -- resetting "${config.pollInterval}" to 2000`)
			config = { ...config, pollInterval: 2000 }
			this.saveConfig(config)
		}
		this.config = config
		// Only tear down/rebuild the actual connection if a connection-relevant
		// field changed. Reopening a serial port immediately after closing it
		// is racy (the OS may not have released the device yet), which used to
		// silently leave the module disconnected -- and therefore pollOnce()
		// permanently no-op'ing -- after changing something as unrelated as
		// Poll ms, until a full disable/enable gave it enough time to recover.
		const transportChanged =
			!prev ||
			prev.conn !== config.conn ||
			prev.host !== config.host ||
			prev.port !== config.port ||
			prev.serialPort !== config.serialPort ||
			prev.baud !== config.baud
		if (transportChanged) await this.initTransport()
		// The Adjust action's default Step is the Knob step.
		if (!prev || prev.knobStep !== config.knobStep) this.setupActions()
		this.startPolling()
	}

	async destroy() {
		this.destroyed = true
		this.stopPolling()
		if (this.serialPortScanTimer) clearInterval(this.serialPortScanTimer)
		if (this.serialReconnectTimer) clearTimeout(this.serialReconnectTimer)
		this.clearQueue() // also stops the in-flight and poll-batch safety timers
		if (this.socket) this.socket.destroy()
	}
}
