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
// INQUIRIES entries carry a payload + a decode descriptor (enum|value|version|system).

export const TERMINATOR = 0xff

// --- shared enum maps (reply byte -> label) --------------------------------
export const ENUM = {
	power: { 0x02: 'On', 0x03: 'Off (Standby)', 0x04: 'Power Circuit Error' },
	wb: { 0x00: 'Auto', 0x01: 'Indoor', 0x02: 'Outdoor', 0x03: 'OnePush', 0x05: 'Manual', 0x20: 'ColorTemp' },
	ae: { 0x00: 'FullAuto', 0x03: 'Manual', 0x0a: 'ShutterPriority' },
	gamma: { 0x00: 'BT709', 0x01: 'HLG', 0x02: 'PQ', 0x03: 'SLOG3' },
	flicker: { 0x01: '50Hz', 0x02: '60Hz' },
	flip: { 0x00: 'Off', 0x01: 'Flip-H', 0x02: 'Flip-V', 0x03: 'Flip-HV' },
	// Dream Chip extension reply maps (raw camera value -> label)
	dct_onoff: { 0x00: 'Off', 0x01: 'On' },
	dct_gain_mode: { 0x00: 'Auto', 0x01: 'LCG', 0x02: 'HCG' },
	// do_sdi_range's own help text: "<flag> - set sdi range [0: legal, 1: full range]"
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
const SYSTEM_INQ = {}
for (const [vm, [b2, b3]] of Object.entries(SYSTEM)) SYSTEM_INQ[`${b2},${b3}`] = Number(vm)

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
// (e.g. post_hue's -128..127 is wire-encoded as an unsigned byte via the same
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
			return String(decode.signed ? toSigned(raw, payload.length) : raw)
		}
		case 'system': {
			if (payload.length >= 4) {
				const vm = SYSTEM_INQ[`${payload[2]},${payload[3]}`]
				if (vm !== undefined) return String(vm)
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

// --- SET commands ----------------------------------------------------------
const P = (...b) => b // tiny helper to keep the table readable
export const COMMANDS = {
	// System
	if_clear: { name: 'IF Clear', group: 'System', kind: 'fixed', bytes: P(0x01, 0x00, 0x01) },
	cam_settings_save: { name: 'Settings Save', group: 'System', kind: 'fixed', bytes: P(0x01, 0x04, 0xa5, 0x10) },
	cam_settings_reset: { name: 'Settings Reset', group: 'System', kind: 'fixed', bytes: P(0x01, 0x04, 0xa0, 0x10) },

	// Power
	cam_power: { name: 'Power', group: 'Power', kind: 'enum', choices: { On: P(0x01, 0x04, 0x00, 0x02), Off: P(0x01, 0x04, 0x00, 0x03) } },

	// Video mode (see SYSTEM dialect caveat)
	cam_system: { name: 'Video Mode', group: 'Video', kind: 'video' },

	// Exposure / AEC
	cam_ae: {
		name: 'AE Mode', group: 'Exposure', kind: 'enum',
		choices: { 'Full Auto': P(0x01, 0x04, 0x39, 0x00), Manual: P(0x01, 0x04, 0x39, 0x03), 'Shutter Pri': P(0x01, 0x04, 0x39, 0x0a) },
	},
	// Reset/Up/Down is the standard VISCA CAM_Gain structure. Up/Down are a
	// firmware-side read-modify-write of cam_gain's real value (query current
	// value, step by ~109 gain units -- the same "10 raw nibble-steps' worth"
	// density as gain_red/blue/green's step -- clamp to 1000-45715, resend).
	cam_gain: { name: 'Gain', group: 'Exposure', kind: 'rud', func: 0x0c },
	// cam_gain's real range is 1000-45715 (1x/0dB/140 ISO min; max from the
	// current AUTO gain-mode range, isi_access_get_gain_range); widened to 3
	// nibbles (0-4095) for ~10.9 gain units per step, matching the BSP.
	cam_gain_direct: { name: 'Gain (direct)', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x04, 0x4c, 0x00, 0x00), nibbles: 3 },
	// Reset/Up/Down is the standard VISCA CAM_Shutter structure. Up/Down are a
	// firmware-side read-modify-write of cam_exposure's real value (query
	// current value, step by ~93us -- the same "10 raw nibble-steps' worth"
	// density as gain_red/blue/green's step -- clamp to 100-38339us, resend).
	cam_shutter: { name: 'Shutter', group: 'Exposure', kind: 'rud', func: 0x0a },
	// cam_exposure's real range is 100-38339us (observed on real hardware);
	// widened to 3 nibbles (0-4095) for ~9.3us per step, matching the BSP.
	cam_shutter_direct: { name: 'Shutter (direct)', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x04, 0x4a, 0x00, 0x00), nibbles: 3 },
	cam_flicker: {
		name: 'Flicker', group: 'Exposure', kind: 'enum',
		choices: { Off: P(0x01, 0x04, 0x23, 0x00), '50Hz': P(0x01, 0x04, 0x23, 0x01), '60Hz': P(0x01, 0x04, 0x23, 0x02) },
	},

	// White balance
	// The standard VISCA set also defines a "One Push" WB mode (0x35/0x03),
	// but it lands on the exact same real command as Manual (both send
	// "awb 0" -- selecting either just disables continuous auto-WB, it
	// doesn't calculate anything by itself; see Trigger below for the command
	// that actually runs the one-push calculation), so it's not exposed as a
	// separate choice here.
	cam_wb: {
		name: 'White Balance', group: 'White Balance', kind: 'enum',
		choices: {
			Auto: P(0x01, 0x04, 0x35, 0x00), Indoor: P(0x01, 0x04, 0x35, 0x01), Outdoor: P(0x01, 0x04, 0x35, 0x02),
			Manual: P(0x01, 0x04, 0x35, 0x05), 'Color Temp': P(0x01, 0x04, 0x35, 0x20),
			Trigger: P(0x01, 0x04, 0x10, 0x05),
		},
	},
	cam_rgain: { name: 'Red Gain', group: 'White Balance', kind: 'rud', func: 0x03 },
	// gain_red's real range is 0-4095 (ISP_AWB_GAIN_MAX); widened to 3 nibbles
	// so the wire encoding represents it exactly, matching the BSP fix.
	cam_rgain_direct: { name: 'Red Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x43, 0x00, 0x00), nibbles: 3 },
	cam_bgain: { name: 'Blue Gain', group: 'White Balance', kind: 'rud', func: 0x04 },
	// gain_blue's real range is 0-4095 (ISP_AWB_GAIN_MAX); widened to 3 nibbles.
	cam_bgain_direct: { name: 'Blue Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x44, 0x00, 0x00), nibbles: 3 },
	// post_sat's real range is 0-255 (ISP_CCOR12_SATURATION_MAX in the BSP); the
	// VISCA wire format is widened to 2 nibbles to match, in step with the same
	// fix in visca_map_picture.c.
	cam_color_gain_direct: { name: 'Color Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x49, 0x00, 0x00), nibbles: 2 },
	// post_hue's real range is signed -128..127 (ISP_CCOR12_HUE_MIN/MAX); wire
	// format widened from 1 nibble (unsigned 0-15, couldn't go negative at all).
	cam_color_hue_direct: { name: 'Color Hue (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x4f, 0x00, 0x00), nibbles: 2, signed: true },
	// No ProVideo command accepts a settable Kelvin value (stat_cct is
	// read-only AWB telemetry). wb_preset's calibration-profile presets each
	// have a real Kelvin rating, but there's no way to query which preset is
	// currently active -- so this is a raw preset-index passthrough with no
	// Kelvin matching (apply_color_profile's own -EINVAL bounds check handles
	// an out-of-range index) and has no inquiry counterpart. `max` narrows the
	// Companion-side UI/knob range to 0-9 -- the largest calibration profile
	// has 10 presets (indices 0-9); profile 0 only has 7 (0-6), so indices
	// 7-9 still correctly error there (confirmed on real hardware), but 0-9
	// is the real usable range across profiles, not the wire's full 0-4095.
	color_temp_direct: { name: 'Color Temp (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x20, 0x00, 0x00), nibbles: 2, min: 0, max: 9 },

	// Picture
	cam_gamma: {
		name: 'Gamma', group: 'Picture', kind: 'enum',
		choices: { 'BT.709': P(0x01, 0x04, 0x5b, 0x00), HLG: P(0x01, 0x04, 0x5b, 0x01), PQ: P(0x01, 0x04, 0x5b, 0x02), 'S-Log3': P(0x01, 0x04, 0x5b, 0x03) },
	},
	// post_bright's real range is signed -128..127 (ISP_CPROC_BRIGHTNESS_MIN/MAX
	// or equivalently ISP_CCOR12_BRIGHTNESS_MIN/MAX); signed to match the fix
	// in visca_map_picture.c. cam_bright's Direct form shares its RUD's
	// function byte (0x0d) -- the firmware disambiguates by packet length,
	// mirroring ggain_command's own dispatch style.
	// (The standard VISCA set also defines a 2nd, Direct-only "CAM_Brightness"
	// function (0xA1) that lands on this exact same post_bright command --
	// the firmware still answers it for other controllers, but it's a pure
	// duplicate of cam_bright_direct so it's deliberately not exposed here.)
	cam_bright: { name: 'Bright', group: 'Picture', kind: 'rud', func: 0x0d },
	cam_bright_direct: { name: 'Bright (direct)', group: 'Picture', kind: 'direct', prefix: P(0x01, 0x04, 0x0d, 0x00, 0x00), nibbles: 2, signed: true },
	cam_contrast_direct: { name: 'Contrast (direct)', group: 'Picture', kind: 'direct', prefix: P(0x01, 0x04, 0xa2, 0x00, 0x00), nibbles: 2 },
	// The standard VISCA set also defines cam_lr_reverse (func 0x61) and
	// cam_picture_flip (func 0x66) -- independent On/Off toggles of just the
	// horizontal or vertical bit of this same `flip` value via read-modify-
	// write. The firmware still answers both for other controllers, but
	// cam_flip's 4-state direct select already reaches every combination in
	// one command, so they're deliberately not exposed here.
	cam_flip: {
		name: 'Flip', group: 'Picture', kind: 'enum',
		choices: { Off: P(0x01, 0x04, 0xa4, 0x00), 'Flip-H': P(0x01, 0x04, 0xa4, 0x01), 'Flip-V': P(0x01, 0x04, 0xa4, 0x02), 'Flip-HV': P(0x01, 0x04, 0xa4, 0x03) },
	},

	// Memory
	cam_memory: {
		name: 'Memory', group: 'System', kind: 'enum',
		choices: { Reset: P(0x01, 0x04, 0x3f, 0x00, 0x00), Set: P(0x01, 0x04, 0x3f, 0x01, 0x00), Recall: P(0x01, 0x04, 0x3f, 0x02, 0x00) },
	},

	// --- DCT vendor extensions (category 0x7E, sub 0x01) ---------------------
	// Payloads are `01 7E 01 SS ...` (Dream Chip vendor extensions).
	dct_ggain: {
		name: 'Green Gain', group: 'DCT Gain', kind: 'enum',
		choices: { Reset: P(0x01, 0x7e, 0x01, 0x01, 0x00), Up: P(0x01, 0x7e, 0x01, 0x01, 0x02), Down: P(0x01, 0x7e, 0x01, 0x01, 0x03) },
	},
	// gain_green's real range is 0-4095 (ISP_AWB_GAIN_MAX); widened to 3 nibbles.
	dct_ggain_direct: { name: 'Green Gain (direct)', group: 'DCT Gain', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x01, 0x00, 0x00), nibbles: 3 },
	dct_gain_mode: {
		name: 'Gain Mode', group: 'DCT Gain', kind: 'enum',
		choices: { Auto: P(0x01, 0x7e, 0x01, 0x02, 0x00), LCG: P(0x01, 0x7e, 0x01, 0x02, 0x01), HCG: P(0x01, 0x7e, 0x01, 0x02, 0x02) },
	},

	// black_master's real range is signed -2048..2047 (ISP_BMST_OFFSET_MIN/MAX,
	// a signed 12-bit value); widened to 3 nibbles to represent it exactly.
	dct_black_master: { name: 'Black Master', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x03), nibbles: 3, signed: true },
	// black_red/green/blue's real range is signed -4096..4095 (ISP_BLS_MIN/MAX);
	// kept at 3 nibbles (signed 12-bit, -2048..2047) with firmware scaling by 2
	// to cover -4096..4094 -- odd values and 4095 itself are unreachable, an
	// accepted precision tradeoff.
	dct_black_red: { name: 'Black Red', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x04), nibbles: 3, signed: true },
	dct_black_green: { name: 'Black Green', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x05), nibbles: 3, signed: true },
	dct_black_blue: { name: 'Black Blue', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x06), nibbles: 3, signed: true },

	// Flare's real signature is "flare <red> <green> <blue>" -- positional,
	// all 3 needed on every set (do_flare has no single-channel form).
	// Firmware handles this via read-modify-write, same as the aec fields
	// further down: it queries flare's current 3-value state, overrides just
	// the one channel below, and reissues the full command. Real range per
	// channel is 0-65535 (ISP_BLS_FLARE_MIN/MAX); raw is 0-4095, firmware
	// multiplies it by 16 (same x16 scale as audio_gain).
	dct_flare_red: { name: 'Flare Red', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x07), nibbles: 3 },
	dct_flare_green: { name: 'Flare Green', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x1b), nibbles: 3 },
	dct_flare_blue: { name: 'Flare Blue', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x1c), nibbles: 3 },
	dct_awb_speed: { name: 'AWB Speed', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x08), nibbles: 1 },
	dct_slog3_gain: { name: 'S-Log3 Master Gain', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x09), nibbles: 2 },
	dct_color_space: { name: 'Color Space', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x17), nibbles: 1 },
	dct_tm_mode: { name: 'Tone-Mapping Mode', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x21), nibbles: 1 },
	// pq_max_brightness's real range is 100-10000 cd/m2 (do_pq_max_brightness);
	// widened to 3 nibbles (0-4095) for ~2.4 cd/m2 per step, matching the BSP.
	dct_pq_max_bright: { name: 'PQ Max Brightness', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x22), nibbles: 3 },
	dct_mcc_opmode: { name: 'MCC Op-Mode', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x40), nibbles: 1 },

	dct_cnr_auto: { name: 'CNR Auto', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x11, 0x00), On: P(0x01, 0x7e, 0x01, 0x11, 0x01) } },
	dct_cnr_mode: { name: 'CNR Mode', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x10), nibbles: 1 },
	dct_dpf_enable: { name: 'DPF Enable', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x12, 0x00), On: P(0x01, 0x7e, 0x01, 0x12, 0x01) } },
	dct_dpf_strength: { name: 'DPF Strength', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x13), nibbles: 1 },
	dct_filter_enable: { name: 'Filter Enable', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x14, 0x00), On: P(0x01, 0x7e, 0x01, 0x14, 0x01) } },
	// real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL, firmware hard-rejects >=32);
	// wire stays 2 nibbles (0-255, same as filter_denoise's real 0-255), but
	// firmware now clamps raw values above 31 to 31 instead of erroring. `max`
	// narrows the Companion-side UI/knob range to what's actually usable,
	// instead of letting the wire's full 0-255 capacity leak through.
	dct_filter_detail: { name: 'Filter Detail', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x15), nibbles: 2, max: 31 },
	// real range is 0-255 (ISP_FLT_MAX_DENOISE_LVL); 1 nibble truncated it,
	// widened to 2 nibbles to match it exactly.
	dct_filter_denoise: { name: 'Filter Denoise', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x16), nibbles: 2 },

	dct_lut_mode: { name: 'LUT Mode', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x24), nibbles: 1 },
	dct_lut_fixed_mode: { name: 'LUT Fixed Mode', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x25), nibbles: 1 },
	dct_lut_preset: { name: 'LUT Preset', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x26), nibbles: 1 },

	// do_sdi_range's own help text: "<flag> - set sdi range [0: legal, 1: full range]"
	dct_sdi_range: { name: 'SDI Range', group: 'DCT SDI', kind: 'enum', choices: { Legal: P(0x01, 0x7e, 0x01, 0x30, 0x00), Full: P(0x01, 0x7e, 0x01, 0x30, 0x01) } },
	dct_sdi_black: { name: 'SDI Black', group: 'DCT SDI', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x31), nibbles: 2 },
	dct_sdi_white: { name: 'SDI White', group: 'DCT SDI', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x32), nibbles: 2 },

	dct_osd: { name: 'OSD', group: 'DCT OSD/Audio', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x52, 0x00), On: P(0x01, 0x7e, 0x01, 0x52, 0x01) } },
	dct_audio_enable: { name: 'Audio Enable', group: 'DCT OSD/Audio', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x65, 0x00), On: P(0x01, 0x7e, 0x01, 0x65, 0x01) } },
	// audio_gain's real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity
	// gain); kept at 3 nibbles (0-4095) with firmware scaling by 16 to cover
	// 0-65520 -- the top 15 values are unreachable, an accepted tradeoff.
	dct_audio_gain: { name: 'Audio Gain', group: 'DCT OSD/Audio', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x66), nibbles: 3 },

	// --- AEC (auto exposure control) individual fields ------------------------
	// aec's real signature is "aec <enable> <setPoint> <speed> <clmTolerance>
	// <costGain> <costTint> <costApt> <taf> <maxGain> <useCustomWeights>" --
	// positional/cumulative (setting field N needs all preceding fields too).
	// Firmware handles this via read-modify-write: it queries aec's current
	// 10-value state, overrides just the one field below, and reissues the
	// full command. VISCA/Companion only ever sends the ONE field's value.
	// setPoint: real range 50-3000 (internal unitless ISP luminance-target
	// scalar); 3 nibbles (0-4095) clamp to it, no scaling needed. `min`/`max`
	// narrow the Companion-side UI/knob range to what's actually usable,
	// instead of letting the wire's full 0-4095 capacity leak through.
	dct_aec_setpoint: { name: 'AEC SetPoint', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x18), nibbles: 3, min: 50, max: 3000 },
	// speed: real range 1-30 (AEC_LOW_PASS_FILTER_SIZE_MIN/MAX); 2 nibbles
	// (0-255) clamp to it, no scaling needed. Same `min`/`max` narrowing.
	dct_aec_speed: { name: 'AEC Speed', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x19), nibbles: 2, min: 1, max: 30 },
	// maxGain: real range 1000-45715 (same as cam_gain, same underlying
	// isi_access_get_gain_range query); 3 nibbles, linearly scaled.
	dct_aec_maxgain: { name: 'AEC Max Gain', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x1a), nibbles: 3 },

	dct_auto_save: { name: 'Auto Save', group: 'DCT System', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x62, 0x00), On: P(0x01, 0x7e, 0x01, 0x62, 0x01) } },
	dct_timecode_hold: { name: 'Timecode Hold', group: 'DCT System', kind: 'enum', choices: { Run: P(0x01, 0x7e, 0x01, 0x64, 0x00), Hold: P(0x01, 0x7e, 0x01, 0x64, 0x01) } },
}

