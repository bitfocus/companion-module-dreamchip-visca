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
import { INQUIRIES, TERMINATOR } from '../src/commands.js'

const realSetTimeout = setTimeout
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

async function waitFor(what, cond, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	while (!cond()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
		await sleep(5)
	}
}

const hex = (b) => Buffer.from(b).toString('hex')

// Answers `version` like an Atom Two (vendor 0x0020, model 0x0000, ROM
// 0x0401, 2 sockets) and every other inquiry with a VISCA error reply, which
// is just as terminal as a value. With `hold` set it receives requests but
// stays silent until release().
class FakeCamera {
	received = [] // hex of every frame the module sent
	held = []
	hold = false
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
					if (this.hold) this.held.push({ sock, frame })
					else this.reply(sock, frame)
				}
			})
		})
		await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
		this.port = this.server.address().port
	}

	reply(sock, frame) {
		const isVersion = hex(frame) === hex(Buffer.from([0x81, ...INQUIRIES.version.payload, TERMINATOR]))
		const out = isVersion
			? [0x90, 0x50, 0x00, 0x20, 0x00, 0x00, 0x04, 0x01, 0x02, TERMINATOR]
			: [0x90, 0x60, 0x02, TERMINATOR]
		sock.write(Buffer.from(out))
	}

	release() {
		this.hold = false
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

async function connect(camera) {
	sent = []
	const inst = new DctViscaInstance({ _isInstanceBaseProps: true, id: 'test', upgradeScripts: [] })
	inst.scanAndProbeSerialPorts = async () => {} // would enumerate real serial devices
	await inst.init({ conn: 'tcp', host: '127.0.0.1', port: camera.port, address: 1, pollInterval: 0, knobStep: 4 })
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
