# Changelog

User-facing notes, newest first. `tools/publish-release.sh` uses the
`## <version>` section as the release commit body.

## 1.1.0

- Serial (COM) connections work in the installed module, and switching from a
  failing Serial port to TCP now connects normally.
- Knobs work from the first turn even with Poll ms 0, use the current Knob step
  setting, and stay correct after a direct action sets a negative value
  (Color Hue, Bright, Black levels, S-Log3 Master Gain, SDI Black/White).
- Buttons pressed while the camera is offline are dropped instead of firing
  when it reconnects.
- AE and WB toggle buttons show the real mode (e.g. Shutter Priority, Color
  Temp) instead of AUTO for every mode other than Manual.
- Gain, Shutter, Color Space and Tone Mapping Mode no longer appear twice under
  the same name in the action list; the variants are now called, for example,
  `Gain (Reset/Up/Down)` and `Gain (ISO)`.
- Less background work: serial ports are no longer re-scanned on TCP
  connections, and a device that is not a VISCA camera can no longer make the
  module use more and more memory.
- Requires Companion with module API 1.14 (`@companion-module/base` 1.14).

## 0.8.0

First public release of the Dream Chip VISCA module for Atom Two and
Atom Two HDR cameras.

- Control over raw VISCA via TCP or a serial (COM) port, with baud selection,
  port auto-scan and automatic reconnect.
- Camera model is detected on connect; controls the camera does not have are
  hidden.
- Actions, presets, variables and feedbacks for exposure (AE mode, gain/ISO,
  shutter, AEC fields), white balance (modes, Kelvin, R/B/G gains), color,
  picture, noise reduction, detail/denoise, LUT (mode, preset, fast gamma),
  video modes, color space, audio and settings save/load.
- Rotary-knob presets for Stream Deck+ encoders: relative adjust, press to
  resync or reset, values shown in natural units (ISO, µs, dB, K, degrees)
  with a progress bar and ring background.
- Tally lamps (red/green, with yellow) via a cycling button.
- Two-tier polling with a configurable interval; Poll ms 0 gives send-only
  mode with immediate read-back after button presses.
- Connection status reflects real camera replies, and a silent camera is
  reported as a warning until it answers again.