// --- INQUIRIES (read-back) -------------------------------------------------
export const INQUIRIES = {
	version: { name: 'Version', varId: 'version', payload: P(0x09, 0x00, 0x02), decode: { type: 'version' } },
	power: { name: 'Power', varId: 'power', payload: P(0x09, 0x04, 0x00), decode: { type: 'enum', map: ENUM.power } },
	video_mode: { name: 'Video Mode', varId: 'video_mode', payload: P(0x09, 0x04, 0x24), decode: { type: 'system' } },
	ae_mode: { name: 'AE Mode', varId: 'ae_mode', payload: P(0x09, 0x04, 0x39), decode: { type: 'enum', map: ENUM.ae } },
	gain: { name: 'Gain', varId: 'gain', payload: P(0x09, 0x04, 0x4c), decode: { type: 'value' } },
	shutter: { name: 'Shutter', varId: 'shutter', payload: P(0x09, 0x04, 0x4a), decode: { type: 'value' } },
	wb_mode: { name: 'WB Mode', varId: 'wb_mode', payload: P(0x09, 0x04, 0x35), decode: { type: 'enum', map: ENUM.wb } },
	rgain: { name: 'Red Gain', varId: 'rgain', payload: P(0x09, 0x04, 0x43), decode: { type: 'value' } },
	bgain: { name: 'Blue Gain', varId: 'bgain', payload: P(0x09, 0x04, 0x44), decode: { type: 'value' } },
	color_temp: { name: 'Color Temp', varId: 'color_temp', payload: P(0x09, 0x04, 0x20), decode: { type: 'value' } },
	color_gain: { name: 'Color Gain', varId: 'color_gain', payload: P(0x09, 0x04, 0x49), decode: { type: 'value' } },
	color_hue: { name: 'Color Hue', varId: 'color_hue', payload: P(0x09, 0x04, 0x4f), decode: { type: 'value', signed: true } },
	gamma: { name: 'Gamma', varId: 'gamma', payload: P(0x09, 0x04, 0x5b), decode: { type: 'enum', map: ENUM.gamma } },
	bright: { name: 'Bright', varId: 'bright', payload: P(0x09, 0x04, 0x4d), decode: { type: 'value', signed: true } },
	contrast: { name: 'Contrast', varId: 'contrast', payload: P(0x09, 0x04, 0xa2), decode: { type: 'value' } },
	flicker: { name: 'Flicker', varId: 'flicker', payload: P(0x09, 0x04, 0x55), decode: { type: 'enum', map: ENUM.flicker } },
	flip: { name: 'Flip', varId: 'flip', payload: P(0x09, 0x04, 0xa4), decode: { type: 'enum', map: ENUM.flip } },

	// DCT vendor extensions (09 7E 01 SS)
	dct_ggain: { name: 'Green Gain', varId: 'dct_ggain', payload: P(0x09, 0x7e, 0x01, 0x01), decode: { type: 'value' } },
	dct_gain_mode: { name: 'Gain Mode', varId: 'dct_gain_mode', payload: P(0x09, 0x7e, 0x01, 0x02), decode: { type: 'enum', map: ENUM.dct_gain_mode } },
	dct_black_master: { name: 'Black Master', varId: 'dct_black_master', payload: P(0x09, 0x7e, 0x01, 0x03), decode: { type: 'value', signed: true } },
	dct_black_red: { name: 'Black Red', varId: 'dct_black_red', payload: P(0x09, 0x7e, 0x01, 0x04), decode: { type: 'value', signed: true } },
	dct_black_green: { name: 'Black Green', varId: 'dct_black_green', payload: P(0x09, 0x7e, 0x01, 0x05), decode: { type: 'value', signed: true } },
	dct_black_blue: { name: 'Black Blue', varId: 'dct_black_blue', payload: P(0x09, 0x7e, 0x01, 0x06), decode: { type: 'value', signed: true } },
	dct_flare_red: { name: 'Flare Red', varId: 'dct_flare_red', payload: P(0x09, 0x7e, 0x01, 0x07), decode: { type: 'value' } },
	dct_flare_green: { name: 'Flare Green', varId: 'dct_flare_green', payload: P(0x09, 0x7e, 0x01, 0x1b), decode: { type: 'value' } },
	dct_flare_blue: { name: 'Flare Blue', varId: 'dct_flare_blue', payload: P(0x09, 0x7e, 0x01, 0x1c), decode: { type: 'value' } },
	dct_awb_speed: { name: 'AWB Speed', varId: 'dct_awb_speed', payload: P(0x09, 0x7e, 0x01, 0x08), decode: { type: 'value' } },
	dct_slog3_gain: { name: 'S-Log3 Master Gain', varId: 'dct_slog3_gain', payload: P(0x09, 0x7e, 0x01, 0x09), decode: { type: 'value' } },
	dct_cnr_mode: { name: 'CNR Mode', varId: 'dct_cnr_mode', payload: P(0x09, 0x7e, 0x01, 0x10), decode: { type: 'value' } },
	dct_cnr_auto: { name: 'CNR Auto', varId: 'dct_cnr_auto', payload: P(0x09, 0x7e, 0x01, 0x11), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_dpf_enable: { name: 'DPF Enable', varId: 'dct_dpf_enable', payload: P(0x09, 0x7e, 0x01, 0x12), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_dpf_strength: { name: 'DPF Strength', varId: 'dct_dpf_strength', payload: P(0x09, 0x7e, 0x01, 0x13), decode: { type: 'value' } },
	dct_filter_enable: { name: 'Filter Enable', varId: 'dct_filter_enable', payload: P(0x09, 0x7e, 0x01, 0x14), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_filter_detail: { name: 'Filter Detail', varId: 'dct_filter_detail', payload: P(0x09, 0x7e, 0x01, 0x15), decode: { type: 'value' } },
	dct_filter_denoise: { name: 'Filter Denoise', varId: 'dct_filter_denoise', payload: P(0x09, 0x7e, 0x01, 0x16), decode: { type: 'value' } },
	dct_color_space: { name: 'Color Space', varId: 'dct_color_space', payload: P(0x09, 0x7e, 0x01, 0x17), decode: { type: 'value' } },
	dct_tm_mode: { name: 'Tone-Mapping Mode', varId: 'dct_tm_mode', payload: P(0x09, 0x7e, 0x01, 0x21), decode: { type: 'value' } },
	dct_pq_max_bright: { name: 'PQ Max Brightness', varId: 'dct_pq_max_bright', payload: P(0x09, 0x7e, 0x01, 0x22), decode: { type: 'value' } },
	dct_lut_mode: { name: 'LUT Mode', varId: 'dct_lut_mode', payload: P(0x09, 0x7e, 0x01, 0x24), decode: { type: 'value' } },
	dct_lut_fixed_mode: { name: 'LUT Fixed Mode', varId: 'dct_lut_fixed_mode', payload: P(0x09, 0x7e, 0x01, 0x25), decode: { type: 'value' } },
	dct_lut_preset: { name: 'LUT Preset', varId: 'dct_lut_preset', payload: P(0x09, 0x7e, 0x01, 0x26), decode: { type: 'value' } },
	dct_sdi_range: { name: 'SDI Range', varId: 'dct_sdi_range', payload: P(0x09, 0x7e, 0x01, 0x30), decode: { type: 'enum', map: ENUM.dct_sdi_range } },
	dct_sdi_black: { name: 'SDI Black', varId: 'dct_sdi_black', payload: P(0x09, 0x7e, 0x01, 0x31), decode: { type: 'value' } },
	dct_sdi_white: { name: 'SDI White', varId: 'dct_sdi_white', payload: P(0x09, 0x7e, 0x01, 0x32), decode: { type: 'value' } },
	dct_mcc_opmode: { name: 'MCC Op-Mode', varId: 'dct_mcc_opmode', payload: P(0x09, 0x7e, 0x01, 0x40), decode: { type: 'value' } },
	dct_osd: { name: 'OSD', varId: 'dct_osd', payload: P(0x09, 0x7e, 0x01, 0x52), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_auto_save: { name: 'Auto Save', varId: 'dct_auto_save', payload: P(0x09, 0x7e, 0x01, 0x62), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_timecode_hold: { name: 'Timecode Hold', varId: 'dct_timecode_hold', payload: P(0x09, 0x7e, 0x01, 0x64), decode: { type: 'enum', map: ENUM.dct_timecode_hold } },
	dct_audio_enable: { name: 'Audio Enable', varId: 'dct_audio_enable', payload: P(0x09, 0x7e, 0x01, 0x65), decode: { type: 'enum', map: ENUM.dct_onoff } },
	dct_audio_gain: { name: 'Audio Gain', varId: 'dct_audio_gain', payload: P(0x09, 0x7e, 0x01, 0x66), decode: { type: 'value' } },
	dct_aec_setpoint: { name: 'AEC SetPoint', varId: 'dct_aec_setpoint', payload: P(0x09, 0x7e, 0x01, 0x18), decode: { type: 'value' } },
	dct_aec_speed: { name: 'AEC Speed', varId: 'dct_aec_speed', payload: P(0x09, 0x7e, 0x01, 0x19), decode: { type: 'value' } },
	dct_aec_maxgain: { name: 'AEC Max Gain', varId: 'dct_aec_maxgain', payload: P(0x09, 0x7e, 0x01, 0x1a), decode: { type: 'value' } },
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
			}
		})
}
