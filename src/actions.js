import { COMMANDS, ENUM, SYSTEM, SYSTEM_NAMES, GAIN_ISO, SHUTTER_SPEEDS, RUD, encodeNibbles } from './commands.js'
import { MODEL_GATED_IDS, KNOB_PRESS_SET_VALUE, TALLY_CYCLE_STATES } from './constants.js'

// `kind: 'rud'` COMMANDS ids -> their real-value INQUIRIES id. Reset/Up/Down
// compute the new value server-side (relative step or a fixed target), and
// the only way to learn what it actually landed on is to ask -- these ids
// don't line up 1:1 with COMMANDS (e.g. cam_gain -> INQUIRIES.gain), same
// irregularity continuousParams()/directVarId() already work around for the
// "direct" counterparts.
const RUD_INQUIRY_ID = {
	cam_gain: 'gain',
	cam_shutter: 'shutter',
	cam_rgain: 'rgain',
	cam_bgain: 'bgain',
	cam_bright: 'bright',
}

// enum COMMANDS ids whose plain per-choice buttons (not just their dedicated
// toggle action) should also confirmIfNotPolling() after sending -- these
// stayed on the continuous poll tier specifically so their toggle buttons'
// live status stays accurate; the plain "SDI Range: Legal"/"Audio Enable:
// On"/"Timecode: Run"/"AE: Auto"/"WB: Manual"-style buttons set the exact
// same value, so they need the same confirmation when auto poll is off.
const CONFIRM_POLL_ENUM_IDS = new Set(['dct_sdi_range', 'dct_timecode_hold', 'dct_audio_enable', 'cam_ae', 'cam_wb'])
// CONFIRM_POLL_ENUM_IDS is keyed by COMMANDS id (what the generic enum
// callback below has in scope), but confirmIfNotPolling() needs an INQUIRIES
// id -- for dct_sdi_range/dct_timecode_hold/dct_audio_enable those are the
// same string, but cam_ae/cam_wb's inquiries are named ae_mode/wb_mode.
const CONFIRM_POLL_INQUIRY_ID = { cam_ae: 'ae_mode', cam_wb: 'wb_mode' }

// dct_ggain (kind:'enum', choices Reset/Up/Down) is semantically a RUD-style
// gain control -- it just uses DCT-extension byte payloads instead of
// the standard VISCA RUD template, so the generic 'rud' branch's RUD_INQUIRY_ID
// handling doesn't apply to it. Give it the exact same unconditional
// confirm+resync treatment as cam_rgain/cam_bgain (below), which it otherwise
// wouldn't get at all.
const ENUM_RUD_INQUIRY_ID = { dct_ggain: 'dct_ggain' }

// enum COMMANDS ids that are purely a named-shortcut UI for a sibling
// `direct`-kind knob (dct_tm_mode_preset -> dct_tm_mode, dct_color_space_preset
// -> dct_color_space, same idea as Gain (ISO)/Shutter (Speed) but via 'enum'
// instead of a curated table) -- pressing one of these buttons sends an exact,
// deterministically-known value (unlike a RUD reset), so it can write the
// sibling knob/state immediately instead of waiting on the next poll, which
// would otherwise never happen at all for a `once:true` (startup-only) param
// like these two. The raw value is the choice's position in `choices`
// (insertion order == wire value 0,1,2... for both of these).
const PRESET_KNOB_TARGET = { dct_tm_mode_preset: 'dct_tm_mode', dct_color_space_preset: 'dct_color_space' }

// `cam_settings_reset`/`dct_load_settings` change most camera parameters at
// once as a side effect of one command; without a follow-up poll, every
// displayed variable/feedback keeps showing its pre-reset value until the
// next manual "Poll inquiries now" or the (off-by-default) poll interval
// fires. pollOnce()'s inquiries get enqueued right behind the reset frame in
// the same send queue (see pump()), so they naturally wait for the reset's
// own reply first -- no artificial delay needed.
const REFRESH_AFTER_IDS = new Set(['cam_settings_reset', 'dct_load_settings'])

