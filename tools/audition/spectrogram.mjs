#!/usr/bin/env node
/**
 * A spectrogram PNG for the audition WAVs — a second pair of eyes on the
 * render, since a level meter cannot show whether a note starts where the
 * mark says it should or whether the bed drops out under the tail.
 *
 * Usage: node tools/audition/spectrogram.mjs "新-古琴"
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "试听");
const SHOT = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOT, { recursive: true });

function read(path) {
	const b = readFileSync(path);
	const sr = b.readUInt32LE(24);
	const ch = b.readUInt16LE(22);
	const frames = b.readUInt32LE(40) / (2 * ch);
	const L = new Float32Array(frames);
	const R = new Float32Array(frames);
	for (let i = 0; i < frames; i += 1) {
		L[i] = b.readInt16LE(44 + i * 2 * ch) / 32768;
		if (ch > 1) R[i] = b.readInt16LE(44 + i * 2 * ch + 2) / 32768;
	}
	return { sr, L, R, frames };
}

function fft(re, im) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i += 1) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = -2 * Math.PI / len;
		const wr = Math.cos(ang); const wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1; let ci = 0;
			for (let k = 0; k < len / 2; k += 1) {
				const ur = re[i + k]; const ui = im[i + k];
				const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
				const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
				re[i + k] = ur + vr; im[i + k] = ui + vi;
				re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
				const ncr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr; cr = ncr;
			}
		}
	}
}

const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function png(rgb, w, h) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y += 1) {
		raw[y * (w * 3 + 1)] = 0;
		rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A dark-blue → violet → amber → white ramp. */
function colour(v) {
	const stops = [[8, 12, 28], [42, 18, 72], [110, 30, 96], [190, 70, 70], [240, 150, 60], [255, 236, 200]];
	const x = Math.max(0, Math.min(1, v)) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(x));
	const k = x - i;
	return stops[i].map((c, j) => Math.round(c + (stops[i + 1][j] - c) * k));
}

const name = process.argv[2] ?? "新-古琴";
const file = join(OUT, name + ".wav");
const { sr, L, R, frames } = read(file);

const W = 1300; const H = 520;
const fMax = 6000;
const win = 1024; const hop = Math.max(1, Math.floor(frames / W));
const rgb = Buffer.alloc(W * H * 3);
const window = new Float32Array(win);
for (let i = 0; i < win; i += 1) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);

const dbFloor = -78; const dbTop = -18;
const band = [];
for (let b = 0; b < H; b += 1) {
	// log frequency axis, so the low register is not a single row
	const f = 20 * Math.pow(fMax / 20, (H - 1 - b) / (H - 1));
	band.push(Math.round(f / (sr / win)));
}

for (let x = 0; x < W; x += 1) {
	const start = x * hop;
	const re = new Float32Array(win); const im = new Float32Array(win);
	for (let i = 0; i < win; i += 1) {
		const idx = start + i;
		re[i] = idx < frames ? (L[idx] + R[idx]) * 0.5 * window[i] : 0;
	}
	fft(re, im);
	for (let y = 0; y < H; y += 1) {
		const k = Math.max(1, Math.min(win / 2 - 1, band[y]));
		const mag = Math.hypot(re[k], im[k]) / (win / 4);
		const v = (20 * Math.log10(mag + 1e-9) - dbFloor) / (dbTop - dbFloor);
		const c = colour(v);
		const off = (y * W + x) * 3;
		rgb[off] = c[0]; rgb[off + 1] = c[1]; rgb[off + 2] = c[2];
	}
}

const out = join(SHOT, name + ".png");
writeFileSync(out, png(rgb, W, H));
console.log(out);
