# AGENTS.md

Bitfocus Companion v4 module controlling Dream Chip cameras over VISCA (raw
bytes over TCP or serial). No build step, no TypeScript — plain
ESM (`"type": "module"`) JS that Companion loads directly via
`companion/manifest.json` → `src/main.js`. Requires Node 22 (`engines: ^22`).

## Structure

All shipped module code lives in `src/` (Companion loads `src/main.js`;
`tools/` and `test/` import from there):

- `src/commands.js` — the single source of truth: `COMMANDS`/`INQUIRIES` wire
  tables plus codec (`buildFrame`, `decodeReply`, nibble encoding) and unit
  conversions. Actions, presets, variables and feedbacks in `src/main.js` are
  all generated from these tables; add features by editing tables, not by
  hand-wiring in main.js.
- `src/main.js` — Companion entrypoint (`InstanceBase` + `runEntrypoint`):
  transport, two-tier poller (inquiries tagged `once: true` are read once per
  connection; the rest repeat on the Poll ms interval, floor 2000), camera
  model detection from the version inquiry (some commands exist only on
  Violetta or Marietta).
- `src/images.js` — knob ring background drawn by a from-scratch PNG encoder
  (no image deps).
- `tools/` — standalone scripts, no Companion needed:
  - `smoke.mjs [host] [port]` — raw-TCP transceive against a camera/simulator
    (defaults `127.0.0.1:4000`).
  - `camera-check.mjs` — hardware integration test (see below).
  - `visca-decode.mjs` — translates pasted TX/RX hex log lines into command
    names + ProVideo console equivalents; use it to debug camera replies.
  - `provideo-names.mjs` — maps command ids to firmware ProVideo commands;
    transcribed from the dct-phoenix-zephyr-bsp repo (`visca/src/visca_map_*.c`).

## Tests

- `yarn test` → `node --test` (discovers `test/*.test.js`; pure unit tests, no
  network or hardware). Single file: `node --test test/commands.test.js`;
  single case: `node --test --test-name-pattern='<name>' test/commands.test.js`.
- Unit tests assert table invariants with hard-coded counts and explicit
  exclusion lists (e.g. "exactly 37 `once:true` inquiries", "cam_power is not
  exposed"). Any change to `COMMANDS`/`INQUIRIES` likely requires updating
   those assertions plus `TESTPLAN.md` (hand-maintained, mirrors
   `COMMANDS`/`INQUIRIES` + `tools/provideo-names.mjs`) and possibly
   `tools/provideo-names.mjs`.
- `yarn test:coverage` → `tools/coverage.mjs` (c8 over `node --test`, config in `.c8rc.json`: counts all of
  `src/**`, so `main.js` shows as 0%; writes `coverage/cobertura-coverage.xml`,
  which Jenkins publishes via `recordCoverage`, report-only).
- Hardware test (not part of `yarn test`, needs a real serial camera):
  `VISCA_TEST_PORT=/dev/ttyUSB0 yarn test:hardware`. It resets camera
  settings before and after the run; destructive commands are skipped unless
  `--include-destructive`. Filters: `--group <Group>`, `--only <substr>`.

## Conventions / gotchas

- The `src/*.js` files (`main.js`, `commands.js`, `images.js`) are the
  public artifact: their comments must not name internal firmware repos,
  source files, handler/function names or internal constants (keep the
  behavioral facts instead, phrased as "the camera firmware ..."). The
  firmware mapping itself lives only in `tools/provideo-names.mjs` and
  `TESTPLAN.md` (internal-only, never shipped).
- Some actions are deliberately *not* exposed even though the wire protocol
  could express them (duplicates, reboot risk) — several unit tests pin this.
  Check those tests before "adding" a missing command.
- UI value ranges are often narrower than the wire range (firmware
  hard-rejects); follow the narrowed ranges and their tests.
- Vendor extensions use the DCT `01 7E 01 SS` prefix (one firmware-blessed
  exception: Tally Green is `01 7E 04 1A` — second sub-namespace, because
  SS 0x1A in `01` belongs to AEC Max Gain; pinned in the prefix test);
  the wire value is raw
  VISCA units, with natural-unit display conversions (ISO, µs, dB, K) applied
  only in the UI/knob layer.
- Poll ms `0` = send-only mode; in that mode buttons confirm state via an
  immediate inquiry (`confirmIfNotPolling`) — new enum/toggle commands may
  need registration in `CONFIRM_POLL_*` maps in main.js.
- Tally lamps (`dct_tally_red`/`_green`) are set-only — no VISCA inquiry
  exists, so `confirmIfNotPolling` can't apply; the cycle button tracks
  optimistic local state (`this.tally` / `TALLY_CYCLE_STATES` in main.js).
  Same applies to any future set-only command.
- Status model: `Ok` is only ever earned by a real VISCA terminal reply
  (`markReplyReceived`/`confirmedReply`) — TCPHelper's Ok-on-connect is
  deliberately suppressed to `Connecting`, silence downgrades to
  `UnknownWarning`, and serial (unlike TCP) has its own 2s reconnect timer
  (`scheduleSerialReconnect`). Don't "simplify" these back to
  updateStatus(Ok) on socket open.
- Package manager is yarn 4 (pinned via `packageManager`, matching
  `@companion-module/tools`; use corepack): `yarn.lock` is the only lockfile —
  never regenerate `package-lock.json`/`pnpm-lock.yaml`. `.yarnrc.yml` sets
  `nodeLinker: node-modules` (Companion needs a plain `node_modules`, not
  PnP). Yarn 4 doesn't enforce the root `engines: ^22` (the floor is real for
  Companion's bundled runtime — keep it) and builds native deps
  (`@serialport/bindings-cpp`) automatically; the pnpm approval dance is gone.

## Workflow

- Gerrit-hosted; `main` is review-protected. Push via `refs/for/main`, with
  the Gerrit `commit-msg` hook installed (`dct hooks install` per README).
- Commit style: short lowercase subject, Conventional-ish prefixes
  (`feat(scope):`, `fix(knob):`).
- CI: `Jenkinsfile.health` (new patchsets) and `Jenkinsfile` (merged
  changes), same stages as in provideo-gui, run
  `yarn install --immutable`, `node --check src/*.js`, `yarn eslint` (checkstyle
  report -> Warnings plugin; eslint errors and prettier formatting warnings only
  mark the build UNSTABLE) and `yarn test`
  (JUnit published) inside the provideo apptainer via `tool-apptainer/apptainer-provideo/run.sh`.
  Node 22 + yarn 4.5.3 + libudev-dev live in that image
  (`apptainer/apptainer-provideo/container.def`); rebuild with `./build.sh -u`
  and keep the yarn version in sync with `packageManager` in `package.json`.
  Hardware tests are not run in CI. The Jenkinsfiles are internal: keep them out of
  anything published upstream.
- Before publishing anywhere public, work through the checklist in `TODO.md`
  (internal Gerrit URLs/sections must be scrubbed first).
