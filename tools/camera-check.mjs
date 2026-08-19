// Automated integration test against a REAL camera over serial VISCA.
// Sends the same commands listed in TESTPLAN.md and validates the replies
// (ACK+Completion vs Error, and where possible a set-then-read-back
// round-trip via the paired inquiry). NOT part of `npm test` -- node --test
// won't discover this file, and it requires real hardware attached.
//
// Disables AEC/AWB before the run (manual gain/exposure/WB-gain tests need
// them off to hold a set value) and, once the run finishes, turns AEC/AWB
// back on and resets settings -- regardless of what was running before the
// test started; `reset_settings` is always the last command sent. Each
// command's bytes are fully flushed to the wire (port.write + port.drain)
// before waiting for its reply, and the next command isn't sent until that
// reply (or timeout) arrives -- a strictly one-at-a-time, synchronous
// send/wait sequence, no artificial delay needed between commands.
//
// Usage:
//   VISCA_TEST_PORT=/dev/ttyUSB0 node tools/camera-check.mjs
//   VISCA_TEST_PORT=/dev/ttyUSB0 VISCA_TEST_BAUD=115200 VISCA_TEST_ADDR=1 \
//     node tools/camera-check.mjs --include-destructive
//   node tools/camera-check.mjs --group Exposure   (filter by COMMANDS group)
//   node tools/camera-check.mjs --only gain        (filter by id/name substring)

import { COMMANDS, INQUIRIES, RUD, TERMINATOR, encodeNibbles, buildFrame, decodeReply, continuousParams, GAIN_ISO, SHUTTER_SPEEDS } from '../commands.js'

const PORT = process.env.VISCA_TEST_PORT
const BAUD = Number(process.env.VISCA_TEST_BAUD) || 115200
const ADDR = Number(process.env.VISCA_TEST_ADDR) || 1
const REPLY_TIMEOUT_MS = 2000

const args = process.argv.slice(2)
const includeDestructive = args.includes('--include-destructive')
const groupFilter = args.includes('--group') ? args[args.indexOf('--group') + 1] : null
const onlyFilter = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

if (!PORT) {
	console.error('Set VISCA_TEST_PORT to the camera serial device, e.g. VISCA_TEST_PORT=/dev/ttyUSB0')
	process.exit(2)
}

// --- serial transport (mirrors main.js's initSerial: 115200 8N1, DTR+RTS
// asserted for half-duplex RS-485 adapters) ---------------------------------
let SerialPort
try {
	;({ SerialPort } = await import('serialport'))
} catch (err) {
	console.error(`serialport import failed: ${err.message}`)
	process.exit(2)
}

const port = new SerialPort({ path: PORT, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false })

let rxbuf = Buffer.alloc(0)
let waiter = null // { resolve, timer }

function onData(chunk) {
	rxbuf = Buffer.concat([rxbuf, chunk])
	let idx
	while ((idx = rxbuf.indexOf(TERMINATOR)) >= 0) {
		const frame = rxbuf.subarray(0, idx + 1)
		rxbuf = rxbuf.subarray(idx + 1)
		handleFrame(frame)
	}
}

function handleFrame(frame) {
	if (frame.length < 2) return
	const kind = frame[1] & 0xf0
	// ACK (0x40) is not terminal; Completion/inquiry-reply (0x50) and error (0x60) are.
	if ((kind === 0x50 || kind === 0x60) && waiter) {
		const w = waiter
		waiter = null
		clearTimeout(w.timer)
		w.resolve({ kind, frame })
	}
}

// Strictly synchronous: register the reply listener, write the frame, wait
// for the OS to actually flush it to the wire (port.drain), THEN wait for
// the camera's terminal reply (or timeout) before returning. No command is
// ever in flight while another is still being sent or awaited.
async function sendAndWaitTerminal(payload) {
	if (waiter) return { kind: 'busy' }

	const replyPromise = new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiter = null
			resolve({ kind: 'timeout' })
		}, REPLY_TIMEOUT_MS)
		waiter = { resolve, timer }
	})

	await new Promise((resolve, reject) => {
		port.write(Buffer.from(buildFrame(ADDR, payload)), (err) => (err ? reject(err) : resolve()))
	})
	await new Promise((resolve, reject) => {
		port.drain((err) => (err ? reject(err) : resolve()))
	})

	return replyPromise
}

