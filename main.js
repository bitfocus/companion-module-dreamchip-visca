import { InstanceBase, InstanceStatus, Regex, TCPHelper, runEntrypoint, combineRgb } from '@companion-module/base'
import { COMMANDS, INQUIRIES, ENUM, SYSTEM, SYSTEM_NAMES, GAIN_ISO, SHUTTER_SPEEDS, RUD, TERMINATOR, encodeNibbles, decodeReply, buildFrame, continuousParams, progressBar } from './commands.js'
import { KNOB_RING_PNG } from './images.js'

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()
const GREEN = combineRgb(0, 102, 0)
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
// blue color-codes the R/G/B gain reset buttons and their knob presets to
// match the channel they act on.
const PRESET_BGCOLOR_OVERRIDES = {
	cam_settings_reset: ORANGE,
	cam_wb_Auto: ORANGE,
	cam_ae_Auto: ORANGE,
	cam_rgain_reset: DIM_RED,
	cam_bgain_reset: DIM_BLUE,
	dct_ggain_Reset: DIM_GREEN,
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
const RUD_INQUIRY_ID = { cam_gain: 'gain', cam_shutter: 'shutter', cam_rgain: 'rgain', cam_bgain: 'bgain', cam_bright: 'bright' }

// enum COMMANDS ids whose plain per-choice buttons (not just their dedicated
// toggle action) should also confirmIfNotPolling() after sending -- these 3
// stayed on the continuous poll tier specifically so their toggle buttons'
// live status stays accurate; the plain "SDI Range: Legal"/"Audio Enable:
// On"/"Timecode: Run"-style buttons set the exact same value, so they need
// the same confirmation when auto poll is off.
const CONFIRM_POLL_ENUM_IDS = new Set(['dct_sdi_range', 'dct_timecode_hold', 'dct_audio_enable'])

// `cam_settings_reset`/`dct_load_settings` change most camera parameters at
// once as a side effect of one command; without a follow-up poll, every
// displayed variable/feedback keeps showing its pre-reset value until the
// next manual "Poll inquiries now" or the (off-by-default) poll interval
// fires. pollOnce()'s inquiries get enqueued right behind the reset frame in
// the same send queue (see pump()), so they naturally wait for the reset's
// own reply first -- no artificial delay needed.
const REFRESH_AFTER_IDS = new Set(['cam_settings_reset', 'dct_load_settings'])

// FN_CAM_COLOR_TEMP's inquiry side (INQUIRIES.color_temp) has no case in the
// BSP's wb_inquiry() -- there is no ProVideo command that reports which
// wb_preset index is currently active, only ones that set it -- so it always
// errors. Left in INQUIRIES so the variable/Companion definition still
// exists (setupVariables() derives its list from INQUIRIES), but excluded
// from actual polling: sending it every cycle would be a wasted round trip
// AND would keep stomping the optimistic value set below back to 'n/a'.
//
// dct_wb_temp_measure is excluded for a different reason -- it works fine
// (wb_temp_measure_inquiry runs a real, fresh capture every request), it's
// just meant to be on-demand only, via the dedicated "WB Kelvin Measure"
// button/action (dct_wb_temp_measure_now), not refreshed automatically on
// every poll tick.
const NO_POLL_INQUIRY_IDS = new Set(['color_temp', 'dct_wb_temp_measure'])
// color_temp_direct (COMMANDS id) is the SET-only counterpart -- since it can
// never be confirmed via inquiry, reflect the just-sent value immediately
// instead of leaving its variable stuck at 'n/a' forever.
const OPTIMISTIC_DIRECT_IDS = new Set(['color_temp_direct'])

class DctViscaInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = {} // decoded inquiry values by varId (for feedbacks)
		this.queue = [] // { frame, onReply, timer }
		this.inflight = null
		this.rxbuf = Buffer.alloc(0)
		this.knob = {} // per-varId knob target (relative-adjust state)
		this.params = continuousParams()
		this.paramById = Object.fromEntries(this.params.map((p) => [p.id, p]))

		this.setupActions()
		this.setupFeedbacks()
		this.setupVariables()
		this.setupPresets()
		await this.initTransport()
		this.startPolling()
	}

	// --- transport ---------------------------------------------------------
	async initTransport() {
		if (this.config?.conn === 'serial') {
			await this.initSerial()
		} else {
			this.initTCP()
		}
	}

	async initSerial() {
		if (this.socket) {
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
		this.socket = {
			isConnected: false,
			send: (buf) => {
				try {
					port.write(Buffer.from(buf))
				} catch (err) {
					this.log('error', `serial write: ${err.message}`)
				}
			},
			destroy: () => {
				try {
					if (port.isOpen) port.close(() => {})
				} catch (_) {
					// ignore
				}
			},
		}
		port.on('open', () => {
			// Half-duplex RS-485 adapters need DTR+RTS asserted or TX never reaches the camera.
			try {
				port.set({ dtr: true, rts: true }, () => {})
			} catch (_) {
				// ignore
			}
			this.socket.isConnected = true
			this.updateStatus(InstanceStatus.Ok)
			this.checkFeedbacks('connected')
			this.pump()
			this.pollStartupOnce()
		})
		port.on('data', (chunk) => this.onData(chunk))
		port.on('close', () => {
			if (this.socket) this.socket.isConnected = false
			this.updateStatus(InstanceStatus.Disconnected)
			this.checkFeedbacks('connected')
		})
		port.on('error', (err) => {
			this.log('error', `serial error: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
		port.open((err) => {
			if (err) {
				this.log('error', `serial open: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			}
		})
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
			this.updateStatus(s, m)
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
	applyInquiryReply(q, reply, kind) {
		const value = kind === 0x50 ? decodeReply(q.decode, reply.subarray(2, reply.length - 1)) : 'n/a'
		this.state[q.varId] = value
		this.setVariableValues({ [q.varId]: value })
		if (q.decode.type === 'value') {
			const n = parseInt(value, 10)
			if (Number.isFinite(n)) this.knob[q.varId] = n
		}
		if (q.varId === 'ae_mode') this.checkFeedbacks('ae_mode_is')
		if (q.varId === 'wb_mode') this.checkFeedbacks('wb_mode_is')
		if (q.varId === 'dct_audio_enable') this.checkFeedbacks('dct_audio_enable_is', 'dct_audio_enable_display')
		if (q.varId === 'dct_sdi_range') this.checkFeedbacks('dct_sdi_range_is', 'dct_sdi_range_display')
		if (q.varId === 'dct_timecode_hold') this.checkFeedbacks('dct_timecode_hold_display')
		this.checkFeedbacks('knob_value')
		this.checkFeedbacks('wb_measure_display')
	}

	// Fire a single named inquiry (INQUIRIES key) on demand.
	inquireOnce(qId) {
		const q = INQUIRIES[qId]
		if (!q) return
		this.enqueue(buildFrame(this.config?.address || 1, q.payload), (reply, kind) => this.applyInquiryReply(q, reply, kind))
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
		const next = Math.max(p.min, Math.min(p.max, raw))
		this.knob[p.varId] = next
		const c = COMMANDS[p.cmd]
		this.send([...c.prefix, ...encodeNibbles(next, c.nibbles)])
		this.state[p.varId] = String(next)
		this.setVariableValues({ [p.varId]: String(next) })
		this.checkFeedbacks('knob_value')
	}

	// --- actions -----------------------------------------------------------
	setupActions() {
		const actions = {}
		for (const [id, c] of Object.entries(COMMANDS)) {
			const a = { name: `${c.group}: ${c.name}`, options: [] }
			if (c.kind === 'enum') {
				const ids = Object.keys(c.choices)
				a.options = [{ type: 'dropdown', id: 'choice', label: c.name, default: ids[0], choices: ids.map((x) => ({ id: x, label: x })) }]
				a.callback = (ev) => {
					this.send(c.choices[ev.options.choice])
					if (CONFIRM_POLL_ENUM_IDS.has(id)) this.confirmIfNotPolling(id)
				}
			} else if (c.kind === 'rud') {
				const rudChoices = c.rudChoices ?? Object.keys(RUD)
				a.options = [{ type: 'dropdown', id: 'choice', label: 'Action', default: rudChoices[0], choices: rudChoices.map((x) => ({ id: x, label: x })) }]
				a.callback = (ev) => {
					this.send([0x01, 0x04, c.func, RUD[ev.options.choice]])
					// Reset/Up/Down all change the real value server-side without
					// telling us what it landed on -- re-read it immediately so the
					// knob display/variable don't sit stale until the next poll.
					const qId = RUD_INQUIRY_ID[id]
					if (qId) this.inquireOnce(qId)
				}
			} else if (c.kind === 'direct') {
				const bits = 4 * c.nibbles
				const max = c.max ?? (c.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1)
				const min = c.min ?? (c.signed ? -(1 << (bits - 1)) : 0)
				const mask = (1 << bits) - 1
				a.options = [{ type: 'number', id: 'value', label: `Value (${min}-${max})`, default: min, min, max }]
				a.callback = (ev) => {
					const value = Number(ev.options.value) & mask
					this.send([...c.prefix, ...encodeNibbles(value, c.nibbles)])
					if (OPTIMISTIC_DIRECT_IDS.has(id)) {
						const varId = this.paramById[id].varId
						this.state[varId] = String(value)
						this.setVariableValues({ [varId]: String(value) })
					}
				}
			} else if (c.kind === 'fixed') {
				a.callback = () => {
					this.send(c.bytes)
					if (REFRESH_AFTER_IDS.has(id)) this.pollOnce()
				}
			} else if (c.kind === 'video') {
				const modes = Object.keys(SYSTEM)
				a.options = [{ type: 'dropdown', id: 'mode', label: 'Video mode', default: modes[0], choices: modes.map((m) => ({ id: m, label: SYSTEM_NAMES[m] ?? `Mode ${m}` })) }]
				a.callback = (ev) => {
					const [b2, b3] = SYSTEM[ev.options.mode]
					this.send([0x01, 0x04, 0x24, 0x00, 0x00, b2, b3])
				}
			} else if (c.kind === 'iso') {
				a.options = [{ type: 'dropdown', id: 'iso', label: 'ISO', default: GAIN_ISO[0].iso, choices: GAIN_ISO.map((g) => ({ id: g.iso, label: `ISO ${g.iso}` })) }]
				a.callback = (ev) => {
					const raw = GAIN_ISO.find((g) => g.iso === Number(ev.options.iso))?.raw ?? 0
					this.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
				}
			} else if (c.kind === 'shutter') {
				a.options = [{ type: 'dropdown', id: 'n', label: 'Shutter speed', default: SHUTTER_SPEEDS[0].n, choices: SHUTTER_SPEEDS.map((s) => ({ id: s.n, label: `1/${s.n}` })) }]
				a.callback = (ev) => {
					const raw = SHUTTER_SPEEDS.find((s) => s.n === Number(ev.options.n))?.raw ?? 0
					this.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
				}
			}
			actions[id] = a
		}
		const params = this.params
		actions['adjust'] = {
			name: 'Knob: Adjust value (relative)',
			options: [
				{ type: 'dropdown', id: 'param', label: 'Parameter', default: params[0]?.id, choices: params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })) },
				{ type: 'number', id: 'step', label: 'Step (may be negative)', default: this.knobStep(), min: -255, max: 255 },
			],
			callback: (ev) => this.adjustParam(ev.options.param, Number(ev.options.step)),
		}
		actions['poll_now'] = { name: 'System: Poll inquiries now', options: [], callback: () => this.pollOnce() }
		actions['poll_startup_now'] = { name: 'System: Poll startup values now', options: [], callback: () => this.pollStartupOnce() }
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
		for (const [id, c] of Object.entries(COMMANDS)) {
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
					presets[`${id}_${g.iso}`] = btn(c.group, `${c.name}: ISO ${g.iso}`, `${c.name}\\nISO ${g.iso}`, id, { iso: g.iso })
				}
			} else if (c.kind === 'shutter') {
				for (const s of SHUTTER_SPEEDS) {
					presets[`${id}_${s.n}`] = btn(c.group, `${c.name}: 1/${s.n}`, `${c.name}\\n1/${s.n}`, id, { n: s.n })
				}
			}
		}
		// Rotary-encoder (Stream Deck+) knobs: turn = adjust +/- step, press = sync.
		for (const p of this.params) {
			const step = p.step ?? (p.max <= 15 ? 1 : this.knobStep())
			presets[`knob_${p.id}`] = {
				type: 'button',
				category: `${p.group}`,
				name: `${p.name} (knob)`,
				options: { rotaryActions: true },
				style: { text: p.name, size: 'auto', color: WHITE, bgcolor: BLUE, png64: KNOB_RING_PNG },
				steps: [
					{
						down: [{ actionId: 'poll_now', options: {} }],
						up: [],
						rotate_right: [{ actionId: 'adjust', options: { param: p.id, step } }],
						rotate_left: [{ actionId: 'adjust', options: { param: p.id, step: -step } }],
					},
				],
				feedbacks: [{ feedbackId: 'knob_value', options: { param: p.id } }],
			}
		}
		presets['wb_kelvin_measure'] = btn('White Balance', 'WB Kelvin Measure', 'WB Measure\\n--', 'dct_wb_temp_measure_now', {}, [
			{ feedbackId: 'wb_measure_display', options: {} },
		])
		presets['audio_enable_toggle'] = btn('Audio', 'Audio: Toggle On/Off', 'Audio\\n--', 'dct_audio_enable_toggle', {}, [
			{ feedbackId: 'dct_audio_enable_display', options: {} },
		])
		presets['sdi_range_toggle'] = btn('System', 'SDI: Toggle Legal/Full', 'SDI\\n--', 'dct_sdi_range_toggle', {}, [
			{ feedbackId: 'dct_sdi_range_display', options: {} },
		])
		presets['timecode_hold_toggle'] = btn('System', 'Timecode: Toggle Run/Hold', 'TC\\n--', 'dct_timecode_hold_toggle', {}, [
			{ feedbackId: 'dct_timecode_hold_display', options: {} },
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
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: Object.values(mapObj)[0], choices: Object.values(mapObj).map((v) => ({ id: v, label: v })) }],
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
					{ type: 'dropdown', id: 'param', label: 'Parameter', default: this.params[0]?.id, choices: this.params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })) },
				],
				callback: (fb) => {
					const p = this.paramById?.[fb.options.param]
					if (!p) return {}
					const v = this.state[p.varId]
					const bar = progressBar(Number(v), p.min, p.max)
					return { text: `${p.name}\\n${v ?? '--'}\\n${bar}`, size: 'auto' }
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
					return { text: `Audio\\n${on ? 'ON' : 'OFF'}`, size: 'auto', bgcolor: on ? LIGHT_CYAN : DARK_CYAN, color: WHITE }
				},
			},
			dct_sdi_range_display: {
				type: 'advanced',
				name: 'SDI Range toggle (display)',
				options: [],
				callback: () => {
					const full = this.state.dct_sdi_range === 'Full'
					return { text: `SDI\\n${full ? 'FULL' : 'LEGAL'}`, size: 'auto', bgcolor: full ? LIGHT_BLUE : BLUE, color: WHITE }
				},
			},
			dct_timecode_hold_display: {
				type: 'advanced',
				name: 'Timecode toggle (display)',
				options: [],
				callback: () => {
					const on = this.state.dct_timecode_hold === 'Run'
					return { text: `TC\\n${on ? 'RUN' : 'HOLD'}`, size: 'auto', bgcolor: on ? LIGHT_GRAY : DARK_GRAY, color: WHITE }
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
		this.pollBatch(Object.entries(INQUIRIES).filter(([id]) => !NO_POLL_INQUIRY_IDS.has(id)).map(([, q]) => q))
	}

	// The recurring background cycle (startPolling()'s setInterval). Skips
	// both NO_POLL_INQUIRY_IDS and the `once`-tagged startup-only tier
	// (calibration/setup-style values that don't change on their own during
	// a live session) -- only the "live" tier needs repeated polling, which
	// keeps every cycle shorter than a full pollOnce() would be.
	pollLiveOnce() {
		this.pollBatch(Object.entries(INQUIRIES).filter(([id, q]) => !NO_POLL_INQUIRY_IDS.has(id) && !q.once).map(([, q]) => q))
	}

	// Fired once per successful (re)connection (see initSerial()/initTCP())
	// and by the "System: Poll startup values now" action -- refreshes just
	// the `once`-tagged tier pollLiveOnce() otherwise never touches, in case
	// it changed while disconnected (another controller, a reboot, etc.).
	pollStartupOnce() {
		this.pollBatch(Object.values(INQUIRIES).filter((q) => q.once))
	}

	// --- lifecycle ---------------------------------------------------------
	getConfigFields() {
		return [
			{ type: 'static-text', id: 'info', width: 12, label: 'DCT VISCA', value: 'Raw VISCA over TCP or serial (RS-485/RS-232). For serial, run Companion on the machine wired to the camera.' },
			{ type: 'dropdown', id: 'conn', label: 'Connection', width: 4, default: 'tcp', choices: [{ id: 'tcp', label: 'TCP' }, { id: 'serial', label: 'Serial (COM)' }] },
			{ type: 'textinput', id: 'host', label: 'Target IP', width: 5, default: '127.0.0.1', regex: Regex.IP, isVisible: (c) => c.conn !== 'serial' },
			{ type: 'number', id: 'port', label: 'TCP port', width: 3, default: 4000, min: 1, max: 65535, isVisible: (c) => c.conn !== 'serial' },
			{ type: 'textinput', id: 'serialPort', label: 'Serial port (e.g. COM3 or /dev/ttyUSB0)', width: 5, default: 'COM3', isVisible: (c) => c.conn === 'serial' },
			{ type: 'number', id: 'baud', label: 'Baud', width: 3, default: 115200, min: 300, max: 3000000, isVisible: (c) => c.conn === 'serial' },
			{ type: 'number', id: 'address', label: 'Camera address (1-7)', width: 2, default: 1, min: 1, max: 7 },
			{ type: 'number', id: 'pollInterval', label: 'Poll ms (0=off)', width: 2, default: 0, min: 0, max: 60000 },
			{ type: 'number', id: 'knobStep', label: 'Knob step (0-255 params)', width: 3, default: 4, min: 1, max: 128 },
		]
	}

	async configUpdated(config) {
		const prev = this.config
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
		this.stopPolling()
		if (this.inflight?.timer) clearTimeout(this.inflight.timer)
		if (this.socket) this.socket.destroy()
	}
}

runEntrypoint(DctViscaInstance, [])
