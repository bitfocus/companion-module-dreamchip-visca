import { InstanceBase, InstanceStatus, Regex, TCPHelper, combineRgb } from '@companion-module/base'
import {
	COMMANDS,
	INQUIRIES,
	ENUM,
	SYSTEM,
	SYSTEM_NAMES,
	GAIN_ISO,
	SHUTTER_SPEEDS,
	RUD,
	TERMINATOR,
	encodeNibbles,
	decodeReply,
	buildFrame,
	continuousParams,
	effectiveMax,
	progressBar,
} from './commands.js'
import { KNOB_RING_PNG } from './images.js'

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()
const GREEN = combineRgb(0, 102, 0)
const RED = combineRgb(204, 0, 0)
const BLUE = combineRgb(0, 51, 102)
const ORANGE = combineRgb(255, 102, 0)
const DIM_RED = combineRgb(102, 0, 0)
const DIM_GREEN = combineRgb(0, 102, 0)
const DIM_BLUE = combineRgb(0, 0, 102)
const DARK_GRAY = combineRgb(51, 51, 51)
const LIGHT_GRAY = combineRgb(153, 153, 153)
const DARK_CYAN = combineRgb(0, 102, 102)
const LIGHT_CYAN = combineRgb(0, 204, 204)
const LIGHT_BLUE = combineRgb(51, 153, 255)
const WHITE = combineRgb(255, 255, 255)

// Per-preset background overrides, applied after generation (default is BLUE
// from the shared btn() helper). Orange calls out the 3 "hands control back
// to the camera's auto algorithms / wipes settings" buttons; dim red/green/
// blue color-codes the R/G/B gain reset/up/down buttons and their knob
// presets to match the channel they act on.
const PRESET_BGCOLOR_OVERRIDES = {
	cam_settings_reset: ORANGE,
	cam_wb_Auto: ORANGE,
	cam_ae_Auto: ORANGE,
	cam_rgain_reset: DIM_RED,
	cam_rgain_up: DIM_RED,
	cam_rgain_down: DIM_RED,
	cam_bgain_reset: DIM_BLUE,
	cam_bgain_up: DIM_BLUE,
	cam_bgain_down: DIM_BLUE,
	dct_ggain_Reset: DIM_GREEN,
	dct_ggain_Up: DIM_GREEN,
	dct_ggain_Down: DIM_GREEN,
	knob_cam_rgain_direct: DIM_RED,
	knob_cam_bgain_direct: DIM_BLUE,
	knob_dct_ggain_direct: DIM_GREEN,
	knob_dct_black_red: DIM_RED,
	knob_dct_black_blue: DIM_BLUE,
	knob_dct_black_green: DIM_GREEN,
	knob_dct_flare_red: DIM_RED,
	knob_dct_flare_blue: DIM_BLUE,
	knob_dct_flare_green: DIM_GREEN,
	cam_settings_save: DARK_GRAY,
	dct_load_settings: DARK_GRAY,
	if_clear: DARK_GRAY,
	dct_timecode_hold_Run: DARK_GRAY,
	dct_timecode_hold_Hold: DARK_GRAY,
	dct_auto_save_On: DARK_GRAY,
	dct_auto_save_Off: DARK_GRAY,
	dct_audio_enable_On: DARK_CYAN,
	dct_audio_enable_Off: DARK_CYAN,
	knob_dct_audio_gain: DARK_CYAN,
}

// `kind: 'rud'` COMMANDS ids -> their real-value INQUIRIES id. Reset/Up/Down
// compute the new value server-side (relative step or a fixed target), and
// the only way to learn what it actually landed on is to ask -- these ids
// don't line up 1:1 with COMMANDS (e.g. cam_gain -> INQUIRIES.gain), same
// irregularity continuousParams()/directVarId() already work around for the
// "direct" counterparts.
const RUD_INQUIRY_ID = {
	cam_gain: 'gain',
	cam_shutter: 'shutter',
	cam_rgain: 'rgain',
	cam_bgain: 'bgain',
	cam_bright: 'bright',
}

