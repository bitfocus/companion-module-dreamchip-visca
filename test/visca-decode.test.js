// Pure unit tests for tools/visca-decode.mjs. No Companion, no network.
//   node --test

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFrame, encodeNibbles, GAIN_ISO, SHUTTER_SPEEDS } from '../commands.js'
import { decodeDump, parseLines, translate } from '../tools/visca-decode.mjs'

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim()
const tx = (payload) => `TX ${hex(buildFrame(1, payload))}`
const rx = (payload) => `RX ${hex(buildFrame(0, payload))}` // replies are always address 0

test('parseLines extracts direction + bytes, ignoring non-hex lines', () => {
	const lines = parseLines('26.07.21 14:45:46 Module: TX 81 09 7e 01 12 ff\nnot a frame\n')
	assert.deepEqual(lines, [{ dir: 'TX', bytes: [0x81, 0x09, 0x7e, 0x01, 0x12, 0xff] }])
})

test('parseLines ignores a CSV header row with incidental hex-looking letter pairs', () => {
	// "Date,Type,Source,Log" contains "Da" and "ce" (valid hex letters), but
	// only 2 bytes total and no TX/RX marker — must not be mistaken for a frame.
	const lines = parseLines('Date,Type,Source,Log\n2026-07-21T13:45:39.234Z,debug,Module,TX 81 09 00 02 ff\n')
	assert.deepEqual(lines, [{ dir: 'TX', bytes: [0x81, 0x09, 0x00, 0x02, 0xff] }])
})

test('DCT-ext direct-set frame (dpf_strength) translates 1:1, no scaling', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x13, ...encodeNibbles(9, 1)])))
	assert.equal(entries.length, 1)
	assert.match(entries[0].companion, /DPF Strength = 9/)
	assert.equal(entries[0].provideo, 'dpf_strength 9')
})

test('DCT-ext inquiry + error reply (real session example: DPF Enable, not executable)', () => {
	const lines = parseLines(`${tx([0x09, 0x7e, 0x01, 0x12])}\n${rx([0x60, 0x41])}`)
	const entries = decodeDump(lines)
	assert.equal(entries.length, 2)
	assert.match(entries[0].companion, /DPF Enable \(inquiry\)/)
	assert.match(entries[1].provideo, /ERROR 0x41 \(Command Not Executable\)/)
	assert.match(entries[1].provideo, /dpf_enable not executable/)
})

test('DCT-ext inquiry + successful reply decodes the value and names the ProVideo command', () => {
	const lines = parseLines(`${tx([0x09, 0x7e, 0x01, 0x13])}\n${rx([0x50, ...encodeNibbles(7, 1)])}`)
	const entries = decodeDump(lines)
	assert.match(entries[1].companion, /DPF Strength = 7/)
	assert.equal(entries[1].provideo, 'dpf_strength')
})

test('standard-category direct-set (Gain) reports the raw value with a scaling caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x4c, 0x00, 0x00, ...encodeNibbles(42, 3)])))
	assert.match(entries[0].companion, /Gain \(direct\) = 42/)
	assert.match(entries[0].provideo, /^cam_gain <raw=42>/)
	assert.match(entries[0].provideo, /real range is 1000-45715/)
})

test('a Gain (ISO) send is indistinguishable on the wire from Gain (direct) and decodes via cam_gain_direct', () => {
	// ISO 3200 -> raw 2001 (GAIN_ISO). The wire bytes equal a manual
	// Gain (direct) = 2001, so the decoder resolves it through cam_gain_direct
	// (no distinct provideo mapping needed or possible).
	const raw = GAIN_ISO.find((g) => g.iso === 3200).raw
	assert.equal(raw, 2001)
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x4c, 0x00, 0x00, ...encodeNibbles(raw, 3)])))
	assert.match(entries[0].companion, /Gain \(direct\) = 2001/)
	assert.match(entries[0].provideo, /^cam_gain <raw=2001>/)
	assert.match(entries[0].provideo, /real range is 1000-45715/)
})