// A "set" command: returns { ok, errorCode } -- ok=true means ACK+Completion.
async function setCommand(payload) {
	const { kind, frame } = await sendAndWaitTerminal(payload)
	if (kind === 0x50) return { ok: true }
	if (kind === 0x60) return { ok: false, errorCode: frame[2] }
	return { ok: false, errorCode: null, note: kind === 'timeout' ? 'timeout' : String(kind) }
}

// An inquiry: returns { ok, value } or { ok: false, errorCode }.
async function inquire(inquiryId) {
	const q = INQUIRIES[inquiryId]
	const { kind, frame } = await sendAndWaitTerminal(q.payload)
	if (kind === 0x50) return { ok: true, value: decodeReply(q.decode, frame.subarray(2, frame.length - 1)) }
	if (kind === 0x60) return { ok: false, errorCode: frame[2] }
	return { ok: false, errorCode: null, note: kind === 'timeout' ? 'timeout' : String(kind) }
}

// --- known-lossy enum inquiries (hand-verified against the BSP source; a
// generic "does the set byte appear as a key in the readback's ENUM map"
// check is NOT safe here -- e.g. ENUM.wb lists Indoor/Outdoor/OnePush as
// possible labels, but wb_inquiry (visca_map_wb.c) only ever replies Auto or
// Manual, so those entries are dead weight in the map, not real return
// values). Each entry maps a COMMANDS choice label to the exact label the
// paired inquiry is known to report. `null` means "no value is observable
// via this inquiry for this choice" (skip the value check, ACK+Completion
// only). `'ERROR'` means this choice is a known-unimplemented VISCA path and
// should fail with VISCA_ERR_NOT_EXECUTABLE (0x41) -- a regression check.
const LOSSY_ENUM_EXPECT = {
	cam_ae: { Auto: 'FullAuto', Manual: 'Manual', 'Shutter Pri': 'FullAuto' },
	cam_wb: { Auto: 'Auto', Indoor: null, Outdoor: null, Manual: 'Manual', Trigger: null },
	cam_flicker: { Off: '50Hz', '50Hz': '50Hz', '60Hz': '60Hz' },
}

// --- RUD reset targets + step sizes (hand-transcribed from the BSP; see
// visca_map_exposure.c/visca_map_wb.c/visca_map_picture.c/visca_map_dct_ext.c).
// `reset`/`step`/`min`/`max` are the REAL ProVideo values the firmware's own
// read-modify-write logic works in -- cam_gain/cam_shutter's Up/Down/Reset
// all operate on the real "cam_gain"/"cam_exposure" value server-side. But
// their INQUIRY reply is the RAW WIRE value (map_gain/map_exposure's inverse,
// same linear scale the Direct SET side uses), not the real value -- so a
// `scale` descriptor is needed to convert the raw reading back to real units
// before comparing. cam_rgain/cam_bgain/cam_bright have no `scale` because
// their wire encoding already IS the real value 1:1 (no scaling function in
// the BSP at all for those). ---
const RUD_SPEC = {
	cam_gain: { verify: 'gain', reset: 1000, step: 109, min: 1000, max: 45715, scale: { min: 1000, max: 45715, rawMax: 4095 } },
	cam_shutter: { verify: 'shutter', reset: 1000, step: 93, min: 100, max: 38339, scale: { min: 100, max: 38339, rawMax: 4095 } },
	cam_rgain: { verify: 'rgain', reset: 512, step: 10, min: 0, max: 4095 },
	cam_bgain: { verify: 'bgain', reset: 512, step: 10, min: 0, max: 4095 },
	cam_bright: { verify: 'bright', reset: 0, step: 5, min: -128, max: 127 },
}

