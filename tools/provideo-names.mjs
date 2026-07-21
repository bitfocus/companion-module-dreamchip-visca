// Maps a matched COMMANDS/INQUIRIES id (from commands.js) to the actual
// ProVideo console command name the dct-phoenix-zephyr-bsp firmware runs for
// it. Companion's own `id`/`varId` strings are NOT reliable for this — e.g.
// INQUIRIES.gain -> "cam_gain", COMMANDS.dct_ggain -> "gain_green". Transcribed
// from the BSP's visca/src/visca_map_*.c (branch develop) — re-verify against
// that repo if this list goes stale.
//
// Entry shape:
//   cmd    - the ProVideo command name, or null if there's no real mapping
//            (protocol-only, or simply unimplemented in the current firmware)
//   scaled - true if firmware applies its own placeholder value scaling
//            (map_gain/unmap_gain/map_exposure/ggain_map, all marked "TODO
//            stage 8: calibrate" in the BSP) before this reaches the sensor —
//            we deliberately do NOT re-implement that math here, since it's
//            expected to change independently of this tool.
//   note   - shown verbatim instead of a value, for protocol-only/unimplemented
//            entries or other caveats worth surfacing.
//   rud    - for `kind:'rud'` COMMANDS entries: which of reset/up/down actually
//            resolve to a command in the current firmware ('cam_gain'/
//            'cam_exposure' only support reset; 'gain_red'/'gain_blue'/
//            'gain_green' also support up/down via read-modify-write).
export const PROVIDEO_NAMES = {
	// --- category 0x00/0x04 standard VISCA (visca_map_system.c) -------------
	if_clear: { cmd: null, note: 'protocol IF_Clear ack only, not a ProVideo command' },
	cam_power: { choices: { On: 'low_power 0', Off: 'low_power 1' } },
	cam_system: { cmd: null, note: 'video-mode dialect is conditional/interop-specific (CONFIG_VISCA_CMD_LENS_STUB); see visca_map_system.c, not a flat mapping' },

	// --- category 0x04 exposure (visca_map_exposure.c) ----------------------
	cam_ae: { choices: { 'Full Auto': 'aec 1', Manual: 'aec 0', 'Shutter Pri': 'aec 1' } },
	ae_mode: { cmd: 'aec', scaled: false, note: 'readback: aec!=0 -> Full Auto, else Manual (Shutter Pri is not distinguishable on readback)' },
	cam_gain: { cmd: 'cam_gain', rud: { reset: 'cam_gain 1000', up: null, down: null } },
	cam_gain_direct: { cmd: 'cam_gain', scaled: true },
	gain: { cmd: 'cam_gain', scaled: true },
	cam_shutter: { cmd: 'cam_exposure', rud: { reset: 'cam_exposure 10000', up: null, down: null } },
	cam_shutter_direct: { cmd: 'cam_exposure', scaled: true },
	shutter: { cmd: 'cam_exposure', scaled: true },

	// --- category 0x04 white balance (visca_map_wb.c) -----------------------
	// cam_wb is one COMMANDS entry with several choices, each landing on a
	// different ProVideo command — keyed by the enum choice label.
	cam_wb: {
		choices: {
			Auto: 'awb 1', Indoor: 'wb_preset 1', Outdoor: 'wb_preset 2',
			'One Push': 'awb 0', Manual: 'awb 0', Trigger: 'wb',
			'Color Temp': null, // not handled by wb_command's switch — falls to -ENOTSUP
		},
	},
	wb_mode: { cmd: 'awb', scaled: false, note: 'readback only distinguishes Auto/Manual, not preset/trigger detail' },
	cam_rgain: { cmd: 'gain_red', rud: { reset: 'gain_red 1000', up: 'read-modify-write (+step)', down: 'read-modify-write (-step)' } },
	cam_rgain_direct: { cmd: 'gain_red', scaled: true },
	rgain: { cmd: 'gain_red', scaled: true },
	cam_bgain: { cmd: 'gain_blue', rud: { reset: 'gain_blue 1000', up: 'read-modify-write (+step)', down: 'read-modify-write (-step)' } },
	cam_bgain_direct: { cmd: 'gain_blue', scaled: true },
	bgain: { cmd: 'gain_blue', scaled: true },

	// --- category 0x04 picture (visca_map_picture.c) — raw passthrough, no scaler
	cam_color_gain_direct: { cmd: 'post_sat', scaled: false },
	color_gain: { cmd: 'post_sat', scaled: false },
	cam_color_hue_direct: { cmd: 'post_hue', scaled: false },
	color_hue: { cmd: 'post_hue', scaled: false },
	cam_brightness_direct: { cmd: 'post_bright', scaled: false },
	brightness: { cmd: 'post_bright', scaled: false },
	cam_contrast_direct: { cmd: 'post_cont', scaled: false },
	contrast: { cmd: 'post_cont', scaled: false },
	cam_flip: { cmd: 'flip', scaled: false },
	flip: { cmd: 'flip', scaled: false },

	// --- not handled by any visca_map_*.c in the current firmware -----------
	// (present as a Companion command/inquiry, but no dispatcher recognizes
	// the function code yet — the camera will reply 0x60/0x41.)
	cam_bright: { cmd: null, note: 'not implemented in current firmware (func 0x0D unhandled)' },
	cam_bright_direct: { cmd: null, note: 'not implemented in current firmware (func 0x0D unhandled)' },
	bright: { cmd: null, note: 'not implemented in current firmware (func 0x0D unhandled)' },
	cam_memory: { cmd: null, note: 'not implemented in current firmware (func 0x3F unhandled)' },
	cam_flicker: { cmd: null, note: 'not implemented in current firmware (func 0x23 unhandled)' },
	flicker: { cmd: null, note: 'not implemented in current firmware (func 0x23 unhandled)' },
	cam_gamma: { cmd: null, note: 'not implemented in current firmware (func 0x5B unhandled)' },
	gamma: { cmd: null, note: 'not implemented in current firmware (func 0x5B unhandled)' },
	cam_lr_reverse: { cmd: null, note: 'not implemented in current firmware (func 0x61 unhandled)' },
	lr_reverse: { cmd: null, note: 'not implemented in current firmware (func 0x61 unhandled)' },
	cam_picture_flip: { cmd: null, note: 'not implemented in current firmware (func 0x66 unhandled)' },
	picture_flip: { cmd: null, note: 'not implemented in current firmware (func 0x66 unhandled)' },
	cam_settings_save: { cmd: null, note: 'not implemented in current firmware (func 0xA5 unhandled)' },
	cam_settings_reset: { cmd: null, note: 'not implemented in current firmware (func 0xA0 unhandled)' },
	color_temp: { cmd: null, note: 'not implemented in current firmware (func 0x20 unhandled)' },
	video_mode: { cmd: null, note: 'video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping' },
	power: { cmd: 'low_power', scaled: false, note: 'reachability implies On; see visca_map_system.c cam_power_inq' },
	version: { cmd: null, note: 'static identity reply, not a ProVideo command' },

	// --- category 0x7E Dream Chip vendor extensions (visca_map_dct_ext.c) ---
	// Table-driven 1:1 mappings; raw decoded value == the ProVideo argument,
	// no scaling — full confidence. Green gain (SS 0x01) is the one bespoke
	// exception: it scales like the standard-category gains.
	dct_ggain: { cmd: 'gain_green', choices: { Reset: 'gain_green 1000', Up: 'read-modify-write (+step)', Down: 'read-modify-write (-step)' } },
	dct_ggain_direct: { cmd: 'gain_green', scaled: true },
	dct_gain_mode: { cmd: 'gain_mode', scaled: false },
	dct_black_master: { cmd: 'black_master', scaled: false },
	dct_black_red: { cmd: 'black_red', scaled: false },
	dct_black_green: { cmd: 'black_green', scaled: false },
	dct_black_blue: { cmd: 'black_blue', scaled: false },
	dct_flare: { cmd: 'flare', scaled: false },
	dct_awb_speed: { cmd: 'awb_speed', scaled: false },
	dct_slog3_gain: { cmd: 'slog3_master_gain', scaled: false },
	dct_cnr_mode: { cmd: 'cnr_mode', scaled: false },
	dct_cnr_auto: { cmd: 'cnr_auto', scaled: false },
	dct_dpf_enable: { cmd: 'dpf_enable', scaled: false },
	dct_dpf_strength: { cmd: 'dpf_strength', scaled: false },
	dct_filter_enable: { cmd: 'filter_enable', scaled: false },
	dct_filter_detail: { cmd: 'filter_detail', scaled: false },
	dct_filter_denoise: { cmd: 'filter_denoise', scaled: false },
	dct_color_space: { cmd: 'color_space', scaled: false },
	dct_tm_mode: { cmd: 'tm_mode', scaled: false },
	dct_pq_max_bright: { cmd: 'pq_max_brightness', scaled: false },
	dct_mcc_opmode: { cmd: 'mcc_opmode', scaled: false },
	dct_lut_mode: { cmd: 'lut_mode', scaled: false },
	dct_lut_fixed_mode: { cmd: 'lut_fixed_mode', scaled: false },
	dct_lut_preset: { cmd: 'lut_preset', scaled: false },
	dct_sdi_range: { cmd: 'sdi_range', scaled: false },
	dct_sdi_black: { cmd: 'sdi_black', scaled: false },
	dct_sdi_white: { cmd: 'sdi_white', scaled: false },
	dct_osd: { cmd: 'osd', scaled: false },
	dct_audio_enable: { cmd: 'audio_enable', scaled: false },
	dct_audio_gain: { cmd: 'audio_gain', scaled: false },
	dct_auto_save: { cmd: 'auto_save', scaled: false },
	dct_timecode_hold: { cmd: 'timecode_hold', scaled: false },
}
