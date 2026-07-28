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
	SYSTEM_NAMES,
	GAIN_ISO,
	GAIN_ISO_STEPS,
	isoToGainRaw,
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
const KINDS = new Set(['enum', 'rud', 'direct', 'fixed', 'video', 'iso'])
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
	assert.equal(decodeReply({ type: 'system' }, [0x00, 0x00, b2, b3]), '1080p30')
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
		} else if (c.kind === 'iso') {
			assert.ok(Array.isArray(c.prefix) && c.prefix.every(isByte), `${id}: prefix`)
			assert.equal(c.prefix[0], 0x01, `${id}: not a command (0x01)`)
			assert.ok([1, 2, 3, 4].includes(c.nibbles), `${id}: nibbles must be 1-4`)
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
		assert.equal(decodeReply({ type: 'system' }, [0x00, 0x00, pair[0], pair[1]]), SYSTEM_NAMES[vm])
	}
})

test('SYSTEM_NAMES covers exactly the SYSTEM modes with non-empty string labels', () => {
	assert.deepEqual(Object.keys(SYSTEM_NAMES).sort(), Object.keys(SYSTEM).sort())
	for (const [vm, name] of Object.entries(SYSTEM_NAMES)) {
		assert.ok(name && typeof name === 'string', `mode ${vm}: label`)
	}
	assert.equal(SYSTEM_NAMES[4], '1080p30')
	assert.equal(SYSTEM_NAMES[11], '1080i60')
})

// --- Gain (ISO) named-step table (OG03A10) ---------------------------------
test('GAIN_ISO raw values match the OG03A10 ISO->raw formula for all 18 steps', () => {
	assert.deepEqual(GAIN_ISO_STEPS, [140, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400])
	assert.equal(GAIN_ISO.length, 18)
	for (const { iso, raw } of GAIN_ISO) {
		// Recompute independently: real_gain_unit = floor(ISO*1000/MIN_ISO), then
		// invert the firmware's linear raw->real scale with the SAME truncating
		// integer division map_gain() uses (trunc, NOT round).
		const realUnit = Math.floor((iso * 1000) / 140)
		const expected = Math.max(0, Math.min(4095, Math.trunc(((realUnit - 1000) * 4095) / 44715)))
		assert.equal(raw, expected, `ISO ${iso}`)
		assert.equal(raw, isoToGainRaw(iso), `ISO ${iso} via isoToGainRaw`)
		assert.ok(raw >= 0 && raw <= 4095, `ISO ${iso} raw in range`)
	}
	assert.equal(GAIN_ISO[0].raw, 0) // ISO 140 -> 0
	assert.equal(GAIN_ISO.at(-1).raw, 4094) // ISO 6400 -> 4094 (trunc; round would give 4095)
})

test('Gain (ISO) builds the exact cam_gain wire frame for spot-check ISO values', () => {
	const c = COMMANDS.cam_gain_iso
	assert.equal(c.kind, 'iso')
	assert.deepEqual(c.prefix, [0x01, 0x04, 0x4c, 0x00, 0x00])
	assert.equal(c.nibbles, 3)
	const raw = (iso) => GAIN_ISO.find((g) => g.iso === iso).raw
	// ISO 140 -> raw 0
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(140), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff],
	)
	// ISO 800 -> raw 431 (0x1AF -> nibbles 1,A,F)
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(800), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4c, 0x00, 0x00, 0x01, 0x0a, 0x0f, 0xff],
	)
	// ISO 6400 -> raw 4094 (0xFFE -> nibbles F,F,E)
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(6400), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4c, 0x00, 0x00, 0x0f, 0x0f, 0x0e, 0xff],
	)
})

test('the raw Gain (direct) number control is left untouched alongside the new ISO control', () => {
	assert.equal(COMMANDS.cam_gain_direct.kind, 'direct')
	assert.deepEqual(COMMANDS.cam_gain_direct.prefix, [0x01, 0x04, 0x4c, 0x00, 0x00])
	assert.equal(COMMANDS.cam_gain_direct.nibbles, 3)
	// the ISO control is additive and is NOT turned into a knob param
	assert.equal(continuousParams().some((p) => p.id === 'cam_gain_iso'), false)
})

test('RUD action bytes', () => {
	assert.deepEqual(RUD, { reset: 0x00, up: 0x02, down: 0x03 })
})

