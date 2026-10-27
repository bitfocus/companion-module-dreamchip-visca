// VISCA command/inquiry registry for the DCT VISCA Companion module.
// The standard VISCA camera set plus Dream Chip vendor extensions (category
// 0x7E); pan/tilt/zoom/focus are out of scope.
//
// Each COMMANDS entry has one `kind`:
//   enum   - labelled choices -> full payload bytes
//   rud    - reset/up/down -> 01 04 <func> {00|02|03}
//   direct - <prefix> + value split into <nibbles> low-nibble bytes
//   fixed  - no-argument payload
//   video  - cam_system video mode via the SYSTEM table
//   iso    - cam_gain via the curated GAIN_ISO named-step table
//   shutter - cam_exposure via the curated SHUTTER_SPEEDS named-step table
// INQUIRIES entries carry a payload + a decode descriptor (enum|value|version|system).

export const TERMINATOR = 0xff

// --- shared enum maps (reply byte -> label) --------------------------------
export const ENUM = {
	wb: { 0x00: 'Auto', 0x01: 'Indoor', 0x02: 'Outdoor', 0x03: 'OnePush', 0x05: 'Manual', 0x20: 'ColorTemp' },
	ae: { 0x00: 'FullAuto', 0x03: 'Manual', 0x0a: 'ShutterPriority' },
	gamma: { 0x00: 'BT709', 0x01: 'HLG', 0x02: 'PQ', 0x03: 'SLOG3' },
	flicker: { 0x01: '50Hz', 0x02: '60Hz' },
	flip: { 0x00: 'Off', 0x01: 'Flip-H', 0x02: 'Flip-V', 0x03: 'Flip-HV' },
	// Dream Chip extension reply maps (raw camera value -> label)
	dct_onoff: { 0x00: 'Off', 0x01: 'On' },
	dct_gain_mode: { 0x00: 'Auto', 0x01: 'LCG', 0x02: 'HCG' },
	// SDI Range: 0 = legal range, 1 = full range.
	dct_sdi_range: { 0x00: 'Legal', 0x01: 'Full' },
	dct_timecode_hold: { 0x00: 'Run', 0x01: 'Hold' },
}

// video_mode -> [b2, b3] for cam_system (8x 01 04 24 00 00 b2 b3 FF).
export const SYSTEM = {
	4: [0x00, 0x0e],
	5: [0x01, 0x00],
	6: [0x01, 0x02],
	7: [0x01, 0x01],
	9: [0x00, 0x03],
	10: [0x00, 0x02],
	11: [0x00, 0x00],
	12: [0x00, 0x01],
}
// video_mode index -> human label (the camera's canonical video-mode names).
// Keyed identically to SYSTEM.
export const SYSTEM_NAMES = {
	4: '1080p30',
	5: '1080p25',
	6: '1080p24',
	7: '1080p23.98',
	9: '1080p50',
	10: '1080p60',
	11: '1080i60',
	12: '1080i50',
}
const SYSTEM_INQ = {}
for (const [vm, [b2, b3]] of Object.entries(SYSTEM)) SYSTEM_INQ[`${b2},${b3}`] = Number(vm)

// --- Gain (ISO) named-step table (currently fitted sensor ONLY) ------------
// cam_gain's wire value is a raw 3-nibble 0-4095 that the camera firmware
// linearly scales onto a "real gain unit" range 1000-45715 via truncating
// integer division (real = 1000 + raw*44715/4095). The current sensor
// defines ISO in real-gain units as real_gain_unit(ISO) =
// floor(ISO*1000/140), with 140 ISO as the 1x/0dB floor (the
// 140-ISO-per-1000-gain-unit proportionality is confirmed by multiple
// independent sources). Inverting the scaling with the SAME truncating
// integer division gives the raw wire value for an ISO:
//   raw(ISO) = trunc((floor(ISO*1000/140) - 1000) * 4095 / 44715), clamped 0-4095
// NOTE (trunc, not round): the firmware's inverse is C integer division
// (truncation); Math.round would give different raw values for ~half the
// steps (e.g. ISO 6400 -> 4095 instead of the correct 4094).
//
// CAVEAT: the 140 / 1000-45715 constants are SPECIFIC TO THE CURRENTLY
// FITTED SENSOR. Other sensor variants (IMX274, IMX421) use different
// constants, and VISCA cannot detect which sensor is fitted. This is
// deliberately hardcoded for the currently fitted sensor per project
// decision -- do NOT try to make it sensor-agnostic.
export const GAIN_ISO_MIN = 140 // base (1x/0dB) ISO of the fitted sensor
const GAIN_REAL_MIN = 1000
const GAIN_REAL_MAX = 45715
const GAIN_RAW_MAX = 4095
export function isoToGainRaw(iso) {
	const realUnit = Math.floor((iso * 1000) / GAIN_ISO_MIN)
	const raw = Math.trunc(((realUnit - GAIN_REAL_MIN) * GAIN_RAW_MAX) / (GAIN_REAL_MAX - GAIN_REAL_MIN))
	return Math.max(0, Math.min(GAIN_RAW_MAX, raw))
}
// Curated third-stop ISO steps offered in the "Gain (ISO)" dropdown/presets.
// The step LIST is arbitrary/curated (not derivable) so it's a literal; the
// raw column is computed from isoToGainRaw() at load time so it can never
// drift from the formula.
export const GAIN_ISO_STEPS = [
	140, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400,
]
export const GAIN_ISO = GAIN_ISO_STEPS.map((iso) => ({ iso, raw: isoToGainRaw(iso) }))
// Inverse of isoToGainRaw()'s underlying scaling -- for DISPLAYING the
// Gain (direct) knob's current raw value as an ISO number (the knob still
// steps in raw units; only the shown text changes). We're going raw -> real
// -> ISO here, not back through the firmware's own truncating raw(ISO)
// inverse, so ordinary rounding would be fine numerically -- rounds UP
// (ceil) instead per project preference, so the displayed ISO never reads
// slightly under the real sensitivity actually in effect.
export function gainRawToIso(raw) {
	const real = GAIN_REAL_MIN + Math.trunc((raw * (GAIN_REAL_MAX - GAIN_REAL_MIN)) / GAIN_RAW_MAX)
	return Math.ceil((real / 1000) * GAIN_ISO_MIN)
}

// --- Shutter (Speed) named-step table ---------------------------------------
// cam_exposure's wire value is a raw 3-nibble 0-4095 that the camera
// firmware linearly scales onto a real microsecond range 100-38339us via
// truncating integer division (real = 100 + raw*38239/4095). Shutter speed
// is expressed to the user
// as a photographic "1/n second" fraction; converting n -> microseconds
// (round(1e6/n)) is a plain unit conversion, not a firmware constant, so it
// uses ordinary rounding to the nearest microsecond. Converting that real
// microsecond value to the raw wire value DOES have to match the firmware's
// exact truncating integer division (same reasoning as Gain (ISO) above):
//   us(n)   = round(1e6 / n)
//   raw(us) = trunc((clamp(us, 100, 38339) - 100) * 4095 / 38239)
const SHUTTER_REAL_MIN = 100
const SHUTTER_REAL_MAX = 38339
const SHUTTER_RAW_MAX = 4095
export function shutterUsToRaw(us) {
	const clamped = Math.max(SHUTTER_REAL_MIN, Math.min(SHUTTER_REAL_MAX, us))
	return Math.trunc(((clamped - SHUTTER_REAL_MIN) * SHUTTER_RAW_MAX) / (SHUTTER_REAL_MAX - SHUTTER_REAL_MIN))
}
// Curated 1/n shutter-speed steps offered in the "Shutter (Speed)"
// dropdown/presets. The step LIST is arbitrary/curated (not derivable) so
// it's a literal; us/raw are computed at load time so they can never drift
// from the formula.
export const SHUTTER_SPEED_STEPS = [8000, 4000, 2000, 1000, 800, 600, 500, 400, 250, 200, 125, 120, 100, 60, 50, 33, 30]
export const SHUTTER_SPEEDS = SHUTTER_SPEED_STEPS.map((n) => {
	const us = Math.round(1e6 / n)
	return { n, us, raw: shutterUsToRaw(us) }
})
// Inverse of shutterUsToRaw()'s underlying scaling -- for DISPLAYING
// the Shutter (direct) knob's current raw value in microseconds.
export function shutterRawToUs(raw) {
	return SHUTTER_REAL_MIN + Math.trunc((raw * (SHUTTER_REAL_MAX - SHUTTER_REAL_MIN)) / SHUTTER_RAW_MAX)
}

