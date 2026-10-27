// Integration tests for main.js: the real DctViscaInstance (on the real
// @companion-module/base) talks to a fake VISCA camera over loopback TCP. No
// Companion, no hardware, no serial port.
//   node --test
//
// InstanceBase reports everything to Companion through process.send(), so the
// tests stub that one function and read back what Companion would have seen
// (status changes, variable values).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { DctViscaInstance } from '../src/main.js'
import { COMMANDS, INQUIRIES, TERMINATOR, encodeNibbles } from '../src/commands.js'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout
const realSetInterval = setInterval
const realClearInterval = clearInterval
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

async function waitFor(what, cond, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	while (!cond()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
		await sleep(5)
	}
}

// The module waits this long for a terminal reply before giving up on a request.
// Tests drive it by hand instead of waiting for real time.
const REQUEST_TIMEOUT_MS = 1500
function fakeRequestTimeouts() {
	const pending = new Set()
	const others = new Set() // the module's other timers, e.g. the poll batch's safety net
	globalThis.setTimeout = (fn, ms, ...args) => {
		if (ms !== REQUEST_TIMEOUT_MS) {
			const timer = realSetTimeout(fn, ms, ...args)
			others.add(timer)
			return timer
		}
		const timer = { fn: () => fn(...args) }
		pending.add(timer)
		return timer
	}
	globalThis.clearTimeout = (timer) => (pending.delete(timer) ? undefined : realClearTimeout(timer))
	return {
		expire() {
			for (const timer of [...pending]) {
				pending.delete(timer)
				timer.fn()
			}
		},
		restore() {
			// a batch that never completes would otherwise keep Node alive for a minute
			for (const timer of others) realClearTimeout(timer)
			globalThis.setTimeout = realSetTimeout
			globalThis.clearTimeout = realClearTimeout
		},
	}
}

// Same for the live poll's setInterval (the 5 s serial-port scan keeps its real timer).
function fakePollInterval(ms) {
	let timer
	globalThis.setInterval = (fn, every, ...args) => {
		if (every !== ms) return realSetInterval(fn, every, ...args)
		timer = { fn: () => fn(...args) }
		return timer
	}
	globalThis.clearInterval = (t) => (t === timer ? (timer = undefined) : realClearInterval(t))
	return {
		tick: () => timer.fn(),
		restore() {
			globalThis.setInterval = realSetInterval
			globalThis.clearInterval = realClearInterval
		},
	}
}

const hex = (b) => Buffer.from(b).toString('hex')

// Answers `version` like an Atom Two (vendor 0x0020, model 0x0000, ROM
// 0x0401, 2 sockets), set commands with ACK + Completion, any frame listed in
// `replies` (hex -> reply bytes) as given, and every other inquiry with a VISCA
// error reply, which is just as terminal as a value. With `hold` set it
// receives requests but stays silent until release().
class FakeCamera {
	received = [] // hex of every frame the module sent
	held = []
	hold = false
	answer = Infinity // requests beyond this many are held back
	replies = {}
	connections = 0 // sockets accepted so far
	sockets = new Set()

	async listen() {
		this.server = net.createServer((sock) => {
			this.connections++
			this.sockets.add(sock)
			sock.on('close', () => this.sockets.delete(sock))
			sock.on('error', () => {})
			let buf = Buffer.alloc(0)
			sock.on('data', (chunk) => {
				buf = Buffer.concat([buf, chunk])
				let idx
				while ((idx = buf.indexOf(TERMINATOR)) >= 0) {
					const frame = buf.subarray(0, idx + 1)
					buf = buf.subarray(idx + 1)
					this.received.push(hex(frame))
					if (this.hold || this.received.length > this.answer) this.held.push({ sock, frame })
					else this.reply(sock, frame)
				}
			})
		})
		await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
		this.port = this.server.address().port
	}

	reply(sock, frame) {
		const isVersion = hex(frame) === hex(Buffer.from([0x81, ...INQUIRIES.version.payload, TERMINATOR]))
		let out = [0x90, 0x60, 0x02, TERMINATOR]
		if (isVersion) out = [0x90, 0x50, 0x00, 0x20, 0x00, 0x00, 0x04, 0x01, 0x02, TERMINATOR]
		else if (this.replies[hex(frame)]) out = this.replies[hex(frame)]
		else if (frame[1] === 0x01) out = [0x90, 0x41, TERMINATOR, 0x90, 0x51, TERMINATOR]
		sock.write(Buffer.from(out))
	}

