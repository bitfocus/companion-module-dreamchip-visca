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
	continuousParams,
	toSigned,
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
			assert.ok([1, 2, 3, 4].includes(c.nibbles), `${id}: nibbles must be 1-4`)
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

// --- continuous (knob) params ----------------------------------------------
test('continuousParams cover every direct command and map to a real inquiry variable', () => {
	const params = continuousParams()
	const varIds = new Set(Object.values(INQUIRIES).map((q) => q.varId))
	const directIds = Object.entries(COMMANDS)
		.filter(([, c]) => c.kind === 'direct')
		.map(([id]) => id)
	assert.equal(params.length, directIds.length, 'one knob param per direct command')

	const seen = new Set()
	for (const p of params) {
		assert.ok(!seen.has(p.id), `${p.id}: duplicate`)
		seen.add(p.id)
		assert.equal(COMMANDS[p.cmd]?.kind, 'direct', `${p.id}: cmd is a direct command`)
		assert.ok(varIds.has(p.varId), `${p.id}: varId '${p.varId}' has no matching inquiry`)
		assert.ok([1, 2, 3, 4].includes(p.nibbles), `${p.id}: nibbles`)
		const bits = 4 * p.nibbles
		const expectedMax = p.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1
		const expectedMin = p.signed ? -(1 << (bits - 1)) : 0
		assert.equal(p.max, expectedMax, `${p.id}: max derived from nibbles/signed`)
		assert.equal(p.min, expectedMin, `${p.id}: min derived from nibbles/signed`)
	}
})

test('a continuous param builds the expected absolute-set frame', () => {
	const params = continuousParams()
	const gain = params.find((p) => p.varId === 'gain')
	const cg = COMMANDS[gain.cmd]
	assert.deepEqual(
		[...buildFrame(1, [...cg.prefix, ...encodeNibbles(42, cg.nibbles)])],
		[0x81, 0x01, 0x04, 0x4c, 0x00, 0x00, 0x00, 0x02, 0x0a, 0xff], // gain = 42 (0x02a)
	)
	const gg = params.find((p) => p.varId === 'dct_ggain')
	const cgg = COMMANDS[gg.cmd]
	assert.deepEqual(
		[...buildFrame(1, [...cgg.prefix, ...encodeNibbles(4095, cgg.nibbles)])],
		[0x81, 0x01, 0x7e, 0x01, 0x01, 0x00, 0x00, 0x0f, 0x0f, 0x0f, 0xff], // green gain = 4095 (ISP_AWB_GAIN_MAX)
	)
})

// --- end-to-end frame shape (buildFrame + table) ---------------------------
test('representative frames build to the exact bytes', () => {
	assert.deepEqual(
		[...buildFrame(1, COMMANDS.cam_ae.choices['Full Auto'])],
		[0x81, 0x01, 0x04, 0x39, 0x00, 0xff],
	)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_black_master.prefix, ...encodeNibbles(0x12, COMMANDS.dct_black_master.nibbles)])],
		[0x81, 0x01, 0x7e, 0x01, 0x03, 0x00, 0x01, 0x02, 0xff],
	)
	assert.deepEqual([...buildFrame(1, INQUIRIES.dct_filter_enable.payload)], [0x81, 0x09, 0x7e, 0x01, 0x14, 0xff])
})

test('Color Gain (direct) uses 2 nibbles for its full 0-255 range (post_sat)', () => {
	// Widened from 1 nibble (0-15) to match post_sat's real ISP_CCOR12_SATURATION_MAX
	// range and the inquiry side, which already replies 2 nibbles via reply_pq.
	assert.equal(COMMANDS.cam_color_gain_direct.nibbles, 2)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.cam_color_gain_direct.prefix, ...encodeNibbles(255, 2)])],
		[0x81, 0x01, 0x04, 0x49, 0x00, 0x00, 0x0f, 0x0f, 0xff],
	)
})

test('toSigned reinterprets a 2-nibble byte as two\'s-complement int8', () => {
	assert.equal(toSigned(0, 2), 0)
	assert.equal(toSigned(127, 2), 127)
	assert.equal(toSigned(128, 2), -128)
	assert.equal(toSigned(251, 2), -5)
	assert.equal(toSigned(255, 2), -1)
})

test('Color Hue (direct) is signed, -128..127, wire-encoded like any other 2-nibble value', () => {
	// post_hue's real range is signed -128..127 (ISP_CCOR12_HUE_MIN/MAX); widened
	// from 1 nibble (unsigned 0-15, couldn't represent negative hue at all).
	assert.equal(COMMANDS.cam_color_hue_direct.nibbles, 2)
	assert.equal(COMMANDS.cam_color_hue_direct.signed, true)
	// -5 as an 8-bit two's-complement value is 0xFB -> nibbles [0xF, 0xB]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.cam_color_hue_direct.prefix, ...encodeNibbles(-5 & 0xff, 2)])],
		[0x81, 0x01, 0x04, 0x4f, 0x00, 0x00, 0x0f, 0x0b, 0xff],
	)
})

test('decodeReply reinterprets a signed value decode as negative', () => {
	assert.equal(decodeReply({ type: 'value', signed: true }, [0x0f, 0x0b]), '-5')
	assert.equal(decodeReply({ type: 'value', signed: true }, [0x00, 0x00]), '0')
	assert.equal(decodeReply({ type: 'value' }, [0x0f, 0x0b]), '251', 'non-signed decode is unaffected')
})

test("continuousParams' Color Hue entry has a signed -128..127 range", () => {
	const hue = continuousParams().find((p) => p.id === 'cam_color_hue_direct')
	assert.equal(hue.signed, true)
	assert.equal(hue.min, -128)
	assert.equal(hue.max, 127)
})

test('Black Master (direct) is signed, -2048..2047, an exact 12-bit fit (3 nibbles)', () => {
	// ISP_BMST_OFFSET_MIN/MAX; widened from 2 nibbles (unsigned 0-255) to 3
	// nibbles to represent the full signed 12-bit range exactly.
	assert.equal(COMMANDS.dct_black_master.nibbles, 3)
	assert.equal(COMMANDS.dct_black_master.signed, true)
	// -500 as a 12-bit two's-complement value is 0xE0C -> nibbles [0xE, 0x0, 0xC]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_black_master.prefix, ...encodeNibbles(-500 & 0xfff, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x03, 0x0e, 0x00, 0x0c, 0xff],
	)
})

test("continuousParams' Black Master entry has a signed -2048..2047 range", () => {
	const bm = continuousParams().find((p) => p.id === 'dct_black_master')
	assert.equal(bm.signed, true)
	assert.equal(bm.min, -2048)
	assert.equal(bm.max, 2047)
})

test('Flare (direct) uses 4 nibbles for its full 0-65535 range, an exact fit', () => {
	// ISP_BLS_FLARE_MIN/MAX; widened from 2 nibbles (0-255), which badly
	// truncated it, to 4 nibbles -- 65535 == 2^16-1, an exact identity mapping.
	assert.equal(COMMANDS.dct_flare.nibbles, 4)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_flare.prefix, ...encodeNibbles(65535, 4)])],
		[0x81, 0x01, 0x7e, 0x01, 0x07, 0x0f, 0x0f, 0x0f, 0x0f, 0xff],
	)
})
