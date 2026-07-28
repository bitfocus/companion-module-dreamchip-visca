# VISCA Companion Test Plan

Generated from `commands.js` + `tools/provideo-names.mjs` (the real ProVideo
command/effect each Companion action or inquiry maps to). Check off each row
after verifying it against real hardware; use Comments for anything
unexpected (error code, wrong value, etc.).

Total: 125 command test cases, 52 inquiries.

An automated equivalent of this plan lives at `tools/camera-check.mjs` -- it
sends the same commands over a real serial connection and validates the
replies (ACK+Completion vs Error, and set-then-read-back via the paired
inquiry where possible). It disables AEC/AWB before the run (manual
gain/exposure/WB-gain tests need them off to hold a set value) and, once
finished, turns AEC/AWB back on and calls `reset_settings`. Run it with:

```
VISCA_TEST_PORT=/dev/ttyUSB0 npm run test:hardware
```

Destructive commands (Settings Save/Reset, Memory) are skipped *as test
cases* by default -- pass `--include-destructive` to include them. Settings
Reset is still always run once at the very end regardless, as the cleanup
step described above. `OSD` is always skipped (visually disruptive to
anyone monitoring the feed). It is not part of `npm test`, and requires a
camera attached.

## Commands

### System

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| IF Clear | protocol IF_Clear ack only, not a ProVideo command | [ ] | |
| Settings Save | not implemented in current firmware (func 0xA5 unhandled) | [ ] | |
| Settings Reset | reset_settings | [ ] | |
| Memory: Reset | not implemented in current firmware (func 0x3F unhandled) | [ ] | |
| Memory: Set | not implemented in current firmware (func 0x3F unhandled) | [ ] | |
| Memory: Recall | not implemented in current firmware (func 0x3F unhandled) | [ ] | |

### Video

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Video: 1080p30 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080p25 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080p24 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080p23.98 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080p50 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080p60 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080i60 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |
| Video: 1080i50 | video-mode dialect is conditional/interop-specific; see visca_map_system.c, not a flat mapping | [ ] | |

### Exposure

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| AE Mode: Full Auto | aec 1 | [ ] | |
| AE Mode: Manual | aec 0 | [ ] | |
| AE Mode: Shutter Pri | aec 1 | [ ] | |
| Gain: reset | cam_gain 1000 | [ ] | |
| Gain: up | read-modify-write (+109) | [ ] | |
| Gain: down | read-modify-write (-109) | [ ] | |
| Gain (direct) | cam_gain <raw=<value>>  // real range is 1000-45715 (1x/0dB/140 ISO min; max from the current AUTO gain-mode range); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| Gain (ISO): ISO 140 | cam_gain <raw=0> (ISO 140, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 160 | cam_gain <raw=13> (ISO 160, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 200 | cam_gain <raw=39> (ISO 200, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 250 | cam_gain <raw=71> (ISO 250, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 320 | cam_gain <raw=117> (ISO 320, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 400 | cam_gain <raw=170> (ISO 400, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 500 | cam_gain <raw=235> (ISO 500, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 640 | cam_gain <raw=327> (ISO 640, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 800 | cam_gain <raw=431> (ISO 800, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 1000 | cam_gain <raw=562> (ISO 1000, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 1250 | cam_gain <raw=726> (ISO 1250, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 1600 | cam_gain <raw=954> (ISO 1600, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 2000 | cam_gain <raw=1216> (ISO 2000, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 2500 | cam_gain <raw=1543> (ISO 2500, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 3200 | cam_gain <raw=2001> (ISO 3200, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 4000 | cam_gain <raw=2524> (ISO 4000, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 5000 | cam_gain <raw=3179> (ISO 5000, OG03A10 sensor) | [ ] | |
| Gain (ISO): ISO 6400 | cam_gain <raw=4094> (ISO 6400, OG03A10 sensor) | [ ] | |
| Shutter: reset | cam_exposure 1000 | [ ] | |
| Shutter: up | read-modify-write (+93us) | [ ] | |
| Shutter: down | read-modify-write (-93us) | [ ] | |
| Shutter (direct) | cam_exposure <raw=<value>>  // real range is 100-38339us (observed on real hardware); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| Flicker: Off | read-modify-write of aec (taf=10000, same as 50Hz -- taf cannot be disabled) | [ ] | |
| Flicker: 50Hz | read-modify-write of aec (taf=10000) | [ ] | |
| Flicker: 60Hz | read-modify-write of aec (taf=8333) | [ ] | |
| AEC SetPoint | aec <raw=<value>>  // sets aec's positional arg 2 (setPoint), real range 50-3000, via read-modify-write of all 10 args | [ ] | |
| AEC Speed | aec <raw=<value>>  // sets aec's positional arg 3 (speed), real range 1-30, via read-modify-write of all 10 args | [ ] | |
| AEC Max Gain | aec <raw=<value>>  // sets aec's positional arg 9 (maxGain), real range 1000-45715 (same as cam_gain), via read-modify-write of all 10 args | [ ] | |