// --- other knob display formatters (raw wire value -> human-readable text) -
// Audio Gain's wire value is a raw 3-nibble 0-4095 that the firmware scales
// ×16 onto a 4.12 fixed-point real amplitude (real=4096 -> 1.0x/0dB unity);
// dB = 20*log10(ratio).
const AUDIO_GAIN_UNITY_REAL = 4096
// Numeric dB (not the display string below) -- also used to position the
// knob's progress bar on a dB scale instead of the raw wire value, so 0dB
// sits at the visual center of the bar (see AUDIO_GAIN_BAR_MIN/MAX) instead
// of near the left edge (raw=256/4095 is only ~6% of the way across).
export function audioGainRawToDbValue(raw) {
	const real = raw * 16
	return 20 * Math.log10(real / AUDIO_GAIN_UNITY_REAL)
}
export function audioGainRawToDb(raw) {
	return audioGainRawToDbValue(raw).toFixed(1)
}
// Symmetric dB window for the progress bar ONLY (not the selectable range --
// raw is still 0-4095/0..~24.08dB): a floor mirroring the real +24.08dB
// ceiling, so 0dB (raw=256, the knob-reset default) renders at the bar's
// midpoint. Values below the floor (very low raw, including -Infinity at
// raw=0) just clamp to the bar's left edge.
export const AUDIO_GAIN_BAR_MAX = 24.08
export const AUDIO_GAIN_BAR_MIN = -AUDIO_GAIN_BAR_MAX
// Color Hue's raw wire value is 128/90 counts per degree (see cam_color_hue_direct);
// inverse: degrees = raw * 90/128.
export function hueRawToDeg(raw) {
	return ((raw * 90) / 128).toFixed(1)
}
// Red/Blue/Green Gain are FP4.8-style, unity gain = 256 raw.
export function wbGainFactor(raw) {
	return (raw / 256).toFixed(2)
}
// Color Gain (saturation) unity = 128 raw (a different unit than the
// WB channel gains above, despite the similar "gain" name).
export function saturationFactor(raw) {
	return (raw / 128).toFixed(2)
}
// LUT Fast Gamma's wire value pq is offset+scaled by the camera firmware onto
// the real gamma: gamma = (1100 + pq*8) / 1000, so raw 140 displays as 2.220.
export function lutFastGammaRawToGamma(raw) {
	return ((1100 + raw * 8) / 1000).toFixed(3)
}

// --- codec (ported from visca_frame.py) ------------------------------------
export function encodeNibbles(value, n) {
	const out = []
	for (let i = 0; i < n; i++) out.push((value >> (4 * (n - 1 - i))) & 0x0f)
	return out
}
export function decodeNibbles(bytes) {
	let v = 0
	for (const b of bytes) v = (v << 4) | (b & 0x0f)
	return v
}
// Reinterpret an unsigned nibble-decoded value as two's-complement signed
// (e.g. Color Hue's -128..127 is wire-encoded as an unsigned byte via the same
// 2-nibble encoding as any other value, then reinterpreted on decode).
export function toSigned(raw, nibbles) {
	const half = 1 << (4 * nibbles - 1)
	return raw >= half ? raw - half * 2 : raw
}
export function buildFrame(address, payload) {
	return Buffer.from([0x80 | (address & 0x0f), ...payload, TERMINATOR])
}

// Decode an inquiry reply payload (bytes between `y0 50` and the FF) to a string.
export function decodeReply(decode, payload) {
	switch (decode.type) {
		case 'enum': {
			if (!payload.length) return '?'
			return decode.map[payload[0]] ?? '0x' + payload[0].toString(16).padStart(2, '0')
		}
		case 'value': {
			const raw = decodeNibbles(payload)
			// `decode.nibbles`, not `payload.length`: some real inquiry replies
			// (e.g. the signed Color Hue/Bright replies) always pad to a fixed
			// "00 00 0p 0q" 4-byte shape even though the
			// real value is only 2 nibbles wide -- using the padded byte count
			// as the two's-complement bit-width would misread negative values
			// as large positive ones.
			const bits = decode.nibbles ?? payload.length
			return String(decode.signed ? toSigned(raw, bits) : raw)
		}
		case 'system': {
			if (payload.length >= 4) {
				const vm = SYSTEM_INQ[`${payload[2]},${payload[3]}`]
				if (vm !== undefined) return SYSTEM_NAMES[vm] ?? String(vm)
			}
			return Buffer.from(payload).toString('hex')
		}
		case 'version': {
			if (payload.length >= 7) {
				const w = (i) => (((payload[i] << 8) | payload[i + 1]) >>> 0).toString(16).padStart(4, '0')
				return `vendor=0x${w(0)} model=0x${w(2)} version=0x${w(4)} sockets=${payload[6]}`
			}
			return Buffer.from(payload).toString('hex')
		}
		default:
			return Buffer.from(payload).toString('hex')
	}
}

// Tone Mapping Mode's 5 named states, index ==
// wire value == raw wire nibble. Single source of truth for both
// dct_tm_mode's knob display and dct_tm_mode_preset's per-choice buttons, so
// the labels/choices/values can never drift apart.
const TM_MODE_LABELS = ['Off', '+0.5EV', '+1.0EV', '+1.5EV', '+2.0EV']

// Color Space's 3 named states, index == wire value == raw wire nibble.
// Single source of truth
// for both dct_color_space's knob display and dct_color_space_preset's
// per-choice buttons, so the labels/choices/values can never drift apart.
const COLOR_SPACE_LABELS = ['Rec.709', 'Rec.2020', 'SGam3.Cine']

// Black R/G/B's real factory default is NOT 0 -- it's a per-model
// factory calibration constant: 256 on Atom Two, 16 on Atom Two HDR.
// Unlike Contrast's raw-128 (a fixed point
// baked into the wire encoding itself), this default varies by connected
// camera, so dct_black_red/green/blue's format needs to know the model
// (passed as its 2nd arg by the knob_value feedback, main.js) to show a
// "0 at factory default" delta. Model unknown (no version reply yet) shows
// the real value with no delta rather than guessing a default.
const BLACK_DEFAULT_BY_MODEL = { 'atom-two': 256, 'atom-two-hdr': 16 }
function formatBlackDelta(raw, model) {
	const real = raw * 2
	const def = BLACK_DEFAULT_BY_MODEL[model]
	if (def === undefined) return String(real)
	const delta = real - def
	return delta > 0 ? `+${delta}` : String(delta)
}

