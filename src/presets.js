import { COMMANDS, SYSTEM, SYSTEM_NAMES, GAIN_ISO, SHUTTER_SPEEDS, RUD } from './commands.js'
import {
	BLUE,
	ORANGE,
	DIM_RED,
	DIM_GREEN,
	DIM_BLUE,
	DARK_GRAY,
	DARK_CYAN,
	WHITE,
	MODEL_GATED_IDS,
	KNOB_PRESS_DOWN,
	KNOB_PRESS_SET_VALUE,
} from './constants.js'
import { KNOB_RING_PNG } from './images.js'

// Per-preset background overrides, applied after generation (default is BLUE
// from the shared btn() helper). Orange calls out the 3 "hands control back
// to the camera's auto algorithms / wipes settings" buttons; dim red/green/
// blue color-codes the R/G/B gain reset/up/down buttons and their knob
// presets to match the channel they act on.
const PRESET_BGCOLOR_OVERRIDES = {
	cam_settings_reset: ORANGE,
	cam_wb_Auto: ORANGE,
	cam_ae_Auto: ORANGE,
	cam_rgain_reset: DIM_RED,
	cam_rgain_up: DIM_RED,
	cam_rgain_down: DIM_RED,
	cam_bgain_reset: DIM_BLUE,
	cam_bgain_up: DIM_BLUE,
	cam_bgain_down: DIM_BLUE,
	dct_ggain_Reset: DIM_GREEN,
	dct_ggain_Up: DIM_GREEN,
	dct_ggain_Down: DIM_GREEN,
	knob_cam_rgain_direct: DIM_RED,
	knob_cam_bgain_direct: DIM_BLUE,
	knob_dct_ggain_direct: DIM_GREEN,
	knob_dct_black_red: DIM_RED,
	knob_dct_black_blue: DIM_BLUE,
	knob_dct_black_green: DIM_GREEN,
	knob_dct_flare_red: DIM_RED,
	knob_dct_flare_blue: DIM_BLUE,
	knob_dct_flare_green: DIM_GREEN,
	cam_settings_save: DARK_GRAY,
	dct_load_settings: DARK_GRAY,
	if_clear: DARK_GRAY,
	dct_timecode_hold_Run: DARK_GRAY,
	dct_timecode_hold_Hold: DARK_GRAY,
	dct_auto_save_On: DARK_GRAY,
	dct_auto_save_Off: DARK_GRAY,
	dct_audio_enable_On: DARK_CYAN,
	dct_audio_enable_Off: DARK_CYAN,
	knob_dct_audio_gain: DARK_CYAN,
}

export default function updatePresets(self) {
	const presets = {}
	const btn = (category, name, text, actionId, options, feedbacks = []) => ({
		type: 'button',
		category,
		name,
		style: { text, size: 'auto', color: WHITE, bgcolor: BLUE },
		steps: [{ down: [{ actionId, options }], up: [] }],
		feedbacks,
	})
	const gatedIds = MODEL_GATED_IDS[self.cameraModel] ?? []
	for (const [id, c] of Object.entries(COMMANDS)) {
		if (gatedIds.includes(id)) continue
		if (c.kind === 'enum') {
			for (const choice of Object.keys(c.choices)) {
				presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
			}
		} else if (c.kind === 'rud') {
			for (const choice of c.rudChoices ?? Object.keys(RUD)) {
				presets[`${id}_${choice}`] = btn(c.group, `${c.name}: ${choice}`, `${c.name}\\n${choice}`, id, { choice })
			}
		} else if (c.kind === 'fixed') {
			presets[id] = btn(c.group, c.name, c.name.replace(/ /g, '\\n'), id, {})
		} else if (c.kind === 'video') {
			for (const mode of Object.keys(SYSTEM)) {
				const label = SYSTEM_NAMES[mode] ?? `Mode ${mode}`
				presets[`${id}_${mode}`] = btn(c.group, `${c.name}: ${label}`, `${c.name}\\n${label}`, id, { mode })
			}
		} else if (c.kind === 'iso') {
			for (const g of GAIN_ISO) {
				presets[`${id}_${g.iso}`] = btn(c.group, `${c.name}: ISO ${g.iso}`, `${c.name}\\nISO ${g.iso}`, id, {
					iso: g.iso,
				})
			}
		} else if (c.kind === 'shutter') {
			for (const s of SHUTTER_SPEEDS) {
				presets[`${id}_${s.n}`] = btn(c.group, `${c.name}: 1/${s.n}`, `${c.name}\\n1/${s.n}`, id, { n: s.n })
			}
		}
	}
	// Rotary-encoder (Stream Deck+) knobs: turn = adjust +/- step, press = sync.
	for (const p of self.params) {
		if (gatedIds.includes(p.id)) continue
		presets[`knob_${p.id}`] = {
			type: 'button',
			category: `${p.group}`,
			name: `${p.name} (knob)`,
			options: { rotaryActions: true },
			style: { text: p.name, size: 'auto', color: WHITE, bgcolor: BLUE, png64: KNOB_RING_PNG },
			steps: [
				{
					down: [
						KNOB_PRESS_DOWN[p.id] ??
							(p.id in KNOB_PRESS_SET_VALUE
								? { actionId: `${p.id}_knob_reset`, options: {} }
								: { actionId: 'poll_now', options: {} }),
					],
					up: [],
					rotate_right: [{ actionId: 'adjust', options: { param: p.id, step: 1, useKnobStep: true } }],
					rotate_left: [{ actionId: 'adjust', options: { param: p.id, step: -1, useKnobStep: true } }],
				},
			],
			feedbacks: [{ feedbackId: 'knob_value', options: { param: p.id } }],
		}
	}
	presets['wb_kelvin_measure'] = btn(
		'White Balance',
		'WB Kelvin Measure',
		'WB Measure\\n--',
		'dct_wb_temp_measure_now',
		{},
		[{ feedbackId: 'wb_measure_display', options: {} }],
	)
	presets['audio_enable_toggle'] = btn('Audio', 'Audio: Toggle On/Off', 'Audio\\n--', 'dct_audio_enable_toggle', {}, [
		{ feedbackId: 'dct_audio_enable_display', options: {} },
	])
	presets['sdi_range_toggle'] = btn('System', 'SDI: Toggle Legal/Full', 'SDI\\n--', 'dct_sdi_range_toggle', {}, [
		{ feedbackId: 'dct_sdi_range_display', options: {} },
	])
	presets['timecode_hold_toggle'] = btn(
		'System',
		'Timecode: Toggle Run/Hold',
		'TC\\n--',
		'dct_timecode_hold_toggle',
		{},
		[{ feedbackId: 'dct_timecode_hold_display', options: {} }],
	)
	presets['tally_cycle'] = btn('System', 'Tally: Cycle Off/Red/Green/Yellow', 'Tally\\n--', 'dct_tally_cycle', {}, [
		{ feedbackId: 'dct_tally_display', options: {} },
	])
	presets['cam_ae_toggle'] = btn('Exposure', 'AE: Toggle Auto/Manual', 'AE\\n--', 'cam_ae_toggle', {}, [
		{ feedbackId: 'cam_ae_display', options: {} },
	])
	presets['cam_wb_toggle'] = btn('White Balance', 'WB: Toggle Auto/Manual', 'WB\\n--', 'cam_wb_toggle', {}, [
		{ feedbackId: 'cam_wb_display', options: {} },
	])
	for (const [id, bgcolor] of Object.entries(PRESET_BGCOLOR_OVERRIDES)) {
		if (presets[id]) presets[id].style.bgcolor = bgcolor
	}
	self.setPresetDefinitions(presets)
}