### White Balance

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| White Balance: Auto | awb 1 | [ ] | |
| White Balance: Indoor | wb_preset 1 | [ ] | |
| White Balance: Outdoor | wb_preset 2 | [ ] | |
| White Balance: Manual | awb 0 | [ ] | |
| White Balance: Color Temp | wb_preset is real (see Color Temp (direct)), but this VISCA path (func 0x35 data 0x20) has no room for a preset index -- always errors | [ ] | |
| White Balance: Trigger | wb | [ ] | |
| Red Gain: reset | gain_red 512 | [ ] | |
| Red Gain: up | read-modify-write (+step) | [ ] | |
| Red Gain: down | read-modify-write (-step) | [ ] | |
| Red Gain (direct) | gain_red <value> | [ ] | |
| Blue Gain: reset | gain_blue 512 | [ ] | |
| Blue Gain: up | read-modify-write (+step) | [ ] | |
| Blue Gain: down | read-modify-write (-step) | [ ] | |
| Blue Gain (direct) | gain_blue <value> | [ ] | |
| Color Gain (direct) | post_sat <value> | [ ] | |
| Color Hue (direct) | post_hue <value> | [ ] | |
| Color Temp (direct) | wb_preset <value> | [ ] | |
| Green Gain: Reset | gain_green 256 | [ ] | |
| Green Gain: Up | read-modify-write (+step) | [ ] | |
| Green Gain: Down | read-modify-write (-step) | [ ] | |
| Green Gain (direct) | gain_green <value> | [ ] | |

### Picture

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Gamma: BT.709 | log_mode 0 | [ ] | |
| Gamma: HLG | log_mode 1 | [ ] | |
| Gamma: PQ | log_mode 2 | [ ] | |
| Gamma: S-Log3 | log_mode 3 | [ ] | |
| Bright: reset | post_bright 0 | [ ] | |
| Bright: up | read-modify-write (+5) | [ ] | |
| Bright: down | read-modify-write (-5) | [ ] | |
| Bright (direct) | post_bright <value> | [ ] | |
| Contrast (direct) | post_cont <value> | [ ] | |
| Flip: Off | flip 0 | [ ] | |
| Flip: Flip-H | flip 1 | [ ] | |
| Flip: Flip-V | flip 2 | [ ] | |
| Flip: Flip-HV | flip 3 | [ ] | |

### DCT Gain

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Gain Mode: Auto | gain_mode 0 | [ ] | |
| Gain Mode: LCG | gain_mode 1 | [ ] | |
| Gain Mode: HCG | gain_mode 2 | [ ] | |

### DCT Black

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Black Master | black_master <value> | [ ] | |
| Black Red | black_red <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |
| Black Green | black_green <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |
| Black Blue | black_blue <raw=<value>>  // real range is signed -4096..4095 (ISP_BLS_MIN/MAX); raw is signed -2048..2047, firmware doubles it (x2) | [ ] | |

### DCT Color

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Flare Red | flare <raw=<value>>  // sets flare's positional arg 1 (red), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| Flare Green | flare <raw=<value>>  // sets flare's positional arg 2 (green), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| Flare Blue | flare <raw=<value>>  // sets flare's positional arg 3 (blue), real range 0-65535, via read-modify-write of all 3 args; raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| AWB Speed | awb_speed <raw=<value>>  // real range is 0-2; do_awb_speed hard-rejects raw values above 2 with -EINVAL (unlike filter_detail, which clamps instead of erroring) | [ ] | |
| S-Log3 Master Gain | slog3_master_gain <raw=<value>>  // real range is signed -6..12 dB (system_settings.h); do_slog3_master_gain hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| Color Space | color_space <raw=<value>>  // real range is 0-2 (Rec.709/Rec.2020/S-Gamut3.Cine, isp_drv.h); do_color_space hard-rejects outside that with -EOPNOTSUPP | [ ] | |
| Tone-Mapping Mode | tm_mode <value> | [ ] | |
| PQ Max Brightness | pq_max_brightness <raw=<value>>  // real range is 100-10000 cd/m2 (do_pq_max_brightness); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| MCC Op-Mode | mcc_opmode <value> | [ ] | |

