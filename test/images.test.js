// Pure unit tests for images.js's from-scratch PNG encoder. No Companion, no network.
//   node --test

import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { encodePng, KNOB_RING_PNG } from '../src/images.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function parseChunks(buf) {
	const chunks = []
	let offset = 8
	while (offset < buf.length) {
		const len = buf.readUInt32BE(offset)
		const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
		const data = buf.subarray(offset + 8, offset + 8 + len)
		chunks.push({ type, data })
		offset += 8 + len + 4 // length + type + data + crc
	}
	return chunks
}

test('encodePng produces a well-formed PNG: signature, IHDR, IDAT, IEND', () => {
	const b64 = encodePng(4, 3, () => [10, 20, 30, 40])
	const buf = Buffer.from(b64, 'base64')
	assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature')

	const chunks = parseChunks(buf)
	assert.deepEqual(
		chunks.map((c) => c.type),
		['IHDR', 'IDAT', 'IEND'],
	)

	const ihdr = chunks[0].data
	assert.equal(ihdr.readUInt32BE(0), 4, 'width')
	assert.equal(ihdr.readUInt32BE(4), 3, 'height')
	assert.equal(ihdr[8], 8, 'bit depth')
	assert.equal(ihdr[9], 6, 'color type (RGBA)')

	assert.equal(chunks[2].data.length, 0, 'IEND has no payload')
})

test('encodePng round-trips exact pixel values through zlib deflate/inflate', () => {
	const width = 3
	const height = 2
	const pixelAt = (x, y) => [x * 10, y * 10, 255 - x, y === 0 ? 255 : 128]
	const buf = Buffer.from(encodePng(width, height, pixelAt), 'base64')
	const chunks = parseChunks(buf)
	const idat = chunks.find((c) => c.type === 'IDAT').data
	const raw = zlib.inflateSync(idat)

	const stride = 1 + width * 4
	for (let y = 0; y < height; y++) {
		assert.equal(raw[y * stride], 0, `row ${y}: filter type None`)
		for (let x = 0; x < width; x++) {
			const o = y * stride + 1 + x * 4
			assert.deepEqual([...raw.subarray(o, o + 4)], pixelAt(x, y), `pixel (${x},${y})`)
		}
	}
})

test('KNOB_RING_PNG is a square RGBA PNG: transparent center/corner, a thin low-contrast anti-aliased ring', () => {
	const buf = Buffer.from(KNOB_RING_PNG, 'base64')
	const chunks = parseChunks(buf)
	const ihdr = chunks.find((c) => c.type === 'IHDR').data
	const width = ihdr.readUInt32BE(0)
	const height = ihdr.readUInt32BE(4)
	assert.equal(width, height, 'square canvas')

	const raw = zlib.inflateSync(chunks.find((c) => c.type === 'IDAT').data)
	const stride = 1 + width * 4
	const alphaAt = (x, y) => raw[y * stride + 1 + x * 4 + 3]

	const center = Math.floor(width / 2)
	assert.equal(alphaAt(center, center), 0, 'center is fully transparent')
	assert.equal(alphaAt(0, 0), 0, 'corner is fully transparent')

	// Scan the whole image: the ring should be thin (a small fraction of the
	// canvas), low-contrast (well short of fully opaque), and actually
	// present (not all-zero) -- regardless of the canvas's actual resolution.
	let maxAlpha = 0
	let litPixels = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const a = alphaAt(x, y)
			if (a > 0) litPixels++
			if (a > maxAlpha) maxAlpha = a
		}
	}
	assert.ok(maxAlpha > 0, 'the ring is actually drawn somewhere')
	assert.ok(maxAlpha < 150, `peak alpha ${maxAlpha} should be low-contrast, not near-opaque`)
	assert.ok(litPixels > 0 && litPixels < width * height * 0.25, `ring should be thin, got ${litPixels} lit pixels`)
})
