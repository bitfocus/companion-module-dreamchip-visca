import { combineRgb } from '@companion-module/base'

export const GREEN = combineRgb(0, 102, 0)
export const RED = combineRgb(204, 0, 0)
export const BLUE = combineRgb(0, 51, 102)
export const ORANGE = combineRgb(255, 102, 0)
export const DIM_RED = combineRgb(102, 0, 0)
export const DIM_GREEN = combineRgb(0, 102, 0)
export const DIM_BLUE = combineRgb(0, 0, 102)
export const DARK_GRAY = combineRgb(51, 51, 51)
export const LIGHT_GRAY = combineRgb(153, 153, 153)
export const DARK_CYAN = combineRgb(0, 102, 102)
export const LIGHT_CYAN = combineRgb(0, 204, 204)
export const LIGHT_BLUE = combineRgb(51, 153, 255)
export const WHITE = combineRgb(255, 255, 255)

// Commands/presets that don't apply to one of the two camera product lines
// (confirmed on real hardware: Tone Mapping Mode only exists on Atom Two HDR,
// so it is unusable -- and thus hidden -- on Atom Two; Filter Enable/Gain Mode
// are hidden on Atom Two HDR per product decision; Filter Denoise exists on
// both, with a narrower range on Atom Two HDR, see COMMANDS.modelMax). Applied in the actions/presets generators and the poll filters
// once the camera's model is known (see this.cameraModel, set from
// applyInquiryReply()'s version-reply hook) -- unknown model means
// unrestricted, so a camera whose firmware predates this model-id scheme (or
// a failed/slow version poll) never has controls incorrectly hidden.
export const MODEL_GATED_IDS = {
	'atom-two': ['dct_tm_mode', 'dct_tm_mode_preset'],
	'atom-two-hdr': ['dct_filter_enable', 'dct_gain_mode'],
}

// Knobs whose real command already has a proper RUD "Reset" (server-side
// target, confirmed via RUD_INQUIRY_ID's unconditional resyncKnob confirm-
// read) -- pressing reuses that exact same action/choice instead of the
// generic poll_now every other knob gets.
export const KNOB_PRESS_DOWN = {
	cam_rgain_direct: { actionId: 'cam_rgain', options: { choice: 'reset' } },
	cam_bgain_direct: { actionId: 'cam_bgain', options: { choice: 'reset' } },
	dct_ggain_direct: { actionId: 'dct_ggain', options: { choice: 'Reset' } },
	cam_gain_direct: { actionId: 'cam_gain', options: { choice: 'reset' } },
	cam_shutter_direct: { actionId: 'cam_shutter', options: { choice: 'reset' } },
	cam_bright_direct: { actionId: 'cam_bright', options: { choice: 'reset' } },
}

// Knobs with no existing RUD/enum "reset" concept (kind:'direct' only, no
// server-side target to ask for) -- pressing sends an explicit direct SET to
// a fixed value instead. Since we choose the exact value ourselves (unlike a
// RUD reset, whose real landing value has to be confirmed via inquiry), the
// generated action can write state/knob directly with no confirm-read needed.
export const KNOB_PRESS_SET_VALUE = {
	cam_color_hue_direct: 0, // neutral hue -- no shift (signed -128..127)
	// Color Gain/Contrast's real factory default is 128 (0x80, "1.0x" on
	// their fixed-point scales) -- confirmed against factory-default state.
	cam_color_gain_direct: 128,
	cam_contrast_direct: 128,
	dct_wb_temp: 6500, // common daylight white-balance reference, per user request
	dct_audio_gain: 256, // per user request
	// LUT Fast Gamma reset target: standard gamma 2.2. The wire grid (1100 + pq*8)
	// can't hit 2.200 exactly -- pq 137 lands on 2.196 and 138 on 2.204
	dct_lut_fast_gamma: 138,
}

// dct_tally_cycle's press order (actions.js); each state is the
// pair of local booleans this.tally tracks. No VISCA inquiry exists for
// either lamp (commands.js's dct_tally_red/dct_tally_green are set-only),
// so this optimistic local pair -- not a polled this.state value -- is the
// source of truth once the user starts pressing the button. Yellow (both
// lamps on) is included as its own cycle stop, reached
// by sending both Red On and Green On.
export const TALLY_CYCLE_STATES = [
	{ red: false, green: false }, // Off
	{ red: true, green: false }, // Red
	{ red: false, green: true }, // Green
	{ red: true, green: true }, // Yellow
]