// --- SET commands ----------------------------------------------------------
const P = (...b) => b // tiny helper to keep the table readable
export const COMMANDS = {
	// System
	if_clear: { name: 'IF Clear', group: 'System', kind: 'fixed', bytes: P(0x01, 0x00, 0x01) },
	cam_settings_save: { name: 'Settings Save', group: 'System', kind: 'fixed', bytes: P(0x01, 0x04, 0xa5, 0x10) },
	cam_settings_reset: { name: 'All Reset', group: 'System', kind: 'fixed', bytes: P(0x01, 0x04, 0xa0, 0x10) },

	// Video mode (see SYSTEM dialect caveat)
	cam_system: { name: 'Video', group: 'Video Modes', kind: 'video' },

	// Exposure / AEC
	cam_ae: {
		name: 'AE',
		group: 'Exposure',
		kind: 'enum',
		choices: {
			Auto: P(0x01, 0x04, 0x39, 0x00),
			Manual: P(0x01, 0x04, 0x39, 0x03),
			'Shutter Pri': P(0x01, 0x04, 0x39, 0x0a),
		},
	},
	// Reset/Up/Down is the standard VISCA CAM_Gain structure. Up/Down are a
	// firmware-side read-modify-write of cam_gain's real value (query current
	// value, step by ~109 gain units -- the same "10 raw nibble-steps' worth"
	// density as the Red/Blue/Green Gain controls' step -- clamp to
	// 1000-45715, resend).
	cam_gain: { name: 'Gain', group: 'Exposure', kind: 'rud', func: 0x0c },
	// cam_gain's real range is 1000-45715 (1x/0dB/140 ISO min; max is the
	// top of the camera's gain range); widened to 3
	// nibbles (0-4095) for ~10.9 gain units per step, matching the camera
	// firmware.
	// logScale, same reasoning as dct_audio_gain: gain is perceived/graded in
	// stops/dB (logarithmic), not linear raw units -- trying it here too.
	// `step` is irrelevant under logScale (adjustParam() only uses its sign),
	// so it's dropped in favor of stepPercent.
	cam_gain_direct: {
		name: 'Gain (direct)',
		group: 'Exposure',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x4c, 0x00, 0x00),
		nibbles: 3,
		logScale: true,
		stepPercent: 5,
		minStep: 4,
		format: (raw) => `ISO ${gainRawToIso(raw)}`,
	},
	// Gain (ISO): a curated dropdown of named third-stop ISO values that map
	// to the SAME wire command as cam_gain_direct (01 04 4C
	// ...) via the GAIN_ISO table above. Purely additive -- the raw
	// cam_gain_direct number control is left untouched for manual/precise entry.
	cam_gain_iso: { name: 'Gain', group: 'Exposure', kind: 'iso', prefix: P(0x01, 0x04, 0x4c, 0x00, 0x00), nibbles: 3 },
	// Reset/Up/Down is the standard VISCA CAM_Shutter structure. Up/Down are a
	// firmware-side read-modify-write of cam_exposure's real value (query
	// current value, step by ~93us -- the same "10 raw nibble-steps' worth"
	// density as the Red/Blue/Green Gain controls' step -- clamp to
	// 100-38339us, resend).
	cam_shutter: { name: 'Shutter', group: 'Exposure', kind: 'rud', func: 0x0a },
	// cam_exposure's real range is 100-38339us (observed on real hardware);
	// widened to 3 nibbles (0-4095) for ~9.3us per step, matching the camera
	// firmware.
	// logScale (like Gain above): shutter speed is perceived/graded in stops,
	// not linear microseconds. `min` floors the fastest selectable manual
	// shutter at 200us (project decision), computed from shutterUsToRaw() so
	// it can never drift from the real<->raw formula above -- +1 because
	// shutterUsToRaw() truncates DOWN, so the raw for exactly 200us actually
	// maps back to ~193us (faster than the requested floor); the next raw up
	// is the first one that's truly >=200us.
	cam_shutter_direct: {
		name: 'Shutter (direct)',
		group: 'Exposure',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x4a, 0x00, 0x00),
		nibbles: 3,
		logScale: true,
		stepPercent: 5,
		minStep: 4,
		min: shutterUsToRaw(200) + 1,
		format: (raw) => `${shutterRawToUs(raw)} µs`,
	},
	// Shutter (Speed): a curated dropdown of named 1/n shutter speeds that map
	// to the SAME wire command as cam_shutter_direct (01 04 4A ...) via the
	// SHUTTER_SPEEDS table above. Purely additive -- the raw cam_shutter_direct
	// number control is left untouched for manual/precise entry.
	cam_shutter_speed: {
		name: 'Shutter',
		group: 'Exposure',
		kind: 'shutter',
		prefix: P(0x01, 0x04, 0x4a, 0x00, 0x00),
		nibbles: 3,
	},
	cam_flicker: {
		name: 'Flicker',
		group: 'Exposure',
		kind: 'enum',
		choices: { Off: P(0x01, 0x04, 0x23, 0x00), '50Hz': P(0x01, 0x04, 0x23, 0x01), '60Hz': P(0x01, 0x04, 0x23, 0x02) },
	},

	// White balance
	// The standard VISCA set also defines a "One Push" WB mode (0x35/0x03),
	// but it lands on the exact same camera-side action as Manual (selecting
	// either just disables continuous auto-WB, it
	// doesn't calculate anything by itself; see Trigger below for the command
	// that actually runs the one-push calculation), so it's not exposed as a
	// separate choice here.
	cam_wb: {
		name: 'WB',
		group: 'White Balance',
		kind: 'enum',
		choices: {
			Auto: P(0x01, 0x04, 0x35, 0x00),
			Indoor: P(0x01, 0x04, 0x35, 0x01),
			Outdoor: P(0x01, 0x04, 0x35, 0x02),
			Manual: P(0x01, 0x04, 0x35, 0x05),
			Trigger: P(0x01, 0x04, 0x10, 0x05),
		},
	},
	cam_rgain: { name: 'Red Gain', group: 'White Balance', kind: 'rud', func: 0x03 },
	// Red WB gain's real range is 0-4095 (the camera's AWB-gain maximum);
	// widened to 3 nibbles
	// so the wire encoding represents it exactly.
	cam_rgain_direct: {
		name: 'Red Gain (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x43, 0x00, 0x00),
		nibbles: 3,
		format: (raw) => `${wbGainFactor(raw)}x`,
	},
	cam_bgain: { name: 'Blue Gain', group: 'White Balance', kind: 'rud', func: 0x04 },
	// Blue WB gain's real range is 0-4095; widened to 3 nibbles.
	cam_bgain_direct: {
		name: 'Blue Gain (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x44, 0x00, 0x00),
		nibbles: 3,
		format: (raw) => `${wbGainFactor(raw)}x`,
	},
	// Color saturation's real range is 0-255; the
	// VISCA wire format is widened to 2 nibbles to match.
	cam_color_gain_direct: {
		name: 'Color Gain (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x49, 0x00, 0x00),
		nibbles: 2,
		format: (raw) => `${saturationFactor(raw)}x`,
	},
	// Color hue's real range is signed -128..127; wire
	// format widened from 1 nibble (unsigned 0-15, couldn't go negative at all).
	cam_color_hue_direct: {
		name: 'Color Hue (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x4f, 0x00, 0x00),
		nibbles: 2,
		signed: true,
		format: (raw) => `${hueRawToDeg(raw)}°`,
	},
	// The camera's calibration-profile presets each have a real Kelvin
	// rating, but there's no way to query which preset is currently active --
	// so this
	// is a raw preset-index passthrough with no Kelvin matching
	// (the camera's own bounds check rejects an out-of-range
	// index) and has no inquiry counterpart of its own. `max` narrows the
	// Companion-side UI/knob range to 0-9 -- the largest calibration profile
	// has 10 presets (indices 0-9); profile 0 only has 7 (0-6), so indices
	// 7-9 still correctly error there (confirmed on real hardware), but 0-9
	// is the real usable range across profiles, not the wire's full 0-4095.
	// Distinct from dct_wb_temp below, which DOES set a real settable Kelvin
	// value.
	color_temp_direct: {
		name: 'Color Temp Preset (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x20, 0x00, 0x00),
		nibbles: 2,
		min: 0,
		max: 9,
	},
	// dct_wb_temp sets the whitepoint by target Kelvin. The true min/max are
	// queried live per-sensor, but the UI range is hardcoded to the
	// real-world 2200-10000 K by project decision; the camera's own bounds
	// check remains the source of truth (a too-narrow or
	// slightly-off UI range is not unsafe). 4 nibbles carry the 16-bit Kelvin,
	// no scaling (Kelvin already is the real unit). The current whitepoint
	// reads back via INQUIRIES.dct_wb_temp (the knob's varId, derived by
	// continuousParams as dct_wb_temp); min/max/measure are separate
	// read-only inquiries (see below) sharing this same SS 0x0B via a
	// selector byte, since the camera returns all three values at once for
	// the base command and no
	// VISCA command in this module packs multiple values into one inquiry.
	// step: 50 overrides the generic knob preset's default step (main.js's
	// global `knobStep` config, meant for small/raw-range params) -- this
	// range spans 7800 real Kelvin, so that default is imperceptibly fine.
	dct_wb_temp: {
		name: 'Color Temp',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x0b),
		nibbles: 4,
		min: 2200,
		max: 10000,
		step: 50,
		format: (raw) => `${raw} K`,
	},

	// Picture
	cam_gamma: {
		name: 'Gamma',
		group: 'System',
		kind: 'enum',
		choices: {
			'BT.709': P(0x01, 0x04, 0x5b, 0x00),
			HLG: P(0x01, 0x04, 0x5b, 0x01),
			PQ: P(0x01, 0x04, 0x5b, 0x02),
			'S-Log3': P(0x01, 0x04, 0x5b, 0x03),
		},
	},
	// Bright's real range is signed -128..127, signed to match the camera
	// firmware. cam_bright's Direct form shares its RUD's
	// function byte (0x0d) -- the firmware disambiguates by packet length,
	// mirroring the Green Gain command's own dispatch style.
	// (The standard VISCA set also defines a 2nd, Direct-only "CAM_Brightness"
	// function (0xA1) that lands on this exact same camera-side control --
	// the firmware still answers it for other controllers, but it's a pure
	// duplicate of cam_bright_direct so it's deliberately not exposed here.)
	cam_bright: { name: 'Bright', group: 'System', kind: 'rud', func: 0x0d },
	cam_bright_direct: {
		name: 'Bright (direct)',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0x0d, 0x00, 0x00),
		nibbles: 2,
		signed: true,
	},
	// Contrast's real factory default/neutral is 128 (0x80, "1.0x" -- see
	// KNOB_PRESS_SET_VALUE in main.js), not the wire's own 0. This is a
	// display-only offset (raw - 128), NOT `signed: true` -- that flag is a
	// two's-complement reinterpretation (raw 0 stays 0, negative wraps from
	// the TOP of the wire range), which would give the wrong mapping here
	// (128 would decode to -128, not 0) and would also change the direct-
	// entry action's/inquiry's raw semantics, not just this display text.
	cam_contrast_direct: {
		name: 'Contrast (direct)',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x04, 0xa2, 0x00, 0x00),
		nibbles: 2,
		format: (raw) => {
			const v = raw - 128
			return v > 0 ? `+${v}` : String(v)
		},
	},
	// The standard VISCA set also defines cam_lr_reverse (func 0x61) and
	// cam_picture_flip (func 0x66) -- independent On/Off toggles of just the
	// horizontal or vertical bit of this same `flip` value via read-modify-
	// write. The firmware still answers both for other controllers, but
	// cam_flip's 4-state direct select already reaches every combination in
	// one command, so they're deliberately not exposed here.
	cam_flip: {
		name: 'Flip',
		group: 'System',
		kind: 'enum',
		choices: {
			Off: P(0x01, 0x04, 0xa4, 0x00),
			'Flip-H': P(0x01, 0x04, 0xa4, 0x01),
			'Flip-V': P(0x01, 0x04, 0xa4, 0x02),
			'Flip-HV': P(0x01, 0x04, 0xa4, 0x03),
		},
	},

	// --- DCT vendor extensions (category 0x7E, sub 0x01) ---------------------
	// Payloads are `01 7E 01 SS ...` (Dream Chip vendor extensions).
	// Grouped with White Balance (not DCT Gain) to match cam_rgain/cam_bgain --
	// all three are the same "per-channel WB gain" control; only its protocol
	// origin (DCT vendor extension, no standard-VISCA equivalent) differs.
	dct_ggain: {
		name: 'Green Gain',
		group: 'White Balance',
		kind: 'enum',
		choices: {
			Reset: P(0x01, 0x7e, 0x01, 0x01, 0x00),
			Up: P(0x01, 0x7e, 0x01, 0x01, 0x02),
			Down: P(0x01, 0x7e, 0x01, 0x01, 0x03),
		},
	},
	// Green WB gain's real range is 0-4095; widened to 3 nibbles.
	dct_ggain_direct: {
		name: 'Green Gain (direct)',
		group: 'White Balance',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x01, 0x00, 0x00),
		nibbles: 3,
		format: (raw) => `${wbGainFactor(raw)}x`,
	},
	dct_gain_mode: {
		name: 'Gain Mode',
		group: 'Exposure',
		kind: 'enum',
		choices: {
			Auto: P(0x01, 0x7e, 0x01, 0x02, 0x00),
			LCG: P(0x01, 0x7e, 0x01, 0x02, 0x01),
			HCG: P(0x01, 0x7e, 0x01, 0x02, 0x02),
		},
	},

	// Black Master's real range is signed -2048..2047 (a signed 12-bit
	// value); widened to 3 nibbles to represent it exactly.
	dct_black_master: {
		name: 'Black Master',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x03),
		nibbles: 3,
		signed: true,
	},
	// Black R/G/B's real range is signed -4096..4095;
	// kept at 3 nibbles (signed 12-bit, -2048..2047) with firmware scaling by 2
	// to cover -4096..4094 -- odd values and 4095 itself are unreachable, an
	// accepted precision tradeoff. `format` shows the delta from the real,
	// per-model factory default (see formatBlackDelta/BLACK_DEFAULT_BY_MODEL
	// above) instead of the raw wire value, display-only -- the knob's own
	// stepping/encoding stays in wire units (same treatment as Contrast's
	// raw-128 offset above: only the printed text changes).
	dct_black_red: {
		name: 'Black Red',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x04),
		nibbles: 3,
		signed: true,
		format: formatBlackDelta,
	},
	dct_black_green: {
		name: 'Black Green',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x05),
		nibbles: 3,
		signed: true,
		format: formatBlackDelta,
	},
	dct_black_blue: {
		name: 'Black Blue',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x06),
		nibbles: 3,
		signed: true,
		format: formatBlackDelta,
	},

	// Flare is a positional 3-channel control (red/green/blue) --
	// all 3 needed on every set (the camera has no single-channel form).
	// Firmware handles this via read-modify-write, same as the AEC fields
	// further down: it queries flare's current 3-value state, overrides just
	// the one channel below, and reissues the full command. Real range per
	// channel is 0-65535; raw is 0-4095, firmware
	// multiplies it by 16 (same x16 scale as Audio Gain).
	dct_flare_red: { name: 'Flare Red', group: 'System', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x07), nibbles: 3 },
	dct_flare_green: {
		name: 'Flare Green',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x1b),
		nibbles: 3,
	},
	dct_flare_blue: {
		name: 'Flare Blue',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x1c),
		nibbles: 3,
	},
	// AWB Speed's real range is 0-2 (the camera hard-rejects >2);
	// `max` narrows the Companion-side UI/knob range to what's
	// actually valid instead of the wire's full 1-nibble 0-15 capacity.
	dct_awb_speed: {
		name: 'AWB Speed',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x08),
		nibbles: 1,
		min: 0,
		max: 2,
	},
	// S-Log3 Master Gain's real range is signed -6..12 dB (hard-rejected
	// outside that by the camera firmware). Signed to
	// match the firmware's bespoke two's-complement handling (it's no longer a
	// generic unsigned passthrough); `min`/`max` narrow the
	// Companion-side UI/knob range from the wire's full signed -128..127.
	dct_slog3_gain: {
		name: 'S-Log3 Master Gain',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x09),
		nibbles: 2,
		signed: true,
		min: -6,
		max: 12,
	},
	// Color Space's real range is 0-2 (the camera hard-rejects outside 0-2);
	// `max` narrows the Companion-side UI/knob range from the
	// wire's full 1-nibble 0-15 capacity.
	dct_color_space: {
		name: 'Color Space',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x17),
		nibbles: 1,
		min: 0,
		max: 2,
		format: (raw) => COLOR_SPACE_LABELS[raw] ?? String(raw),
	},
	// Color Space: 3 individual per-choice buttons for the SAME wire command
	// as dct_color_space above -- purely additive, same pattern as Gain
	// (ISO)/Shutter (Speed); the raw Color Space (direct) number-input stays
	// for manual entry.
	dct_color_space_preset: {
		name: 'Color Space',
		group: 'System',
		kind: 'enum',
		choices: Object.fromEntries(COLOR_SPACE_LABELS.map((label, v) => [label, P(0x01, 0x7e, 0x01, 0x17, v)])),
	},
	// Tone Mapping Mode's real range is 0-4 (the camera hard-rejects outside
	// that). The old "off path is a firmware hack" caveat that kept this
	// excluded no longer applies -- current firmware implements mode 0 as a
	// proper identity tone curve.
	dct_tm_mode: {
		name: 'Tone Mapping Mode',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x21),
		nibbles: 1,
		min: 0,
		max: 4,
		format: (raw) => TM_MODE_LABELS[raw] ?? String(raw),
	},
	// Tone Mapping Mode: 5 individual per-choice buttons for the SAME wire
	// command as dct_tm_mode above -- purely additive, same pattern as Color
	// Space/Gain (ISO)/Shutter (Speed); the raw direct number-input stays for
	// manual entry.
	dct_tm_mode_preset: {
		name: 'Tone Mapping Mode',
		group: 'System',
		kind: 'enum',
		choices: Object.fromEntries(TM_MODE_LABELS.map((label, v) => [label, P(0x01, 0x7e, 0x01, 0x21, v)])),
	},
	// PQ Max Brightness's real range is 100-10000 cd/m2;
	// widened to 3 nibbles (0-4095) for ~2.4 cd/m2 per step, matching the
	// camera firmware.
	// step: 30 overrides the generic knob preset's default step (main.js's
	// global `knobStep` config, default 4) -- too fine for a 9900 cd/m2 span.
	dct_pq_max_bright: {
		name: 'PQ Max Brightness',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x22),
		nibbles: 3,
		step: 32,
	},
	dct_mcc_opmode: {
		name: 'MCC Op-Mode',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x40),
		nibbles: 1,
	},

	dct_cnr_auto: {
		name: 'CNR Auto',
		group: 'System',
		kind: 'enum',
		choices: { Off: P(0x01, 0x7e, 0x01, 0x11, 0x00), On: P(0x01, 0x7e, 0x01, 0x11, 0x01) },
	},
	dct_cnr_mode: { name: 'CNR Mode', group: 'System', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x10), nibbles: 1 },
	// The former DPF Enable/DPF Strength controls (function 0x13) no longer
	// exist in camera firmware -- on Marietta the denoise strength is Filter
	// Denoise below -- so they are removed rather than kept as
	// permanently-erroring dead code.
	dct_filter_enable: {
		name: 'Filter Enable',
		group: 'System',
		kind: 'enum',
		choices: { Off: P(0x01, 0x7e, 0x01, 0x14, 0x00), On: P(0x01, 0x7e, 0x01, 0x14, 0x01) },
	},
	// Filter Detail's real range is 0-31 (firmware hard-rejects >=32);
	// wire stays 2 nibbles (0-255, same as Filter Denoise's real 0-255), but
	// firmware now clamps raw values above 31 to 31 instead of erroring. `max`
	// narrows the Companion-side UI/knob range to what's actually usable,
	// instead of letting the wire's full 0-255 capacity leak through.
	dct_filter_detail: {
		name: 'Filter Detail',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x15),
		nibbles: 2,
		max: 31,
	},
	// Filter Denoise's real range is 0-255 on Atom Two; 1 nibble truncated it,
	// widened to 2 nibbles to match it exactly. Atom Two HDR's firmware only
	// accepts 0-7 (0 = off), so `modelMax` narrows the Companion-side UI/knob
	// range per camera model once the model is known (see effectiveMax()).
	dct_filter_denoise: {
		name: 'Filter Denoise',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x16),
		nibbles: 2,
		modelMax: { 'atom-two-hdr': 7 },
	},

	// LUT Mode's real settable range is 0-1; a third "fixed" mode
	// exists in the camera but is explicitly rejected as
	// "used only internally". `max`
	// narrows the Companion-side UI/knob range from the wire's full 0-15.
	dct_lut_mode: {
		name: 'LUT Mode',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x24),
		nibbles: 1,
		min: 0,
		max: 1,
	},
	dct_lut_fixed_mode: {
		name: 'LUT Fixed Mode',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x25),
		nibbles: 1,
	},
	dct_lut_preset: {
		name: 'LUT Preset',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x26),
		nibbles: 1,
	},
	// LUT Fast Gamma: the camera firmware offset+scales the 2-nibble wire
	// value pq onto a real gamma of (1100 + pq*8)/1000, so pq 0..237 spans
	// 1.100..2.996 in exact 0.008 steps and round-trips the inquiry losslessly
	// (the camera's 2.222 default reads back as pq 140). pq 238..255 all clamp
	// to a real 3.000 but the inquiry floors back to 237 (displayed 2.996), so
	// `max` stops the knob at 237 -- the last value whose set/read-back agree,
	// sparing the knob a visible one-step snap-back after every poll.
	dct_lut_fast_gamma: {
		name: 'LUT Fast Gamma',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x27),
		nibbles: 2,
		min: 0,
		max: 237,
		// default knob step (config knobStep, 4) would move 0.032 gamma per
		// turn; this knob's useful resolution is the finest wire step (1 pq =
		// 0.008 gamma).
		step: 1,
		format: (raw) => `Gamma ${lutFastGammaRawToGamma(raw)}`,
	},

	// SDI Range: 0 = legal range, 1 = full range.
	dct_sdi_range: {
		name: 'SDI Range',
		group: 'System',
		kind: 'enum',
		choices: { Legal: P(0x01, 0x7e, 0x01, 0x30, 0x00), Full: P(0x01, 0x7e, 0x01, 0x30, 0x01) },
	},
	// SDI Black's real range is signed -60..60 (the camera hard-rejects
	// outside that). Signed to match the firmware's bespoke two's-
	// complement handling (it's no longer a generic unsigned
	// passthrough, same fix as dct_slog3_gain); `min`/`max` narrow the
	// Companion-side UI/knob range from the wire's full signed -128..127.
	dct_sdi_black: {
		name: 'SDI Black',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x31),
		nibbles: 2,
		signed: true,
		min: -60,
		max: 60,
	},
	// SDI White's real range is signed -80..79 (the camera hard-rejects
	// outside that); same treatment as SDI Black above.
	dct_sdi_white: {
		name: 'SDI White',
		group: 'System',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x32),
		nibbles: 2,
		signed: true,
		min: -80,
		max: 79,
	},

	// Independent Red/Green tally lamps -- set-only (no inquiry given).
	// p: 2=On, 3=Off (standard VISCA on/off convention, not this module's
	// own usual 0/1 enum style -- matches the real wire spec exactly).
	// Yellow = both lamps on,
	// reached by sending Red On + Green On -- not a wire value of its own.
	dct_tally_red: {
		name: 'Tally Red',
		group: 'System',
		kind: 'enum',
		choices: { On: P(0x01, 0x7e, 0x01, 0x0a, 0x00, 0x02), Off: P(0x01, 0x7e, 0x01, 0x0a, 0x00, 0x03) },
	},
	// Second DCT sub-namespace (0x04, not 0x01) -- avoids colliding with
	// dct_aec_maxgain at SS 0x1A in the normal sub-namespace.
	dct_tally_green: {
		name: 'Tally Green',
		group: 'System',
		kind: 'enum',
		choices: { On: P(0x01, 0x7e, 0x04, 0x1a, 0x00, 0x02), Off: P(0x01, 0x7e, 0x04, 0x1a, 0x00, 0x03) },
	},

	dct_audio_enable: {
		name: 'Audio Enable',
		group: 'Audio',
		kind: 'enum',
		choices: { Off: P(0x01, 0x7e, 0x01, 0x65, 0x00), On: P(0x01, 0x7e, 0x01, 0x65, 0x01) },
	},
	// Audio Gain's real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity
	// gain); kept at 3 nibbles (0-4095) with firmware scaling by 16 to cover
	// 0-65520 -- the top 15 values are unreachable, an accepted tradeoff.
	// logScale: the raw value is a linear amplitude multiplier, but audio
	// level perception (and dB) is logarithmic -- a flat per-turn raw
	// increment feels huge near the bottom of the range and imperceptible
	// near the top. adjustParam() (main.js) multiplies/divides by
	// (1 + stepPercent/100) per knob turn instead of adding a flat step.
	// stepPercent is tuned to exactly one 0.5dB step per knob click, not the
	// generic 5%: a fixed dB step IS a fixed log-domain percentage step
	// (10^(dB/20) - 1), so this reuses the existing logScale/stepPercent
	// mechanism precisely rather than inventing a second stepping algorithm.
	// Range is whatever raw 0-4095 already produces -- 0 to ~24.08dB (the
	// hardware's real ceiling; NOT 42dB, see audioGainRawToDb()).
	dct_audio_gain: {
		name: 'Audio Gain',
		group: 'Audio',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x66),
		nibbles: 3,
		logScale: true,
		stepPercent: (10 ** (0.5 / 20) - 1) * 100,
		format: (raw) => `${audioGainRawToDb(raw)} dB`,
		// Progress-bar position uses the dB scale (barValue/barMin/barMax),
		// not the raw wire value -- see AUDIO_GAIN_BAR_MIN/MAX above.
		barValue: audioGainRawToDbValue,
		barMin: AUDIO_GAIN_BAR_MIN,
		barMax: AUDIO_GAIN_BAR_MAX,
	},

	// --- AEC (auto exposure control) individual fields ------------------------
	// The camera's AEC is a positional/cumulative multi-field setting (10
	// fields; setting field N needs all preceding fields too).
	// Firmware handles this via read-modify-write: it queries the AEC's
	// current 10-value state, overrides just the one field below, and reissues
	// the full command. VISCA/Companion only ever sends the ONE field's value.
	// SetPoint: real range 50-3000 (an internal unitless luminance-target
	// scalar); 3 nibbles (0-4095) clamp to it, no scaling needed. `min`/`max`
	// narrow the Companion-side UI/knob range to what's actually usable,
	// instead of letting the wire's full 0-4095 capacity leak through.
	dct_aec_setpoint: {
		name: 'AEC SetPoint',
		group: 'Exposure',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x18),
		nibbles: 3,
		min: 50,
		max: 3000,
	},
	// Speed: real range 1-30; 2 nibbles
	// (0-255) clamp to it, no scaling needed. Same `min`/`max` narrowing.
	// logScale like Gain/Shutter (same reasoning: perceived/graded, not
	// linear); no `format` -- raw IS the real value 1-30 already (no
	// wire-scaling gap to convert through, unlike ISO/us), so there's no
	// separate human unit to display. minStep left at its default (1):
	// gain/shutter's minStep:4 floor was sized for their 0-4095 raw space,
	// not this 1-30 one -- default 1 is already the finest possible step here.
	dct_aec_speed: {
		name: 'AEC Speed',
		group: 'Exposure',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x19),
		nibbles: 2,
		min: 1,
		max: 30,
		logScale: true,
		stepPercent: 5,
	},
	// Max Gain: real range 1000-45715 (same as cam_gain, same underlying
	// camera gain-range query) -- identical raw<->real formula, so
	// this gets the exact same treatment as cam_gain_direct, reusing
	// gainRawToIso() directly rather than a new conversion function.
	dct_aec_maxgain: {
		name: 'AEC Max Gain',
		group: 'Exposure',
		kind: 'direct',
		prefix: P(0x01, 0x7e, 0x01, 0x1a),
		nibbles: 3,
		logScale: true,
		stepPercent: 5,
		minStep: 4,
		format: (raw) => `ISO ${gainRawToIso(raw)}`,
	},

	dct_auto_save: {
		name: 'Auto Save',
		group: 'System',
		kind: 'enum',
		choices: { Off: P(0x01, 0x7e, 0x01, 0x62, 0x00), On: P(0x01, 0x7e, 0x01, 0x62, 0x01) },
	},
	dct_timecode_hold: {
		name: 'Timecode',
		group: 'System',
		kind: 'enum',
		choices: { Run: P(0x01, 0x7e, 0x01, 0x64, 0x00), Hold: P(0x01, 0x7e, 0x01, 0x64, 0x01) },
	},
	// Load Settings: reloads settings from flash (falling back to compiled-in
	// defaults per-block only if the stored data is missing/corrupt/version-
	// mismatched) -- distinct from Settings Reset (in-RAM defaults only, no
	// flash access) and Settings Save (writes current in-RAM state to flash).
	// No standard VISCA function code exists for this, so it's a DCT vendor
	// extension (fixed no-argument trigger, sub-opcode 0x67).
	dct_load_settings: { name: 'Load Settings', group: 'System', kind: 'fixed', bytes: P(0x01, 0x7e, 0x01, 0x67) },
}

