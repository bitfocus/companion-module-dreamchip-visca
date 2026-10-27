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
import { COMMANDS, INQUIRIES, TERMINATOR } from '../src/commands.js'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout
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
	sockets = new Set()

	async listen() {
		this.server = net.createServer((sock) => {
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

// Send-only mode (Poll ms 0), startup poll done, camera log empty.
async function sendOnly() {
	const camera = new FakeCamera()
	await camera.listen()
	const inst = await connect(camera, { pollInterval: 0 })
	await waitFor('Ok', () => statuses().includes('ok'))
	await settled(inst)
	return { camera, inst }
}

// Press a generic enum button and return the frames the camera saw, once at
// least `min` arrived and the module has been quiet for a moment.
async function press(camera, inst, id, choice, min) {
	camera.received.length = 0
	inst.actions[id].callback({ options: { choice } })
	await waitFor(`${id} frames`, () => camera.received.length >= min)
	await sleep(50) // anything else the button would send follows at once
	await waitFor('an idle queue', () => !inst.inflight && inst.queue.length === 0)
	return [...camera.received]
}

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