// Inverse of the BSP's map_gain/map_exposure (raw wire value -> real
// ProVideo value), for RUD specs with a `scale` descriptor. Lossy (matches
// the same ~(max-min)/rawMax granularity the wire encoding itself has), so
// callers must compare with a tolerance, not exact equality.
function rawToReal(raw, spec) {
	if (!spec.scale) return raw
	const { min, max, rawMax } = spec.scale
	return min + Math.round((raw * (max - min)) / rawMax)
}

// One raw wire step's worth of real-unit imprecision, plus a small buffer --
// wider than the flat tolerance=2 used for non-scaled/direct comparisons.
function rudTolerance(spec) {
	if (!spec.scale) return 2
	return Math.ceil((spec.scale.max - spec.scale.min) / spec.scale.rawMax) + 2
}

// A generic direct-command inquiry doesn't exist for these (no ProVideo data
// source backs the readback) -- SET-only, ACK+Completion check.
const NO_VERIFY_DIRECT = new Set(['color_temp_direct'])

// Gain (ISO)/Shutter (Speed) share cam_gain_direct's/cam_shutter_direct's
// exact wire encoding (already exercised by runDirect), so a "few" spot
// checks (not all 18/17 named steps) are enough here to confirm the real
// hardware accepts the GAIN_ISO/SHUTTER_SPEEDS table's computed raw values --
// min, a mid-range value, and max, per control.
const ISO_SPOT_CHECK = [140, 800, 6400]
const SHUTTER_SPOT_CHECK = [8000, 500, 30]

// Destructive/risky on real hardware: writes EEPROM, reloads persisted
// settings, or (video mode) disrupts a live signal. Skipped unless
// --include-destructive.
const DESTRUCTIVE_IDS = new Set(['cam_settings_save', 'cam_settings_reset', 'dct_load_settings', 'cam_system'])

// varId derivation for `direct` commands (mirrors continuousParams()' own rule).
function directVarId(id) {
	const base = id.endsWith('_direct') ? id.slice(0, -'_direct'.length) : id
	return base.startsWith('cam_') ? base.slice(4) : base
}

const paramsById = Object.fromEntries(continuousParams().map((p) => [p.id, p]))

function pickTestValue(min, max) {
	return min + Math.floor((max - min) * 0.25)
}

// cam_ae's "Auto"/"Shutter Pri" choices re-enable AEC (aec 1), and
// cam_wb's "Auto" choice re-enables AWB (awb 1) -- both must run AFTER every
// other test case, or they'd silently undo withAutoModesDisabled() partway
// through the run and break every subsequent manual gain/exposure/WB-gain
// test. cam_gamma's "S-Log3" choice (its last, per COMMANDS.cam_gamma's key
// order) sets log_mode != LOG_MODE_OFF, which do_lut_mode/do_lut_fixed_mode
// (cmd_lut.c) and do_sdi_range (cmd_isp.c, specifically LOG_MODE_SLOG3) all
// hard-reject with -EFAULT -- so cam_gamma must run last too, or it silently
// breaks every LUT/SDI-range test for the rest of the run. Run gamma first,
// then AEC's cases, then WB's, matching the requested order.
const DEFERRED_ORDER = ['cam_gamma', 'cam_ae', 'cam_wb']

