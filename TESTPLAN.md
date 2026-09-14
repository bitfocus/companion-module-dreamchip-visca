# VISCA Companion Test Plan

Generated from `commands.js` + `tools/provideo-names.mjs` (the real ProVideo
command/effect each Companion action or inquiry maps to). Check off each row
after verifying it against real hardware; use Comments for anything
unexpected (error code, wrong value, etc.). The 4 toggle-button rows (Audio,
SDI, Timecode) and "WB Kelvin Measure" are Companion-only additions with no
`COMMANDS` entry of their own (see `main.js`), so they're listed here by hand.

Total: 96 command test cases, 54 inquiries.

An automated equivalent of this plan lives at `tools/camera-check.mjs` -- it
sends the same commands over a real serial connection and validates the
replies (ACK+Completion vs Error, and set-then-read-back via the paired
inquiry where possible). It disables AEC/AWB before the run (manual
gain/exposure/WB-gain tests need them off to hold a set value) and, once
finished, turns AEC/AWB back on and calls `reset_settings`. Run it with:

```
VISCA_TEST_PORT=/dev/ttyUSB0 npm run test:hardware
```

Destructive commands (Settings Save/Reset) are skipped *as test
cases* by default -- pass `--include-destructive` to include them. Settings
Reset is still always run once at the very end regardless, as the cleanup
step described above. It is not part of `npm test`, and requires a camera
attached.

Companion's own background polling (`main.js`) is two-tier: 35 of the 54
inquiries are calibration/setup-style values (`INQUIRIES.*.once: true` in
`commands.js`) that are only ever queried once per connection
(`pollStartupOnce()`) or on demand ("System: Poll startup values now"), not
on the recurring interval timer (`pollLiveOnce()`). SDI Range, Timecode, and
Audio Enable stay on the continuous tier despite being DCT settings, since
they back the SDI/Timecode/Audio toggle buttons' live status display. The
"Poll inquiries now"
action still refreshes everything regardless of tier. This doesn't change
what's testable here -- every inquiry below is still reachable, just not
necessarily via the recurring poll.

## Commands