test('cam_gain and cam_shutter expose the full Reset/Up/Down rud structure (no per-command restriction)', () => {
	assert.equal(COMMANDS.cam_gain.rudChoices, undefined)
	assert.equal(COMMANDS.cam_shutter.rudChoices, undefined)
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
		const cmd = COMMANDS[p.cmd]
		// A command may narrow its wire-derived range (e.g. dct_aec_speed:
		// wire is 0-255, but the firmware only honors 1-30) via explicit
		// min/max on the COMMANDS entry.
		const expectedMax = cmd.max ?? (p.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1)
		const expectedMin = cmd.min ?? (p.signed ? -(1 << (bits - 1)) : 0)
		assert.equal(p.max, expectedMax, `${p.id}: max derived from nibbles/signed, unless narrowed`)
		assert.equal(p.min, expectedMin, `${p.id}: min derived from nibbles/signed, unless narrowed`)
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

test('decodeReply uses decode.nibbles (not the padded payload length) for signed bit-width', () => {
	// Real hardware (reply_pq, visca_map_picture.c) always pads post_hue's/
	// post_bright's inquiry reply to 4 bytes ("00 00 0p 0q") even though the
	// real value is only 2 nibbles wide. Without an explicit nibbles count,
	// toSigned(raw, payload.length) would treat this as a 16-bit value and
	// never see the 8-bit sign bit -- silently reporting -5 as 251 instead.
	const padded = [0x00, 0x00, 0x0f, 0x0b] // -5, as an 8-bit value, padded to 4 bytes
	assert.equal(decodeReply({ type: 'value', signed: true, nibbles: 2 }, padded), '-5')
	assert.equal(decodeReply({ type: 'value', signed: true }, padded), '251', 'without nibbles, padding breaks the sign bit')
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

// --- Flare individual channels (red/green/blue) -----------------------------
// flare's real range is a firmware read-modify-write concern (see
// provideo-names.mjs), not something the wire encoding itself needs to
// express -- these are plain unsigned direct commands like any other.

test('Flare Red (direct) round-trips a representative value (3 nibbles)', () => {
	assert.equal(COMMANDS.dct_flare_red.nibbles, 3)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_flare_red.prefix, ...encodeNibbles(300, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x07, 0x01, 0x02, 0x0c, 0xff],
	)
})

test('Flare Green (direct) round-trips its full raw range (3 nibbles)', () => {
	assert.equal(COMMANDS.dct_flare_green.nibbles, 3)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_flare_green.prefix, ...encodeNibbles(4095, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x1b, 0x0f, 0x0f, 0x0f, 0xff],
	)
})

test('Flare Blue (direct) round-trips zero (3 nibbles)', () => {
	assert.equal(COMMANDS.dct_flare_blue.nibbles, 3)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_flare_blue.prefix, ...encodeNibbles(0, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x1c, 0x00, 0x00, 0x00, 0xff],
	)
})

test('continuousParams includes the 3 Flare channels with unsigned 0-4095 ranges', () => {
	const params = continuousParams()
	const red = params.find((p) => p.id === 'dct_flare_red')
	const green = params.find((p) => p.id === 'dct_flare_green')
	const blue = params.find((p) => p.id === 'dct_flare_blue')

	assert.equal(red.min, 0)
	assert.equal(red.max, 4095)
	assert.equal(green.min, 0)
	assert.equal(green.max, 4095)
	assert.equal(blue.min, 0)
	assert.equal(blue.max, 4095)
})

// --- AEC individual fields (setPoint/speed/maxGain) -------------------------
// aec's real range is a firmware read-modify-write concern (see
// provideo-names.mjs), not something the wire encoding itself needs to
// express -- these are plain unsigned direct commands like any other.

test('AEC SetPoint (direct) round-trips a representative value (3 nibbles)', () => {
	assert.equal(COMMANDS.dct_aec_setpoint.nibbles, 3)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_aec_setpoint.prefix, ...encodeNibbles(857, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x18, 0x03, 0x05, 0x09, 0xff],
	)
})

test('AEC Speed (direct) round-trips a representative value (2 nibbles)', () => {
	assert.equal(COMMANDS.dct_aec_speed.nibbles, 2)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_aec_speed.prefix, ...encodeNibbles(26, 2)])],
		[0x81, 0x01, 0x7e, 0x01, 0x19, 0x01, 0x0a, 0xff],
	)
})

test('AEC Max Gain (direct) round-trips its full raw range (3 nibbles)', () => {
	assert.equal(COMMANDS.dct_aec_maxgain.nibbles, 3)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_aec_maxgain.prefix, ...encodeNibbles(4095, 3)])],
		[0x81, 0x01, 0x7e, 0x01, 0x1a, 0x0f, 0x0f, 0x0f, 0xff],
	)
})