// --- build the test case list (same enumeration as tools/testplan generation) ---
function buildCases() {
	const main = []
	const deferred = []
	for (const [id, c] of Object.entries(COMMANDS)) {
		if (!includeDestructive && DESTRUCTIVE_IDS.has(id)) continue
		if (c.kind === 'video') continue // disrupts a live signal; not covered here
		if (groupFilter && c.group !== groupFilter) continue
		if (onlyFilter && !id.includes(onlyFilter) && !c.name.includes(onlyFilter)) continue

		const cases = DEFERRED_ORDER.includes(id) ? deferred : main
		if (c.kind === 'fixed') {
			cases.push({ id, label: c.name, run: () => runFixed(id) })
		} else if (c.kind === 'enum') {
			for (const choice of Object.keys(c.choices)) {
				cases.push({ id, label: `${c.name}: ${choice}`, run: () => runEnum(id, choice) })
			}
		} else if (c.kind === 'rud') {
			for (const action of c.rudChoices ?? Object.keys(RUD)) {
				cases.push({ id, label: `${c.name}: ${action}`, run: () => runRud(id, action) })
			}
		} else if (c.kind === 'direct') {
			cases.push({ id, label: c.name, run: () => runDirect(id) })
		} else if (c.kind === 'iso') {
			for (const iso of ISO_SPOT_CHECK) {
				cases.push({ id, label: `${c.name}: ISO ${iso}`, run: () => runIso(iso) })
			}
		} else if (c.kind === 'shutter') {
			for (const n of SHUTTER_SPOT_CHECK) {
				cases.push({ id, label: `${c.name}: 1/${n}`, run: () => runShutterSpeed(n) })
			}
		}
	}
	deferred.sort((a, b) => DEFERRED_ORDER.indexOf(a.id) - DEFERRED_ORDER.indexOf(b.id))
	return [...main, ...deferred]
}

// --- per-kind runners: return { pass, detail } -----------------------------

async function runFixed(id) {
	const c = COMMANDS[id]
	const res = await setCommand(c.bytes)
	return res.ok ? { pass: true, detail: 'ACK+Completion' } : { pass: false, detail: describeFailure(res) }
}

async function runEnum(id, choice) {
	const c = COMMANDS[id]
	const res = await setCommand(c.choices[choice])
	const lossy = LOSSY_ENUM_EXPECT[id]?.[choice]

	if (lossy === 'ERROR') {
		if (!res.ok && res.errorCode === 0x41) return { pass: true, detail: 'correctly errors (known unimplemented)' }
		return { pass: false, detail: res.ok ? 'expected ERROR 0x41 but command succeeded' : describeFailure(res) }
	}
	if (!res.ok) return { pass: false, detail: describeFailure(res) }
	if (lossy === null) return { pass: true, detail: 'ACK+Completion (no observable readback for this choice)' }
	if (lossy !== undefined) return await checkEnumReadback(inquiryIdFor(id), lossy)

	// Generic path: does the set byte appear as a key in the readback's own
	// ENUM map? If so it's an exact, non-lossy passthrough -- verify it.
	const qId = inquiryIdFor(id)
	const q = qId && INQUIRIES[qId]
	if (!q || q.decode.type !== 'enum') return { pass: true, detail: 'ACK+Completion (no inquiry to verify against)' }
	const setByte = c.choices[choice][c.choices[choice].length - 1]
	const expectedLabel = q.decode.map[setByte]
	if (expectedLabel === undefined) return { pass: true, detail: 'ACK+Completion (choice byte not in readback map)' }
	return await checkEnumReadback(qId, expectedLabel)
}

async function checkEnumReadback(inquiryId, expectedLabel) {
	if (!inquiryId) return { pass: true, detail: 'ACK+Completion (no matching inquiry id)' }
	const inq = await inquire(inquiryId)
	if (!inq.ok) return { pass: false, detail: `readback failed: ${describeFailure(inq)}` }
	if (inq.value === expectedLabel) return { pass: true, detail: `readback = ${inq.value}` }
	return { pass: false, detail: `expected ${expectedLabel}, read back ${inq.value}` }
}

// Maps a COMMANDS enum id to its verification INQUIRIES id (the two tables
// are 1:1 except for a handful of standard-VISCA irregulars).
const ENUM_VERIFY_MAP = {
	cam_ae: 'ae_mode',
	cam_wb: 'wb_mode',
	cam_gamma: 'gamma',
	cam_flip: 'flip',
	cam_flicker: 'flicker',
	dct_ggain: 'dct_ggain',
	dct_gain_mode: 'dct_gain_mode',
	dct_cnr_auto: 'dct_cnr_auto',
	dct_dpf_enable: 'dct_dpf_enable',
	dct_filter_enable: 'dct_filter_enable',
	dct_sdi_range: 'dct_sdi_range',
	dct_audio_enable: 'dct_audio_enable',
	dct_auto_save: 'dct_auto_save',
	dct_timecode_hold: 'dct_timecode_hold',
}
function inquiryIdFor(id) {
	return ENUM_VERIFY_MAP[id] ?? null
}

