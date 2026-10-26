// Translate a pasted VISCA hex dump (as printed by this module's own debug
// log, e.g. "TX 81 09 7e 01 04 ff" / "RX 90 50 0f 0f ff") into both the
// Companion-side command name and its ProVideo console-command equivalent on
// the dct-phoenix-zephyr-bsp camera firmware.
//
//   node tools/visca-decode.mjs [file]      # defaults to stdin
//
// Bare hex lines (no "TX "/"RX " prefix) are also accepted; direction is then
// inferred from the frame's type/kind byte.
import { readFileSync } from 'node:fs'
import { COMMANDS, INQUIRIES, RUD, SYSTEM, SYSTEM_NAMES, TERMINATOR, decodeNibbles, decodeReply, toSigned } from '../src/commands.js'
import { PROVIDEO_NAMES } from './provideo-names.mjs'

const ERROR_CODES = {
	0x01: 'Message Length Error',
	0x02: 'Syntax Error',
	0x03: 'Command Buffer Full',
	0x04: 'Command Cancelled',
	0x05: 'No Socket',
	0x41: 'Command Not Executable',
}

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')

// --- input parsing -----------------------------------------------------
export function parseLines(text) {
	const out = []
	for (const raw of text.split('\n')) {
		const m = raw.match(/\b(TX|RX)\b/i)
		const dir = m ? m[1].toUpperCase() : null
		const rest = m ? raw.slice(m.index + m[0].length) : raw
		const hex = rest.match(/[0-9a-f]{2}/gi)
		// Require 3+ bytes (the shortest real VISCA frame is addr+kind+terminator)
		// so incidental hex-looking substrings elsewhere on the line (e.g. a CSV
		// header row's "Date"/"Source" containing "Da"/"ce") don't get mistaken
		// for a 2-byte frame.
		if (!hex || hex.length < 3) continue
		out.push({ dir, bytes: hex.map((h) => parseInt(h, 16)) })
	}
	return out
}

// --- frame matching (Companion side) ------------------------------------
// `payload` excludes the leading address byte and the trailing terminator.
export function matchCommand(payload) {
	for (const [id, c] of Object.entries(COMMANDS)) {
		if (c.kind === 'fixed' && eq(payload, c.bytes)) return { id, kind: 'fixed' }
		if (c.kind === 'enum') {
			for (const [choice, bytes] of Object.entries(c.choices)) {
				if (eq(payload, bytes)) return { id, kind: 'enum', choice, arg: bytes[bytes.length - 1] }
			}
		}
		if (c.kind === 'rud' && payload.length === 4 && eq(payload.slice(0, 3), [0x01, 0x04, c.func])) {
			const action = Object.keys(RUD).find((k) => RUD[k] === payload[3])
			if (action) return { id, kind: 'rud', action }
		}
		if (c.kind === 'direct' && payload.length === c.prefix.length + c.nibbles && eq(payload.slice(0, c.prefix.length), c.prefix)) {
			const raw = decodeNibbles(payload.slice(c.prefix.length))
			return { id, kind: 'direct', value: c.signed ? toSigned(raw, c.nibbles) : raw }
		}
		if (c.kind === 'video' && payload.length === 7 && eq(payload.slice(0, 5), [0x01, 0x04, 0x24, 0x00, 0x00])) {
			const [b2, b3] = payload.slice(5)
			const mode = Object.entries(SYSTEM).find(([, v]) => v[0] === b2 && v[1] === b3)?.[0]
			return { id, kind: 'video', mode: mode ?? `unknown (${b2},${b3})` }
		}
	}
	return null
}

export function matchInquiry(payload) {
	for (const [id, q] of Object.entries(INQUIRIES)) {
		if (eq(payload, q.payload)) return { id }
	}
	return null
}

function describeCompanion(m) {
	if (!m) return '(unrecognized frame)'
	if (m.kind === 'inquiry') return `${INQUIRIES[m.id].name} (inquiry)`
	const c = COMMANDS[m.id]
	if (m.kind === 'fixed') return c.name
	if (m.kind === 'enum') return `${c.name} = ${m.choice}`
	if (m.kind === 'rud') return `${c.name} ${m.action}`
	if (m.kind === 'direct') return `${c.name} = ${m.value}`
	if (m.kind === 'video') return `${c.name} = ${SYSTEM_NAMES[m.mode] ?? `Mode ${m.mode}`}`
	return c.name
}

