import { InstanceBase, InstanceStatus, Regex, TCPHelper, runEntrypoint, combineRgb } from '@companion-module/base'
import { COMMANDS, INQUIRIES, ENUM, SYSTEM, RUD, TERMINATOR, encodeNibbles, decodeReply, buildFrame } from './commands.js'

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()
const GREEN = combineRgb(0, 102, 0)
const BLUE = combineRgb(0, 51, 102)
const WHITE = combineRgb(255, 255, 255)

class DctViscaInstance extends InstanceBase {
	async init(config) {
		this.config = config
		this.state = {} // decoded inquiry values by varId (for feedbacks)
		this.queue = [] // { frame, onReply, timer }
		this.inflight = null
		this.rxbuf = Buffer.alloc(0)

		this.setupActions()
		this.setupFeedbacks()
		this.setupVariables()
		this.setupPresets()
		this.initTCP()
		this.startPolling()
	}

	// --- transport ---------------------------------------------------------
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
		this.socket.on('connect', () => this.pump())
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

	// --- actions -----------------------------------------------------------
	setupActions() {
		const actions = {}
		for (const [id, c] of Object.entries(COMMANDS)) {
			const a = { name: `${c.group}: ${c.name}`, options: [] }
			if (c.kind === 'enum') {
				const ids = Object.keys(c.choices)
				a.options = [{ type: 'dropdown', id: 'choice', label: c.name, default: ids[0], choices: ids.map((x) => ({ id: x, label: x })) }]
				a.callback = (ev) => this.send(c.choices[ev.options.choice])
			} else if (c.kind === 'rud') {
				a.options = [{ type: 'dropdown', id: 'choice', label: 'Action', default: 'up', choices: Object.keys(RUD).map((x) => ({ id: x, label: x })) }]
				a.callback = (ev) => this.send([0x01, 0x04, c.func, RUD[ev.options.choice]])
			} else if (c.kind === 'direct') {
				const max = (1 << (4 * c.nibbles)) - 1
				a.options = [{ type: 'number', id: 'value', label: `Value (0-${max})`, default: 0, min: 0, max }]
				a.callback = (ev) => this.send([...c.prefix, ...encodeNibbles(Number(ev.options.value) & max, c.nibbles)])
			} else if (c.kind === 'fixed') {
				a.callback = () => this.send(c.bytes)
			} else if (c.kind === 'video') {
				const modes = Object.keys(SYSTEM)
				a.options = [{ type: 'dropdown', id: 'mode', label: 'Video mode', default: modes[0], choices: modes.map((m) => ({ id: m, label: `Mode ${m}` })) }]
				a.callback = (ev) => {
					const [b2, b3] = SYSTEM[ev.options.mode]
					this.send([0x01, 0x04, 0x24, 0x00, 0x00, b2, b3])
				}
			}
			actions[id] = a
		}
		actions['poll_now'] = { name: 'System: Poll inquiries now', options: [], callback: () => this.pollOnce() }
		this.setActionDefinitions(actions)
	}

	// --- presets -----------------------------------------------------------
	setupPresets() {
		const presets = {}
		const btn = (category, name, text, actionId, options) => ({
			type: 'button',
			category,
			name,
			style: { text, size: 'auto', color: WHITE, bgcolor: BLUE },
			steps: [{ down: [{ actionId, options }], up: [] }],
			feedbacks: [],
		})
		for (const [id, c] of Object.entries(COMMANDS)) {
			if (c.kind === 'enum') {
				for (const choice of Object.keys(c.choices)) {
					presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
				}
			} else if (c.kind === 'rud') {
				for (const choice of Object.keys(RUD)) {
					presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
				}
			} else if (c.kind === 'fixed') {
				presets[id] = btn(c.group, c.name, c.name.replace(/ /g, '\\n'), id, {})
			}
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
			connected: {
				type: 'boolean',
				name: 'Connection OK',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [],
				callback: () => this.socket?.isConnected === true,
			},
		})
	}

	// --- inquiry polling ---------------------------------------------------
	startPolling() {
		this.stopPolling()
		const ms = Number(this.config?.pollInterval)
		if (ms > 0) this.pollTimer = setInterval(() => this.pollOnce(), ms)
	}
	stopPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
	}

	pollOnce() {
		if (!this.socket?.isConnected) return
		const addr = this.config?.address || 1
		for (const q of Object.values(INQUIRIES)) {
			this.enqueue(buildFrame(addr, q.payload), (reply, kind) => {
				let value = 'n/a'
				if (kind === 0x50) value = decodeReply(q.decode, reply.subarray(2, reply.length - 1))
				this.state[q.varId] = value
				this.setVariableValues({ [q.varId]: value })
				if (q.varId === 'ae_mode') this.checkFeedbacks('ae_mode_is')
				if (q.varId === 'wb_mode') this.checkFeedbacks('wb_mode_is')
			})
		}
	}

	// --- lifecycle ---------------------------------------------------------
	getConfigFields() {
		return [
			{ type: 'static-text', id: 'info', width: 12, label: 'DCT VISCA', value: 'Raw VISCA over TCP. Set the camera IP and VISCA TCP port (default 4000).' },
			{ type: 'textinput', id: 'host', label: 'Target IP', width: 5, default: '127.0.0.1', regex: Regex.IP },
			{ type: 'number', id: 'port', label: 'TCP port', width: 3, default: 4000, min: 1, max: 65535 },
			{ type: 'number', id: 'address', label: 'Camera address (1-7)', width: 2, default: 1, min: 1, max: 7 },
			{ type: 'number', id: 'pollInterval', label: 'Poll ms (0=off)', width: 2, default: 0, min: 0, max: 60000 },
		]
	}

	async configUpdated(config) {
		this.config = config
		this.initTCP()
		this.startPolling()
	}

	async destroy() {
		this.stopPolling()
		if (this.inflight?.timer) clearTimeout(this.inflight.timer)
		if (this.socket) this.socket.destroy()
	}
}

runEntrypoint(DctViscaInstance, [])