test('continuousParams includes the 3 AEC fields with correct ranges (setPoint/speed narrowed to their real clamp, maxGain fully scaled)', () => {
	const params = continuousParams()
	const setpoint = params.find((p) => p.id === 'dct_aec_setpoint')
	const speed = params.find((p) => p.id === 'dct_aec_speed')
	const maxgain = params.find((p) => p.id === 'dct_aec_maxgain')

	assert.equal(setpoint.min, 50)
	assert.equal(setpoint.max, 3000)
	assert.equal(speed.min, 1)
	assert.equal(speed.max, 30)
	assert.equal(maxgain.min, 0)
	assert.equal(maxgain.max, 4095)
})

// --- cam_bright (signed, post_bright) ---------------------------------------
// The standard VISCA set also defines a 2nd, Direct-only "CAM_Brightness"
// function (0xA1) landing on this exact same post_bright command; the
// firmware still answers it for other controllers, but it's a pure
// duplicate of cam_bright_direct, so it's deliberately not exposed as a
// Companion command/inquiry (see commands.js's comment above cam_bright).

test("cam_bright's Direct form shares its RUD's function byte (0x0d)", () => {
	assert.equal(COMMANDS.cam_bright.kind, 'rud')
	assert.equal(COMMANDS.cam_bright.func, 0x0d)
	assert.equal(COMMANDS.cam_bright_direct.prefix[2], 0x0d)
})

test('Bright (direct) is signed, -128..127 (post_bright)', () => {
	assert.equal(COMMANDS.cam_bright_direct.nibbles, 2)
	assert.equal(COMMANDS.cam_bright_direct.signed, true)
	// -5 as an 8-bit two's-complement value is 0xFB -> nibbles [0xF, 0xB]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.cam_bright_direct.prefix, ...encodeNibbles(-5 & 0xff, 2)])],
		[0x81, 0x01, 0x04, 0x0d, 0x00, 0x00, 0x0f, 0x0b, 0xff],
	)
})

test("continuousParams' Bright (direct) entry has a signed -128..127 range", () => {
	const p = continuousParams().find((x) => x.id === 'cam_bright_direct')
	assert.equal(p.signed, true)
	assert.equal(p.min, -128)
	assert.equal(p.max, 127)
})

test('cam_brightness_direct is deliberately not exposed (pure duplicate of cam_bright_direct)', () => {
	assert.equal(COMMANDS.cam_brightness_direct, undefined)
	assert.equal(INQUIRIES.brightness, undefined)
})

// --- cam_gamma / cam_flicker (enums) -----------------------------------

test('cam_gamma enum choices map to log_mode 0-3', () => {
	assert.deepEqual(COMMANDS.cam_gamma.choices['BT.709'], [0x01, 0x04, 0x5b, 0x00])
	assert.deepEqual(COMMANDS.cam_gamma.choices.HLG, [0x01, 0x04, 0x5b, 0x01])
	assert.deepEqual(COMMANDS.cam_gamma.choices.PQ, [0x01, 0x04, 0x5b, 0x02])
	assert.deepEqual(COMMANDS.cam_gamma.choices['S-Log3'], [0x01, 0x04, 0x5b, 0x03])
})

test('cam_flicker enum choices (Off/50Hz/60Hz)', () => {
	assert.deepEqual(COMMANDS.cam_flicker.choices.Off, [0x01, 0x04, 0x23, 0x00])
	assert.deepEqual(COMMANDS.cam_flicker.choices['50Hz'], [0x01, 0x04, 0x23, 0x01])
	assert.deepEqual(COMMANDS.cam_flicker.choices['60Hz'], [0x01, 0x04, 0x23, 0x02])
})

// cam_lr_reverse (0x61) and cam_picture_flip (0x66) each toggle one bit of
// the same `flip` value that cam_flip's 4-state direct select already
// reaches in one command -- the firmware still answers both for other
// controllers, but they're deliberately not exposed in Companion.
test('cam_lr_reverse and cam_picture_flip are deliberately not exposed (cam_flip already reaches every state)', () => {
	assert.equal(COMMANDS.cam_lr_reverse, undefined)
	assert.equal(COMMANDS.cam_picture_flip, undefined)
	assert.equal(INQUIRIES.lr_reverse, undefined)
	assert.equal(INQUIRIES.picture_flip, undefined)
})

test("cam_wb has no separate 'One Push' choice (it's a pure duplicate of Manual -- both send \"awb 0\")", () => {
	assert.equal(COMMANDS.cam_wb.choices['One Push'], undefined)
	assert.deepEqual(COMMANDS.cam_wb.choices.Manual, [0x01, 0x04, 0x35, 0x05])
})