	release() {
		this.hold = false
		this.answer = Infinity
		for (const { sock, frame } of this.held.splice(0)) this.reply(sock, frame)
	}

	async close() {
		for (const sock of this.sockets) sock.destroy()
		await new Promise((resolve) => this.server.close(resolve))
	}
}

// What Companion would have seen: process.send() messages, payloads are EJSON strings.
let sent
const realSend = process.send
before(() => {
	process.send = (msg) => void sent.push(msg)
})
after(() => {
	process.send = realSend
	process.removeAllListeners('message') // InstanceBase subscribes in its constructor
})

const statuses = () => sent.filter((m) => m.name === 'set-status').map((m) => JSON.parse(m.payload).status)

function variables() {
	const vars = {}
	for (const m of sent.filter((m) => m.name === 'setVariableValues'))
		for (const { id, value } of JSON.parse(m.payload).newValues) vars[id] = value
	return vars
}

async function connect(camera, config = {}) {
	sent = []
	const inst = new DctViscaInstance({ _isInstanceBaseProps: true, id: 'test', upgradeScripts: [] })
	inst.scanAndProbeSerialPorts = async () => {} // would enumerate real serial devices
	inst.setActionDefinitions = (actions) => (inst.actions = actions) // keep the callbacks, Companion would call them
	await inst.init({
		conn: 'tcp',
		host: '127.0.0.1',
		port: camera.port,
		address: 1,
		pollInterval: 0,
		knobStep: 4,
		...config,
	})
	return inst
}

// Let the startup batch run to its end: it holds a safety timer until then.
const settled = (inst) => waitFor('startup poll to finish', () => !inst.pollBusy && !inst.inflight)