### System

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| IF Clear | protocol IF_Clear ack only, not a ProVideo command | [N] | |
| Settings Save | save_settings | [ ] | |
| Settings Reset | reset_settings | [Y] | |
| Load Settings | load_settings | [ ] | |
| Black Master | black_master <value> | [ Y] | |
| Black Red | black_red <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ Y] | |
| Black Green | black_green <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ Y] | |
| Black Blue | black_blue <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ Y] | |
| Flare Red | flare <raw=<value>>  // sets flare's positional arg 1 (red), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ Y] | |
| Flare Green | flare <raw=<value>>  // sets flare's positional arg 2 (green), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ Y] | |
| Flare Blue | flare <raw=<value>>  // sets flare's positional arg 3 (blue), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ Y] | |
| AWB Speed | awb_speed <raw=<value>>  // real range is 0-2; do_awb_speed hard-rejects raw values above 2 with -EINVAL (unlike filter_detail, which clamps instead of erroring) | [ Y] | |
| S-Log3 Master Gain | slog3_master_gain <raw=<value>>  // real range is signed -6..12 dB (system_settings.h); do_slog3_master_gain hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ Y] | |
| Color Space | color_space <raw=<value>>  // real range is 0-2 (Rec.709/Rec.2020/S-Gamut3.Cine, isp_drv.h); do_color_space hard-rejects outside that with -EOPNOTSUPP | [ Y] | reported failing on real hardware (raw=0 -> 90 61 41 ff); VISCA mapping itself confirmed correct against firmware source -- cause undetermined (CONFIG_CMD_COLOR_SPACE_AVAILABLE compiled out, or a runtime ISP/vout register-write failure); see investigation notes|
| Color Space Preset: Rec.709 | color_space 0 (same wire command as Color Space (direct) above) | [ ] | |
| Color Space Preset: Rec.2020 | color_space 1 | [ ] | |
| Color Space Preset: S-Gamut3.Cine | color_space 2 | [ ] | |
| PQ Max Brightness | pq_max_brightness <raw=<value>>  // real range is 100-10000 cd/m2 (do_pq_max_brightness); raw is 0-4095, linearly scaled, not a placeholder | [ Y] | |
| MCC Op-Mode | mcc_opmode <value> | [ Y] | |
| CNR Auto: Off | cnr_auto 0 | [ Y] | |
| CNR Auto: On | cnr_auto 1 | [ Y] | dont see a change|
| CNR Mode | cnr_mode <value> | [ Y] | |
| DPF Strength | dpf_strength <value>  // "DPF Enable" removed from Companion: dpf_enable/dpf_strength were both deleted from firmware in favor of a single dpf_denoise 0-7 knob (0=off); the VISCA mapping for function 0x13 was fixed to follow the rename, but the Companion command is still named/wired as dpf_strength pending that rename here too | [ N] | |
| Filter Enable: Off | filter_enable 0 | [ Y] | |
| Filter Enable: On | filter_enable 1 | [ Y] | |
| Filter Detail | filter_detail <raw=<value>>  // real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL); firmware clamps raw values above 31 to 31 instead of erroring | [ Y] | |
| Filter Denoise | filter_denoise <value> | [ Y] | |
| LUT Mode | lut_mode <raw=<value>>  // real settable range is 0-1 (Interpolate/Fast Gamma, lut_drv.h); do_lut_mode rejects LUT_MODE_FIXED=2 with -EINVAL ("used only internally") | [ Y] | |
| LUT Fixed Mode | lut_fixed_mode <value> | [ Y] | |
| LUT Preset | lut_preset <value> | [ Y] | |
| SDI Range: Legal | sdi_range 0 | [ Y] | |
| SDI Range: Full | sdi_range 1 | [ Y] | |
| SDI: Toggle Legal/Full | sdi_range 0 or 1 (Companion-only toggle, see main.js) | [ ] | |
| SDI Black | sdi_black <raw=<value>>  // real range is signed -60..60; do_sdi_black hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ Y] | |
| SDI White | sdi_white <raw=<value>>  // real range is signed -80..79; do_sdi_white hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ Y] | |
| Auto Save: Off | auto_save 0 | [ N] | how to test?|
| Auto Save: On | auto_save 1 | [ N] | |
| Timecode: Run | timecode_hold 0 | [ N] | cant see timecode|
| Timecode: Hold | timecode_hold 1 | [ N] | |
| Timecode: Toggle Run/Hold | timecode_hold 0 or 1 (Companion-only toggle, see main.js) | [ ] | |
| Gamma: BT.709 | log_mode 0 | [ Y] | |
| Gamma: HLG | log_mode 1 | [ Y] | |
| Gamma: PQ | log_mode 2 | [ Y] | |
| Gamma: S-Log3 | log_mode 3 | [ Y] | |
| Bright: reset | post_bright 0 | [ Y] | |
| Bright: up | read-modify-write (+5) | [ Y] | |
| Bright: down | read-modify-write (-5) | [ Y] | |
| Bright (direct) | post_bright <value> | [ Y] | |
| Contrast (direct) | post_cont <value> | [ Y] | |
| Flip: Off | flip 0 | [ Y] | |
| Flip: Flip-H | flip 1 | [ Y] | |
| Flip: Flip-V | flip 2 | [ Y] | |
| Flip: Flip-HV | flip 3 | [ Y] | |

### Video Modes

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Video Mode | (select video mode, see SYSTEM table in commands.js) | [N] | wrapped in CONFIG_VISCA_CMD_LENS_STUB, currently disabled|

### Exposure

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| AE: Auto | aec 1 | [ Y] | |
| AE: Manual | aec 0 | [ Y] | |
| AE: Shutter Pri | aec 1 | [ Y] | |
| AE: Toggle Auto/Manual | aec 1 or 0 (Companion-only toggle, see main.js) | [ ] | |
| Gain: reset | cam_gain 1000 | [ Y] | |
| Gain: up | read-modify-write (+109) | [ Y] | |
| Gain: down | read-modify-write (-109) | [ Y] | |
| Gain (direct) | cam_gain <raw=<value>>  // real range is 1000-45715 (1x/0dB/140 ISO min; max from the current AUTO gain-mode range); raw is 0-4095, linearly scaled, not a placeholder; knob is log-scaled (5%/turn, 4-raw-unit minimum step), see main.js adjustParam(); knob LCD displays ISO (gainRawToIso(), commands.js), not the raw number | [ Y] | |
| Shutter: reset | cam_exposure 1000 | [ Y] | |
| Shutter: up | read-modify-write (+93us) | [ Y] | |
| Shutter: down | read-modify-write (-93us) | [ Y] | |
| Shutter (direct) | cam_exposure <raw=<value>>  // real range is 100-38339us (observed on real hardware); raw is 0-4095, linearly scaled, not a placeholder; knob is now log-scaled (5%/turn, 4-raw-unit minimum step) and floored so the fastest selectable manual shutter is >=200us (was 100us); knob LCD displays microseconds (shutterRawToUs(), commands.js) | [ ] | needs re-verification: min floor + logScale are new|
| Flicker: Off | read-modify-write of aec (taf=10000, same as 50Hz -- taf cannot be disabled) | [ Y] | |
| Flicker: 50Hz | read-modify-write of aec (taf=10000) | [ Y] | |
| Flicker: 60Hz | read-modify-write of aec (taf=8333) | [ Y] | |
| AEC SetPoint | aec <raw=<value>>  // sets aec's positional arg 2 (setPoint), real range 50-3000, via read-modify-write of all 10 args | [ Y] | |
| AEC Speed | aec <raw=<value>>  // sets aec's positional arg 3 (speed), real range 1-30, via read-modify-write of all 10 args | [ Y] | |
| AEC Max Gain | aec <raw=<value>>  // sets aec's positional arg 9 (maxGain), real range 1000-45715 (same as cam_gain), via read-modify-write of all 10 args | [ Y] | dont see effect|
| Gain Mode: Auto | gain_mode 0 | [ Y] | |
| Gain Mode: LCG | gain_mode 1 | [ Y] | |
| Gain Mode: HCG | gain_mode 2 | [ Y] | |

