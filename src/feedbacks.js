import { ENUM, effectiveMax, progressBar } from './commands.js'
import {
	GREEN,
	RED,
	BLUE,
	ORANGE,
	DIM_RED,
	DARK_GRAY,
	LIGHT_GRAY,
	DARK_CYAN,
	LIGHT_CYAN,
	LIGHT_BLUE,
	WHITE,
} from './constants.js'

export default function updateFeedbacks(self) {
	// Auto/Manual toggle button face: AUTO or MANUAL for those two modes, the
	// real mode name (Shutter Priority, Indoor, Color Temp, ...) for any other,
	// and -- until the camera has told us -- no guess at all.
	const modeToggleDisplay = (name, label, varId, autoMode) => ({
		type: 'advanced',
		name,
		options: [],
		callback: () => {
			const mode = self.state[varId]
			if (!mode || mode === 'n/a') return { text: `${label}\\n--`, size: 'auto', bgcolor: DARK_GRAY, color: WHITE }
			if (mode === autoMode) return { text: `${label}\\nAUTO`, size: 'auto', bgcolor: GREEN, color: WHITE }
			if (mode === 'Manual') return { text: `${label}\\nMANUAL`, size: 'auto', bgcolor: DIM_RED, color: WHITE }
			return { text: `${label}\\n${mode}`, size: 'auto', bgcolor: DARK_CYAN, color: WHITE }
		},
	})
	const modeFeedback = (name, mapObj, varId) => ({
		type: 'boolean',
		name,
		defaultStyle: { bgcolor: GREEN, color: WHITE },
		options: [
			{
				type: 'dropdown',
				id: 'mode',
				label: 'Mode',
				default: Object.values(mapObj)[0],
				choices: Object.values(mapObj).map((v) => ({ id: v, label: v })),
			},
		],
		callback: (fb) => self.state[varId] === fb.options.mode,
	})
	self.setFeedbackDefinitions({
		ae_mode_is: modeFeedback('AE mode is', ENUM.ae, 'ae_mode'),
		wb_mode_is: modeFeedback('WB mode is', ENUM.wb, 'wb_mode'),
		dct_audio_enable_is: modeFeedback('Audio Enable is', ENUM.dct_onoff, 'dct_audio_enable'),
		dct_sdi_range_is: modeFeedback('SDI Range is', ENUM.dct_sdi_range, 'dct_sdi_range'),
		connected: {
			type: 'boolean',
			name: 'Connection OK',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => self.socket?.isConnected === true,
		},
		knob_value: {
			type: 'advanced',
			name: 'Knob: show current value',
			options: [
				{
					type: 'dropdown',
					id: 'param',
					label: 'Parameter',
					default: self.params[0]?.id,
					choices: self.params.map((p) => ({ id: p.id, label: `${p.group}: ${p.name}` })),
				},
			],
			callback: (fb) => {
				const p = self.paramById?.[fb.options.param]
				if (!p) return {}
				// Prefer the knob's own running target (same value adjustParam()'s
				// arithmetic uses) over the possibly-lagging polled self.state --
				// otherwise the display can show an older, lower number while
				// polling catches up mid-turn, looking like a spurious step back.
				const v = self.knob[p.varId] !== undefined ? self.knob[p.varId] : self.state[p.varId]
				const n = Number(v)
				// Second arg (self.cameraModel) is only consumed by format functions
				// that need it (e.g. dct_black_red/green/blue's per-ISP factory
				// default, see BLACK_DEFAULT_BY_MODEL in commands.js) -- every other
				// format function ignores extra arguments, so this is safe to pass
				// unconditionally.
				const text = p.format && Number.isFinite(n) ? p.format(n, self.cameraModel) : (v ?? '--')
				// Most params bar-position on the raw wire value; a few (e.g. Audio
				// Gain) define a separate display-unit scale (barValue/barMin/barMax)
				// so the bar reflects the same unit as the text above it -- e.g. 0dB
				// sits at the visual center of a symmetric dB window, not near the
				// left edge of the raw 0-4095 range. A non-finite barValue (Audio
				// Gain's raw=0 is -Infinity dB) clamps to the bar's low end instead
				// of falling through to progressBar()'s own "not finite" dashes.
				let barVal = p.barValue ? p.barValue(n) : n
				const barMin = p.barValue ? p.barMin : p.min
				const barMax = p.barValue ? p.barMax : effectiveMax(p, self.cameraModel)
				if (p.barValue && !Number.isFinite(barVal)) barVal = barMin
				const bar = progressBar(barVal, barMin, barMax)
				return { text: `${p.name}\\n${text}\\n${bar}`, size: 'auto' }
			},
		},
		wb_measure_display: {
			type: 'advanced',
			name: 'WB Kelvin Measure (display)',
			options: [],
			callback: () => {
				const v = self.state.dct_wb_temp_measure
				return { text: `WB Measure\\n${v ?? '--'} K`, size: 'auto' }
			},
		},
		dct_audio_enable_display: {
			type: 'advanced',
			name: 'Audio Enable toggle (display)',
			options: [],
			callback: () => {
				const on = self.state.dct_audio_enable === 'On'
				return {
					text: `Audio\\n${on ? 'ON' : 'OFF'}`,
					size: 'auto',
					bgcolor: on ? LIGHT_CYAN : DARK_CYAN,
					color: WHITE,
				}
			},
		},
		dct_sdi_range_display: {
			type: 'advanced',
			name: 'SDI Range toggle (display)',
			options: [],
			callback: () => {
				const full = self.state.dct_sdi_range === 'Full'
				return {
					text: `SDI\\n${full ? 'FULL' : 'LEGAL'}`,
					size: 'auto',
					bgcolor: full ? LIGHT_BLUE : BLUE,
					color: WHITE,
				}
			},
		},
		dct_tally_display: {
			type: 'advanced',
			name: 'Tally cycle (display)',
			options: [],
			callback: () => {
				const { red, green } = self.tally
				const label = red && green ? 'YELLOW' : red ? 'RED' : green ? 'GREEN' : 'OFF'
				const bgcolor = red && green ? ORANGE : red ? RED : green ? GREEN : DARK_GRAY
				return { text: `Tally\\n${label}`, size: 'auto', bgcolor, color: WHITE }
			},
		},
		cam_ae_display: modeToggleDisplay('AE toggle (display)', 'AE', 'ae_mode', 'FullAuto'),
		cam_wb_display: modeToggleDisplay('WB toggle (display)', 'WB', 'wb_mode', 'Auto'),
		dct_timecode_hold_display: {
			type: 'advanced',
			name: 'Timecode toggle (display)',
			options: [],
			callback: () => {
				const on = self.state.dct_timecode_hold === 'Run'
				return {
					text: `TC\\n${on ? 'RUN' : 'HOLD'}`,
					size: 'auto',
					bgcolor: on ? LIGHT_GRAY : DARK_GRAY,
					color: WHITE,
				}
			},
		},
	})
}