test('a Shutter (Speed) send is indistinguishable on the wire from Shutter (direct) and decodes via cam_shutter_direct', () => {
	// 1/1000 -> raw 96 (SHUTTER_SPEEDS). The wire bytes equal a manual
	// Shutter (direct) = 96, so the decoder resolves it through
	// cam_shutter_direct (no distinct provideo mapping needed or possible).
	const raw = SHUTTER_SPEEDS.find((s) => s.n === 1000).raw
	assert.equal(raw, 96)
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x4a, 0x00, 0x00, ...encodeNibbles(raw, 3)])))
	assert.match(entries[0].companion, /Shutter \(direct\) = 96/)
	assert.match(entries[0].provideo, /^cam_exposure <raw=96>/)
	assert.match(entries[0].provideo, /real range is 100-38339us/)
})

test('DCT-ext wb_temp SET translates to wb_temp <kelvin>, 4-nibble, no scaling', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x0b, ...encodeNibbles(5000, 4)])))
	assert.equal(entries.length, 1)
	assert.match(entries[0].companion, /Color Temp \(Kelvin\) = 5000/)
	assert.equal(entries[0].provideo, 'wb_temp 5000')
})

test('DCT-ext wb_temp current inquiry + reply decodes Kelvin and names wb_temp', () => {
	const lines = parseLines(`${tx([0x09, 0x7e, 0x01, 0x0b, 0x00])}\n${rx([0x50, ...encodeNibbles(2200, 4)])}`)
	const entries = decodeDump(lines)
	assert.match(entries[0].companion, /Color Temp \(K\) \(inquiry\)/)
	assert.match(entries[1].companion, /Color Temp \(K\) = 2200/)
	assert.equal(entries[1].provideo, 'wb_temp')
})

test('DCT-ext wb_temp min/max inquiries are distinguished by selector byte', () => {
	const minEntries = decodeDump(parseLines(tx([0x09, 0x7e, 0x01, 0x0b, 0x01])))
	const maxEntries = decodeDump(parseLines(tx([0x09, 0x7e, 0x01, 0x0b, 0x02])))
	assert.match(minEntries[0].companion, /Color Temp Min \(K\) \(inquiry\)/)
	assert.match(maxEntries[0].companion, /Color Temp Max \(K\) \(inquiry\)/)
})

test('DCT-ext wb_temp_measure inquiry + reply decodes measured cct and names wb_temp_measure', () => {
	const lines = parseLines(`${tx([0x09, 0x7e, 0x01, 0x0c])}\n${rx([0x50, ...encodeNibbles(5600, 4)])}`)
	const entries = decodeDump(lines)
	assert.match(entries[0].companion, /Color Temp Measured \(K\) \(inquiry\)/)
	assert.match(entries[1].companion, /Color Temp Measured \(K\) = 5600/)
	assert.equal(entries[1].provideo, 'wb_temp_measure')
})

test('signed direct-set (Color Hue) decodes the wire byte as negative, not as its raw unsigned value', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x4f, 0x00, 0x00, ...encodeNibbles(-5 & 0xff, 2)])))
	assert.match(entries[0].companion, /Color Hue \(direct\) = -5/)
	assert.equal(entries[0].provideo, 'post_hue -5')
})

test('signed inquiry reply (Color Hue) decodes the wire byte as negative', () => {
	// Real hardware pads to "00 00 0p 0q" (reply_pq, visca_map_picture.c),
	// not a bare 2-nibble reply -- this must still decode correctly.
	const lines = parseLines(`${tx([0x09, 0x04, 0x4f])}\n${rx([0x50, 0x00, 0x00, ...encodeNibbles(-5 & 0xff, 2)])}`)
	const entries = decodeDump(lines)
	assert.match(entries[1].companion, /Color Hue = -5/)
	assert.equal(entries[1].provideo, 'post_hue')
})