export default function updateActions(self) {
	const actions = {}
	const gatedIds = MODEL_GATED_IDS[self.cameraModel] ?? []
	for (const [id, c] of Object.entries(COMMANDS)) {
		if (gatedIds.includes(id)) continue
		// actionName tells apart commands that would otherwise share one picker entry.
		const a = { name: `${c.group}: ${c.actionName ?? c.name}`, options: [] }
		if (c.kind === 'enum') {
			const ids = Object.keys(c.choices)
			a.options = [
				{
					type: 'dropdown',
					id: 'choice',
					label: c.name,
					default: ids[0],
					choices: ids.map((x) => ({ id: x, label: x })),
				},
			]
			a.callback = (ev) => {
				self.send(c.choices[ev.options.choice])
				if (CONFIRM_POLL_ENUM_IDS.has(id)) self.confirmIfNotPolling(CONFIRM_POLL_INQUIRY_ID[id] ?? id)
				const rudQId = ENUM_RUD_INQUIRY_ID[id]
				if (rudQId) self.inquireOnce(rudQId, { resyncKnob: true })
				const knobVarId = PRESET_KNOB_TARGET[id]
				if (knobVarId) self.setKnobValue(knobVarId, ids.indexOf(ev.options.choice))
			}
		} else if (c.kind === 'rud') {
			const rudChoices = c.rudChoices ?? Object.keys(RUD)
			a.options = [
				{
					type: 'dropdown',
					id: 'choice',
					label: 'Action',
					default: rudChoices[0],
					choices: rudChoices.map((x) => ({ id: x, label: x })),
				},
			]
			a.callback = (ev) => {
				self.send([0x01, 0x04, c.func, RUD[ev.options.choice]])
				// Reset/Up/Down all change the real value server-side without
				// telling us what it landed on -- re-read it immediately so the
				// knob display/variable don't sit stale until the next poll.
				// resyncKnob is safe here (unlike a background poll): this is a
				// single, deliberate, user-triggered confirmation, not something
				// that can race a burst of knob turns.
				const qId = RUD_INQUIRY_ID[id]
				if (qId) self.inquireOnce(qId, { resyncKnob: true })
			}
		} else if (c.kind === 'direct') {
			const bits = 4 * c.nibbles
			const max = c.modelMax?.[self.cameraModel] ?? c.max ?? (c.signed ? (1 << (bits - 1)) - 1 : (1 << bits) - 1)
			const min = c.min ?? (c.signed ? -(1 << (bits - 1)) : 0)
			const mask = (1 << bits) - 1
			a.options = [{ type: 'number', id: 'value', label: `Value (${min}-${max})`, default: min, min, max }]
			a.callback = (ev) => {
				// Keep the signed value for our own state (knob/variable); only the
				// bytes on the wire use the unsigned two's-complement form.
				const value = Math.max(min, Math.min(max, Number(ev.options.value)))
				self.send([...c.prefix, ...encodeNibbles(value & mask, c.nibbles)])
				// A direct SET's landing value is exactly what we just sent -- no
				// ambiguity to confirm via inquiry (unlike a RUD reset), so write
				// state/knob immediately instead of waiting for the next poll.
				const varId = self.paramById[id]?.varId
				if (varId) self.setKnobValue(varId, value)
			}
		} else if (c.kind === 'fixed') {
			a.callback = () => {
				self.send(c.bytes)
				if (REFRESH_AFTER_IDS.has(id)) self.pollOnce()
			}
		} else if (c.kind === 'video') {
			const modes = Object.keys(SYSTEM)
			a.options = [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Video mode',
					default: modes[0],
					choices: modes.map((m) => ({ id: m, label: SYSTEM_NAMES[m] ?? `Mode ${m}` })),
				},
			]
			a.callback = (ev) => {
				const [b2, b3] = SYSTEM[ev.options.mode]
				self.send([0x01, 0x04, 0x24, 0x00, 0x00, b2, b3])
			}
		} else if (c.kind === 'iso') {
			a.options = [
				{
					type: 'dropdown',
					id: 'iso',
					label: 'ISO',
					default: GAIN_ISO[0].iso,
					choices: GAIN_ISO.map((g) => ({ id: g.iso, label: `ISO ${g.iso}` })),
				},
			]
			a.callback = (ev) => {
				const raw = GAIN_ISO.find((g) => g.iso === Number(ev.options.iso))?.raw ?? 0
				self.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
				// Shares cam_gain_direct's wire command/varId ('gain') -- same
				// "we know the exact landing value" optimistic write as 'direct'.
				self.setKnobValue('gain', raw)
			}
		} else if (c.kind === 'shutter') {
			a.options = [
				{
					type: 'dropdown',
					id: 'n',
					label: 'Shutter speed',
					default: SHUTTER_SPEEDS[0].n,
					choices: SHUTTER_SPEEDS.map((s) => ({ id: s.n, label: `1/${s.n}` })),
				},
			]
			a.callback = (ev) => {
				const raw = SHUTTER_SPEEDS.find((s) => s.n === Number(ev.options.n))?.raw ?? 0
				self.send([...c.prefix, ...encodeNibbles(raw, c.nibbles)])
				// Shares cam_shutter_direct's wire command/varId ('shutter').
				self.setKnobValue('shutter', raw)
			}
		}
		actions[id] = a
	}
	const params = self.params
	actions['adjust'] = {
		name: 'Knob: Adjust value (relative)',
		options: [
			{
				type: 'dropdown',
				id: 'param',
				label: 'Parameter',
				default: params[0]?.id,
				choices: params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })),
			},
			{ type: 'number', id: 'step', label: 'Step (may be negative)', default: self.knobStep(), min: -255, max: 255 },
			{
				type: 'checkbox',
				id: 'useKnobStep',
				label: "Use the connection's Knob step (Step then only sets the direction)",
				default: false,
			},
		],
		callback: (ev) => {
			const step = Number(ev.options.step)
			// Resolved when the knob turns, so a changed Knob step reaches buttons that are already placed.
			const delta = ev.options.useKnobStep ? Math.sign(step) * self.knobStepFor(ev.options.param) : step
			self.adjustParam(ev.options.param, delta)
		},
	}
	actions['poll_now'] = { name: 'System: Poll inquiries now', options: [], callback: () => self.pollOnce() }
	actions['poll_startup_now'] = {
		name: 'System: Poll startup values now',
		options: [],
		callback: () => self.pollStartupOnce(),
	}
	// Knob-press "set to a fixed value" actions (see KNOB_PRESS_SET_VALUE) --
	// a plain direct SET to a value we chose ourselves, so (unlike a RUD
	// reset) there's nothing to confirm via inquiry: write state/knob
	// straight away.
	for (const [pid, value] of Object.entries(KNOB_PRESS_SET_VALUE)) {
		const p = self.paramById[pid]
		const cmd = COMMANDS[pid]
		actions[`${pid}_knob_reset`] = {
			name: `${p.name}: Set to ${value} (knob press)`,
			options: [],
			callback: () => {
				const mask = (1 << (4 * cmd.nibbles)) - 1
				self.send([...cmd.prefix, ...encodeNibbles(value & mask, cmd.nibbles)])
				self.setKnobValue(p.varId, value)
			},
		}
	}
	// wb_temp_measure has no SET side (it's a live, continuously-updated
	// AWB filter reading, not something you configure) -- so it has no
	// COMMANDS entry and is invisible to the generic loop above. Fire just
	// this one inquiry on demand, same shape as poll_now but scoped to it.
	actions['dct_wb_temp_measure_now'] = {
		name: 'White Balance: Measure Kelvin now',
		options: [],
		callback: () => self.inquireOnce('dct_wb_temp_measure'),
	}
	// Genuinely binary commands (unlike cam_ae/cam_wb's 3-6 choices) --
	// toggle unambiguously flips to whichever of the 2 choices isn't
	// current, writing state immediately so the button's own feedback
	// doesn't wait for a poll.
	actions['dct_audio_enable_toggle'] = {
		name: 'Audio: Toggle On/Off',
		options: [],
		callback: () => {
			const goOn = self.state.dct_audio_enable !== 'On'
			self.send(COMMANDS.dct_audio_enable.choices[goOn ? 'On' : 'Off'])
			self.state.dct_audio_enable = goOn ? 'On' : 'Off'
			self.setVariableValues({ dct_audio_enable: self.state.dct_audio_enable })
			self.checkFeedbacks('dct_audio_enable_is', 'dct_audio_enable_display')
			self.confirmIfNotPolling('dct_audio_enable')
		},
	}
	actions['dct_sdi_range_toggle'] = {
		name: 'SDI: Toggle Legal/Full',
		options: [],
		callback: () => {
			const goFull = self.state.dct_sdi_range !== 'Full'
			self.send(COMMANDS.dct_sdi_range.choices[goFull ? 'Full' : 'Legal'])
			self.state.dct_sdi_range = goFull ? 'Full' : 'Legal'
			self.setVariableValues({ dct_sdi_range: self.state.dct_sdi_range })
			self.checkFeedbacks('dct_sdi_range_is', 'dct_sdi_range_display')
			self.confirmIfNotPolling('dct_sdi_range')
		},
	}
	actions['dct_timecode_hold_toggle'] = {
		name: 'Timecode: Toggle Run/Hold',
		options: [],
		callback: () => {
			const goRun = self.state.dct_timecode_hold !== 'Run'
			self.send(COMMANDS.dct_timecode_hold.choices[goRun ? 'Run' : 'Hold'])
			self.state.dct_timecode_hold = goRun ? 'Run' : 'Hold'
			self.setVariableValues({ dct_timecode_hold: self.state.dct_timecode_hold })
			self.checkFeedbacks('dct_timecode_hold_display')
			self.confirmIfNotPolling('dct_timecode_hold')
		},
	}
	// 4-state cycle over TALLY_CYCLE_STATES, unlike the strict 2-way
	// toggles above (which don't generalize past 2 states). Red/Green are
	// independent set-only commands with no inquiry, so this tracks
	// self.tally locally rather than reading back camera state; unknown
	// (-1, e.g. never pressed) advances to index 0 "Off", a safe start.
	// Only sends the lamp(s) that actually change between states.
	actions['dct_tally_cycle'] = {
		name: 'Tally: Cycle Off/Red/Green/Yellow',
		options: [],
		callback: () => {
			const cur = TALLY_CYCLE_STATES.findIndex((s) => s.red === self.tally.red && s.green === self.tally.green)
			const next = TALLY_CYCLE_STATES[(cur + 1) % TALLY_CYCLE_STATES.length]
			if (next.red !== self.tally.red) self.send(COMMANDS.dct_tally_red.choices[next.red ? 'On' : 'Off'])
			if (next.green !== self.tally.green) self.send(COMMANDS.dct_tally_green.choices[next.green ? 'On' : 'Off'])
			self.tally = next
			self.checkFeedbacks('dct_tally_display')
		},
	}
	// AE/WB are genuinely 3-/5-choice enums (cam_ae, cam_wb above), unlike
	// the strictly-binary toggles above -- these two additional toggles
	// only ever flip between Auto and Manual (ignoring Shutter Pri /
	// Indoor / Outdoor / Trigger, all still reachable via their own
	// existing per-choice buttons).
	actions['cam_ae_toggle'] = {
		name: 'AE: Toggle Auto/Manual',
		options: [],
		callback: () => {
			const goManual = self.state.ae_mode !== 'Manual'
			self.send(COMMANDS.cam_ae.choices[goManual ? 'Manual' : 'Auto'])
			self.state.ae_mode = goManual ? 'Manual' : ENUM.ae[0x00] // 'FullAuto', as the inquiry reports it
			self.setVariableValues({ ae_mode: self.state.ae_mode })
			self.checkFeedbacks('ae_mode_is', 'cam_ae_display')
			self.confirmIfNotPolling('ae_mode')
		},
	}
	actions['cam_wb_toggle'] = {
		name: 'WB: Toggle Auto/Manual',
		options: [],
		callback: () => {
			const goManual = self.state.wb_mode !== 'Manual'
			self.send(COMMANDS.cam_wb.choices[goManual ? 'Manual' : 'Auto'])
			self.state.wb_mode = goManual ? 'Manual' : 'Auto'
			self.setVariableValues({ wb_mode: self.state.wb_mode })
			self.checkFeedbacks('wb_mode_is', 'cam_wb_display')
			self.confirmIfNotPolling('wb_mode')
		},
	}
	self.setActionDefinitions(actions)
}