### DCT Detail/NR

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| CNR Auto: Off | cnr_auto 0 | [ ] | |
| CNR Auto: On | cnr_auto 1 | [ ] | |
| CNR Mode | cnr_mode <value> | [ ] | |
| DPF Enable: Off | dpf_enable 0 | [ ] | |
| DPF Enable: On | dpf_enable 1 | [ ] | |
| DPF Strength | dpf_strength <value> | [ ] | |
| Filter Enable: Off | filter_enable 0 | [ ] | |
| Filter Enable: On | filter_enable 1 | [ ] | |
| Filter Detail | filter_detail <raw=<value>>  // real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL); firmware clamps raw values above 31 to 31 instead of erroring | [ ] | |
| Filter Denoise | filter_denoise <value> | [ ] | |

### DCT LUT

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| LUT Mode | lut_mode <raw=<value>>  // real settable range is 0-1 (Interpolate/Fast Gamma, lut_drv.h); do_lut_mode rejects LUT_MODE_FIXED=2 with -EINVAL ("used only internally") | [ ] | |
| LUT Fixed Mode | lut_fixed_mode <value> | [ ] | |
| LUT Preset | lut_preset <value> | [ ] | |

### DCT SDI

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| SDI Range: Legal | sdi_range 0 | [ ] | |
| SDI Range: Full | sdi_range 1 | [ ] | |
| SDI Black | sdi_black <raw=<value>>  // real range is signed -60..60; do_sdi_black hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| SDI White | sdi_white <raw=<value>>  // real range is signed -80..79; do_sdi_white hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |

### DCT OSD/Audio

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| OSD: Off | osd 0 | [ ] | |
| OSD: On | osd 1 | [ ] | |
| Audio Enable: Off | audio_enable 0 | [ ] | |
| Audio Enable: On | audio_enable 1 | [ ] | |
| Audio Gain | audio_gain <raw=<value>>  // real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity gain); raw is 0-4095, firmware multiplies it by 16 | [ ] | |

### DCT System

| Companion Action | ProVideo Command | Tested | Comments |
|---|---|---|---|
| Auto Save: Off | auto_save 0 | [ ] | |
| Auto Save: On | auto_save 1 | [ ] | |
| Timecode Hold: Run | timecode_hold 0 | [ ] | |
| Timecode Hold: Hold | timecode_hold 1 | [ ] | |

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
| DPF Enable | dpf_enable | [ ] | |
| DPF Strength | dpf_strength | [ ] | |
| Filter Enable | filter_enable | [ ] | |
| Filter Detail | real range is 0-31 (ISP_FLT_MAX_DETAIL_LVL); firmware clamps raw values above 31 to 31 instead of erroring | [ ] | |
| Filter Denoise | filter_denoise | [ ] | |
| Color Space | real range is 0-2 (Rec.709/Rec.2020/S-Gamut3.Cine, isp_drv.h); do_color_space hard-rejects outside that with -EOPNOTSUPP | [ ] | |
| Tone-Mapping Mode | tm_mode | [ ] | |
| PQ Max Brightness | real range is 100-10000 cd/m2 (do_pq_max_brightness); raw is 0-4095, linearly scaled, not a placeholder | [ ] | |
| LUT Mode | real settable range is 0-1 (Interpolate/Fast Gamma, lut_drv.h); do_lut_mode rejects LUT_MODE_FIXED=2 with -EINVAL ("used only internally") | [ ] | |
| LUT Fixed Mode | lut_fixed_mode | [ ] | |
| LUT Preset | lut_preset | [ ] | |
| SDI Range | sdi_range | [ ] | |
| SDI Black | real range is signed -60..60; do_sdi_black hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| SDI White | real range is signed -80..79; do_sdi_white hard-rejects outside that with -EINVAL; raw is signed -128..127, clamped, not scaled | [ ] | |
| MCC Op-Mode | mcc_opmode | [ ] | |
| OSD | osd | [ ] | |
| Auto Save | auto_save | [ ] | |
| Timecode Hold | timecode_hold | [ ] | |
| Audio Enable | audio_enable | [ ] | |
| Audio Gain | real range is 0-65535 (4.12 fixed-point, 4096 = 1.0x unity gain); raw is 0-4095, firmware multiplies it by 16 | [ ] | |
| AEC SetPoint | sets aec's positional arg 2 (setPoint), real range 50-3000, via read-modify-write of all 10 args | [ ] | |
| AEC Speed | sets aec's positional arg 3 (speed), real range 1-30, via read-modify-write of all 10 args | [ ] | |
| AEC Max Gain | sets aec's positional arg 9 (maxGain), real range 1000-45715 (same as cam_gain), via read-modify-write of all 10 args | [ ] | |