### White Balance

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| WB: Auto | awb 1 | [ Y] | |
| WB: Indoor | wb_preset 1 | [ Y] | |
| WB: Outdoor | wb_preset 2 | [ Y] | |
| WB: Manual | awb 0 | [ Y] | |
| WB: Trigger | wb | [ Y] | |
| WB: Toggle Auto/Manual | awb 1 or 0 (Companion-only toggle, see main.js) | [ ] | |
| Red Gain: reset | gain_red 512 | [ Y] | |
| Red Gain: up | read-modify-write (+step) | [ Y] | |
| Red Gain: down | read-modify-write (-step) | [ Y] | |
| Red Gain (direct) | gain_red <value>; knob LCD displays a float factor value/256 (wbGainFactor(), commands.js), unity=256 | [ Y] | |
| Blue Gain: reset | gain_blue 512 | [ Y] | |
| Blue Gain: up | read-modify-write (+step) | [ Y] | |
| Blue Gain: down | read-modify-write (-step) | [ Y] | |
| Blue Gain (direct) | gain_blue <value>; knob LCD displays a float factor value/256 (wbGainFactor()), unity=256 | [ Y] | |
| Color Gain (direct) | post_sat <value>; knob LCD displays a float factor value/128 (saturationFactor(), commands.js) -- different unity than the WB channel gains above, despite the similar name | [ Y] | |
| Color Hue (direct) | post_hue <value>; knob LCD displays degrees (hueRawToDeg(): raw*90/128), see commands.js | [ Y] | |
| Color Temp Preset (direct) | wb_preset <value>  // renamed from "Color Temp (direct)" to disambiguate from the settable Kelvin entry below, which now owns the bare "Color Temp" name | [ Y] | query: cannot parse return string|
| Color Temp (Kelvin) | wb_temp <value>  // UI range hardcoded 2200-10000; firmware rejects out-of-range per live per-sensor min/max; knob LCD displays "<value> K"; COMMANDS/action name is now just "Color Temp" (Kelvin unit shown via the knob's format() instead) | [ ] | |
| Green Gain: Reset | gain_green 256 | [ Y] | |
| Green Gain: Up | read-modify-write (+step) | [ Y] | |
| Green Gain: Down | read-modify-write (-step) | [ Y] | |
| Green Gain (direct) | gain_green <value>; knob LCD displays a float factor value/256 (wbGainFactor()), unity=256 | [ Y] | |
| WB Kelvin Measure | wb_temp_measure | [ ] | |

### Audio

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Audio Enable: Off | audio_enable 0 | [ Y] | |
| Audio Enable: On | audio_enable 1 | [ Y] | |
| Audio: Toggle On/Off | audio_enable 0 or 1 (Companion-only toggle, see main.js) | [ ] | |
| Audio Gain | audio_gain <raw=<value>>  // real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity gain); raw is 0-4095, firmware multiplies it by 16; knob is log-scaled, now stepped in exact 0.5dB increments (was a generic 5%/turn), see main.js adjustParam(); knob LCD displays dB (audioGainRawToDb(), commands.js), 0 to ~24.08dB (the hardware's real ceiling) | [ ] | needs re-verification: stepPercent + display are new|

## Inquiries (Read-back)