// enum COMMANDS ids whose plain per-choice buttons (not just their dedicated
// toggle action) should also confirmIfNotPolling() after sending -- these
// stayed on the continuous poll tier specifically so their toggle buttons'
// live status stays accurate; the plain "SDI Range: Legal"/"Audio Enable:
// On"/"Timecode: Run"/"AE: Auto"/"WB: Manual"-style buttons set the exact
// same value, so they need the same confirmation when auto poll is off.
const CONFIRM_POLL_ENUM_IDS = new Set(['dct_sdi_range', 'dct_timecode_hold', 'dct_audio_enable', 'cam_ae', 'cam_wb'])
// CONFIRM_POLL_ENUM_IDS is keyed by COMMANDS id (what the generic enum
// callback below has in scope), but confirmIfNotPolling() needs an INQUIRIES
// id -- for dct_sdi_range/dct_timecode_hold/dct_audio_enable those are the
// same string, but cam_ae/cam_wb's inquiries are named ae_mode/wb_mode.
const CONFIRM_POLL_INQUIRY_ID = { cam_ae: 'ae_mode', cam_wb: 'wb_mode' }

// dct_ggain (kind:'enum', choices Reset/Up/Down) is semantically a RUD-style
// gain control -- it just uses DCT-extension byte payloads instead of
// the standard VISCA RUD template, so the generic 'rud' branch's RUD_INQUIRY_ID
// handling doesn't apply to it. Give it the exact same unconditional
// confirm+resync treatment as cam_rgain/cam_bgain (below), which it otherwise
// wouldn't get at all.
const ENUM_RUD_INQUIRY_ID = { dct_ggain: 'dct_ggain' }

// enum COMMANDS ids that are purely a named-shortcut UI for a sibling
// `direct`-kind knob (dct_tm_mode_preset -> dct_tm_mode, dct_color_space_preset
// -> dct_color_space, same idea as Gain (ISO)/Shutter (Speed) but via 'enum'
// instead of a curated table) -- pressing one of these buttons sends an exact,
// deterministically-known value (unlike a RUD reset), so it can write the
// sibling knob/state immediately instead of waiting on the next poll, which
// would otherwise never happen at all for a `once:true` (startup-only) param
// like these two. The raw value is the choice's position in `choices`
// (insertion order == wire value 0,1,2... for both of these).
const PRESET_KNOB_TARGET = { dct_tm_mode_preset: 'dct_tm_mode', dct_color_space_preset: 'dct_color_space' }

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

// Commands/presets that don't apply to one of the two camera product lines
// (confirmed on real hardware: Tone Mapping Mode only exists on Atom Two HDR,
// so it is unusable -- and thus hidden -- on Atom Two; Filter Enable/Gain Mode
// are hidden on Atom Two HDR per product decision; Filter Denoise exists on
// both, with a narrower range on Atom Two HDR, see COMMANDS.modelMax). Applied in setupActions()/setupPresets() and the poll filters
// once the camera's model is known (see this.cameraModel, set from
// applyInquiryReply()'s version-reply hook) -- unknown model means
// unrestricted, so a camera whose firmware predates this model-id scheme (or
// a failed/slow version poll) never has controls incorrectly hidden.
const MODEL_GATED_IDS = {
	'atom-two': ['dct_tm_mode', 'dct_tm_mode_preset'],
	'atom-two-hdr': ['dct_filter_enable', 'dct_gain_mode'],
}

// Knobs whose real command already has a proper RUD "Reset" (server-side
// target, confirmed via RUD_INQUIRY_ID's unconditional resyncKnob confirm-
// read) -- pressing reuses that exact same action/choice instead of the
// generic poll_now every other knob gets.
const KNOB_PRESS_DOWN = {
	cam_rgain_direct: { actionId: 'cam_rgain', options: { choice: 'reset' } },
	cam_bgain_direct: { actionId: 'cam_bgain', options: { choice: 'reset' } },
	dct_ggain_direct: { actionId: 'dct_ggain', options: { choice: 'Reset' } },
	cam_gain_direct: { actionId: 'cam_gain', options: { choice: 'reset' } },
	cam_shutter_direct: { actionId: 'cam_shutter', options: { choice: 'reset' } },
	cam_bright_direct: { actionId: 'cam_bright', options: { choice: 'reset' } },
}

// Knobs with no existing RUD/enum "reset" concept (kind:'direct' only, no
// server-side target to ask for) -- pressing sends an explicit direct SET to
// a fixed value instead. Since we choose the exact value ourselves (unlike a
// RUD reset, whose real landing value has to be confirmed via inquiry), the
// generated action can write state/knob directly with no confirm-read needed.
const KNOB_PRESS_SET_VALUE = {
	cam_color_hue_direct: 0, // neutral hue -- no shift (signed -128..127)
	// Color Gain/Contrast's real factory default is 128 (0x80, "1.0x" on
	// their fixed-point scales) -- confirmed against factory-default state.
	cam_color_gain_direct: 128,
	cam_contrast_direct: 128,
	dct_wb_temp: 6500, // common daylight white-balance reference, per user request
	dct_audio_gain: 256, // per user request
	// LUT Fast Gamma reset target: standard gamma 2.2. The wire grid (1100 + pq*8)
	// can't hit 2.200 exactly -- pq 137 lands on 2.196 and 138 on 2.204
	dct_lut_fast_gamma: 138,
}

