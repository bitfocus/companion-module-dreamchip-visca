# companion-module-dct-visca

A Bitfocus Companion v4 module to control Dream Chip cameras over **VISCA**.
It sends VISCA commands as raw bytes over TCP and reads camera state back via
VISCA inquiries.

Supported: the standard VISCA camera set — system/power, exposure (AE, gain,
shutter), white balance (+ red/blue/colour gains, colour temperature in
Kelvin), picture (gamma, brightness, contrast, flip/mirror), video mode,
flicker, settings save/reset — plus Dream Chip vendor extensions
(green gain, gain mode, black levels, flare, AWB speed, S-Log3 gain, colour
space, PQ, noise reduction, detail/denoise, LUT mode/preset, SDI
range/levels, MCC op-mode, audio, Timecode, white-balance colour
temperature (settable Kelvin + measured scene cct)). Toggle-style buttons are
also available for the binary controls (Audio Enable, SDI Range, Timecode
Run/Hold, AE Auto/Manual, WB Auto/Manual). Pan/tilt/zoom/focus are out of scope.

## Requirements

- Bitfocus Companion **v4.x**
- A Dream Chip camera reachable over **TCP** that accepts VISCA (default port `4000`)

## Configuration

In Companion, add a **"Dream Chip Technologies: VISCA"** connection and set:

| Field | Description |
|---|---|
| **Connection** | `TCP` or `Serial (COM)` |
| **Target IP** / **TCP port** | TCP mode: the camera's IP and VISCA TCP port (default `4000`) |
| **Serial port** / **Baud** | Serial mode: the COM port (e.g. `COM3` or `/dev/ttyUSB0`) and baud (default `115200`). Run Companion on the machine physically wired to the camera |
| **Camera address** | VISCA address `1`–`7` (default `1`) |
| **Poll ms** | Read-back polling interval in ms; `0` = off (send-only), otherwise a **minimum of `2000`** (faster values are automatically raised to 2000). Only the "live" tier is repeated on this interval -- calibration/setup-style values (LUT, filters, CNR, SDI, gamma, black levels, flare, audio, etc.) are read once per connection instead; use "System: Poll startup values now" to re-sync them on demand |
| **Knob step** | Turn increment for rotary-knob presets on `0`–`255` params (default `4`); `0`–`15` params always step by 1 |

## What it exposes

- **Actions** — one per command:
  - enum commands → a dropdown (e.g. AE Mode, WB, Gamma, Flip),
  - reset/up/down commands → a dropdown (Gain, Shutter, Red/Blue Gain, Bright),
  - "direct" commands → a numeric value input,
  - Gain (ISO) → a dropdown of named ISO steps (140–6400, OG03A10 sensor); the raw Gain (direct) input stays for manual entry,
  - Shutter (Speed) → a dropdown of named 1/n shutter speeds (1/8000–1/30); the raw Shutter (direct) input stays for manual entry,
  - fixed commands → IF Clear, Settings Save/Reset, Load Settings,
  - Video → a dropdown of named modes (1080p30, 1080p25, …, 1080i50), plus "Poll inquiries now" (refreshes everything) and "Poll startup values now" (refreshes just the calibration/setup-style tier -- see Poll ms above),
  - **"Knob: Adjust value (relative)"** → pick a parameter + a signed step (used by
    the knob presets, but also assignable to any button).
- **Presets** — a button per command choice, grouped by category (System,
  Exposure, White Balance, Audio, and Video Modes), plus **rotary-knob
  presets** (see below), grouped under `Knobs: …`.
- **Variables** — one per inquiry, updated by the poller, e.g. `$(visca:wb_mode)`,
  `$(visca:ae_mode)`, `$(visca:gain)`, `$(visca:version)`. The prefix is your
  connection's label.
- **Feedbacks** — "AE mode is …", "WB mode is …" (tint the active-mode button),
  "Connection OK", and **"Knob: show current value"** (renders the live value on a
  rotary encoder's LCD, in each parameter's natural unit — see Knobs below).

## Knobs (Stream Deck+ encoders)

Every continuous parameter (gain, shutter, red/blue/green gain, black master/R/G/B,
flare, S-Log3 gain, SDI black/white, brightness, contrast, audio gain, …) has a
ready-made **rotary-encoder preset** under the `Knobs: <group>` categories:

- **Turn right / left** → increase / decrease the value by the **Knob step**
  (0–15 params step by 1). It sends an absolute `direct` set and updates the value
  immediately, so it works even with polling off.
- **Press** → re-reads the camera to re-sync the knob to the real value.
- The **encoder LCD** shows the parameter name, its current value, and a text
  progress bar (e.g. `...|......`) marking its position within its range,
  over a generated ring background (`images.js` — no image dependency, drawn
  by a small from-scratch PNG encoder at load time). The underlying VISCA
  value always steps in raw wire units; several knobs display it converted to
  its natural unit instead of the bare number: Gain shows **ISO**, Shutter
  shows **microseconds**, Audio Gain shows **dB** (0 to ~24dB, stepped in
  0.5dB increments), Color Temp shows **Kelvin**, Color Hue shows **degrees**,
  and Red/Blue/Green/Color Gain show a **float factor** (`x`). Gain and
  Shutter both step logarithmically (perceived in stops, not linearly); the
  fastest selectable manual Shutter is floored at 200µs.

Drag a knob preset onto a Stream Deck+ encoder (or an encoder in the web/emulator
surface). To build your own, enable **Rotary Actions** on a button and map
*rotate right/left* to **"Knob: Adjust value (relative)"** with a positive/negative
step. Companion has no on-screen fader; an absolute fader would come from an external
MIDI/Satellite surface writing a variable that drives a "direct" set action.

## Development

```sh
yarn install    # yarn 4; needs corepack: corepack enable && yarn install
```

In the Companion launcher, set the **Developer modules path** to the folder
containing this module and restart, then add the connection as described above.

## License

MIT