test('cam_power is not exposed (low_power 1 reboots the device and fails on real hardware -- save_boot_settings error)', () => {
	assert.equal(COMMANDS.cam_power, undefined)
	assert.equal(INQUIRIES.power, undefined)
	assert.equal(ENUM.power, undefined)
})

// --- color_temp_direct (unsigned raw preset index, no Kelvin matching) ------

test('Color Temp (direct) round-trips a raw preset index (unsigned, 2 nibbles)', () => {
	assert.equal(COMMANDS.color_temp_direct.nibbles, 2)
	assert.equal(COMMANDS.color_temp_direct.signed, undefined)
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.color_temp_direct.prefix, ...encodeNibbles(3, 2)])],
		[0x81, 0x01, 0x04, 0x20, 0x00, 0x00, 0x00, 0x03, 0xff],
	)
})

test("continuousParams' Color Temp entry is narrowed to 0-9 (largest calibration profile), not the wire's full 0-255", () => {
	const p = continuousParams().find((x) => x.id === 'color_temp_direct')
	assert.equal(p.min, 0)
	assert.equal(p.max, 9)
})

test("continuousParams' AWB Speed entry is narrowed to 0-2 (do_awb_speed hard-rejects >2), not the wire's full 0-15", () => {
	const p = continuousParams().find((x) => x.id === 'dct_awb_speed')
	assert.equal(p.min, 0)
	assert.equal(p.max, 2)
})

test('S-Log3 Master Gain (direct) is signed, -6..12 (do_slog3_master_gain hard-rejects outside that)', () => {
	assert.equal(COMMANDS.dct_slog3_gain.nibbles, 2)
	assert.equal(COMMANDS.dct_slog3_gain.signed, true)
	// -6 as an 8-bit two's-complement value is 0xFA -> nibbles [0xF, 0xA]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_slog3_gain.prefix, ...encodeNibbles(-6 & 0xff, 2)])],
		[0x81, 0x01, 0x7e, 0x01, 0x09, 0x0f, 0x0a, 0xff],
	)
})

test("continuousParams' S-Log3 Master Gain entry is narrowed to -6..12, not the wire's full signed -128..127", () => {
	const p = continuousParams().find((x) => x.id === 'dct_slog3_gain')
	assert.equal(p.signed, true)
	assert.equal(p.min, -6)
	assert.equal(p.max, 12)
})

test("continuousParams' Color Space entry is narrowed to 0-2 (do_color_space hard-rejects outside that), not the wire's full 0-15", () => {
	const p = continuousParams().find((x) => x.id === 'dct_color_space')
	assert.equal(p.min, 0)
	assert.equal(p.max, 2)
})

test("continuousParams' LUT Mode entry is narrowed to 0-1 (LUT_MODE_FIXED=2 is rejected), not the wire's full 0-15", () => {
	const p = continuousParams().find((x) => x.id === 'dct_lut_mode')
	assert.equal(p.min, 0)
	assert.equal(p.max, 1)
})

test('SDI Black (direct) is signed, -60..60 (do_sdi_black hard-rejects outside that)', () => {
	assert.equal(COMMANDS.dct_sdi_black.nibbles, 2)
	assert.equal(COMMANDS.dct_sdi_black.signed, true)
	// -60 as an 8-bit two's-complement value is 0xC4 -> nibbles [0xC, 0x4]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_sdi_black.prefix, ...encodeNibbles(-60 & 0xff, 2)])],
		[0x81, 0x01, 0x7e, 0x01, 0x31, 0x0c, 0x04, 0xff],
	)
})

test('SDI White (direct) is signed, -80..79 (do_sdi_white hard-rejects outside that)', () => {
	assert.equal(COMMANDS.dct_sdi_white.nibbles, 2)
	assert.equal(COMMANDS.dct_sdi_white.signed, true)
	// -80 as an 8-bit two's-complement value is 0xB0 -> nibbles [0xB, 0x0]
	assert.deepEqual(
		[...buildFrame(1, [...COMMANDS.dct_sdi_white.prefix, ...encodeNibbles(-80 & 0xff, 2)])],
		[0x81, 0x01, 0x7e, 0x01, 0x32, 0x0b, 0x00, 0xff],
	)
})

test("continuousParams' SDI Black/White entries are narrowed to their real signed ranges, not the wire's full signed -128..127", () => {
	const black = continuousParams().find((x) => x.id === 'dct_sdi_black')
	assert.equal(black.signed, true)
	assert.equal(black.min, -60)
	assert.equal(black.max, 60)

	const white = continuousParams().find((x) => x.id === 'dct_sdi_white')
	assert.equal(white.signed, true)
	assert.equal(white.min, -80)
	assert.equal(white.max, 79)
})