async function runRud(id, action) {
	const spec = RUD_SPEC[id]
	const c = COMMANDS[id]
	if (action === 'reset') {
		const res = await setCommand([0x01, 0x04, c.func, RUD.reset])
		if (!res.ok) return { pass: false, detail: describeFailure(res) }
		if (!spec) return { pass: true, detail: 'ACK+Completion' }
		const inq = await inquire(spec.verify)
		if (!inq.ok) return { pass: false, detail: `readback failed: ${describeFailure(inq)}` }
		const got = rawToReal(Number(inq.value), spec)
		return Math.abs(got - spec.reset) <= rudTolerance(spec)
			? { pass: true, detail: `readback = ${got}` }
			: { pass: false, detail: `expected ${spec.reset}, read back ${got}` }
	}

	// up/down: read current value first (never assume state from a prior test).
	if (!spec) {
		const res = await setCommand([0x01, 0x04, c.func, RUD[action]])
		return res.ok ? { pass: true, detail: 'ACK+Completion' } : { pass: false, detail: describeFailure(res) }
	}
	const before = await inquire(spec.verify)
	if (!before.ok) return { pass: false, detail: `pre-read failed: ${describeFailure(before)}` }
	const cur = rawToReal(Number(before.value), spec)
	const delta = action === 'up' ? spec.step : -spec.step
	const expected = Math.max(spec.min, Math.min(spec.max, cur + delta))

	const res = await setCommand([0x01, 0x04, c.func, RUD[action]])
	if (!res.ok) return { pass: false, detail: describeFailure(res) }
	const after = await inquire(spec.verify)
	if (!after.ok) return { pass: false, detail: `post-read failed: ${describeFailure(after)}` }
	const got = rawToReal(Number(after.value), spec)
	return Math.abs(got - expected) <= rudTolerance(spec)
		? { pass: true, detail: `${cur} -> ${got} (expected ~${expected})` }
		: { pass: false, detail: `${cur} -> ${got}, expected ~${expected}` }
}

async function runDirect(id) {
	const c = COMMANDS[id]
	const p = paramsById[id]
	const value = pickTestValue(p.min, p.max)
	const mask = (1 << (4 * c.nibbles)) - 1
	const res = await setCommand([...c.prefix, ...encodeNibbles(value & mask, c.nibbles)])
	if (!res.ok) return { pass: false, detail: describeFailure(res) }

	if (NO_VERIFY_DIRECT.has(id)) return { pass: true, detail: `set ${value} (no readback available)` }

	const qId = directVarId(id)
	const q = INQUIRIES[qId]
	if (!q) return { pass: true, detail: `set ${value} (no matching inquiry)` }
	const inq = await inquire(qId)
	if (!inq.ok) return { pass: false, detail: `readback failed: ${describeFailure(inq)}` }
	const got = Number(inq.value)
	// tolerance=2: covers rounding in linear-scaled fields; x2/x16-scaled
	// fields and plain clamps round-trip exactly.
	return Math.abs(got - value) <= 2
		? { pass: true, detail: `set ${value}, read back ${got}` }
		: { pass: false, detail: `set ${value}, read back ${got}` }
}

