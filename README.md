# companion-module-dct-visca

A Bitfocus Companion v4 module to control Dream Chip cameras over **VISCA**.
It sends VISCA commands as raw bytes over TCP and reads camera state back via
VISCA inquiries.

Supported: the standard VISCA camera set — system/power, exposure (AE, gain,
shutter), white balance (+ red/blue/colour gains), picture (gamma, brightness,
contrast, flip/mirror), video mode, flicker, memory, settings save/reset — plus
Dream Chip vendor extensions (green gain, gain mode, black levels, flare, AWB
speed, S-Log3 gain, colour space, tone-mapping/PQ, noise reduction,
detail/denoise, LUT mode/preset, SDI range/levels, MCC op-mode, OSD, audio,
timecode hold). Pan/tilt/zoom/focus are out of scope.

## Requirements

- Bitfocus Companion **v4.x**
- A Dream Chip camera reachable over **TCP** that accepts VISCA (default port `4000`)

## Configuration

In Companion, add a **"Dream Chip Technologies: VISCA"** connection and set:

| Field | Description |
|---|---|
| **Target IP** | The camera's IP address |
| **TCP port** | VISCA TCP port (default `4000`) |
| **Camera address** | VISCA address `1`–`7` (default `1`) |
| **Poll ms** | Read-back polling interval in ms; `0` = off (send-only). Set it >0 (e.g. `2000`) to keep variables and feedbacks live |

## What it exposes

- **Actions** — one per command:
  - enum commands → a dropdown (e.g. AE Mode, White Balance, Gamma, Flip),
  - reset/up/down commands → a dropdown (Gain, Shutter, Red/Blue Gain, Bright),
  - "direct" commands → a numeric value input,
  - fixed commands → IF Clear, Settings Save/Reset,
  - Video Mode → a mode dropdown, plus "Poll inquiries now".
- **Presets** — a button per command choice, grouped by category (System, Power,
  Exposure, White Balance, Picture, Video, and the Dream Chip extension groups).
- **Variables** — one per inquiry, updated by the poller, e.g. `$(visca:wb_mode)`,
  `$(visca:ae_mode)`, `$(visca:gain)`, `$(visca:version)`. The prefix is your
  connection's label.
- **Feedbacks** — "AE mode is …", "WB mode is …" (tint the active-mode button) and
  "Connection OK".

## Cloning

```sh
git clone ssh://gerrit.office.dreamchip.de:29418/project/provideo/sw/companion-module-dct-visca project/provideo/sw/companion-module-dct-visca
git -C project/provideo/sw/companion-module-dct-visca dct hooks install
```

`main` is review-protected — submit changes via `refs/for/main`. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Development

```sh
npm install     # or: pnpm install
```

In the Companion launcher, set the **Developer modules path** to the folder
containing this module and restart, then add the connection as described above.

## License

MIT
