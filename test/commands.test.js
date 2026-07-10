// Pure unit tests for the command table + codec. No Companion, no network.
//   node --test
//
// These catch table drift immediately: a malformed payload byte, a wrong
// command/inquiry type byte, a broken DCT `01 7E 01 SS` prefix, a missing or
// bad decode descriptor, a duplicate variable id, or a codec regression.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	COMMANDS,
	INQUIRIES,
	ENUM,
	SYSTEM,
	RUD,
	TERMINATOR,
	encodeNibbles,
	decodeNibbles,
	buildFrame,
	decodeReply,
} from '../commands.js'

const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xff
const KINDS = new Set(['enum', 'rud', 'direct', 'fixed', 'video'])
const DECODES = new Set(['enum', 'value', 'version', 'system'])

// return every raw payload a command can emit (for structural checks)
const payloadsOf = (c) =>
	c.kind === 'enum'
		? Object.values(c.choices)
		: c.kind === 'direct'
			? [c.prefix]
			: c.kind === 'fixed'
				? [c.bytes]
				: []

// --- codec -----------------------------------------------------------------
test('encodeNibbles / decodeNibbles round-trip', () => {
	for (const [v, n] of [
		[0, 1],
		[0xf, 1],
		[0x00, 2],
		[0xab, 2],
		[0xff, 2],
		[0x1a2b, 4],
	]) {
		const nib = encodeNibbles(v, n)
		assert.equal(nib.length, n)
		assert.ok(nib.every((b) => b >= 0 && b <= 0x0f), 'only low nibbles')
		assert.equal(decodeNibbles(nib), v)
	}
	assert.deepEqual(encodeNibbles(0xab, 2), [0x0a, 0x0b])
	assert.equal(decodeNibbles([0x0a, 0x0b]), 0xab)
})

test('buildFrame adds header + terminator and masks the address', () => {
	const f = buildFrame(1, [0x01, 0x04, 0x00])
	assert.deepEqual([...f], [0x81, 0x01, 0x04, 0x00, 0xff])
	assert.equal(f[f.length - 1], TERMINATOR)
	assert.equal(buildFrame(7, [0x00])[0], 0x87)
	assert.equal(buildFrame(0x1f, [0x00])[0], 0x8f) // low nibble only
})

test('decodeReply handles each decode type', () => {
	assert.equal(decodeReply({ type: 'value' }, [0x0a, 0x0b]), '171') // 0xab
	assert.equal(decodeReply({ type: 'enum', map: ENUM.ae }, [0x03]), 'Manual')
	assert.equal(decodeReply({ type: 'enum', map: ENUM.ae }, [0x99]), '0x99') // fallback
	assert.match(
		decodeReply({ type: 'version' }, [0x00, 0x23, 0x00, 0x00, 0x00, 0x01, 0x02]),
		/vendor=0x0023/,
	)
	const [b2, b3] = SYSTEM[4]
	assert.equal(decodeReply({ type: 'system' }, [0x00, 0x00, b2, b3]), '4')
})

// --- COMMANDS integrity ----------------------------------------------------
test('every COMMANDS entry is well-formed', () => {
	for (const [id, c] of Object.entries(COMMANDS)) {
		assert.ok(c.name && typeof c.name === 'string', `${id}: name`)
		assert.ok(c.group && typeof c.group === 'string', `${id}: group`)
		assert.ok(KINDS.has(c.kind), `${id}: bad kind ${c.kind}`)

		if (c.kind === 'enum') {
			const choices = Object.entries(c.choices || {})
			assert.ok(choices.length, `${id}: no choices`)
			for (const [label, p] of choices) {
				assert.ok(Array.isArray(p) && p.length >= 2, `${id}.${label}: payload`)
				assert.ok(p.every(isByte), `${id}.${label}: byte range`)
				assert.equal(p[0], 0x01, `${id}.${label}: not a command (0x01)`)
			}
		} else if (c.kind === 'rud') {
			assert.ok(isByte(c.func), `${id}: func`)
		} else if (c.kind === 'direct') {
			assert.ok(Array.isArray(c.prefix) && c.prefix.every(isByte), `${id}: prefix`)
			assert.equal(c.prefix[0], 0x01, `${id}: not a command (0x01)`)
			assert.ok([1, 2].includes(c.nibbles), `${id}: nibbles must be 1 or 2`)
		} else if (c.kind === 'fixed') {
			assert.ok(Array.isArray(c.bytes) && c.bytes.every(isByte), `${id}: bytes`)
			assert.equal(c.bytes[0], 0x01, `${id}: not a command (0x01)`)
		}
	}
})