// Gain (ISO)/Shutter (Speed) share cam_gain_direct's/cam_shutter_direct's
// exact wire prefix, and their inquiry ('gain'/'shutter') replies the RAW
// wire value too (same as runDirect's check) -- so this just confirms real
// hardware round-trips the GAIN_ISO/SHUTTER_SPEEDS table's precomputed raw
// value for a given named step, not a re-derivation of the ISO/shutter math
// itself (that's covered by the commands.js unit tests).
async function runIso(iso) {
	const c = COMMANDS.cam_gain_iso
	const { raw } = GAIN_ISO.find((g) => g.iso === iso)
	const res = await setCommand([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
	if (!res.ok) return { pass: false, detail: describeFailure(res) }
	const inq = await inquire('gain')
	if (!inq.ok) return { pass: false, detail: `readback failed: ${describeFailure(inq)}` }
	const got = Number(inq.value)
	return Math.abs(got - raw) <= 2
		? { pass: true, detail: `ISO ${iso} -> raw ${raw}, read back ${got}` }
		: { pass: false, detail: `ISO ${iso} -> raw ${raw}, read back ${got}` }
}

async function runShutterSpeed(n) {
	const c = COMMANDS.cam_shutter_speed
	const { raw } = SHUTTER_SPEEDS.find((s) => s.n === n)
	const res = await setCommand([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
	if (!res.ok) return { pass: false, detail: describeFailure(res) }
	const inq = await inquire('shutter')
	if (!inq.ok) return { pass: false, detail: `readback failed: ${describeFailure(inq)}` }
	const got = Number(inq.value)
	return Math.abs(got - raw) <= 2
		? { pass: true, detail: `1/${n} -> raw ${raw}, read back ${got}` }
		: { pass: false, detail: `1/${n} -> raw ${raw}, read back ${got}` }
}

function describeFailure(res) {
	if (res.errorCode != null) return `ERROR 0x${res.errorCode.toString(16)}`
	if (res.note) return res.note
	return 'unknown failure'
}

// AEC/AWB actively fight manual gain/exposure/WB-gain sets in real time (the
// auto-exposure/auto-white-balance loop re-adjusts on the very next frame),
// so a manual `cam_gain`/`cam_shutter`/`cam_rgain`/`cam_bgain` set can never
// be observed to hold via inquiry while they're running. Force both to
// Manual for the duration of the run. Afterwards -- regardless of what was
// running before the test started -- turn AEC/AWB back on, then reset every
// setting the run touched back to defaults (`reset_settings`, confirmed
// reachable on real hardware). `reset_settings` is always the last command
// sent to the camera.
async function withAutoModesDisabled(fn) {
	console.log('Disabling AWB and AEC for the duration of this run (manual gain/exposure/WB-gain tests need them off to hold a set value)...')
	await setCommand(COMMANDS.cam_wb.choices['Manual'])
	await setCommand(COMMANDS.cam_ae.choices['Manual'])

	try {
		await fn()
	} finally {
		console.log('\nTurning AEC/AWB back on and resetting settings...')
		await setCommand(COMMANDS.cam_ae.choices['Auto'])
		await setCommand(COMMANDS.cam_wb.choices['Auto'])
		const reset = await setCommand(COMMANDS.cam_settings_reset.bytes)
		console.log(reset.ok ? 'reset_settings: ok' : `reset_settings: ${describeFailure(reset)}`)
	}
}

// --- run ---------------------------------------------------------------
async function main() {
	const cases = buildCases()
	console.log(`${cases.length} test case(s) queued${includeDestructive ? ' [destructive included]' : ''}. Connecting to ${PORT}...`)

	await new Promise((resolve, reject) => {
		port.open((err) => (err ? reject(err) : resolve()))
	})
	try {
		port.set({ dtr: true, rts: true }, () => {})
	} catch (_) {
		// ignore
	}
	port.on('data', onData)
	console.log(`Connected. Running against camera address ${ADDR}...\n`)

	let pass = 0
	let fail = 0
	const failures = []
	await withAutoModesDisabled(async () => {
		for (const tc of cases) {
			let result
			try {
				result = await tc.run()
			} catch (err) {
				result = { pass: false, detail: `threw: ${err.message}` }
			}
			if (result.pass) {
				pass++
				console.log(`  ok  ${tc.label} -- ${result.detail}`)
			} else {
				fail++
				failures.push({ label: tc.label, detail: result.detail })
				console.log(`FAIL  ${tc.label} -- ${result.detail}`)
			}
		}
	})

	console.log(`\n${pass}/${cases.length} passed`)
	if (failures.length) {
		console.log('\nFailures:')
		for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`)
	}

	port.close()
	process.exit(fail ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(2)
})