test('signed + scaled direct-set (Black Red) shows the signed raw value with an x2 scaling caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x04, ...encodeNibbles(-500 & 0xfff, 3)])))
	assert.match(entries[0].companion, /Black Red = -500/)
	assert.match(entries[0].provideo, /^black_red <raw=-500>/)
	assert.match(entries[0].provideo, /firmware doubles it \(x2\)/)
})

test('DCT-ext direct-set (Filter Detail) flags the firmware clamp for raw values above its real max', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x15, ...encodeNibbles(200, 2)])))
	assert.match(entries[0].companion, /Filter Detail = 200/)
	assert.match(entries[0].provideo, /^filter_detail <raw=200>/)
	assert.match(entries[0].provideo, /clamps raw values above 31 to 31/)
})

test('DCT-ext direct-set (Audio Gain) shows the raw value with an x16 scaling caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x66, ...encodeNibbles(256, 3)])))
	assert.match(entries[0].companion, /Audio Gain = 256/)
	assert.match(entries[0].provideo, /^audio_gain <raw=256>/)
	assert.match(entries[0].provideo, /firmware multiplies it by 16/)
})

test('DCT-ext direct-set (AEC SetPoint) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x18, ...encodeNibbles(857, 3)])))
	assert.match(entries[0].companion, /AEC SetPoint = 857/)
	assert.match(entries[0].provideo, /^aec <raw=857>/)
	assert.match(entries[0].provideo, /positional arg 2 \(setPoint\), real range 50-3000/)
	assert.match(entries[0].provideo, /read-modify-write of all 10 args/)
})

test('DCT-ext direct-set (AEC Speed) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x19, ...encodeNibbles(26, 2)])))
	assert.match(entries[0].companion, /AEC Speed = 26/)
	assert.match(entries[0].provideo, /^aec <raw=26>/)
	assert.match(entries[0].provideo, /positional arg 3 \(speed\), real range 1-30/)
	assert.match(entries[0].provideo, /read-modify-write of all 10 args/)
})

test('DCT-ext direct-set (AEC Max Gain) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x1a, ...encodeNibbles(4095, 3)])))
	assert.match(entries[0].companion, /AEC Max Gain = 4095/)
	assert.match(entries[0].provideo, /^aec <raw=4095>/)
	assert.match(entries[0].provideo, /positional arg 9 \(maxGain\), real range 1000-45715/)
	assert.match(entries[0].provideo, /read-modify-write of all 10 args/)
})

test('DCT-ext direct-set (Flare Red) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x07, ...encodeNibbles(300, 3)])))
	assert.match(entries[0].companion, /Flare Red = 300/)
	assert.match(entries[0].provideo, /^flare <raw=300>/)
	assert.match(entries[0].provideo, /positional arg 1 \(red\), real range 0-65535/)
	assert.match(entries[0].provideo, /read-modify-write of all 3 args/)
	assert.match(entries[0].provideo, /firmware multiplies it by 16/)
})

test('DCT-ext direct-set (Flare Green) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x1b, ...encodeNibbles(4095, 3)])))
	assert.match(entries[0].companion, /Flare Green = 4095/)
	assert.match(entries[0].provideo, /^flare <raw=4095>/)
	assert.match(entries[0].provideo, /positional arg 2 \(green\), real range 0-65535/)
	assert.match(entries[0].provideo, /read-modify-write of all 3 args/)
})

test('DCT-ext direct-set (Flare Blue) reports the raw value with a read-modify-write caveat', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x1c, ...encodeNibbles(0, 3)])))
	assert.match(entries[0].companion, /Flare Blue = 0/)
	assert.match(entries[0].provideo, /^flare <raw=0>/)
	assert.match(entries[0].provideo, /positional arg 3 \(blue\), real range 0-65535/)
	assert.match(entries[0].provideo, /read-modify-write of all 3 args/)
})

test('DCT-ext enum command (SDI Range) maps 0->Legal, 1->Full, matching do_sdi_range\'s own help text', () => {
	const legal = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x30, 0x00])))
	assert.match(legal[0].companion, /SDI Range = Legal/)
	assert.equal(legal[0].provideo, 'sdi_range 0')

	const full = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x30, 0x01])))
	assert.match(full[0].companion, /SDI Range = Full/)
	assert.equal(full[0].provideo, 'sdi_range 1')
})