// dct_tally_cycle's press order (main.js setupActions()); each state is the
// pair of local booleans this.tally tracks. No VISCA inquiry exists for
// either lamp (commands.js's dct_tally_red/dct_tally_green are set-only),
// so this optimistic local pair -- not a polled this.state value -- is the
// source of truth once the user starts pressing the button. Yellow (both
// lamps on) is included as its own cycle stop, reached
// by sending both Red On and Green On.
const TALLY_CYCLE_STATES = [
	{ red: false, green: false }, // Off
	{ red: true, green: false }, // Red
	{ red: false, green: true }, // Green
	{ red: true, green: true }, // Yellow
]

// `cam_settings_reset`/`dct_load_settings` change most camera parameters at
// once as a side effect of one command; without a follow-up poll, every
// displayed variable/feedback keeps showing its pre-reset value until the
// next manual "Poll inquiries now" or the (off-by-default) poll interval
// fires. pollOnce()'s inquiries get enqueued right behind the reset frame in
// the same send queue (see pump()), so they naturally wait for the reset's
// own reply first -- no artificial delay needed.
const REFRESH_AFTER_IDS = new Set(['cam_settings_reset', 'dct_load_settings'])

// The color-temp-preset inquiry side (INQUIRIES.color_temp) has no
// inquiry that can answer it -- the camera has no command that reports
// which preset index is currently active, only ones that set it -- so
// it always errors. Left in INQUIRIES so the variable/Companion definition still
// exists (setupVariables() derives its list from INQUIRIES), but excluded
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
		this.serialPortScanTimer = setInterval(() => void this.scanAndProbeSerialPorts().catch(() => {}), 5000)
		await this.scanAndProbeSerialPorts()
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
			this.pollStartupOnce()
		})
		port.on('data', (chunk) => this.onData(chunk))
		port.on('close', () => {
			if (adapter.closing) return // our own teardown, not a link drop
			adapter.isConnected = false
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
				if (s !== InstanceStatus.Ok && s !== InstanceStatus.UnknownWarning) this.confirmedReply = false
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
			this.pollStartupOnce()
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

	enqueue(frame, onReply) {
		this.queue.push({ frame, onReply })
		this.pump()
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
		const cur = this.readValue(p.varId)
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
		const actions = {}
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		for (const [id, c] of Object.entries(COMMANDS)) {
			if (gatedIds.includes(id)) continue
			const a = { name: `${c.group}: ${c.name}`, options: [] }
			if (c.kind === 'enum') {
				const ids = Object.keys(c.choices)
				a.options = [
					{
						type: 'dropdown',
						id: 'choice',
						label: c.name,
						default: ids[0],
						choices: ids.map((x) => ({ id: x, label: x })),
					},
				]
				a.callback = (ev) => {
					this.send(c.choices[ev.options.choice])
					if (CONFIRM_POLL_ENUM_IDS.has(id)) this.confirmIfNotPolling(CONFIRM_POLL_INQUIRY_ID[id] ?? id)
					const rudQId = ENUM_RUD_INQUIRY_ID[id]
					if (rudQId) this.inquireOnce(rudQId, { resyncKnob: true })
					const knobVarId = PRESET_KNOB_TARGET[id]
					if (knobVarId) this.setKnobValue(knobVarId, ids.indexOf(ev.options.choice))
				}
			} else if (c.kind === 'rud') {
				const rudChoices = c.rudChoices ?? Object.keys(RUD)
				a.options = [
					{
						type: 'dropdown',
						id: 'choice',
						label: 'Action',
						default: rudChoices[0],
						choices: rudChoices.map((x) => ({ id: x, label: x })),
					},
				]
				a.callback = (ev) => {
					this.send([0x01, 0x04, c.func, RUD[ev.options.choice]])
					// Reset/Up/Down all change the real value server-side without
					// telling us what it landed on -- re-read it immediately so the
					// knob display/variable don't sit stale until the next poll.
					// resyncKnob is safe here (unlike a background poll): this is a
					// single, deliberate, user-triggered confirmation, not something
					// that can race a burst of knob turns.
					const qId = RUD_INQUIRY_ID[id]
					if (qId) this.inquireOnce(qId, { resyncKnob: true })
				}
			} else if (c.kind === 'direct') {
				const bits = 4 * c.nibbles
				const max = c.modelMax?.[this.cameraModel] ?? c.max ?? (c.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1)
				const min = c.min ?? (c.signed ? -(1 << (bits - 1)) : 0)
				const mask = (1 << bits) - 1
				a.options = [{ type: 'number', id: 'value', label: `Value (${min}-${max})`, default: min, min, max }]
				a.callback = (ev) => {
					const value = Number(ev.options.value) & mask
					this.send([...c.prefix, ...encodeNibbles(value, c.nibbles)])
					// A direct SET's landing value is exactly what we just sent -- no
					// ambiguity to confirm via inquiry (unlike a RUD reset), so write
					// state/knob immediately instead of waiting for the next poll.
					const varId = this.paramById[id]?.varId
					if (varId) this.setKnobValue(varId, value)
				}
			} else if (c.kind === 'fixed') {
				a.callback = () => {
					this.send(c.bytes)
					if (REFRESH_AFTER_IDS.has(id)) this.pollOnce()
				}
			} else if (c.kind === 'video') {
				const modes = Object.keys(SYSTEM)
				a.options = [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Video mode',
						default: modes[0],
						choices: modes.map((m) => ({ id: m, label: SYSTEM_NAMES[m] ?? `Mode ${m}` })),
					},
				]
				a.callback = (ev) => {
					const [b2, b3] = SYSTEM[ev.options.mode]
					this.send([0x01, 0x04, 0x24, 0x00, 0x00, b2, b3])
				}
			} else if (c.kind === 'iso') {
				a.options = [
					{
						type: 'dropdown',
						id: 'iso',
						label: 'ISO',
						default: GAIN_ISO[0].iso,
						choices: GAIN_ISO.map((g) => ({ id: g.iso, label: `ISO ${g.iso}` })),
					},
				]
				a.callback = (ev) => {
					const raw = GAIN_ISO.find((g) => g.iso === Number(ev.options.iso))?.raw ?? 0
					this.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
					// Shares cam_gain_direct's wire command/varId ('gain') -- same
					// "we know the exact landing value" optimistic write as 'direct'.
					this.setKnobValue('gain', raw)
				}
			} else if (c.kind === 'shutter') {
				a.options = [
					{
						type: 'dropdown',
						id: 'n',
						label: 'Shutter speed',
						default: SHUTTER_SPEEDS[0].n,
						choices: SHUTTER_SPEEDS.map((s) => ({ id: s.n, label: `1/${s.n}` })),
					},
				]
				a.callback = (ev) => {
					const raw = SHUTTER_SPEEDS.find((s) => s.n === Number(ev.options.n))?.raw ?? 0
					this.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
					// Shares cam_shutter_direct's wire command/varId ('shutter').
					this.setKnobValue('shutter', raw)
				}
			}
			actions[id] = a
		}
		const params = this.params
		actions['adjust'] = {
			name: 'Knob: Adjust value (relative)',
			options: [
				{
					type: 'dropdown',
					id: 'param',
					label: 'Parameter',
					default: params[0]?.id,
					choices: params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })),
				},
				{ type: 'number', id: 'step', label: 'Step (may be negative)', default: this.knobStep(), min: -255, max: 255 },
			],
			callback: (ev) => this.adjustParam(ev.options.param, Number(ev.options.step)),
		}
		actions['poll_now'] = { name: 'System: Poll inquiries now', options: [], callback: () => this.pollOnce() }
		actions['poll_startup_now'] = {
			name: 'System: Poll startup values now',
			options: [],
			callback: () => this.pollStartupOnce(),
		}
		// Knob-press "set to a fixed value" actions (see KNOB_PRESS_SET_VALUE) --
		// a plain direct SET to a value we chose ourselves, so (unlike a RUD
		// reset) there's nothing to confirm via inquiry: write state/knob
		// straight away.
		for (const [pid, value] of Object.entries(KNOB_PRESS_SET_VALUE)) {
			const p = this.paramById[pid]
			const cmd = COMMANDS[pid]
			actions[`${pid}_knob_reset`] = {
				name: `${p.name}: Set to ${value} (knob press)`,
				options: [],
				callback: () => {
					const mask = (1 << (4 * cmd.nibbles)) - 1
					this.send([...cmd.prefix, ...encodeNibbles(value & mask, cmd.nibbles)])
					this.setKnobValue(p.varId, value)
				},
			}
		}
		// wb_temp_measure has no SET side (it's a live, continuously-updated
		// AWB filter reading, not something you configure) -- so it has no
		// COMMANDS entry and is invisible to the generic loop above. Fire just
		// this one inquiry on demand, same shape as poll_now but scoped to it.
		actions['dct_wb_temp_measure_now'] = {
			name: 'White Balance: Measure Kelvin now',
			options: [],
			callback: () => this.inquireOnce('dct_wb_temp_measure'),
		}
		// Genuinely binary commands (unlike cam_ae/cam_wb's 3-6 choices) --
		// toggle unambiguously flips to whichever of the 2 choices isn't
		// current, writing state immediately so the button's own feedback
		// doesn't wait for a poll.
		actions['dct_audio_enable_toggle'] = {
			name: 'Audio: Toggle On/Off',
			options: [],
			callback: () => {
				const goOn = this.state.dct_audio_enable !== 'On'
				this.send(COMMANDS.dct_audio_enable.choices[goOn ? 'On' : 'Off'])
				this.state.dct_audio_enable = goOn ? 'On' : 'Off'
				this.setVariableValues({ dct_audio_enable: this.state.dct_audio_enable })
				this.checkFeedbacks('dct_audio_enable_is', 'dct_audio_enable_display')
				this.confirmIfNotPolling('dct_audio_enable')
			},
		}
		actions['dct_sdi_range_toggle'] = {
			name: 'SDI: Toggle Legal/Full',
			options: [],
			callback: () => {
				const goFull = this.state.dct_sdi_range !== 'Full'
				this.send(COMMANDS.dct_sdi_range.choices[goFull ? 'Full' : 'Legal'])
				this.state.dct_sdi_range = goFull ? 'Full' : 'Legal'
				this.setVariableValues({ dct_sdi_range: this.state.dct_sdi_range })
				this.checkFeedbacks('dct_sdi_range_is', 'dct_sdi_range_display')
				this.confirmIfNotPolling('dct_sdi_range')
			},
		}
		actions['dct_timecode_hold_toggle'] = {
			name: 'Timecode: Toggle Run/Hold',
			options: [],
			callback: () => {
				const goRun = this.state.dct_timecode_hold !== 'Run'
				this.send(COMMANDS.dct_timecode_hold.choices[goRun ? 'Run' : 'Hold'])
				this.state.dct_timecode_hold = goRun ? 'Run' : 'Hold'
				this.setVariableValues({ dct_timecode_hold: this.state.dct_timecode_hold })
				this.checkFeedbacks('dct_timecode_hold_display')
				this.confirmIfNotPolling('dct_timecode_hold')
			},
		}
		// 4-state cycle over TALLY_CYCLE_STATES, unlike the strict 2-way
		// toggles above (which don't generalize past 2 states). Red/Green are
		// independent set-only commands with no inquiry, so this tracks
		// this.tally locally rather than reading back camera state; unknown
		// (-1, e.g. never pressed) advances to index 0 "Off", a safe start.
		// Only sends the lamp(s) that actually change between states.
		actions['dct_tally_cycle'] = {
			name: 'Tally: Cycle Off/Red/Green/Yellow',
			options: [],
			callback: () => {
				const cur = TALLY_CYCLE_STATES.findIndex((s) => s.red === this.tally.red && s.green === this.tally.green)
				const next = TALLY_CYCLE_STATES[(cur + 1) % TALLY_CYCLE_STATES.length]
				if (next.red !== this.tally.red) this.send(COMMANDS.dct_tally_red.choices[next.red ? 'On' : 'Off'])
				if (next.green !== this.tally.green) this.send(COMMANDS.dct_tally_green.choices[next.green ? 'On' : 'Off'])
				this.tally = next
				this.checkFeedbacks('dct_tally_display')
			},
		}
		// AE/WB are genuinely 3-/5-choice enums (cam_ae, cam_wb above), unlike
		// the strictly-binary toggles above -- these two additional toggles
		// only ever flip between Auto and Manual (ignoring Shutter Pri /
		// Indoor / Outdoor / Trigger, all still reachable via their own
		// existing per-choice buttons).
		actions['cam_ae_toggle'] = {
			name: 'AE: Toggle Auto/Manual',
			options: [],
			callback: () => {
				const goManual = this.state.ae_mode !== 'Manual'
				this.send(COMMANDS.cam_ae.choices[goManual ? 'Manual' : 'Auto'])
				this.state.ae_mode = goManual ? 'Manual' : 'Auto'
				this.setVariableValues({ ae_mode: this.state.ae_mode })
				this.checkFeedbacks('ae_mode_is', 'cam_ae_display')
				this.confirmIfNotPolling('ae_mode')
			},
		}
		actions['cam_wb_toggle'] = {
			name: 'WB: Toggle Auto/Manual',
			options: [],
			callback: () => {
				const goManual = this.state.wb_mode !== 'Manual'
				this.send(COMMANDS.cam_wb.choices[goManual ? 'Manual' : 'Auto'])
				this.state.wb_mode = goManual ? 'Manual' : 'Auto'
				this.setVariableValues({ wb_mode: this.state.wb_mode })
				this.checkFeedbacks('wb_mode_is', 'cam_wb_display')
				this.confirmIfNotPolling('wb_mode')
			},
		}
		this.setActionDefinitions(actions)
	}

	// --- presets -----------------------------------------------------------
	setupPresets() {
		const presets = {}
		const btn = (category, name, text, actionId, options, feedbacks = []) => ({
			type: 'button',
			category,
			name,
			style: { text, size: 'auto', color: WHITE, bgcolor: BLUE },
			steps: [{ down: [{ actionId, options }], up: [] }],
			feedbacks,
		})
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		for (const [id, c] of Object.entries(COMMANDS)) {
			if (gatedIds.includes(id)) continue
			if (c.kind === 'enum') {
				for (const choice of Object.keys(c.choices)) {
					presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
				}
			} else if (c.kind === 'rud') {
				for (const choice of c.rudChoices ?? Object.keys(RUD)) {
					presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
				}
			} else if (c.kind === 'fixed') {
				presets[id] = btn(c.group, c.name, c.name.replace(/ /g, '\\n'), id, {})
			} else if (c.kind === 'video') {
				for (const mode of Object.keys(SYSTEM)) {
					const label = SYSTEM_NAMES[mode] ?? `Mode ${mode}`
					presets[`${id}_${mode}`] = btn(c.group, `${c.name}: ${label}`, `${c.name}\\n${label}`, id, { mode })
				}
			} else if (c.kind === 'iso') {
				for (const g of GAIN_ISO) {
					presets[`${id}_${g.iso}`] = btn(c.group, `${c.name}: ISO ${g.iso}`, `${c.name}\\nISO ${g.iso}`, id, {
						iso: g.iso,
					})
				}
			} else if (c.kind === 'shutter') {
				for (const s of SHUTTER_SPEEDS) {
					presets[`${id}_${s.n}`] = btn(c.group, `${c.name}: 1/${s.n}`, `${c.name}\\n1/${s.n}`, id, { n: s.n })
				}
			}
		}
		// Rotary-encoder (Stream Deck+) knobs: turn = adjust +/- step, press = sync.
		for (const p of this.params) {
			if (gatedIds.includes(p.id)) continue
			const step = p.step ?? (effectiveMax(p, this.cameraModel) <= 15 ? 1 : this.knobStep())
			presets[`knob_${p.id}`] = {
				type: 'button',
				category: `${p.group}`,
				name: `${p.name} (knob)`,
				options: { rotaryActions: true },
				style: { text: p.name, size: 'auto', color: WHITE, bgcolor: BLUE, png64: KNOB_RING_PNG },
				steps: [
					{
						down: [
							KNOB_PRESS_DOWN[p.id] ??
								(p.id in KNOB_PRESS_SET_VALUE
									? { actionId: `${p.id}_knob_reset`, options: {} }
									: { actionId: 'poll_now', options: {} }),
						],
						up: [],
						rotate_right: [{ actionId: 'adjust', options: { param: p.id, step } }],
						rotate_left: [{ actionId: 'adjust', options: { param: p.id, step: -step } }],
					},
				],
				feedbacks: [{ feedbackId: 'knob_value', options: { param: p.id } }],
			}
		}
		presets['wb_kelvin_measure'] = btn(
			'White Balance',
			'WB Kelvin Measure',
			'WB Measure\\n--',
			'dct_wb_temp_measure_now',
			{},
			[{ feedbackId: 'wb_measure_display', options: {} }],
		)
		presets['audio_enable_toggle'] = btn('Audio', 'Audio: Toggle On/Off', 'Audio\\n--', 'dct_audio_enable_toggle', {}, [
			{ feedbackId: 'dct_audio_enable_display', options: {} },
		])
		presets['sdi_range_toggle'] = btn('System', 'SDI: Toggle Legal/Full', 'SDI\\n--', 'dct_sdi_range_toggle', {}, [
			{ feedbackId: 'dct_sdi_range_display', options: {} },
		])
		presets['timecode_hold_toggle'] = btn(
			'System',
			'Timecode: Toggle Run/Hold',
			'TC\\n--',
			'dct_timecode_hold_toggle',
			{},
			[{ feedbackId: 'dct_timecode_hold_display', options: {} }],
		)
		presets['tally_cycle'] = btn('System', 'Tally: Cycle Off/Red/Green/Yellow', 'Tally\\n--', 'dct_tally_cycle', {}, [
			{ feedbackId: 'dct_tally_display', options: {} },
		])
		presets['cam_ae_toggle'] = btn('Exposure', 'AE: Toggle Auto/Manual', 'AE\\n--', 'cam_ae_toggle', {}, [
			{ feedbackId: 'cam_ae_display', options: {} },
		])
		presets['cam_wb_toggle'] = btn('White Balance', 'WB: Toggle Auto/Manual', 'WB\\n--', 'cam_wb_toggle', {}, [
			{ feedbackId: 'cam_wb_display', options: {} },
		])
		for (const [id, bgcolor] of Object.entries(PRESET_BGCOLOR_OVERRIDES)) {
			if (presets[id]) presets[id].style.bgcolor = bgcolor
		}
		this.setPresetDefinitions(presets)
	}

	// --- variables + feedbacks --------------------------------------------
	setupVariables() {
		this.setVariableDefinitions(Object.values(INQUIRIES).map((q) => ({ variableId: q.varId, name: q.name })))
	}

	setupFeedbacks() {
		const modeFeedback = (name, mapObj, varId) => ({
			type: 'boolean',
			name,
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: Object.values(mapObj)[0],
					choices: Object.values(mapObj).map((v) => ({ id: v, label: v })),
				},
			],
			callback: (fb) => this.state[varId] === fb.options.mode,
		})
		this.setFeedbackDefinitions({
			ae_mode_is: modeFeedback('AE mode is', ENUM.ae, 'ae_mode'),
			wb_mode_is: modeFeedback('WB mode is', ENUM.wb, 'wb_mode'),
			dct_audio_enable_is: modeFeedback('Audio Enable is', ENUM.dct_onoff, 'dct_audio_enable'),
			dct_sdi_range_is: modeFeedback('SDI Range is', ENUM.dct_sdi_range, 'dct_sdi_range'),
			connected: {
				type: 'boolean',
				name: 'Connection OK',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [],
				callback: () => this.socket?.isConnected === true,
			},
			knob_value: {
				type: 'advanced',
				name: 'Knob: show current value',
				options: [
					{
						type: 'dropdown',
						id: 'param',
						label: 'Parameter',
						default: this.params[0]?.id,
						choices: this.params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })),
					},
				],
				callback: (fb) => {
					const p = this.paramById?.[fb.options.param]
					if (!p) return {}
					// Prefer the knob's own running target (same value adjustParam()'s
					// arithmetic uses) over the possibly-lagging polled this.state --
					// otherwise the display can show an older, lower number while
					// polling catches up mid-turn, looking like a spurious step back.
					const v = this.knob[p.varId] !== undefined ? this.knob[p.varId] : this.state[p.varId]
					const n = Number(v)
					// Second arg (this.cameraModel) is only consumed by format functions
					// that need it (e.g. dct_black_red/green/blue's per-ISP factory
					// default, see BLACK_DEFAULT_BY_MODEL in commands.js) -- every other
					// format function ignores extra arguments, so this is safe to pass
					// unconditionally.
					const text = p.format && Number.isFinite(n) ? p.format(n, this.cameraModel) : (v ?? '--')
					// Most params bar-position on the raw wire value; a few (e.g. Audio
					// Gain) define a separate display-unit scale (barValue/barMin/barMax)
					// so the bar reflects the same unit as the text above it -- e.g. 0dB
					// sits at the visual center of a symmetric dB window, not near the
					// left edge of the raw 0-4095 range. A non-finite barValue (Audio
					// Gain's raw=0 is -Infinity dB) clamps to the bar's low end instead
					// of falling through to progressBar()'s own "not finite" dashes.
					let barVal = p.barValue ? p.barValue(n) : n
					const barMin = p.barValue ? p.barMin : p.min
					const barMax = p.barValue ? p.barMax : effectiveMax(p, this.cameraModel)
					if (p.barValue && !Number.isFinite(barVal)) barVal = barMin
					const bar = progressBar(barVal, barMin, barMax)
					return { text: `${p.name}\\n${text}\\n${bar}`, size: 'auto' }
				},
			},
			wb_measure_display: {
				type: 'advanced',
				name: 'WB Kelvin Measure (display)',
				options: [],
				callback: () => {
					const v = this.state.dct_wb_temp_measure
					return { text: `WB Measure\\n${v ?? '--'} K`, size: 'auto' }
				},
			},
			dct_audio_enable_display: {
				type: 'advanced',
				name: 'Audio Enable toggle (display)',
				options: [],
				callback: () => {
					const on = this.state.dct_audio_enable === 'On'
					return {
						text: `Audio\\n${on ? 'ON' : 'OFF'}`,
						size: 'auto',
						bgcolor: on ? LIGHT_CYAN : DARK_CYAN,
						color: WHITE,
					}
				},
			},
			dct_sdi_range_display: {
				type: 'advanced',
				name: 'SDI Range toggle (display)',
				options: [],
				callback: () => {
					const full = this.state.dct_sdi_range === 'Full'
					return {
						text: `SDI\\n${full ? 'FULL' : 'LEGAL'}`,
						size: 'auto',
						bgcolor: full ? LIGHT_BLUE : BLUE,
						color: WHITE,
					}
				},
			},
			dct_tally_display: {
				type: 'advanced',
				name: 'Tally cycle (display)',
				options: [],
				callback: () => {
					const { red, green } = this.tally
					const label = red && green ? 'YELLOW' : red ? 'RED' : green ? 'GREEN' : 'OFF'
					const bgcolor = red && green ? ORANGE : red ? RED : green ? GREEN : DARK_GRAY
					return { text: `Tally\\n${label}`, size: 'auto', bgcolor, color: WHITE }
				},
			},
			cam_ae_display: {
				type: 'advanced',
				name: 'AE toggle (display)',
				options: [],
				callback: () => {
					const auto = this.state.ae_mode !== 'Manual'
					return {
						text: `AE\\n${auto ? 'AUTO' : 'MANUAL'}`,
						size: 'auto',
						bgcolor: auto ? GREEN : DIM_RED,
						color: WHITE,
					}
				},
			},
			cam_wb_display: {
				type: 'advanced',
				name: 'WB toggle (display)',
				options: [],
				callback: () => {
					const auto = this.state.wb_mode !== 'Manual'
					return {
						text: `WB\\n${auto ? 'AUTO' : 'MANUAL'}`,
						size: 'auto',
						bgcolor: auto ? GREEN : DIM_RED,
						color: WHITE,
					}
				},
			},
			dct_timecode_hold_display: {
				type: 'advanced',
				name: 'Timecode toggle (display)',
				options: [],
				callback: () => {
					const on = this.state.dct_timecode_hold === 'Run'
					return {
						text: `TC\\n${on ? 'RUN' : 'HOLD'}`,
						size: 'auto',
						bgcolor: on ? LIGHT_GRAY : DARK_GRAY,
						color: WHITE,
					}
				},
			},
		})
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
			clearTimeout(safety)
		}
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
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		this.pollBatch(
			Object.entries(INQUIRIES)
				.filter(([id, q]) => !NO_POLL_INQUIRY_IDS.has(id) && !q.once && !gatedIds.includes(id))
				.map(([, q]) => q),
		)
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
		const gatedIds = MODEL_GATED_IDS[this.cameraModel] ?? []
		this.pollBatch(Object.values(INQUIRIES).filter((q) => q.once && !gatedIds.includes(q.varId)))
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
		// in-progress edit, only `isVisible` gets the live values).
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
				isVisible: (c) => c.conn !== 'serial',
			},
			{
				type: 'number',
				id: 'port',
				label: 'TCP port',
				width: 3,
				default: 4000,
				min: 1,
				max: 65535,
				isVisible: (c) => c.conn !== 'serial',
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
				isVisible: (c) => c.conn === 'serial',
			},
			{
				type: 'checkbox',
				id: 'serialFilterAdapters',
				label: 'Only show USB serial adapters',
				width: 3,
				default: true,
				isVisible: (c) => c.conn === 'serial',
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
				isVisible: (c) => c.conn === 'serial',
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
		this.startPolling()
	}

	async destroy() {
		this.destroyed = true
		this.stopPolling()
		if (this.serialPortScanTimer) clearInterval(this.serialPortScanTimer)
		if (this.serialReconnectTimer) clearTimeout(this.serialReconnectTimer)
		if (this.inflight?.timer) clearTimeout(this.inflight.timer)
		if (this.socket) this.socket.destroy()
	}
}
