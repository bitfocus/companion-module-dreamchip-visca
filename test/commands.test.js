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
	SHUTTER_SPEEDS,
	SHUTTER_SPEED_STEPS,
	shutterUsToRaw,
	gainRawToIso,
	shutterRawToUs,
	audioGainRawToDb,
	audioGainRawToDbValue,
	AUDIO_GAIN_BAR_MIN,
	AUDIO_GAIN_BAR_MAX,
	hueRawToDeg,
	wbGainFactor,
	saturationFactor,
	progressBar,
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
const KINDS = new Set(['enum', 'rud', 'direct', 'fixed', 'video', 'iso', 'shutter'])
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
		} else if (c.kind === 'iso' || c.kind === 'shutter') {
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

// --- Shutter (Speed) named-step table ---------------------------------------
test('SHUTTER_SPEEDS us/raw values match the formula for all 17 steps', () => {
	assert.deepEqual(SHUTTER_SPEED_STEPS, [8000, 4000, 2000, 1000, 800, 600, 500, 400, 250, 200, 125, 120, 100, 60, 50, 33, 30])
	assert.equal(SHUTTER_SPEEDS.length, 17)
	for (const { n, us, raw } of SHUTTER_SPEEDS) {
		// Recompute independently: us = round(1e6/n) (plain unit conversion),
		// then invert the firmware's linear raw->real scale with the SAME
		// truncating integer division unmap_exposure() uses (trunc, NOT round).
		const expectedUs = Math.round(1e6 / n)
		assert.equal(us, expectedUs, `1/${n}: us`)
		const expectedRaw = Math.trunc(((expectedUs - 100) * 4095) / 38239)
		assert.equal(raw, expectedRaw, `1/${n}: raw`)
		assert.equal(raw, shutterUsToRaw(us), `1/${n} via shutterUsToRaw`)
		assert.ok(raw >= 0 && raw <= 4095, `1/${n}: raw in range`)
	}
	assert.equal(SHUTTER_SPEEDS[0].raw, 2) // 1/8000 -> 125us -> raw 2
	assert.equal(SHUTTER_SPEEDS.at(-1).raw, 3558) // 1/30 -> 33333us -> raw 3558
})

test('Shutter (Speed) builds the exact cam_exposure wire frame for spot-check speeds', () => {
	const c = COMMANDS.cam_shutter_speed
	assert.equal(c.kind, 'shutter')
	assert.deepEqual(c.prefix, [0x01, 0x04, 0x4a, 0x00, 0x00])
	assert.equal(c.nibbles, 3)
	const raw = (n) => SHUTTER_SPEEDS.find((s) => s.n === n).raw
	// 1/8000 -> raw 2
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(8000), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4a, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff],
	)
	// 1/1000 -> raw 96 (0x060 -> nibbles 0,6,0)
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(1000), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4a, 0x00, 0x00, 0x00, 0x06, 0x00, 0xff],
	)
	// 1/30 -> raw 3558 (0xDE6 -> nibbles D,E,6)
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(raw(30), c.nibbles)])],
		[0x81, 0x01, 0x04, 0x4a, 0x00, 0x00, 0x0d, 0x0e, 0x06, 0xff],
	)
})

test('the raw Shutter (direct) number control is left untouched alongside the new Speed control', () => {
	assert.equal(COMMANDS.cam_shutter_direct.kind, 'direct')
	assert.deepEqual(COMMANDS.cam_shutter_direct.prefix, [0x01, 0x04, 0x4a, 0x00, 0x00])
	assert.equal(COMMANDS.cam_shutter_direct.nibbles, 3)
	// the Speed control is additive and is NOT turned into a knob param
	assert.equal(continuousParams().some((p) => p.id === 'cam_shutter_speed'), false)
})

// --- Color Temp (Kelvin) / wb_temp -----------------------------------------
test('DCT wb_temp SET builds the exact 4-nibble wire frame and has the hardcoded 2200-10000 UI range', () => {
	const c = COMMANDS.dct_wb_temp
	assert.equal(c.kind, 'direct')
	assert.deepEqual(c.prefix, [0x01, 0x7e, 0x01, 0x0b])
	assert.equal(c.nibbles, 4)
	assert.equal(c.min, 2200)
	assert.equal(c.max, 10000)
	assert.equal(c.group, 'White Balance')
	// 5000 K = 0x1388 -> nibbles 1,3,8,8
	assert.deepEqual(
		[...buildFrame(1, [...c.prefix, ...encodeNibbles(5000, c.nibbles)])],
		[0x81, 0x01, 0x7e, 0x01, 0x0b, 0x01, 0x03, 0x08, 0x08, 0xff],
	)
	// round-trip: 2200 K = 0x0898
	assert.equal(decodeNibbles(encodeNibbles(2200, c.nibbles)), 2200)
})