test("Green Gain reset targets 256 (unity), not 512 like red/blue's reset", () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x01, 0x00])))
	assert.match(entries[0].companion, /Green Gain = Reset/)
	assert.equal(entries[0].provideo, 'gain_green 256')
})

test('rud command (Gain) supports the full Reset/Up/Down structure via firmware read-modify-write', () => {
	const reset = decodeDump(parseLines(tx([0x01, 0x04, 0x0c, 0x00])))
	assert.equal(reset[0].provideo, 'cam_gain 1000')

	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x0c, 0x02])))
	assert.match(up[0].provideo, /read-modify-write \(\+109\)/)

	const down = decodeDump(parseLines(tx([0x01, 0x04, 0x0c, 0x03])))
	assert.match(down[0].provideo, /read-modify-write \(-109\)/)
})

test('rud command (Shutter) supports the full Reset/Up/Down structure via firmware read-modify-write', () => {
	const reset = decodeDump(parseLines(tx([0x01, 0x04, 0x0a, 0x00])))
	assert.equal(reset[0].provideo, 'cam_exposure 1000')

	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x0a, 0x02])))
	assert.match(up[0].provideo, /read-modify-write \(\+93us\)/)

	const down = decodeDump(parseLines(tx([0x01, 0x04, 0x0a, 0x03])))
	assert.match(down[0].provideo, /read-modify-write \(-93us\)/)
})

test('rud command with firmware read-modify-write support (Red Gain up)', () => {
	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x03, 0x02])))
	assert.match(up[0].provideo, /read-modify-write \(\+step\)/)
})

test('enum command with a per-choice ProVideo mapping (WB -> Indoor)', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x35, 0x01])))
	assert.match(entries[0].companion, /WB = Indoor/)
	assert.equal(entries[0].provideo, 'wb_preset 1')
})

test('enum command with a per-choice ProVideo mapping (AE -> Auto)', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x39, 0x00])))
	assert.match(entries[0].companion, /AE = Auto/)
	assert.equal(entries[0].provideo, 'aec 1')
})

test('cam_bright (RUD) supports Reset/Up/Down via read-modify-write of post_bright', () => {
	const reset = decodeDump(parseLines(tx([0x01, 0x04, 0x0d, 0x00])))
	assert.match(reset[0].companion, /Bright reset/)
	assert.equal(reset[0].provideo, 'post_bright 0')

	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x0d, 0x02])))
	assert.match(up[0].provideo, /read-modify-write \(\+5\)/)
})

test('Bright (direct) decodes a negative signed value (post_bright)', () => {
	const bright = decodeDump(parseLines(tx([0x01, 0x04, 0x0d, 0x00, 0x00, ...encodeNibbles(-5 & 0xff, 2)])))
	assert.match(bright[0].companion, /Bright \(direct\) = -5/)
	assert.equal(bright[0].provideo, 'post_bright -5')
})

test('the standard "CAM_Brightness" function (0xA1) is a pure duplicate of cam_bright_direct and is not decoded (not exposed in Companion)', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0xa1, 0x00, 0x00, ...encodeNibbles(-5 & 0xff, 2)])))
	assert.equal(entries[0].provideo, '(no ProVideo mapping known)')
})

test('signed inquiry reply (Bright) decodes the wire byte as negative, not the padded 251', () => {
	// Same padded-reply caveat as Color Hue's inquiry above.
	const lines = parseLines(`${tx([0x09, 0x04, 0x4d])}\n${rx([0x50, 0x00, 0x00, ...encodeNibbles(-5 & 0xff, 2)])}`)
	const entries = decodeDump(lines)
	assert.match(entries[1].companion, /Bright = -5/)
	assert.equal(entries[1].provideo, 'post_bright')
})

test('cam_gamma maps directly to log_mode', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x5b, 0x03])))
	assert.match(entries[0].companion, /Gamma = S-Log3/)
	assert.equal(entries[0].provideo, 'log_mode 3')
})

