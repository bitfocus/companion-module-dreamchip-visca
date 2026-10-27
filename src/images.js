// Generated button background images. Companion's `style.png64` expects a
// raw base64-encoded PNG (no "data:image/png;base64," prefix) -- confirmed
// against companion-module-sony-visca's own `image_rotary_bg` asset, which
// is the precedent this file's "circle on a knob preset" follows. Unlike
// that module (which ships an opaque pre-rendered blob), this one draws its
// image from a small from-scratch PNG encoder below and computes the base64
// at module load time -- no image/canvas dependency needed (this module has
// none), and the ring's size/color/stroke are plain source, not a blob to
// reverse-engineer if it ever needs tweaking.

import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(buf) {
	let c = 0xffffffff
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
	const typeBuf = Buffer.from(type, 'ascii')
	const lenBuf = Buffer.alloc(4)
	lenBuf.writeUInt32BE(data.length)
	const crcBuf = Buffer.alloc(4)
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
	return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

// Encode an 8-bit RGBA PNG from a per-pixel callback -> raw base64 string.
export function encodePng(width, height, getPixel) {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type: RGBA
	// ihdr[10..12] (compression/filter/interlace) already zero-initialized

	const stride = 1 + width * 4 // filter-type byte + 4 bytes/pixel
	const raw = Buffer.alloc(height * stride)
	for (let y = 0; y < height; y++) {
		let o = y * stride
		raw[o++] = 0 // filter type: None
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = getPixel(x, y)
			raw[o++] = r
			raw[o++] = g
			raw[o++] = b
			raw[o++] = a
		}
	}
	const idat = zlib.deflateSync(raw)

	const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
	return png.toString('base64')
}

// A circular ring ("dial") outline for rotary-knob presets: a thin,
// low-contrast, anti-aliased stroke on an otherwise fully transparent
// background, so it overlays subtly on the knob button's existing blue
// background/white text (main.js's knob preset `style`) without needing
// per-button colors. A hard-edged threshold (dist-from-ring <= stroke/2)
// looks thick and jagged at small stroke widths; fading alpha linearly
// across the stroke's half-width instead gives a thin, smooth line at any
// stroke setting.
//
// Rendered at a higher resolution than Companion's actual button size
// (72x72) for a crisper downscaled result; radius/stroke are scaled up from
// the original 72px design (radius 30, stroke 1.5) by the same factor as
// the canvas, so the proportions -- and the ring's on-button appearance --
// stay identical, just sharper.
const KNOB_RING_SIZE = 200
const KNOB_RING_SCALE = KNOB_RING_SIZE / 72
const KNOB_RING_RADIUS = 30 * KNOB_RING_SCALE
const KNOB_RING_STROKE = 1.5 * KNOB_RING_SCALE
const KNOB_RING_ALPHA = 90 // out of 255 -- subtle, not stark against the blue background
function knobRingPixel(x, y) {
	const center = KNOB_RING_SIZE / 2
	const dx = x + 0.5 - center
	const dy = y + 0.5 - center
	const dist = Math.sqrt(dx * dx + dy * dy)
	const edgeDist = Math.abs(dist - KNOB_RING_RADIUS)
	const coverage = Math.max(0, 1 - edgeDist / (KNOB_RING_STROKE / 2))
	return [255, 255, 255, Math.round(KNOB_RING_ALPHA * coverage)]
}
export const KNOB_RING_PNG = encodePng(KNOB_RING_SIZE, KNOB_RING_SIZE, knobRingPixel)
