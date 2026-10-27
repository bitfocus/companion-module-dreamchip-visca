# TODO

## Before publishing to a public host

Publishing goes through `tools/publish-release.sh` (see "Release process" in
`AGENTS.md`); it exports only the allowlisted files and rewrites the public
fields, so the old manual scrub steps (manifest URLs, README Cloning section,
this file, `Jenkinsfile*`, `.github/`) are no longer needed. What is left:

- [ ] Run the full `tools/publish-release.sh --dry-run <x.y.z>` once with
      network (without `--no-install`): check that `yarn install`/`yarn package`
      work with upstream's `.yarnrc.yml` (`enableScripts: false`) and the native
      `serialport` bindings, and review the `yarn.lock` change.
- [ ] Ask the Gerrit admin for a `release` branch in the project (needed for
      `git push origin release:refs/for/release`).
- [ ] Review the `## <version>` section of `CHANGELOG.md` (no ticket IDs); the
      script uses it as the release commit body.
- [ ] Review the soft leak-check hits the script lists.
- [ ] Decide whether upstream's template `apiVersion`/node26/base 2.1 should
      ever replace node22/base 1.11 (currently kept on 1.11).

## Command coverage (firmware follow-ups)

Actions the module exposes that the camera firmware does not yet fully honour —
they come back as "Command Not Executable". Each needs a VISCA→camera mapping
added on the firmware side (and, where noted, a matching camera command).

### Picture
- [ ] **Gamma** (`cam_gamma`, `0x5B`) — no dedicated gamma command; map to the LUT
      fixed-curve selector (BT.709 / HLG / PQ / S-Log3 → LUT index).
- [ ] **Bright** up/down/reset + direct (`cam_bright`, `0x0D`) — map to `post_bright`.
- [ ] **LR Reverse** (`0x61`) / **Picture Flip** (`0x66`) — map to the `flip` H/V bits.
- [ ] **Flicker** (`cam_flicker`, `0x23`) — no camera flicker command; confirm whether
      it can be supported at all.

### System
- [ ] **Memory** (`cam_memory`, `0x3F`) — recall / set / reset.

### Video
- [ ] **Video Mode dialect** — the module sends `04 24 00 00 b2 b3`; the firmware
      currently only accepts the `04 24 72 …` (Tamron) dialect. Reconcile so the
      documented dialect works.

### Exposure
- [ ] **Gain / Shutter** up/down + direct — full sensor gain/shutter mapping
      (up/down need read-modify-write; requires the sensor-command firmware feature).
- [ ] **AE Shutter-Priority** currently behaves like Full Auto — implement a real
      shutter-priority path.

### DCT extensions — removed (firmware limitation, not a VISCA-mapping issue)
- [ ] **tm_mode** (`dct_tm_mode`, `0x21`) — removed from `commands.js`/`INQUIRIES`.
      `tm_mode 0` (disable) accepts without a VISCA error but doesn't actually
      stick: `do_tm_mode` (`product/src/cmd_tm.c`, marked `// TODO: this is a
      hack to have something for the NAB`) pokes the SLTM/GTM registers
      directly instead of going through the driver API, and
      `g_chain_settings.tm_mode` is write-only — nothing ever reads it back to
      decide whether the tone-mapping hardware should be on. Separately,
      `chain_set_vmode()` (`product/src/chain.c`) unconditionally calls
      `isp_enable_gtm(g_chain.isp, true)` ("for now enable the gtm with a
      linear curve") on every video-mode change, chain stop/start, AND at boot
      via `execute_settings()` — silently re-enabling tone mapping regardless
      of what `tm_mode` was last set to, so even a saved "off" doesn't survive
      a power cycle. Real fix needs both: `chain_set_vmode()`/
      `execute_settings()` must consult `g_chain_settings.tm_mode` instead of
      hardcoding `true`, and `tm_mode`/`tm_param` should route through
      `isp_enable_gtm()`/the proper tone-curve driver API instead of raw
      `hw_access_write_reg` pokes. Re-add the Companion control once that's
      done.

### DCT extensions — deferred (VISCA payload doesn't match the camera command's args)
- [ ] **knee** (enable + point + slope)
- [ ] **lut_enable** (index + flag)
- [ ] **mcc_set** (segment + saturation + hue)
- [ ] **osd_color** (palette entry: id + alpha + y + cb + cr)
- [ ] **status_led** (brightness % vs r/g/b)
- [ ] **timecode** (hh:mm:ss vs + frames)
- [ ] **Calibrate DCT value scaling** — currently identity placeholders for black
      levels, flare, S-Log3, PQ, SDI, audio gain and green gain.

### Build / feature dependent (work on real hardware, not the native simulator)
- [ ] **Power On/Off** (`cam_power`) → `low_power` — present on real builds only.
- [ ] **Flip** *set* — not modelled on the simulator (the inquiry works).