// --- INQUIRIES (read-back) -------------------------------------------------
// `once: true` marks a "startup-only" inquiry -- a calibration/setup-style
// value that's essentially never touched during a live session. main.js's
// pollLiveOnce() (the recurring background poll) skips these; they're only
// read once per connection (pollStartupOnce(), fired on transport connect)
// or on demand ("System: Poll startup values now"). pollOnce() ("Poll
// inquiries now") still refreshes everything regardless of this flag.
export const INQUIRIES = {
	version: { name: 'Version', varId: 'version', payload: P(0x09, 0x00, 0x02), decode: { type: 'version' }, once: true },
	video_mode: {
		name: 'Video Mode',
		varId: 'video_mode',
		payload: P(0x09, 0x04, 0x24),
		decode: { type: 'system' },
		once: true,
	},
	ae_mode: { name: 'AE Mode', varId: 'ae_mode', payload: P(0x09, 0x04, 0x39), decode: { type: 'enum', map: ENUM.ae } },
	gain: { name: 'Gain', varId: 'gain', payload: P(0x09, 0x04, 0x4c), decode: { type: 'value' } },
	shutter: { name: 'Shutter', varId: 'shutter', payload: P(0x09, 0x04, 0x4a), decode: { type: 'value' } },
	wb_mode: { name: 'WB Mode', varId: 'wb_mode', payload: P(0x09, 0x04, 0x35), decode: { type: 'enum', map: ENUM.wb } },
	rgain: { name: 'R Gain', varId: 'rgain', payload: P(0x09, 0x04, 0x43), decode: { type: 'value' } },
	bgain: { name: 'Blue Gain', varId: 'bgain', payload: P(0x09, 0x04, 0x44), decode: { type: 'value' } },
	color_temp: {
		name: 'Color Temp Preset',
		varId: 'color_temp',
		payload: P(0x09, 0x04, 0x20),
		decode: { type: 'value' },
	},
	// The three color-temperature fields (current/min/max -- the camera
	// returns them as one combined "<current> <min> <max>" dump),
	// each its own VISCA round-trip disambiguated by a selector byte
	// (payload's last byte: 0/1/2) -- see COMMANDS.dct_wb_temp.
	dct_wb_temp: {
		name: 'Color Temp (K)',
		varId: 'dct_wb_temp',
		payload: P(0x09, 0x7e, 0x01, 0x0b, 0x00),
		decode: { type: 'value' },
	},
	dct_wb_temp_min: {
		name: 'Color Temp Min (K)',
		varId: 'dct_wb_temp_min',
		payload: P(0x09, 0x7e, 0x01, 0x0b, 0x01),
		decode: { type: 'value' },
	},
	dct_wb_temp_max: {
		name: 'Color Temp Max (K)',
		varId: 'dct_wb_temp_max',
		payload: P(0x09, 0x7e, 0x01, 0x0b, 0x02),
		decode: { type: 'value' },
	},
	// Measured scene color temperature, inquiry-only
	// (the camera offers no way to set it at all).
	dct_wb_temp_measure: {
		name: 'Color Temp Measured (K)',
		varId: 'dct_wb_temp_measure',
		payload: P(0x09, 0x7e, 0x01, 0x0c),
		decode: { type: 'value' },
	},
	color_gain: { name: 'Color Gain', varId: 'color_gain', payload: P(0x09, 0x04, 0x49), decode: { type: 'value' } },
	// nibbles:2 -- the real reply pads to "00 00 0p 0q",
	// so the two's-complement bit-width must be
	// declared explicitly rather than inferred from the padded byte count.
	color_hue: {
		name: 'Color Hue',
		varId: 'color_hue',
		payload: P(0x09, 0x04, 0x4f),
		decode: { type: 'value', signed: true, nibbles: 2 },
	},
	gamma: {
		name: 'Gamma',
		varId: 'gamma',
		payload: P(0x09, 0x04, 0x5b),
		decode: { type: 'enum', map: ENUM.gamma },
		once: true,
	},
	// nibbles:2 -- same padded-reply caveat as color_hue above.
	bright: {
		name: 'Bright',
		varId: 'bright',
		payload: P(0x09, 0x04, 0x4d),
		decode: { type: 'value', signed: true, nibbles: 2 },
	},
	contrast: { name: 'Contrast', varId: 'contrast', payload: P(0x09, 0x04, 0xa2), decode: { type: 'value' } },
	flicker: {
		name: 'Flicker',
		varId: 'flicker',
		payload: P(0x09, 0x04, 0x55),
		decode: { type: 'enum', map: ENUM.flicker },
		once: true,
	},
	flip: {
		name: 'Flip',
		varId: 'flip',
		payload: P(0x09, 0x04, 0xa4),
		decode: { type: 'enum', map: ENUM.flip },
		once: true,
	},

	// DCT vendor extensions (09 7E 01 SS)
	dct_ggain: { name: 'Green Gain', varId: 'dct_ggain', payload: P(0x09, 0x7e, 0x01, 0x01), decode: { type: 'value' } },
	dct_gain_mode: {
		name: 'Gain Mode',
		varId: 'dct_gain_mode',
		payload: P(0x09, 0x7e, 0x01, 0x02),
		decode: { type: 'enum', map: ENUM.dct_gain_mode },
		once: true,
	},
	dct_black_master: {
		name: 'Black Master',
		varId: 'dct_black_master',
		payload: P(0x09, 0x7e, 0x01, 0x03),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_black_red: {
		name: 'Black Red',
		varId: 'dct_black_red',
		payload: P(0x09, 0x7e, 0x01, 0x04),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_black_green: {
		name: 'Black Green',
		varId: 'dct_black_green',
		payload: P(0x09, 0x7e, 0x01, 0x05),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_black_blue: {
		name: 'Black Blue',
		varId: 'dct_black_blue',
		payload: P(0x09, 0x7e, 0x01, 0x06),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_flare_red: {
		name: 'Flare Red',
		varId: 'dct_flare_red',
		payload: P(0x09, 0x7e, 0x01, 0x07),
		decode: { type: 'value' },
		once: true,
	},
	dct_flare_green: {
		name: 'Flare Green',
		varId: 'dct_flare_green',
		payload: P(0x09, 0x7e, 0x01, 0x1b),
		decode: { type: 'value' },
		once: true,
	},
	dct_flare_blue: {
		name: 'Flare Blue',
		varId: 'dct_flare_blue',
		payload: P(0x09, 0x7e, 0x01, 0x1c),
		decode: { type: 'value' },
		once: true,
	},
	dct_awb_speed: {
		name: 'AWB Speed',
		varId: 'dct_awb_speed',
		payload: P(0x09, 0x7e, 0x01, 0x08),
		decode: { type: 'value' },
		once: true,
	},
	dct_slog3_gain: {
		name: 'S-Log3 Master Gain',
		varId: 'dct_slog3_gain',
		payload: P(0x09, 0x7e, 0x01, 0x09),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_cnr_mode: {
		name: 'CNR Mode',
		varId: 'dct_cnr_mode',
		payload: P(0x09, 0x7e, 0x01, 0x10),
		decode: { type: 'value' },
		once: true,
	},
	dct_cnr_auto: {
		name: 'CNR Auto',
		varId: 'dct_cnr_auto',
		payload: P(0x09, 0x7e, 0x01, 0x11),
		decode: { type: 'enum', map: ENUM.dct_onoff },
		once: true,
	},
	dct_filter_enable: {
		name: 'Filter Enable',
		varId: 'dct_filter_enable',
		payload: P(0x09, 0x7e, 0x01, 0x14),
		decode: { type: 'enum', map: ENUM.dct_onoff },
		once: true,
	},
	dct_filter_detail: {
		name: 'Filter Detail',
		varId: 'dct_filter_detail',
		payload: P(0x09, 0x7e, 0x01, 0x15),
		decode: { type: 'value' },
		once: true,
	},
	dct_filter_denoise: {
		name: 'Filter Denoise',
		varId: 'dct_filter_denoise',
		payload: P(0x09, 0x7e, 0x01, 0x16),
		decode: { type: 'value' },
		once: true,
	},
	dct_color_space: {
		name: 'Color Space',
		varId: 'dct_color_space',
		payload: P(0x09, 0x7e, 0x01, 0x17),
		decode: { type: 'value' },
		once: true,
	},
	dct_tm_mode: {
		name: 'Tone Mapping Mode',
		varId: 'dct_tm_mode',
		payload: P(0x09, 0x7e, 0x01, 0x21),
		decode: { type: 'value' },
		once: true,
	},
	dct_pq_max_bright: {
		name: 'PQ Max Brightness',
		varId: 'dct_pq_max_bright',
		payload: P(0x09, 0x7e, 0x01, 0x22),
		decode: { type: 'value' },
		once: true,
	},
	dct_lut_mode: {
		name: 'LUT Mode',
		varId: 'dct_lut_mode',
		payload: P(0x09, 0x7e, 0x01, 0x24),
		decode: { type: 'value' },
		once: true,
	},
	dct_lut_fixed_mode: {
		name: 'LUT Fixed Mode',
		varId: 'dct_lut_fixed_mode',
		payload: P(0x09, 0x7e, 0x01, 0x25),
		decode: { type: 'value' },
		once: true,
	},
	dct_lut_preset: {
		name: 'LUT Preset',
		varId: 'dct_lut_preset',
		payload: P(0x09, 0x7e, 0x01, 0x26),
		decode: { type: 'value' },
		once: true,
	},
	dct_lut_fast_gamma: {
		name: 'LUT Fast Gamma',
		varId: 'dct_lut_fast_gamma',
		payload: P(0x09, 0x7e, 0x01, 0x27),
		decode: { type: 'value' },
		once: true,
	},
	// Not once:true (unlike its SDI Black/White neighbors below): backs the
	// "SDI: Toggle Legal/Full" button's live status display, which should
	// track real-time state even if changed by another controller.
	dct_sdi_range: {
		name: 'SDI Range',
		varId: 'dct_sdi_range',
		payload: P(0x09, 0x7e, 0x01, 0x30),
		decode: { type: 'enum', map: ENUM.dct_sdi_range },
	},
	dct_sdi_black: {
		name: 'SDI Black',
		varId: 'dct_sdi_black',
		payload: P(0x09, 0x7e, 0x01, 0x31),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_sdi_white: {
		name: 'SDI White',
		varId: 'dct_sdi_white',
		payload: P(0x09, 0x7e, 0x01, 0x32),
		decode: { type: 'value', signed: true },
		once: true,
	},
	dct_mcc_opmode: {
		name: 'MCC Op-Mode',
		varId: 'dct_mcc_opmode',
		payload: P(0x09, 0x7e, 0x01, 0x40),
		decode: { type: 'value' },
		once: true,
	},
	dct_osd: {
		name: 'OSD',
		varId: 'dct_osd',
		payload: P(0x09, 0x7e, 0x01, 0x52),
		decode: { type: 'enum', map: ENUM.dct_onoff },
		once: true,
	},
	dct_auto_save: {
		name: 'Auto Save',
		varId: 'dct_auto_save',
		payload: P(0x09, 0x7e, 0x01, 0x62),
		decode: { type: 'enum', map: ENUM.dct_onoff },
		once: true,
	},
	// Not once:true: backs the "Timecode: Toggle Run/Hold" button's live
	// status display -- see dct_sdi_range's comment above.
	dct_timecode_hold: {
		name: 'Timecode',
		varId: 'dct_timecode_hold',
		payload: P(0x09, 0x7e, 0x01, 0x64),
		decode: { type: 'enum', map: ENUM.dct_timecode_hold },
	},
	// Not once:true (unlike Audio Gain below): backs the "Audio: Toggle
	// On/Off" button's live status display -- see dct_sdi_range's comment
	// above.
	dct_audio_enable: {
		name: 'Audio Enable',
		varId: 'dct_audio_enable',
		payload: P(0x09, 0x7e, 0x01, 0x65),
		decode: { type: 'enum', map: ENUM.dct_onoff },
	},
	dct_audio_gain: {
		name: 'Audio Gain',
		varId: 'dct_audio_gain',
		payload: P(0x09, 0x7e, 0x01, 0x66),
		decode: { type: 'value' },
		once: true,
	},
	dct_aec_setpoint: {
		name: 'AEC SetPoint',
		varId: 'dct_aec_setpoint',
		payload: P(0x09, 0x7e, 0x01, 0x18),
		decode: { type: 'value' },
		once: true,
	},
	dct_aec_speed: {
		name: 'AEC Speed',
		varId: 'dct_aec_speed',
		payload: P(0x09, 0x7e, 0x01, 0x19),
		decode: { type: 'value' },
		once: true,
	},
	dct_aec_maxgain: {
		name: 'AEC Max Gain',
		varId: 'dct_aec_maxgain',
		payload: P(0x09, 0x7e, 0x01, 0x1a),
		decode: { type: 'value' },
		once: true,
	},
}

// RUD action byte per choice.
export const RUD = { reset: 0x00, up: 0x02, down: 0x03 }

// Continuous (knob-able) parameters, derived from the `direct` commands. Each
// entry gives the absolute-set command id (`cmd`), the value variable shown on
// the encoder LCD / read for the current value (`varId`, from INQUIRIES), and the
// value range (`min`/`max`, from `nibbles` unless the command narrows it --
// see e.g. dct_aec_speed, whose wire capacity (0-255) is wider than what the
// firmware actually uses (1-30); exposing the full wire range in the UI would
// let the knob/action silently no-op past the real clamp). The rotary presets
// and the relative Adjust action are generated from this list. varId rule:
// strip a trailing `_direct`, then drop a leading `cam_` (dct_* ids equal
// their inquiry varId).
export function continuousParams() {
	return Object.entries(COMMANDS)
		.filter(([, c]) => c.kind === 'direct')
		.map(([id, c]) => {
			const base = id.endsWith('_direct') ? id.slice(0, -'_direct'.length) : id
			const varId = base.startsWith('cam_') ? base.slice(4) : base
			const bits = 4 * c.nibbles
			const wireMin = c.signed ? -(1 << (bits - 1)) : 0
			const wireMax = c.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1
			return {
				id,
				cmd: id,
				varId,
				name: c.name.replace(/ \(direct\)$/, ''),
				group: c.group,
				nibbles: c.nibbles,
				signed: !!c.signed,
				min: c.min ?? wireMin,
				max: c.max ?? wireMax,
				modelMax: c.modelMax,
				step: c.step,
				logScale: !!c.logScale,
				stepPercent: c.stepPercent,
				minStep: c.minStep,
				format: c.format,
				barValue: c.barValue,
				barMin: c.barMin,
				barMax: c.barMax,
			}
		})
}

// A param's upper bound for the given camera model ('atom-two'|'atom-two-hdr'|
// undefined): the per-model `modelMax` override if one applies, else `max`.
// Unknown model keeps the unrestricted `max`.
export function effectiveMax(p, model) {
	return p.modelMax?.[model] ?? p.max
}

// Render a value's position within [min,max] as a compact text bar, e.g.
// progressBar(30, 0, 100) -> "...|......" -- the same technique
// companion-module-sony-visca uses for its rotary-knob presets (a
// dynamically-positioned marker in a fixed-width dot string), rather than a
// per-value drawn image. Out-of-range values clamp; a non-finite value or a
// degenerate [min,max] (max <= min) renders as all dashes.
export function progressBar(value, min, max, width = 10) {
	if (!Number.isFinite(value) || !(max > min)) return '-'.repeat(width)
	const pct = Math.max(0, Math.min(1, (value - min) / (max - min)))
	const filled = Math.min(width, Math.floor(pct * width))
	return '.'.repeat(filled) + '|' + '.'.repeat(width - filled)
}
