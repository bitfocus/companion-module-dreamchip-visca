// Pure unit tests for tools/visca-decode.mjs. No Companion, no network.
//   node --test

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFrame, encodeNibbles } from '../commands.js'
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
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x4c, 0x00, 0x00, ...encodeNibbles(42, 2)])))
	assert.match(entries[0].companion, /Gain \(direct\) = 42/)
	assert.match(entries[0].provideo, /^cam_gain <raw=42>/)
	assert.match(entries[0].provideo, /firmware applies its own scaling/)
})

test('rud command (Gain reset) is a real firmware command; up/down are not implemented', () => {
	const reset = decodeDump(parseLines(tx([0x01, 0x04, 0x0c, 0x00])))
	assert.equal(reset[0].provideo, 'cam_gain 1000')

	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x0c, 0x02])))
	assert.match(up[0].provideo, /not implemented in current firmware \(up unsupported\)/)
})

test('rud command with firmware read-modify-write support (Red Gain up)', () => {
	const up = decodeDump(parseLines(tx([0x01, 0x04, 0x03, 0x02])))
	assert.match(up[0].provideo, /read-modify-write \(\+step\)/)
})

test('enum command with a per-choice ProVideo mapping (White Balance -> Indoor)', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x35, 0x01])))
	assert.match(entries[0].companion, /White Balance = Indoor/)
	assert.equal(entries[0].provideo, 'wb_preset 1')
})

test('enum command not handled by any firmware dispatcher reports as such', () => {
	const entries = decodeDump(parseLines(tx([0x01, 0x04, 0x35, 0x20]))) // Color Temp
	assert.match(entries[0].provideo, /not implemented in current firmware \(Color Temp unsupported\)/)
})

test('translate() returns a clear message for a frame with no table entry at all', () => {
	assert.equal(translate(null), '(no ProVideo mapping known)')
})