test('the three wb_temp field inquiries share SS 0x0B but use distinct selector bytes and varIds', () => {
	const cur = INQUIRIES.dct_wb_temp
	const min = INQUIRIES.dct_wb_temp_min
	const max = INQUIRIES.dct_wb_temp_max
	for (const q of [cur, min, max]) {
		assert.deepEqual(q.payload.slice(0, 4), [0x09, 0x7e, 0x01, 0x0b], `${q.varId}: SS`)
		assert.equal(q.decode.type, 'value')
	}
	assert.equal(cur.payload[4], 0x00)
	assert.equal(min.payload[4], 0x01)
	assert.equal(max.payload[4], 0x02)
	assert.deepEqual([cur.varId, min.varId, max.varId], ['dct_wb_temp', 'dct_wb_temp_min', 'dct_wb_temp_max'])
})

test('wb_temp_measure inquiry is SS 0x0C with no selector byte, value decode', () => {
	const q = INQUIRIES.dct_wb_temp_measure
	assert.deepEqual(q.payload, [0x09, 0x7e, 0x01, 0x0c])
	assert.equal(q.decode.type, 'value')
})

test('the wb_temp knob param reads back the current inquiry (varId dct_wb_temp) with the 2200-10000 range', () => {
	const p = continuousParams().find((x) => x.id === 'dct_wb_temp')
	assert.ok(p, 'dct_wb_temp is a continuous param')
	assert.equal(p.varId, 'dct_wb_temp') // matches INQUIRIES.dct_wb_temp
	assert.equal(p.min, 2200)
	assert.equal(p.max, 10000)
})

test('color_temp_direct remains a distinct raw preset-index passthrough alongside the new settable dct_wb_temp', () => {
	assert.ok(COMMANDS.dct_wb_temp, 'dct_wb_temp SET exists')
	assert.equal(COMMANDS.color_temp_direct.name, 'Color Temp Preset (direct)')
	assert.equal(COMMANDS.color_temp_direct.max, 9)
})