| Companion Inquiry | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Version | static identity reply, not a ProVideo command | [ ] | |
| Video Mode | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| AE Mode | readback: aec!=0 -> Full Auto, else Manual (Shutter Pri is not distinguishable on readback) | [ ] | |
| Gain | real range is 1000-45715 (1x/0dB/140 ISO min; max from the current AUTO gain-mode range); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| Shutter | real range is 100-38339us (observed on real hardware); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| WB Mode | readback only distinguishes Auto/Manual, not preset/trigger detail | [ ] | |
| Red Gain | gain_red | [ ] | |
| Blue Gain | gain_blue | [ ] | |
| Color Temp | no way to read back the current wb_preset index; SET works, see COMMANDS.color_temp_direct | [ ] | |
| Color Temp (K) | current field of "wb_temp" dump (live per-sensor calibrated range) | [ ] | |
| Color Temp Min (K) | min field of "wb_temp" dump; read via the bare wb_temp/dump with a selector, not its own ProVideo command | [ ] | |
| Color Temp Max (K) | max field of "wb_temp" dump; read via the bare wb_temp/dump with a selector, not its own ProVideo command | [ ] | |
| Color Temp Measured (K) | measured scene color temperature [K] (lpf_cct_run); inquiry-only, no ProVideo set handler exists at all | [ ] | |
| Color Gain | post_sat | [ ] | |
| Color Hue | post_hue | [ ] | |
| Gamma | log_mode | [ ] | |
| Bright | post_bright | [ ] | |
| Contrast | post_cont | [ ] | |
| Flicker | reads aec's taf field: 8333 -> 60Hz, anything else (including the un-set-able Off) normalizes to 50Hz | [ ] | |
| Flip | flip | [ ] | |
| Green Gain | gain_green | [ ] | |
| Gain Mode | gain_mode | [ ] | |
| Black Master | black_master | [ ] | |
| Black Red | real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |
| Black Green | real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |
| Black Blue | real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |
| Flare Red | sets flare's positional arg 1 (red), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| Flare Green | sets flare's positional arg 2 (green), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| Flare Blue | sets flare's positional arg 3 (blue), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| AWB Speed | real range is 0-2; do_awb_speed hard-rejects raw values above 2 with -EINVAL (unlike filter_detail, which clamps instead of erroring) | [ ] | |
| S-Log3 Master Gain | real range is signed -6..12 dB (system_settings.h); do_slog3_master_gain hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| CNR Mode | cnr_mode | [ ] | |
| CNR Auto | cnr_auto | [ ] | |
| DPF Strength | dpf_strength  // removed from firmware (see Companion Actions section above); this inquiry is kept in Companion but will always error until renamed to dpf_denoise | [ ] | |
| Filter Enable | filter_enable | [ ] | |
| Filter Detail | real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL); firmware clamps raw values above 31 to 31 instead of erroring | [ ] | |
| Filter Denoise | filter_denoise | [ ] | |
| Color Space | real range is 0-2 (Rec.709/Rec.2020/S-Gamut3.Cine, isp_drv.h); do_color_space hard-rejects outside that with -EOPNOTSUPP | [ ] | |
| PQ Max Brightness | real range is 100-10000 cd/m2 (do_pq_max_brightness); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| LUT Mode | real settable range is 0-1 (Interpolate/Fast Gamma, lut_drv.h); do_lut_mode rejects LUT_MODE_FIXED=2 with -EINVAL ("used only internally") | [ ] | |
| LUT Fixed Mode | lut_fixed_mode | [ ] | |
| LUT Preset | lut_preset | [ ] | |
| SDI Range | sdi_range | [ ] | |
| SDI Black | real range is signed -60..60; do_sdi_black hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| SDI White | real range is signed -80..79; do_sdi_white hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| MCC Op-Mode | mcc_opmode | [ ] | |
| OSD | osd  // no Companion buttons remain for this (removed); the inquiry/variable is kept | [ ] | |
| Auto Save | auto_save | [ ] | |
| Timecode | timecode_hold | [ ] | |
| Audio Enable | audio_enable | [ ] | |
| Audio Gain | real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity gain); raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| AEC SetPoint | sets aec's positional arg 2 (setPoint), real range 50-3000, via read-modify-write of all 10 args | [ ] | |
| AEC Speed | sets aec's positional arg 3 (speed), real range 1-30, via read-modify-write of all 10 args | [ ] | |
| AEC Max Gain | sets aec's positional arg 9 (maxGain), real range 1000-45715 (same as cam_gain), via read-modify-write of all 10 args | [ ] | |
