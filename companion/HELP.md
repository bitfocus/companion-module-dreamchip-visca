# Dream Chip VISCA

Controls Dream Chip cameras over VISCA, using raw VISCA bytes over **TCP** or a **serial** port.

Supported cameras: **Atom Two** and **Atom Two HDR**. The module detects the model on connect and hides controls the camera doesn't have. Pan/tilt/zoom/focus are not supported.

| Difference                        | Atom Two      | Atom Two HDR        |
| --------------------------------- | ------------- | ------------------- |
| **Tone Mapping Mode** (+ presets) | not available | available           |
| **Filter Enable**, **Gain Mode**  | available     | not available       |
| **Filter Denoise** range          | `0`–`255`     | `0`–`7` (`0` = off) |

Until the camera has answered the first version inquiry, the model is unknown and nothing is hidden.

No setup is needed on the camera to enable VISCA.

## Configuration

| Field                    | Description                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connection**           | `TCP` or `Serial (COM)`                                                                                                                                                                    |
| **Target IP / TCP port** | TCP mode: the camera's IP address and VISCA port (default `4000`)                                                                                                                          |
| **Serial port / Baud**   | Serial mode: the port (e.g. `COM3` or `/dev/ttyUSB0`) and baud rate. **The camera uses `115200`, not the VISCA default of 9600.** Companion must run on the machine the camera is wired to |
| **Camera address**       | VISCA address `1`–`7` (default `1`)                                                                                                                                                        |
| **Poll ms**              | Read-back interval. `0` = send-only (buttons then confirm state with an immediate inquiry). Otherwise the minimum is `2000`; lower values are raised to 2000                               |
| **Knob step**            | Step per click for rotary-knob presets on `0`–`255` parameters (default `4`). `0`–`15` parameters always step by 1                                                                         |

Setup-style values (LUT, filters, black levels, SDI, audio, …) are read once per connection rather than on every poll. Use the action **System: Poll startup values now** to re-read them, or **Poll inquiries now** to refresh everything.

## Actions, presets, variables

- **Actions** cover System, Exposure, White Balance, Picture, Video Mode and Audio, plus Dream Chip extensions (black levels, flare, noise reduction, LUT, SDI, timecode, …). Enums are dropdowns, "direct" actions take a value, and Gain and Shutter offer named steps (ISO, 1/n).
- **Presets** are grouped by category, plus rotary-knob presets under `Knobs: …`.
- **Variables** hold the camera state read back by the poller, e.g. `$(label:ae_mode)`, `$(label:wb_mode)`, `$(label:gain)`, `$(label:version)`. `label` is the name of your connection.
- **Feedbacks**: AE mode is …, WB mode is …, Connection OK, and **Knob: show current value**.

## Knobs (Stream Deck+)

Every continuous parameter has a ready-made encoder preset under `Knobs: <group>`:

- **Turn** right/left: raises/lowers the value by the Knob step and sends it immediately, so it also works with polling off.
- **Press**: re-reads the camera to re-sync the knob.
- The encoder display shows the name, the current value and a position bar. Values are shown in natural units: ISO for gain, µs for shutter, dB for audio gain, Kelvin for colour temperature, degrees for hue, and a factor (`x`) for colour gains. Gain and shutter step in stops.

To build your own, enable **Rotary Actions** on a button and map rotate left/right to **Knob: Adjust value (relative)** with a negative/positive step.

## Good to know

- The connection shows **Connecting** until the camera sends its first real VISCA reply, and a warning if it later goes silent. Serial reconnects automatically every 2 seconds.
- Some value ranges are narrower than the VISCA wire range, because the camera rejects values outside them.
- A command the camera cannot execute in its current state is reported as "Command Not Executable".