test('dct_wb_temp owns the bare "Color Temp" name; color_temp_direct/color_temp are disambiguated as "Color Temp Preset" to avoid colliding with it', () => {
	assert.equal(COMMANDS.dct_wb_temp.name, 'Color Temp')
	assert.equal(continuousParams().find((x) => x.id === 'dct_wb_temp').name, 'Color Temp')
	// color_temp_direct's knob/button label (after continuousParams() strips
	// the trailing " (direct)") must NOT collapse back down to bare "Color
	// Temp" -- that's the exact collision this naming was chosen to avoid.
	const preset = continuousParams().find((x) => x.id === 'color_temp_direct')
	assert.equal(preset.name, 'Color Temp Preset')
	assert.equal(INQUIRIES.color_temp.name, 'Color Temp Preset')
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

// --- progressBar (knob feedback's text position bar) -----------------------
test('progressBar marks the "|" position proportionally to value within [min,max]', () => {
	assert.equal(progressBar(0, 0, 100, 10), '|..........')
	assert.equal(progressBar(100, 0, 100, 10), '..........|')
	assert.equal(progressBar(50, 0, 100, 10), '.....|.....')
	assert.equal(progressBar(30, 0, 100, 10), '...|.......')
	// negative range
	assert.equal(progressBar(-6, -6, 12, 6), '|......')
	assert.equal(progressBar(12, -6, 12, 6), '......|')
})

test('progressBar clamps out-of-range values instead of erroring', () => {
	assert.equal(progressBar(-50, 0, 100, 10), progressBar(0, 0, 100, 10))
	assert.equal(progressBar(150, 0, 100, 10), progressBar(100, 0, 100, 10))
})

test('progressBar renders all dashes for non-finite values or a degenerate range', () => {
	assert.equal(progressBar(NaN, 0, 100, 10), '-'.repeat(10))
	assert.equal(progressBar(undefined, 0, 100, 10), '-'.repeat(10))
	assert.equal(progressBar(50, 10, 10, 10), '-'.repeat(10)) // max <= min
	assert.equal(progressBar(50, 20, 10, 10), '-'.repeat(10)) // max < min
})

test('progressBar defaults to width 10 and always returns width+1 characters (the "|" marker plus the dots)', () => {
	assert.equal(progressBar(50, 0, 100).length, 11)
	assert.equal(progressBar(5, 0, 10, 4).length, 5)
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
		[...buildFrame(1, COMMANDS.cam_ae.choices['Auto'])],
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

test('Color Space Preset (dct_color_space_preset) sends the exact confirmed-working wire frame for each of the 3 choices', () => {
	const c = COMMANDS.dct_color_space_preset
	assert.equal(c.kind, 'enum')
	assert.deepEqual(Object.keys(c.choices), ['Rec.709', 'Rec.2020', 'SGam3.Cine'])
	// raw hardware confirmation: 81 01 7e 01 17 00 ff -> ACK+Completion (not the
	// earlier-reported 90 61 41 ff error, which turned out to be unrelated to
	// the VISCA mapping itself -- see the color_space investigation).
	assert.deepEqual([...buildFrame(1, c.choices['Rec.709'])], [0x81, 0x01, 0x7e, 0x01, 0x17, 0x00, 0xff])
	assert.deepEqual([...buildFrame(1, c.choices['Rec.2020'])], [0x81, 0x01, 0x7e, 0x01, 0x17, 0x01, 0xff])
	assert.deepEqual([...buildFrame(1, c.choices['SGam3.Cine'])], [0x81, 0x01, 0x7e, 0x01, 0x17, 0x02, 0xff])
	// same underlying wire command as the raw Color Space (direct) entry --
	// purely additive, both stay independently usable.
	assert.deepEqual(c.choices['Rec.709'].slice(0, 4), COMMANDS.dct_color_space.prefix)
})

test("continuousParams' LUT Mode entry is narrowed to 0-1 (LUT_MODE_FIXED=2 is rejected), not the wire's full 0-15", () => {
	const p = continuousParams().find((x) => x.id === 'dct_lut_mode')
	assert.equal(p.min, 0)
	assert.equal(p.max, 1)
})

test('dct_tm_mode is exposed (0-4, direct + 5-choice preset) now that the BSP fixed tm_mode\'s "off" hack', () => {
	const c = COMMANDS.dct_tm_mode
	assert.equal(c.kind, 'direct')
	assert.deepEqual(c.prefix, [0x01, 0x7e, 0x01, 0x21])
	assert.equal(c.min, 0)
	assert.equal(c.max, 4)
	assert.ok(INQUIRIES.dct_tm_mode)
	assert.equal(continuousParams().some((p) => p.id === 'dct_tm_mode'), true)

	const preset = COMMANDS.dct_tm_mode_preset
	assert.equal(preset.kind, 'enum')
	assert.deepEqual(Object.keys(preset.choices), ['Off', '+0.5EV', '+1.0EV', '+1.5EV', '+2.0EV'])
	assert.deepEqual(preset.choices['+1.0EV'], [0x01, 0x7e, 0x01, 0x21, 2])
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

test("cam_wb has no 'Color Temp' choice (func 0x35 data 0x20 has no room for a preset index -- always errors, see color_temp_direct)", () => {
	assert.equal(COMMANDS.cam_wb.choices['Color Temp'], undefined)
})

test('dct_osd is not exposed as a command (buttons removed), but its inquiry/variable still exists', () => {
	assert.equal(COMMANDS.dct_osd, undefined)
	assert.ok(INQUIRIES.dct_osd, 'INQUIRIES.dct_osd should still exist')
	assert.equal(INQUIRIES.dct_osd.varId, 'dct_osd')
})

test('Audio Enable and Audio Gain are grouped under Audio (not System)', () => {
	assert.equal(COMMANDS.dct_audio_enable.group, 'Audio')
	assert.equal(COMMANDS.dct_audio_gain.group, 'Audio')
})

test("continuousParams' Audio Gain entry is logScale, stepped in exact 0.5dB increments (not linear or the generic 5%)", () => {
	const p = continuousParams().find((x) => x.id === 'dct_audio_gain')
	assert.equal(p.logScale, true)
	assert.ok(Math.abs(p.stepPercent - (10 ** (0.5 / 20) - 1) * 100) < 1e-9)
	assert.equal(p.min, 0)
	assert.equal(p.max, 4095)
})

test("continuousParams' logScale defaults to false and stepPercent to undefined for ordinary (linear) params", () => {
	const p = continuousParams().find((x) => x.id === 'cam_rgain_direct')
	assert.equal(p.logScale, false)
	assert.equal(p.stepPercent, undefined)
	assert.equal(p.minStep, undefined)
})

test("continuousParams' Gain (direct) entry is logScale with a 4-raw-unit minimum step (gain is perceived in stops/dB, not linear)", () => {
	const p = continuousParams().find((x) => x.id === 'cam_gain_direct')
	assert.equal(p.logScale, true)
	assert.equal(p.stepPercent, 5)
	assert.equal(p.minStep, 4)
	assert.equal(p.min, 0)
	assert.equal(p.max, 4095)
})

// --- two-tier polling (main.js pollLiveOnce()/pollStartupOnce()) -----------

test('exactly the 36 calibration/setup-style inquiries are tagged once:true (startup-only tier)', () => {
	const onceIds = Object.entries(INQUIRIES)
		.filter(([, q]) => q.once)
		.map(([id]) => id)
		.sort()
	assert.equal(onceIds.length, 36)
	assert.deepEqual(
		onceIds,
		[
			'dct_aec_maxgain', 'dct_aec_setpoint', 'dct_aec_speed', 'dct_audio_gain',
			'dct_auto_save', 'dct_awb_speed', 'dct_black_blue', 'dct_black_green', 'dct_black_master',
			'dct_black_red', 'dct_cnr_auto', 'dct_cnr_mode', 'dct_color_space',
			'dct_dpf_strength', 'dct_filter_denoise', 'dct_filter_detail', 'dct_filter_enable',
			'dct_flare_blue', 'dct_flare_green', 'dct_flare_red', 'dct_gain_mode', 'dct_lut_fixed_mode',
			'dct_lut_mode', 'dct_lut_preset', 'dct_mcc_opmode', 'dct_osd', 'dct_pq_max_bright',
			'dct_sdi_black', 'dct_sdi_white', 'dct_slog3_gain', 'dct_tm_mode', 'flicker', 'flip',
			'gamma', 'version', 'video_mode',
		].sort(),
	)
})

test('Gain/Shutter/AE/WB/RGB-gain/Green-gain/Bright/Contrast/Color-Gain-Hue/Timecode/SDI-Range/Audio-Enable/WB-temp stay on the continuous (non-once) tier', () => {
	for (const id of [
		'gain', 'shutter', 'ae_mode', 'wb_mode', 'rgain', 'bgain', 'dct_ggain', 'bright', 'contrast',
		'color_gain', 'color_hue', 'dct_timecode_hold', 'dct_sdi_range', 'dct_audio_enable',
		'dct_wb_temp', 'dct_wb_temp_min', 'dct_wb_temp_max',
	]) {
		assert.ok(!INQUIRIES[id].once, `${id} should not be tagged once:true`)
	}
})

// --- knob display formatters (raw wire value -> human-readable text) ------

test('gainRawToIso is the inverse of the map_gain() real-gain formula, in ISO units (rounded UP, not to nearest)', () => {
	// raw 0 -> real 1000 -> ISO 140 (the OG03A10 1x/0dB floor)
	assert.equal(gainRawToIso(0), 140)
	// raw 4095 -> real 45715 -> ISO 6400.1 -> ceil -> 6401 (rounds up, not down
	// to the curated table's nominal top value)
	assert.equal(gainRawToIso(4095), 6401)
	// raw->ISO->raw isn't lossless (truncating integer division both ways,
	// same caveat as shutterRawToUs below) -- for every curated ISO step,
	// gainRawToIso(its raw) must land within 1 ISO of the original.
	for (const { iso, raw } of GAIN_ISO) {
		assert.ok(Math.abs(gainRawToIso(raw) - iso) <= 1, `ISO ${iso}: raw ${raw} -> ${gainRawToIso(raw)}`)
	}
})

test('shutterRawToUs is the inverse of the map_exposure() real-exposure formula, in microseconds', () => {
	assert.equal(shutterRawToUs(0), 100)
	assert.equal(shutterRawToUs(4095), 38339)
	SHUTTER_SPEEDS.forEach(({ us, raw }, i) => {
		// us->raw->us isn't lossless (truncating integer division), but the
		// round trip must land within one raw step's worth of microseconds.
		assert.ok(Math.abs(shutterRawToUs(raw) - us) <= 10, `1/${SHUTTER_SPEED_STEPS[i]}`)
	})
})

test('cam_shutter_direct is logScale and floors the fastest manual shutter at >=200us', () => {
	const p = continuousParams().find((x) => x.id === 'cam_shutter_direct')
	assert.equal(p.logScale, true)
	// shutterUsToRaw(200) truncates down to a raw that's actually ~193us
	// (faster than the floor); the command adds +1 to guarantee >=200us.
	assert.equal(p.min, shutterUsToRaw(200) + 1)
	assert.equal(shutterRawToUs(p.min) >= 200, true)
	assert.ok(shutterRawToUs(p.min) < 210, 'the 200us floor should not be padded far past 200us')
})

test('audioGainRawToDb: raw 256 (the knob-reset default) is 0dB unity, raw 4095 is the real hardware max (~24dB, not 42)', () => {
	assert.equal(audioGainRawToDb(256), '0.0')
	const maxDb = Number(audioGainRawToDb(4095))
	assert.ok(maxDb > 24.0 && maxDb < 24.2, `expected ~24.08dB, got ${maxDb}`)
})

test("dct_audio_gain's bar range is symmetric around 0dB, so the knob-reset default (raw 256/0dB) sits at the visual center", () => {
	const p = continuousParams().find((x) => x.id === 'dct_audio_gain')
	assert.equal(typeof p.barValue, 'function')
	assert.equal(p.barMin, -p.barMax, 'bar range must be symmetric around 0')
	assert.equal(p.barValue(256), 0)
	assert.equal(p.barMax, AUDIO_GAIN_BAR_MAX)
	assert.equal(p.barMin, AUDIO_GAIN_BAR_MIN)
	assert.equal(audioGainRawToDbValue(256), 0)
	assert.equal(audioGainRawToDbValue(4095).toFixed(2), '24.08')
	// raw=0 is true silence -- -Infinity dB, not a finite bar position.
	assert.equal(audioGainRawToDbValue(0), -Infinity)
})

test("Audio Gain's stepPercent is tuned to exactly one 0.5dB step, not the generic 5%", () => {
	const p = continuousParams().find((x) => x.id === 'dct_audio_gain')
	const factor = 1 + p.stepPercent / 100
	const dbPerStep = 20 * Math.log10(factor)
	assert.ok(Math.abs(dbPerStep - 0.5) < 1e-9, `expected exactly 0.5dB/step, got ${dbPerStep}`)
})

test('hueRawToDeg inverts the user-supplied degrees->raw example (22.1° -> raw 31)', () => {
	// user's own worked example: hue=22.1° -> h=22.1*128/90=31.43.. -> round -> 31
	assert.equal(hueRawToDeg(31), (31 * 90 / 128).toFixed(1))
	assert.equal(Number(hueRawToDeg(31)), 21.8) // round-trip lands close to, not exactly, 22.1 (integer raw quantization)
})

test('wbGainFactor/saturationFactor render unity gain (raw=256/128) as 1.00', () => {
	assert.equal(wbGainFactor(256), '1.00')
	assert.equal(wbGainFactor(512), '2.00')
	assert.equal(saturationFactor(128), '1.00')
	assert.equal(saturationFactor(64), '0.50')
})

test('every knob-backed param with a format() renders a non-empty string for its min and max', () => {
	for (const p of continuousParams()) {
		if (!p.format) continue
		assert.equal(typeof p.format(p.min), 'string', `${p.id} format(min)`)
		assert.equal(typeof p.format(p.max), 'string', `${p.id} format(max)`)
		assert.ok(p.format(p.min).length > 0, `${p.id} format(min) non-empty`)
	}
})

// --- AE/WB Auto/Manual toggles (mirrors the SDI/Timecode/Audio toggle trio) -

test('cam_ae/cam_wb are still full multi-choice enums (the new toggle only ever targets Auto/Manual)', () => {
	assert.deepEqual(Object.keys(COMMANDS.cam_ae.choices), ['Auto', 'Manual', 'Shutter Pri'])
	assert.deepEqual(Object.keys(COMMANDS.cam_wb.choices), ['Auto', 'Indoor', 'Outdoor', 'Manual', 'Trigger'])
})
