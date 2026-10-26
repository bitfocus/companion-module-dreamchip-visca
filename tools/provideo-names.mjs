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
//   scaled - true if the raw VISCA value isn't the literal ProVideo argument —
//            currently always a documented linear scale across a real,
//            known min-max range (see each entry's `note`: cam_gain
//            1000-45715, cam_exposure 100-38339us). We deliberately do NOT
//            re-implement that scaling math here, since it lives in and can
//            change independently of this tool.
//            gain_red/gain_blue/gain_green are NOT in this category: their
//            VISCA encoding was widened to 3 nibbles to exactly represent
//            ISP_AWB_GAIN_MAX (0-4095), so the wire value already equals the
//            real ProVideo argument (scaled: false).
//   note   - shown verbatim instead of a value, for protocol-only/unimplemented
//            entries or other caveats worth surfacing.
//   rud    - for `kind:'rud'` COMMANDS entries: which of reset/up/down actually
//            resolve to a command in the current firmware ('cam_gain'/
//            'cam_exposure' only support reset; 'gain_red'/'gain_blue'/
//            'gain_green' also support up/down via read-modify-write).
export const PROVIDEO_NAMES = {
	// --- category 0x00/0x04 standard VISCA (visca_map_system.c) -------------
	if_clear: { cmd: null, note: 'protocol IF_Clear ack only, not a ProVideo command' },
	cam_system: {
		cmd: null,
		note: 'video-mode dialect is conditional/interop-specific (CONFIG_VISCA_CMD_LENS_STUB); see visca_map_system.c, not a flat mapping',
	},

	// --- category 0x04 exposure (visca_map_exposure.c) ----------------------
	cam_ae: { choices: { Auto: 'aec 1', Manual: 'aec 0', 'Shutter Pri': 'aec 1' } },
	ae_mode: {
		cmd: 'aec',
		scaled: false,
		note: 'readback: aec!=0 -> Full Auto, else Manual (Shutter Pri is not distinguishable on readback)',
	},
	cam_gain: {
		cmd: 'cam_gain',
		rud: { reset: 'cam_gain 1000', up: 'read-modify-write (+109)', down: 'read-modify-write (-109)' },
	},
	cam_gain_direct: {
		cmd: 'cam_gain',
		scaled: true,
		note: 'real range is 1000-45715 (1x/0dB/140 ISO min; max from the current AUTO gain-mode range); raw is 0-4095, linearly scaled, not a placeholder',
	},
	gain: {
		cmd: 'cam_gain',
		scaled: true,
		note: 'real range is 1000-45715 (1x/0dB/140 ISO min; max from the current AUTO gain-mode range); raw is 0-4095, linearly scaled, not a placeholder',
	},
	cam_shutter: {
		cmd: 'cam_exposure',
		rud: { reset: 'cam_exposure 1000', up: 'read-modify-write (+93us)', down: 'read-modify-write (-93us)' },
	},
	cam_shutter_direct: {
		cmd: 'cam_exposure',
		scaled: true,
		note: 'real range is 100-38339us (observed on real hardware); raw is 0-4095, linearly scaled, not a placeholder',
	},
	shutter: {
		cmd: 'cam_exposure',
		scaled: true,
		note: 'real range is 100-38339us (observed on real hardware); raw is 0-4095, linearly scaled, not a placeholder',
	},

	// --- category 0x04 white balance (visca_map_wb.c) -----------------------
	// cam_wb is one COMMANDS entry with several choices, each landing on a
	// different ProVideo command — keyed by the enum choice label.
	cam_wb: {
		choices: {
			Auto: 'awb 1',
			Indoor: 'wb_preset 1',
			Outdoor: 'wb_preset 2',
			Manual: 'awb 0',
			Trigger: 'wb',
		},
	},
	wb_mode: { cmd: 'awb', scaled: false, note: 'readback only distinguishes Auto/Manual, not preset/trigger detail' },
	// wb_preset's calibration-profile presets each have a real Kelvin rating,
	// but there's no way to query which one is active. This is a raw
	// preset-index passthrough (no Kelvin matching) with no inquiry
	// counterpart of its own. wb_temp (below) is the distinct command that
	// DOES set/read a real settable Kelvin value.
	color_temp_direct: {
		cmd: 'wb_preset',
		scaled: false,
		note: 'raw preset index passthrough, not a Kelvin value -- see COMMANDS.color_temp_direct',
	},
	// wb_temp: settable Kelvin whitepoint. The bare-dump form returns
	// "<cur> <min> <max>"; the current/min/max inquiries select one field via
	// a selector byte, so all three resolve to the same ProVideo command.
	dct_wb_temp: {
		cmd: 'wb_temp',
		scaled: false,
		note: 'UI range hardcoded 2200-10000; firmware rejects out-of-range per live per-sensor min/max',
	},
	dct_wb_temp_min: {
		cmd: 'wb_temp',
		scaled: false,
		note: 'min field of "wb_temp" dump (live per-sensor calibrated range); read via the bare wb_temp/dump with a selector, not its own ProVideo command',
	},
	dct_wb_temp_max: {
		cmd: 'wb_temp',
		scaled: false,
		note: 'max field of "wb_temp" dump (live per-sensor calibrated range); read via the bare wb_temp/dump with a selector, not its own ProVideo command',
	},
	dct_wb_temp_measure: {
		cmd: 'wb_temp_measure',
		scaled: false,
		note: 'measured scene color temperature [K] (lpf_cct_run); inquiry-only',
	},
	cam_rgain: {
		cmd: 'gain_red',
		rud: { reset: 'gain_red 512', up: 'read-modify-write (+step)', down: 'read-modify-write (-step)' },
	},
	cam_rgain_direct: { cmd: 'gain_red', scaled: false },
	rgain: { cmd: 'gain_red', scaled: false },
	cam_bgain: {
		cmd: 'gain_blue',
		rud: { reset: 'gain_blue 512', up: 'read-modify-write (+step)', down: 'read-modify-write (-step)' },
	},
	cam_bgain_direct: { cmd: 'gain_blue', scaled: false },
	bgain: { cmd: 'gain_blue', scaled: false },

	// --- category 0x04 picture (visca_map_picture.c) — raw passthrough, no scaler
	cam_color_gain_direct: { cmd: 'post_sat', scaled: false },
	color_gain: { cmd: 'post_sat', scaled: false },
	cam_color_hue_direct: { cmd: 'post_hue', scaled: false },
	color_hue: { cmd: 'post_hue', scaled: false },
	cam_contrast_direct: { cmd: 'post_cont', scaled: false },
	contrast: { cmd: 'post_cont', scaled: false },
	cam_flip: { cmd: 'flip', scaled: false },
	flip: { cmd: 'flip', scaled: false },
	// cam_bright's Direct form shares its RUD's function byte (0x0D) --
	// disambiguated by packet length, not a separate function code.
	cam_bright: {
		cmd: 'post_bright',
		rud: { reset: 'post_bright 0', up: 'read-modify-write (+5)', down: 'read-modify-write (-5)' },
	},
	cam_bright_direct: { cmd: 'post_bright', scaled: false },
	bright: { cmd: 'post_bright', scaled: false },
	// cam_gamma is a plain 4-value enum passthrough to log_mode. Value 0 isn't
	// literally hardcoded to BT709 in the firmware (it's "log mode off,
	// restore whatever LUT was active before"), but the system default LUT is
	// Rec.709, so it behaves as BT709 in the common case.
	cam_gamma: { cmd: 'log_mode', scaled: false },
	gamma: { cmd: 'log_mode', scaled: false },
	// No dedicated flicker command exists -- this read-modify-writes aec's
	// `taf` field (the anti-flicker exposure quantum). taf can't truly be
	// disabled, so Off and 50Hz both resolve to the same real value (10000).
	cam_flicker: {
		choices: {
			Off: 'read-modify-write of aec (taf=10000, same as 50Hz -- taf cannot be disabled)',
			'50Hz': 'read-modify-write of aec (taf=10000)',
			'60Hz': 'read-modify-write of aec (taf=8333)',
		},
	},
	flicker: {
		cmd: 'aec',
		scaled: false,
		note: "reads aec's taf field: 8333 -> 60Hz, anything else (including the un-set-able Off) normalizes to 50Hz",
	},

	cam_settings_save: { cmd: 'save_settings', scaled: false },
	cam_settings_reset: { cmd: 'reset_settings', scaled: false },
	// SET works (raw wb_preset index passthrough -- no ProVideo command
	// accepts a settable Kelvin value, only stat_cct exists and it's
	// read-only AWB telemetry). INQUIRY has no data source: the currently
	// active preset index is never exposed via any text command.
	color_temp: {
		cmd: null,
		note: 'no way to read back the current wb_preset index; SET works, see COMMANDS.color_temp_direct',
	},
	video_mode: {
		cmd: null,
		note: 'video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping',
	},
	version: { cmd: null, note: 'static identity reply, not a ProVideo command' },

	// --- category 0x7E Dream Chip vendor extensions (visca_map_dct_ext.c) ---
	// Table-driven 1:1 mappings; raw decoded value == the ProVideo argument,
	// no scaling — full confidence. Green gain (SS 0x01) is the one bespoke
	// exception: it scales like the standard-category gains.
	// green's reset target is 256 (unity/1.0x, the AWB reference channel),
	// unlike red/blue's 512 (2x) -- confirmed on real hardware.
	dct_ggain: {
		cmd: 'gain_green',
		choices: { Reset: 'gain_green 256', Up: 'read-modify-write (+step)', Down: 'read-modify-write (-step)' },
	},
	dct_ggain_direct: { cmd: 'gain_green', scaled: false },
	dct_gain_mode: { cmd: 'gain_mode', scaled: false },
	dct_black_master: { cmd: 'black_master', scaled: false },
	dct_black_red: {
		cmd: 'black_red',
		scaled: true,
		note: 'real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2)',
	},
	dct_black_green: {
		cmd: 'black_green',
		scaled: true,
		note: 'real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2)',
	},
	dct_black_blue: {
		cmd: 'black_blue',
		scaled: true,
		note: 'real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2)',
	},
	// flare's 3 individually-exposed channels: none of these are standalone
	// commands -- they each set one positional argument of the larger
	// "flare <red> <green> <blue>" command via firmware-side read-modify-write
	// (query current 3-value state, override one channel, reissue the full
	// command). `cmd: 'flare'` (not null) so the raw decoded value still shows
	// in the tool's output alongside the caveat.
	dct_flare_red: {
		cmd: 'flare',
		scaled: true,
		note: "sets flare's positional arg 1 (red), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16",
	},
	dct_flare_green: {
		cmd: 'flare',
		scaled: true,
		note: "sets flare's positional arg 2 (green), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16",
	},
	dct_flare_blue: {
		cmd: 'flare',
		scaled: true,
		note: "sets flare's positional arg 3 (blue), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16",
	},
	dct_awb_speed: {
		cmd: 'awb_speed',
		scaled: true,
		note: 'real range is 0-2; do_awb_speed hard-rejects raw values above 2 with -EINVAL (unlike filter_detail, which clamps instead of erroring)',
	},
	dct_slog3_gain: {
		cmd: 'slog3_master_gain',
		scaled: true,
		note: 'real range is signed -6..12 dB (system_settings.h); do_slog3_master_gain hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled',
	},
	dct_cnr_mode: { cmd: 'cnr_mode', scaled: false },
	dct_cnr_auto: { cmd: 'cnr_auto', scaled: false },
	dct_filter_enable: { cmd: 'filter_enable', scaled: false },
	dct_filter_detail: {
		cmd: 'filter_detail',
		scaled: true,
		note: 'real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL); firmware clamps raw values above 31 to 31 instead of erroring',
	},
	dct_filter_denoise: {
		cmd: 'filter_denoise',
		scaled: false,
		note: 'real range is 0-255 on Violetta, 0-7 on Marietta (firmware dpf_denoise; 0 = off)',
	},
	dct_color_space: {
		cmd: 'color_space',
		scaled: true,
		note: 'real range is 0-2 (Rec.709/Rec.2020/S-Gamut3.Cine, isp_drv.h); do_color_space hard-rejects outside that with -EOPNOTSUPP',
	},
	dct_pq_max_bright: {
		cmd: 'pq_max_brightness',
		scaled: true,
		note: 'real range is 100-10000 cd/m2 (do_pq_max_brightness); raw is 0-4095, linearly scaled, not a placeholder',
	},
	dct_mcc_opmode: { cmd: 'mcc_opmode', scaled: false },
	dct_lut_mode: {
		cmd: 'lut_mode',
		scaled: true,
		note: 'real settable range is 0-1 (Interpolate/Fast Gamma, lut_drv.h); do_lut_mode rejects LUT_MODE_FIXED=2 with -EINVAL ("used only internally")',
	},
	dct_lut_fixed_mode: { cmd: 'lut_fixed_mode', scaled: false },
	dct_lut_preset: { cmd: 'lut_preset', scaled: false },
	dct_lut_fast_gamma: {
		cmd: 'lut_fast_gamma',
		scaled: true,
		note: 'real range is 1100-3000 (gamma x 1000, i.e. 1.1-3.0); raw pq 0-237 maps to 1100+pq*8 (0.008 steps), pq 238-255 clamp to 3000 but read back as 237; inquiry floors (gamma-1100)/8',
	},
	dct_sdi_range: { cmd: 'sdi_range', scaled: false },
	dct_sdi_black: {
		cmd: 'sdi_black',
		scaled: true,
		note: 'real range is signed -60..60; do_sdi_black hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled',
	},
	dct_sdi_white: {
		cmd: 'sdi_white',
		scaled: true,
		note: 'real range is signed -80..79; do_sdi_white hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled',
	},
	dct_osd: { cmd: 'osd', scaled: false },
	dct_audio_enable: { cmd: 'audio_enable', scaled: false },
	dct_audio_gain: {
		cmd: 'audio_gain',
		scaled: true,
		note: 'real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity gain); raw is 0-4095, firmware multiplies it by 16',
	},
	dct_auto_save: { cmd: 'auto_save', scaled: false },
	dct_timecode_hold: { cmd: 'timecode_hold', scaled: false },
	dct_load_settings: { cmd: 'load_settings', scaled: false },

	// aec's 3 individually-exposed fields: none of these are standalone
	// commands -- they each set one positional argument of the much larger
	// "aec <enable> <setPoint> <speed> <clmTolerance> <costGain> <costTint>
	// <costApt> <taf> <maxGain> <useCustomWeights>" command via firmware-side
	// read-modify-write (query current 10-value state, override one field,
	// reissue the full command). `cmd: 'aec'` (not null) so the raw decoded
	// value still shows in the tool's output alongside the caveat.
	dct_aec_setpoint: {
		cmd: 'aec',
		scaled: true,
		note: "sets aec's positional arg 2 (setPoint), real range 50-3000, via read-modify-write of all 10 args",
	},
	dct_aec_speed: {
		cmd: 'aec',
		scaled: true,
		note: "sets aec's positional arg 3 (speed), real range 1-30, via read-modify-write of all 10 args",
	},
	dct_aec_maxgain: {
		cmd: 'aec',
		scaled: true,
		note: "sets aec's positional arg 9 (maxGain), real range 1000-45715 (same as cam_gain), via read-modify-write of all 10 args",
	},
}