test("cam_flicker read-modify-writes aec's taf field (Off and 50Hz both normalize to taf=10000)", () => {
	const off = decodeDump(parseLines(tx([0x01, 0x04, 0x23, 0x00])))
	assert.match(off[0].provideo, /taf=10000, same as 50Hz/)

	const hz60 = decodeDump(parseLines(tx([0x01, 0x04, 0x23, 0x02])))
	assert.match(hz60[0].provideo, /taf=8333/)
})

test('cam_lr_reverse and cam_picture_flip (0x61/0x66) are not decoded -- cam_flip already reaches every state', () => {
	const lr = decodeDump(parseLines(tx([0x01, 0x04, 0x61, 0x02])))
	assert.equal(lr[0].provideo, '(no ProVideo mapping known)')

	const pf = decodeDump(parseLines(tx([0x01, 0x04, 0x66, 0x03])))
	assert.equal(pf[0].provideo, '(no ProVideo mapping known)')
})

test('color_temp_direct is a raw wb_preset index passthrough, not a Kelvin value', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x20, 0x00, 0x00, ...encodeNibbles(3, 2)])))
	assert.match(entries[0].companion, /Color Temp \(direct\) = 3/)
	assert.equal(entries[0].provideo, 'wb_preset 3')
})

test('cam_settings_reset and cam_settings_save both map to real ProVideo commands (confirmed reachable on real hardware)', () => {
	const reset = decodeDump(parseLines(tx([0x01, 0x04, 0xa0, 0x10])))
	assert.equal(reset[0].provideo, 'reset_settings')

	const save = decodeDump(parseLines(tx([0x01, 0x04, 0xa5, 0x10])))
	assert.equal(save[0].provideo, 'save_settings')
})

test('Load Settings (DCT ext, no standard VISCA equivalent) maps to load_settings', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x67])))
	assert.match(entries[0].companion, /Load Settings/)
	assert.equal(entries[0].provideo, 'load_settings')
})

test('S-Log3 Master Gain (direct) decodes a negative signed value, not the wire-range full 0-255', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x09, ...encodeNibbles(-6 & 0xff, 2)])))
	assert.match(entries[0].companion, /S-Log3 Master Gain = -6/)
	assert.match(entries[0].provideo, /^slog3_master_gain <raw=-6>/)
	assert.match(entries[0].provideo, /real range is signed -6\.\.12 dB/)
})

test('SDI Black/White (direct) decode negative signed values, not the wire-range full 0-255', () => {
	const black = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x31, ...encodeNibbles(-60 & 0xff, 2)])))
	assert.match(black[0].companion, /SDI Black = -60/)
	assert.match(black[0].provideo, /^sdi_black <raw=-60>/)
	assert.match(black[0].provideo, /real range is signed -60\.\.60/)

	const white = decodeDump(parseLines(tx([0x01, 0x7e, 0x01, 0x32, ...encodeNibbles(-80 & 0xff, 2)])))
	assert.match(white[0].companion, /SDI White = -80/)
	assert.match(white[0].provideo, /^sdi_white <raw=-80>/)
	assert.match(white[0].provideo, /real range is signed -80\.\.79/)
})

test('video-mode set (cam_system) decodes to its named mode, not a bare index', () => {
	const [b2, b3] = [0x00, 0x0e] // mode 4 = 1080p30
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x24, 0x00, 0x00, b2, b3])))
	assert.match(entries[0].companion, /Video = 1080p30/)
})

test('video-mode inquiry reply decodes to its named mode', () => {
	const lines = parseLines(`${tx([0x09, 0x04, 0x24])}\n${rx([0x50, 0x00, 0x00, 0x00, 0x0e])}`)
	const entries = decodeDump(lines)
	assert.match(entries[1].companion, /Video Mode = 1080p30/)
})

test('translate() returns a clear message for a frame with no table entry at all', () => {
	assert.equal(translate(null), '(no ProVideo mapping known)')
})