test('an open TCP link stays Connecting until the camera sends a real reply', async () => {
	const camera = new FakeCamera()
	camera.hold = true
	await camera.listen()
	const inst = await connect(camera)
	try {
		// The link is up and the version request went out, but nothing answered.
		await waitFor('the first request to reach the camera', () => camera.received.length > 0)
		await sleep(100)
		assert.ok(statuses().includes('connecting'), `statuses: ${statuses()}`)
		assert.ok(!statuses().includes('ok'), `must not be Ok without a reply, statuses: ${statuses()}`)

		camera.release()
		await waitFor('Ok', () => statuses().includes('ok'))
		await settled(inst)
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('startup poll queries exactly the once-tier inquiries and learns the camera model', async () => {
	const camera = new FakeCamera()
	await camera.listen()
	const inst = await connect(camera)
	try {
		await waitFor('Ok', () => statuses().includes('ok'))
		await settled(inst)

		const once = Object.values(INQUIRIES).filter((q) => q.once)
		const expected = once.map((q) => hex(Buffer.from([0x81, ...q.payload, TERMINATOR])))
		assert.deepEqual([...camera.received].sort(), expected.sort())

		assert.equal(inst.cameraModel, 'atom-two')
		const vars = variables()
		assert.equal(vars.version, 'vendor=0x0020 model=0x0000 version=0x0401 sockets=2')
		for (const q of once.filter((q) => q.varId !== 'version'))
			assert.equal(vars[q.varId], 'n/a', `${q.varId} after an error reply`)
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('two unanswered requests downgrade to UnknownWarning, and a reply earns Ok back', async () => {
	const camera = new FakeCamera()
	camera.answer = 1 // the first request is answered, then the camera goes silent
	await camera.listen()
	const timeouts = fakeRequestTimeouts()
	const inst = await connect(camera)
	try {
		await waitFor('Ok', () => statuses().includes('ok'))
		await waitFor('the second request to reach the camera', () => camera.received.length === 2)

		timeouts.expire()
		await waitFor('the third request to reach the camera', () => camera.received.length === 3)
		assert.ok(!statuses().includes('unknown_warning'), 'one timeout is not enough')

		timeouts.expire()
		await waitFor('the warning', () => statuses().includes('unknown_warning'))
		const last = sent.findLast((m) => m.name === 'set-status')
		assert.deepEqual(JSON.parse(last.payload), { status: 'unknown_warning', message: 'No response from camera' })

		camera.release()
		await waitFor('Ok again', () => statuses().at(-1) === 'ok')
	} finally {
		await inst.destroy()
		timeouts.restore()
		await camera.close()
	}
})

// AE Toggle writes its new state optimistically. If the SET errored or was
// refused nothing would correct that, so with polling off the module reads the
// mode back right away; with polling on the next poll cycle does that instead.
const frameHex = (payload) => hex(Buffer.from([0x81, ...payload, TERMINATOR]))
const SET_AE_MANUAL = frameHex(COMMANDS.cam_ae.choices.Manual)
const ASK_AE_MODE = frameHex(INQUIRIES.ae_mode.payload)

async function toggleAe(pollInterval) {
	const camera = new FakeCamera()
	// the camera is in Auto, whatever the optimistic toggle assumes
	camera.replies[ASK_AE_MODE] = [0x90, 0x50, 0x00, TERMINATOR]
	await camera.listen()
	const inst = await connect(camera, { pollInterval })
	await waitFor('Ok', () => statuses().includes('ok'))
	await settled(inst)
	camera.received.length = 0
	inst.actions.cam_ae_toggle.callback({ options: {} })
	return { camera, inst }
}

test('Poll ms 0: a toggle reads the real state back right after sending', async () => {
	const { camera, inst } = await toggleAe(0)
	try {
		assert.equal(inst.pollTimer, undefined, 'send-only mode runs no poll timer')
		await waitFor('the confirming inquiry', () => camera.received.length === 2)
		assert.deepEqual(camera.received, [SET_AE_MANUAL, ASK_AE_MODE])
		await waitFor('the camera state to replace the optimistic one', () => variables().ae_mode === 'FullAuto')
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('polling on: a toggle only sends the command and leaves confirming to the poll', async () => {
	const { camera, inst } = await toggleAe(2000)
	try {
		await waitFor('the command', () => camera.received.length >= 1)
		await sleep(100) // an inquiry would follow at once
		assert.deepEqual(camera.received, [SET_AE_MANUAL])
		assert.equal(variables().ae_mode, 'Manual', 'the optimistic state stands until the next poll')
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

// The generic per-choice buttons are generated from COMMANDS. With polling off
// the ones whose toggle button shows live state must read it back too, and the
// rest must not: a stray inquiry would just slow the serial queue down.
const CONFIRMING_ENUM_BUTTONS = [
	// [COMMANDS id, choice, INQUIRIES id it reads back]
	['cam_ae', 'Manual', 'ae_mode'],
	['cam_wb', 'Manual', 'wb_mode'],
	['dct_sdi_range', 'Full', 'dct_sdi_range'],
	['dct_audio_enable', 'On', 'dct_audio_enable'],
	['dct_timecode_hold', 'Hold', 'dct_timecode_hold'],
]
const PLAIN_ENUM_BUTTONS = [
	['cam_flicker', '60Hz'],
	['cam_gamma', 'HLG'],
	['dct_cnr_auto', 'On'],
	['dct_auto_save', 'On'],
]

// Startup poll done (send-only mode unless a poll interval is given).
async function sendOnly(pollInterval = 0) {
	const camera = new FakeCamera()
	await camera.listen()
	const inst = await connect(camera, { pollInterval })
	await waitFor('Ok', () => statuses().includes('ok'))
	await settled(inst)
	return { camera, inst }
}

// Run `act` and return the frames the camera saw: once at least `min` arrived
// and the module has been quiet for a moment (anything else the action would
// send follows at once).
async function framesAfter(camera, inst, min, act) {
	camera.received.length = 0
	act()
	await waitFor('the expected frames', () => camera.received.length >= min)
	await sleep(50)
	await waitFor('an idle queue', () => !inst.inflight && inst.queue.length === 0)
	return [...camera.received]
}

// Press a generic enum button.
const press = (camera, inst, id, choice, min) =>
	framesAfter(camera, inst, min, () => inst.actions[id].callback({ options: { choice } }))

test('Poll ms 0: enum buttons with a live-state toggle read the state back', async () => {
	const { camera, inst } = await sendOnly()
	try {
		for (const [id, choice, inquiry] of CONFIRMING_ENUM_BUTTONS) {
			const frames = await press(camera, inst, id, choice, 2)
			assert.deepEqual(frames, [frameHex(COMMANDS[id].choices[choice]), frameHex(INQUIRIES[inquiry].payload)], id)
		}
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('Poll ms 0: the other enum buttons only send their command', async () => {
	const { camera, inst } = await sendOnly()
	try {
		for (const [id, choice] of PLAIN_ENUM_BUTTONS) {
			const frames = await press(camera, inst, id, choice, 1)
			assert.deepEqual(frames, [frameHex(COMMANDS[id].choices[choice])], id)
		}
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

// Green Gain is an enum button (Reset/Up/Down) that changes the real value
// without saying where it landed, so it always reads the value back and resyncs
// the knob from the answer, whatever the poll mode. Changing a gain can also
// flip WB to Manual on older firmware, so with polling off WB is re-read too.
const GGAIN_RAW = 1234 // what the camera says its green gain is now
const ASK_GGAIN = frameHex(INQUIRIES.dct_ggain.payload)
const ASK_WB_MODE = frameHex(INQUIRIES.wb_mode.payload)
const GGAIN_REPLY = [0x90, 0x50, ...encodeNibbles(GGAIN_RAW, 3), TERMINATOR]

test('Green Gain buttons read the value back and resync the knob; Poll ms 0 also re-reads WB', async () => {
	const { camera, inst } = await sendOnly(0)
	try {
		camera.replies[ASK_GGAIN] = GGAIN_REPLY
		for (const choice of ['Reset', 'Up', 'Down']) {
			inst.knob.dct_ggain = 0
			const frames = await press(camera, inst, 'dct_ggain', choice, 3)
			assert.deepEqual(frames, [frameHex(COMMANDS.dct_ggain.choices[choice]), ASK_GGAIN, ASK_WB_MODE], choice)
			assert.equal(inst.knob.dct_ggain, GGAIN_RAW, `${choice}: knob resynced from the reply`)
		}
		assert.equal(variables().dct_ggain, String(GGAIN_RAW))
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('Green Gain buttons with polling on still read the value back, but leave WB to the poll', async () => {
	const { camera, inst } = await sendOnly(2000)
	try {
		camera.replies[ASK_GGAIN] = GGAIN_REPLY
		inst.knob.dct_ggain = 0
		// a recent knob turn shields the knob from background polls; this deliberate read-back must win anyway
		inst.knobLockUntil.dct_ggain = Date.now() + 60000
		const frames = await press(camera, inst, 'dct_ggain', 'Up', 2)
		assert.deepEqual(frames, [frameHex(COMMANDS.dct_ggain.choices.Up), ASK_GGAIN])
		assert.equal(inst.knob.dct_ggain, GGAIN_RAW)
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

// --- knobs ------------------------------------------------------------------
// adjustParam() is what every rotary-knob turn and the relative Adjust action
// end up in: clamp, send an absolute direct SET, write the new value into
// knob/state/variable and (re)start the knob's lock against stale poll replies.

const directFrame = (id, value) => frameHex([...COMMANDS[id].prefix, ...encodeNibbles(value, COMMANDS[id].nibbles)])
const turn = (camera, inst, id, delta) => framesAfter(camera, inst, 1, () => inst.adjustParam(id, delta))
const valueReply = (raw, nibbles) => Buffer.from([0x90, 0x50, ...encodeNibbles(raw, nibbles), TERMINATOR])

test('a knob turn sends the direct value, shows it at once and locks the knob', async () => {
	const { camera, inst } = await sendOnly(2000)
	try {
		assert.equal(inst.readValue('dct_wb_temp'), 0, 'nothing known yet reads as 0')
		inst.state.dct_wb_temp = '5600'
		assert.equal(inst.readValue('dct_wb_temp'), 5600, 'falls back to the polled value')
		inst.knob.dct_wb_temp = 5600

		// 5700 K = 0x1644 on four nibbles
		const frames = await turn(camera, inst, 'dct_wb_temp', 100)
		assert.deepEqual(frames, ['81017e010b01060404ff'])
		assert.equal(variables().dct_wb_temp, '5700')
		assert.equal(inst.knob.dct_wb_temp, 5700)
		assert.ok(inst.knobLockUntil.dct_wb_temp > Date.now(), 'the knob is locked against background polls')

		// signed values go out as two's complement: -4 on three nibbles is 0xFFC
		inst.knob.dct_black_master = 0
		assert.deepEqual(await turn(camera, inst, 'dct_black_master', -4), ['81017e01030f0f0cff'])
		assert.equal(variables().dct_black_master, '-4')
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('a knob turn stops at the parameter range, and at the per-model maximum', async () => {
	const { camera, inst } = await sendOnly(2000)
	try {
		const cases = [
			// [param, current, delta, expected]
			['dct_wb_temp', 9990, 100, 10000],
			['dct_wb_temp', 2250, -100, 2200],
			['dct_black_master', 2040, 100, 2047],
			['dct_filter_denoise', 6, 10, 16], // Atom Two: 0-255
		]
		for (const [id, cur, delta, expected] of cases) {
			inst.knob[id] = cur
			assert.deepEqual(await turn(camera, inst, id, delta), [directFrame(id, expected)], `${id} ${cur}${delta}`)
			assert.equal(inst.knob[id], expected, `${id} ${cur}${delta}`)
		}

		inst.cameraModel = 'atom-two-hdr' // Filter Denoise only goes to 7 there
		inst.knob.dct_filter_denoise = 6
		assert.deepEqual(await turn(camera, inst, 'dct_filter_denoise', 10), [directFrame('dct_filter_denoise', 7)])
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('a log-scaled knob steps by a percentage, with a floor at the low end', async () => {
	const { camera, inst } = await sendOnly(2000)
	try {
		const cases = [
			// [current, delta, expected]; only the sign of delta counts
			[1000, 4, 1050], // +5%
			[1000, 100, 1050],
			[1000, -4, 952], // /1.05
			[10, 1, 14], // 5% would round to 11: the 4-unit minimum step wins
			[3, -1, 0], // never below 0
			[0, 1, 4], // from 0 the minimum step gets it going
		]
		for (const [cur, delta, expected] of cases) {
			inst.knob.gain = cur
			assert.deepEqual(
				await turn(camera, inst, 'cam_gain_direct', delta),
				[directFrame('cam_gain_direct', expected)],
				`${cur} ${delta}`,
			)
		}
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('a background poll reply cannot undo a knob turn, a deliberate read-back can', async () => {
	const { camera, inst } = await sendOnly(2000)
	try {
		inst.knob.rgain = 100
		await turn(camera, inst, 'cam_rgain_direct', 4)
		assert.equal(inst.knob.rgain, 104)

		// a poll request sent before the turn answers late with the old value
		inst.applyInquiryReply(INQUIRIES.rgain, valueReply(900, 3), 0x50)
		assert.equal(inst.knob.rgain, 104, 'locked: the stale reply must not stomp the knob')
		assert.equal(variables().rgain, '900', 'but the variable shows what the camera says')

		inst.applyInquiryReply(INQUIRIES.rgain, valueReply(700, 3), 0x50, { resyncKnob: true })
		assert.equal(inst.knob.rgain, 700, 'a deliberate read-back always wins')

		inst.knobLockUntil.rgain = Date.now() - 1 // the lock ran out
		inst.applyInquiryReply(INQUIRIES.rgain, valueReply(900, 3), 0x50)
		assert.equal(inst.knob.rgain, 900, 'unlocked: external changes are picked up again')
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('a knob turn that can flip AE or WB to Manual re-reads that mode only without polling', async () => {
	const off = await sendOnly(0)
	try {
		for (const [id, mode] of [
			['cam_rgain_direct', 'wb_mode'],
			['cam_gain_direct', 'ae_mode'],
		]) {
			const frames = await turn(off.camera, off.inst, id, 4)
			assert.equal(frames.length, 2, id)
			assert.equal(frames[1], frameHex(INQUIRIES[mode].payload), `${id} reads back ${mode}`)
		}
	} finally {
		await off.inst.destroy()
		await off.camera.close()
	}

	const on = await sendOnly(2000)
	try {
		assert.equal((await turn(on.camera, on.inst, 'cam_rgain_direct', 4)).length, 1)
	} finally {
		await on.inst.destroy()
		await on.camera.close()
	}
})

// --- poll cycles ------------------------------------------------------------
const NO_POLL = ['color_temp', 'dct_wb_temp_measure'] // never worth a round trip, or on-demand only
const GATED_ON_ATOM_TWO = ['dct_tm_mode', 'dct_tm_mode_preset']
const askFrames = (ids) => ids.map((id) => frameHex(INQUIRIES[id].payload)).sort()
const inquiryIds = (keep) =>
	Object.entries(INQUIRIES)
		.filter(([id, q]) => keep(id, q))
		.map(([id]) => id)

test('the live poll cycle asks only the live tier', async () => {
	const interval = fakePollInterval(2000)
	const { camera, inst } = await sendOnly(2000)
	try {
		const frames = await framesAfter(camera, inst, 1, () => interval.tick())
		const live = inquiryIds((id, q) => !q.once && !NO_POLL.includes(id) && !GATED_ON_ATOM_TWO.includes(id))
		assert.deepEqual([...frames].sort(), askFrames(live))
	} finally {
		await inst.destroy()
		interval.restore()
		await camera.close()
	}
})

test('a live poll cycle still running blocks the next one', async () => {
	const interval = fakePollInterval(2000)
	const { camera, inst } = await sendOnly(2000)
	try {
		camera.hold = true
		camera.received.length = 0
		interval.tick()
		await waitFor('the first inquiry', () => camera.received.length === 1)
		interval.tick() // the camera has not answered yet: a second cycle would only grow the backlog
		interval.tick()
		await sleep(50)
		assert.equal(camera.received.length, 1)

		camera.release()
		await settled(inst)
		const live = inquiryIds((id, q) => !q.once && !NO_POLL.includes(id) && !GATED_ON_ATOM_TWO.includes(id))
		assert.deepEqual([...camera.received].sort(), askFrames(live), 'exactly one cycle in the end')
	} finally {
		await inst.destroy()
		interval.restore()
		await camera.close()
	}
})

test('"Poll inquiries now" asks everything that can ever answer, startup tier included', async () => {
	const { camera, inst } = await sendOnly(0)
	try {
		const frames = await framesAfter(camera, inst, 1, () => inst.actions.poll_now.callback({ options: {} }))
		const all = inquiryIds((id) => !NO_POLL.includes(id) && !GATED_ON_ATOM_TWO.includes(id))
		assert.deepEqual([...frames].sort(), askFrames(all))
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

// --- configUpdated / destroy -------------------------------------------------
const saved = () => sent.filter((m) => m.name === 'saveConfig').map((m) => JSON.parse(m.payload).config)

test('configUpdated corrects values the editor only hints at, and saves the correction', async () => {
	const { camera, inst } = await sendOnly(0)
	try {
		const base = { ...inst.config }
		await inst.configUpdated({ ...base, knobStep: 0, pollInterval: 1999 }) // just under the 2 s floor
		assert.equal(inst.config.knobStep, 4)
		assert.equal(inst.config.pollInterval, 2000)
		assert.equal(saved().length, 2, 'one save per correction')
		assert.equal(saved().at(-1).pollInterval, 2000)

		const before = saved().length
		await inst.configUpdated({ ...base, knobStep: 8, pollInterval: 0 }) // 0 = off is valid
		assert.equal(inst.config.pollInterval, 0)
		assert.equal(inst.config.knobStep, 8)
		await inst.configUpdated({ ...base, pollInterval: 2000 }) // exactly the floor
		assert.equal(inst.config.pollInterval, 2000)
		assert.equal(saved().length, before, 'valid values are left alone')
	} finally {
		await inst.destroy()
		await camera.close()
	}
})

test('configUpdated reconnects only when a connection setting changed', async () => {
	const { camera, inst } = await sendOnly(0)
	const other = new FakeCamera()
	await other.listen()
	try {
		const socket = inst.socket
		await inst.configUpdated({ ...inst.config, pollInterval: 3000, knobStep: 8, address: 2 })
		assert.equal(inst.socket, socket, 'Poll ms, knob step and address do not touch the link')
		assert.equal(camera.connections, 1)

		await inst.configUpdated({ ...inst.config, port: other.port })
		assert.notEqual(inst.socket, socket, 'a new port is a new connection')
		await waitFor('the new camera to be asked', () => other.received.length > 0)
		await settled(inst) // its startup poll holds a safety timer until it ends
		assert.equal(camera.connections, 1)
	} finally {
		await inst.destroy()
		await camera.close()
		await other.close()
	}
})

test('configUpdated and destroy start and stop the poll timer', async () => {
	const { camera, inst } = await sendOnly(0)
	try {
		assert.equal(inst.pollTimer, undefined)
		await inst.configUpdated({ ...inst.config, pollInterval: 2000 })
		assert.ok(inst.pollTimer, 'a poll interval starts the timer')
		await inst.configUpdated({ ...inst.config, pollInterval: 0 })
		assert.equal(inst.pollTimer, undefined, '0 stops it again')

		await inst.configUpdated({ ...inst.config, pollInterval: 2000 })
		await inst.destroy()
		assert.equal(inst.pollTimer, undefined)
		await waitFor('the link to close', () => camera.sockets.size === 0)
	} finally {
		await inst.destroy()
		await camera.close()
	}
})