test('DCT command payloads use the 01 7E 01 SS prefix consistently', () => {
	for (const [id, c] of Object.entries(COMMANDS)) {
		const ss = new Set()
		for (const p of payloadsOf(c)) {
			if (p[1] !== 0x7e) continue
			assert.equal(p[0], 0x01, `${id}: DCT command byte`)
			assert.equal(p[2], 0x01, `${id}: DCT sub-namespace`)
			assert.ok(isByte(p[3]), `${id}: DCT sub-opcode`)
			ss.add(p[3])
		}
		assert.ok(ss.size <= 1, `${id}: mixed DCT sub-opcodes across choices`)
	}
})

// --- INQUIRIES integrity ---------------------------------------------------
test('every INQUIRIES entry is well-formed with a unique varId', () => {
	const seen = new Set()
	for (const [id, q] of Object.entries(INQUIRIES)) {
		assert.ok(q.name && typeof q.name === 'string', `${id}: name`)
		assert.ok(q.varId && typeof q.varId === 'string', `${id}: varId`)
		assert.ok(!seen.has(q.varId), `${id}: duplicate varId ${q.varId}`)
		seen.add(q.varId)

		assert.ok(Array.isArray(q.payload) && q.payload.every(isByte), `${id}: payload`)
		assert.equal(q.payload[0], 0x09, `${id}: not an inquiry (0x09)`)

		assert.ok(q.decode && DECODES.has(q.decode.type), `${id}: decode type`)
		if (q.decode.type === 'enum') {
			assert.ok(
				q.decode.map && typeof q.decode.map === 'object' && Object.keys(q.decode.map).length,
				`${id}: enum decode needs a non-empty map`,
			)
		}
		if (q.payload[1] === 0x7e) {
			assert.equal(q.payload[2], 0x01, `${id}: DCT sub-namespace`)
			assert.ok(isByte(q.payload[3]), `${id}: DCT sub-opcode`)
		}
	}
})

// --- shared tables ---------------------------------------------------------
test('ENUM maps have numeric keys and non-empty string labels', () => {
	for (const [name, map] of Object.entries(ENUM)) {
		const entries = Object.entries(map)
		assert.ok(entries.length, `${name}: empty`)
		for (const [k, v] of entries) {
			assert.ok(Number.isInteger(Number(k)), `${name}: non-numeric key ${k}`)
			assert.ok(v && typeof v === 'string', `${name}: bad label for ${k}`)
		}
	}
})

test('SYSTEM video-mode table is well-formed and reversible via decodeReply', () => {
	const seen = new Set()
	for (const [vm, pair] of Object.entries(SYSTEM)) {
		assert.ok(Array.isArray(pair) && pair.length === 2 && pair.every(isByte), `mode ${vm}`)
		const key = pair.join(',')
		assert.ok(!seen.has(key), `mode ${vm}: duplicate b2,b3`)
		seen.add(key)
		assert.equal(decodeReply({ type: 'system' }, [0x00, 0x00, pair[0], pair[1]]), String(vm))
	}
})

test('RUD action bytes', () => {
	assert.deepEqual(RUD, { reset: 0x00, up: 0x02, down: 0x03 })
})

// --- end-to-end frame shape (buildFrame + table) ---------------------------
test('representative frames build to the exact bytes', () => {
	assert.deepEqual(
		[...buildFrame(1, COMMANDS.cam_ae.choices['Full Auto'])],
		[0x81, 0x01, 0x04, 0x39, 0x00, 0xff],
	)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_black_master.prefix, ...encodeNibbles(0x12, 2)])],
		[0x81, 0x01, 0x7e, 0x01, 0x03, 0x01, 0x02, 0xff],
	)
	assert.deepEqual([...buildFrame(1, INQUIRIES.dct_filter_enable.payload)], [0x81, 0x09, 0x7e, 0x01, 0x14, 0xff])
})
