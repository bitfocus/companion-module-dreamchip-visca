# Changelog

User-facing notes, newest first. `tools/publish-release.sh` uses the
`## <version>` section as the release commit body.

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
