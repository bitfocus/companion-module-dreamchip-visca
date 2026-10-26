// Standalone transport + decode smoke test — no Companion needed.
// Connects raw-TCP (default 127.0.0.1:4000) to a VISCA target,
// sends a few benign SET commands, then every INQUIRY and prints the decoded
// value. Proves the exact Companion -> camera path and the decode logic.
//
//   node tools/smoke.mjs [host] [port]
//
import net from 'node:net'
import { INQUIRIES, buildFrame, decodeReply, TERMINATOR } from '../src/commands.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 4000)
const addr = 1
const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()

// Benign SET samples (no-ops / safe on the sim; avoids settings reset & power).
const SETS = [
	['AE Auto', [0x01, 0x04, 0x39, 0x00]],
	['WB Auto', [0x01, 0x04, 0x35, 0x00]],
	['Red Gain Up', [0x01, 0x04, 0x03, 0x02]],
]

function transceive(sock, frame, timeoutMs = 1200) {
	return new Promise((resolve) => {
		let buf = Buffer.alloc(0)
		const cleanup = () => {
			sock.off('data', onData)
			clearTimeout(t)
		}
		const onData = (d) => {
			buf = Buffer.concat([buf, d])
			let idx
			while ((idx = buf.indexOf(TERMINATOR)) >= 0) {
				const f = buf.subarray(0, idx + 1)
				buf = buf.subarray(idx + 1)
				if (f.length >= 2 && (f[1] & 0xf0) !== 0x40) {
					cleanup()
					resolve(f)
					return
				}
			}
		}
		const t = setTimeout(() => {
			cleanup()
			resolve(null)
		}, timeoutMs)
		sock.on('data', onData)
		sock.write(Buffer.from(frame))
	})
}

const sock = net.createConnection({ host, port }, run)
sock.on('error', (e) => {
	console.error(`connect failed (${host}:${port}): ${e.message}`)
	console.error('Is a VISCA target reachable on this host/port?')
	process.exit(1)
})

async function run() {
	console.log(`connected ${host}:${port}\n--- SET commands ---`)
	for (const [name, payload] of SETS) {
		const f = buildFrame(addr, payload)
		const r = await transceive(sock, f)
		console.log(`${name.padEnd(14)} TX ${hex(f)}   RX ${r ? hex(r) : '(none)'}`)
	}
	console.log('\n--- INQUIRIES (decoded) ---')
	for (const q of Object.values(INQUIRIES)) {
		const r = await transceive(sock, buildFrame(addr, q.payload))
		let dec = '(no reply)'
		if (r && (r[1] & 0xf0) === 0x50) dec = decodeReply(q.decode, r.subarray(2, r.length - 1))
		else if (r && (r[1] & 0xf0) === 0x60) dec = 'ERROR (not executable)'
		console.log(`${q.varId.padEnd(13)} ${dec}`)
	}
	sock.end(() => process.exit(0))
}