// --- ProVideo-side translation -------------------------------------------
export function translate(m) {
	if (!m) return '(no ProVideo mapping known)'
	const p = PROVIDEO_NAMES[m.id]
	if (!p) return '(no ProVideo mapping known)'

	if (m.kind === 'rud') {
		if (!p.rud) return p.note ?? '(no ProVideo mapping known)'
		return p.rud[m.action] ?? `not implemented in current firmware (${m.action} unsupported)`
	}
	if (m.kind === 'enum') {
		if (p.choices) return p.choices[m.choice] ?? `not implemented in current firmware (${m.choice} unsupported)`
		if (p.cmd) return `${p.cmd} ${m.arg}`
		return p.note ?? '(no ProVideo mapping known)'
	}
	if (m.kind === 'direct') {
		if (!p.cmd) return p.note ?? '(no ProVideo mapping known)'
		return p.scaled ? `${p.cmd} <raw=${m.value}>  // ${p.note ?? 'firmware applies its own scaling (TODO stage 8) before this reaches the sensor'}` : `${p.cmd} ${m.value}`
	}
	if (m.kind === 'fixed' || m.kind === 'video') return p.note ?? (p.cmd ? p.cmd : '(no ProVideo mapping known)')
	return p.note ?? (p.cmd ? `${p.cmd}${p.scaled ? ' <raw value>' : ''}` : '(no ProVideo mapping known)')
}

// --- one pass over parsed lines ------------------------------------------
export function decodeDump(lines) {
	const out = []
	let pending = null // last TX inquiry match, awaiting its RX reply
	for (const { dir, bytes } of lines) {
		if (bytes.length < 3) {
			out.push({ dir: dir ?? '?', raw: bytes, companion: '(frame too short, ignored)' })
			continue
		}
		const type = bytes[1]
		const isRequest = dir === 'TX' || (!dir && (type === 0x01 || type === 0x09))
		const isReply = dir === 'RX' || (!dir && (type & 0xf0) >= 0x40 && !isRequest)

		if (isRequest) {
			const payload = bytes.slice(1, bytes[bytes.length - 1] === TERMINATOR ? -1 : undefined)
			if (type === 0x09) {
				const m = matchInquiry(payload)
				pending = m ? { ...m, kind: 'inquiry' } : null
				out.push({ dir: 'TX', raw: bytes, companion: describeCompanion(pending), provideo: pending ? undefined : '(no ProVideo mapping known)' })
			} else {
				const m = matchCommand(payload)
				pending = null
				out.push({ dir: 'TX', raw: bytes, companion: describeCompanion(m), provideo: translate(m) })
			}
			continue
		}

		if (isReply) {
			const kind = bytes[1] & 0xf0
			if (kind === 0x40) {
				out.push({ dir: 'RX', raw: bytes, companion: '(ACK)', provideo: undefined })
				continue
			}
			if (kind === 0x60) {
				const code = bytes[2]
				const label = ERROR_CODES[code] ?? 'Unknown error'
				const who = pending?.id && INQUIRIES[pending.id] ? INQUIRIES[pending.id].name : null
				out.push({
					dir: 'RX',
					raw: bytes,
					companion: who ? `${who}: ERROR` : '(ERROR)',
					provideo: `ERROR 0x${code.toString(16).padStart(2, '0')} (${label})${who ? ` — ${PROVIDEO_NAMES[pending.id]?.cmd ?? pending.id} not executable` : ''}`,
				})
				pending = null
				continue
			}
			if (kind === 0x50 && pending?.id && INQUIRIES[pending.id]) {
				const q = INQUIRIES[pending.id]
				const data = bytes.slice(2, bytes[bytes.length - 1] === TERMINATOR ? -1 : undefined)
				const label = decodeReply(q.decode, data)
				const p = PROVIDEO_NAMES[pending.id]
				let provideo
				if (!p || (!p.cmd && !p.note)) provideo = '(no ProVideo mapping known)'
				else if (!p.cmd) provideo = p.note
				else if (p.scaled && q.decode.type === 'value')
					provideo = `${p.cmd} <raw=${label}>  // ${p.note ?? 'firmware applies its own scaling (TODO stage 8) before this reaches the sensor'}`
				else provideo = p.cmd
				out.push({ dir: 'RX', raw: bytes, companion: `${q.name} = ${label}`, provideo })
				pending = null
				continue
			}
			out.push({ dir: 'RX', raw: bytes, companion: '(completion)', provideo: undefined })
			pending = null
			continue
		}

		out.push({ dir: dir ?? '?', raw: bytes, companion: '(unrecognized frame)', provideo: undefined })
	}
	return out
}

export function formatEntry(e) {
	const parts = [e.dir === 'RX' ? `RX ${hex(e.raw)}\t${e.companion}` : `${e.dir ?? '?'} ${e.companion}`]
	if (e.provideo !== undefined) parts.push(`provideo: ${e.provideo}`)
	return parts.join('\t')
}

// --- CLI entrypoint --------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
	const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
	const entries = decodeDump(parseLines(input))
	for (const e of entries) console.log(formatEntry(e))
}
