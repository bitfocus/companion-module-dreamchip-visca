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
	onoff23: { 0x02: 'On', 0x03: 'Off' },
	flip: { 0x00: 'Off', 0x01: 'Flip-H', 0x02: 'Flip-V', 0x03: 'Flip-HV' },
	// Dream Chip extension reply maps (raw camera value -> label)
	dct_onoff: { 0x00: 'Off', 0x01: 'On' },
	dct_gain_mode: { 0x00: 'Auto', 0x01: 'LCG', 0x02: 'HCG' },
	dct_sdi_range: { 0x00: 'Full', 0x01: 'Legal' },
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
		case 'value':
			return String(decodeNibbles(payload))
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
	cam_gain: { name: 'Gain', group: 'Exposure', kind: 'rud', func: 0x0c },
	cam_gain_direct: { name: 'Gain (direct)', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x04, 0x4c, 0x00, 0x00), nibbles: 2 },
	cam_shutter: { name: 'Shutter', group: 'Exposure', kind: 'rud', func: 0x0a },
	cam_shutter_direct: { name: 'Shutter (direct)', group: 'Exposure', kind: 'direct', prefix: P(0x01, 0x04, 0x4a, 0x00, 0x00), nibbles: 2 },
	cam_flicker: {
		name: 'Flicker', group: 'Exposure', kind: 'enum',
		choices: { Off: P(0x01, 0x04, 0x23, 0x00), '50Hz': P(0x01, 0x04, 0x23, 0x01), '60Hz': P(0x01, 0x04, 0x23, 0x02) },
	},

	// White balance
	cam_wb: {
		name: 'White Balance', group: 'White Balance', kind: 'enum',
		choices: {
			Auto: P(0x01, 0x04, 0x35, 0x00), Indoor: P(0x01, 0x04, 0x35, 0x01), Outdoor: P(0x01, 0x04, 0x35, 0x02),
			'One Push': P(0x01, 0x04, 0x35, 0x03), Manual: P(0x01, 0x04, 0x35, 0x05), 'Color Temp': P(0x01, 0x04, 0x35, 0x20),
			Trigger: P(0x01, 0x04, 0x10, 0x05),
		},
	},
	cam_rgain: { name: 'Red Gain', group: 'White Balance', kind: 'rud', func: 0x03 },
	cam_rgain_direct: { name: 'Red Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x43, 0x00, 0x00), nibbles: 2 },
	cam_bgain: { name: 'Blue Gain', group: 'White Balance', kind: 'rud', func: 0x04 },
	cam_bgain_direct: { name: 'Blue Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x44, 0x00, 0x00), nibbles: 2 },
	cam_color_gain_direct: { name: 'Color Gain (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x49, 0x00, 0x00, 0x00), nibbles: 1 },
	cam_color_hue_direct: { name: 'Color Hue (direct)', group: 'White Balance', kind: 'direct', prefix: P(0x01, 0x04, 0x4f, 0x00, 0x00, 0x00), nibbles: 1 },

	// Picture
	cam_gamma: {
		name: 'Gamma', group: 'Picture', kind: 'enum',
		choices: { 'BT.709': P(0x01, 0x04, 0x5b, 0x00), HLG: P(0x01, 0x04, 0x5b, 0x01), PQ: P(0x01, 0x04, 0x5b, 0x02), 'S-Log3': P(0x01, 0x04, 0x5b, 0x03) },
	},
	cam_bright: { name: 'Bright', group: 'Picture', kind: 'rud', func: 0x0d },
	cam_bright_direct: { name: 'Bright (direct)', group: 'Picture', kind: 'direct', prefix: P(0x01, 0x04, 0x0d, 0x00, 0x00), nibbles: 2 },
	cam_brightness_direct: { name: 'Brightness (direct)', group: 'Picture', kind: 'direct', prefix: P(0x01, 0x04, 0xa1, 0x00, 0x00), nibbles: 2 },
	cam_contrast_direct: { name: 'Contrast (direct)', group: 'Picture', kind: 'direct', prefix: P(0x01, 0x04, 0xa2, 0x00, 0x00), nibbles: 2 },
	cam_lr_reverse: { name: 'LR Reverse', group: 'Picture', kind: 'enum', choices: { On: P(0x01, 0x04, 0x61, 0x02), Off: P(0x01, 0x04, 0x61, 0x03) } },
	cam_picture_flip: { name: 'Picture Flip', group: 'Picture', kind: 'enum', choices: { On: P(0x01, 0x04, 0x66, 0x02), Off: P(0x01, 0x04, 0x66, 0x03) } },
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
	dct_ggain_direct: { name: 'Green Gain (direct)', group: 'DCT Gain', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x01, 0x00, 0x00), nibbles: 2 },
	dct_gain_mode: {
		name: 'Gain Mode', group: 'DCT Gain', kind: 'enum',
		choices: { Auto: P(0x01, 0x7e, 0x01, 0x02, 0x00), LCG: P(0x01, 0x7e, 0x01, 0x02, 0x01), HCG: P(0x01, 0x7e, 0x01, 0x02, 0x02) },
	},

	dct_black_master: { name: 'Black Master', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x03), nibbles: 2 },
	dct_black_red: { name: 'Black Red', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x04), nibbles: 2 },
	dct_black_green: { name: 'Black Green', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x05), nibbles: 2 },
	dct_black_blue: { name: 'Black Blue', group: 'DCT Black', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x06), nibbles: 2 },

	dct_flare: { name: 'Flare', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x07), nibbles: 2 },
	dct_awb_speed: { name: 'AWB Speed', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x08), nibbles: 1 },
	dct_slog3_gain: { name: 'S-Log3 Master Gain', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x09), nibbles: 2 },
	dct_color_space: { name: 'Color Space', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x17), nibbles: 1 },
	dct_tm_mode: { name: 'Tone-Mapping Mode', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x21), nibbles: 1 },
	dct_pq_max_bright: { name: 'PQ Max Brightness', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x22), nibbles: 2 },
	dct_mcc_opmode: { name: 'MCC Op-Mode', group: 'DCT Color', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x40), nibbles: 1 },

	dct_cnr_auto: { name: 'CNR Auto', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x11, 0x00), On: P(0x01, 0x7e, 0x01, 0x11, 0x01) } },
	dct_cnr_mode: { name: 'CNR Mode', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x10), nibbles: 1 },
	dct_dpf_enable: { name: 'DPF Enable', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x12, 0x00), On: P(0x01, 0x7e, 0x01, 0x12, 0x01) } },
	dct_dpf_strength: { name: 'DPF Strength', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x13), nibbles: 1 },
	dct_filter_enable: { name: 'Filter Enable', group: 'DCT Detail/NR', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x14, 0x00), On: P(0x01, 0x7e, 0x01, 0x14, 0x01) } },
	dct_filter_detail: { name: 'Filter Detail', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x15), nibbles: 1 },
	dct_filter_denoise: { name: 'Filter Denoise', group: 'DCT Detail/NR', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x16), nibbles: 1 },

	dct_lut_mode: { name: 'LUT Mode', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x24), nibbles: 1 },
	dct_lut_fixed_mode: { name: 'LUT Fixed Mode', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x25), nibbles: 1 },
	dct_lut_preset: { name: 'LUT Preset', group: 'DCT LUT', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x26), nibbles: 1 },

	dct_sdi_range: { name: 'SDI Range', group: 'DCT SDI', kind: 'enum', choices: { Full: P(0x01, 0x7e, 0x01, 0x30, 0x00), Legal: P(0x01, 0x7e, 0x01, 0x30, 0x01) } },
	dct_sdi_black: { name: 'SDI Black', group: 'DCT SDI', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x31), nibbles: 2 },
	dct_sdi_white: { name: 'SDI White', group: 'DCT SDI', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x32), nibbles: 2 },

	dct_osd: { name: 'OSD', group: 'DCT OSD/Audio', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x52, 0x00), On: P(0x01, 0x7e, 0x01, 0x52, 0x01) } },
	dct_audio_enable: { name: 'Audio Enable', group: 'DCT OSD/Audio', kind: 'enum', choices: { Off: P(0x01, 0x7e, 0x01, 0x65, 0x00), On: P(0x01, 0x7e, 0x01, 0x65, 0x01) } },
	dct_audio_gain: { name: 'Audio Gain', group: 'DCT OSD/Audio', kind: 'direct', prefix: P(0x01, 0x7e, 0x01, 0x66), nibbles: 2 },

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
	color_hue: { name: 'Color Hue', varId: 'color_hue', payload: P(0x09, 0x04, 0x4f), decode: { type: 'value' } },
	gamma: { name: 'Gamma', varId: 'gamma', payload: P(0x09, 0x04, 0x5b), decode: { type: 'enum', map: ENUM.gamma } },
	bright: { name: 'Bright', varId: 'bright', payload: P(0x09, 0x04, 0x4d), decode: { type: 'value' } },
	brightness: { name: 'Brightness', varId: 'brightness', payload: P(0x09, 0x04, 0xa1), decode: { type: 'value' } },
	contrast: { name: 'Contrast', varId: 'contrast', payload: P(0x09, 0x04, 0xa2), decode: { type: 'value' } },
	flicker: { name: 'Flicker', varId: 'flicker', payload: P(0x09, 0x04, 0x55), decode: { type: 'enum', map: ENUM.flicker } },
	lr_reverse: { name: 'LR Reverse', varId: 'lr_reverse', payload: P(0x09, 0x04, 0x61), decode: { type: 'enum', map: ENUM.onoff23 } },
	picture_flip: { name: 'Picture Flip', varId: 'picture_flip', payload: P(0x09, 0x04, 0x66), decode: { type: 'enum', map: ENUM.onoff23 } },
	flip: { name: 'Flip', varId: 'flip', payload: P(0x09, 0x04, 0xa4), decode: { type: 'enum', map: ENUM.flip } },

	// DCT vendor extensions (09 7E 01 SS)
	dct_ggain: { name: 'Green Gain', varId: 'dct_ggain', payload: P(0x09, 0x7e, 0x01, 0x01), decode: { type: 'value' } },
	dct_gain_mode: { name: 'Gain Mode', varId: 'dct_gain_mode', payload: P(0x09, 0x7e, 0x01, 0x02), decode: { type: 'enum', map: ENUM.dct_gain_mode } },
	dct_black_master: { name: 'Black Master', varId: 'dct_black_master', payload: P(0x09, 0x7e, 0x01, 0x03), decode: { type: 'value' } },
	dct_black_red: { name: 'Black Red', varId: 'dct_black_red', payload: P(0x09, 0x7e, 0x01, 0x04), decode: { type: 'value' } },
	dct_black_green: { name: 'Black Green', varId: 'dct_black_green', payload: P(0x09, 0x7e, 0x01, 0x05), decode: { type: 'value' } },
	dct_black_blue: { name: 'Black Blue', varId: 'dct_black_blue', payload: P(0x09, 0x7e, 0x01, 0x06), decode: { type: 'value' } },
	dct_flare: { name: 'Flare', varId: 'dct_flare', payload: P(0x09, 0x7e, 0x01, 0x07), decode: { type: 'value' } },
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
}

// RUD action byte per choice.
export const RUD = { reset: 0x00, up: 0x02, down: 0x03 }
