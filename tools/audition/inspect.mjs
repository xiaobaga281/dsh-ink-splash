#!/usr/bin/env node
/** Read the audition WAVs back and report the things a render can get wrong. */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "试听");

function read(path) {
	const b = readFileSync(path);
	const sr = b.readUInt32LE(24);
	const ch = b.readUInt16LE(22);
	const n = b.readUInt32LE(40) / 4;
	const L = new Float32Array(n);
	const R = new Float32Array(n);
	for (let i = 0; i < n; i += 1) {
		L[i] = b.readInt16LE(44 + i * 4) / 32768;
		R[i] = b.readInt16LE(44 + i * 4 + 2) / 32768;
	}
	return { sr, ch, L, R, n };
}

const db = (x) => (x <= 1e-12 ? -999 : 20 * Math.log10(x));

for (const file of readdirSync(OUT).filter((f) => f.endsWith(".wav"))) {
	const { sr, L, R, n } = read(join(OUT, file));
	let md = 0; let peak = 0; let sum = 0; let corr = 0; let mdAt = 0;
	for (let i = 1; i < n; i += 1) {
		const d = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
		if (d > md) { md = d; mdAt = i; }
	}
	for (let i = 0; i < n; i += 1) {
		peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
		sum += L[i] * L[i] + R[i] * R[i];
		corr += L[i] * R[i];
	}
	const rms = Math.sqrt(sum / (2 * n));
	const width = corr / (sum / 2 || 1);

	// 100 ms RMS envelope, printed as a bar so the arc is visible at a glance
	const step = Math.round(0.1 * sr);
	let line = "";
	for (let s = 0; s + step <= n; s += step) {
		let e = 0;
		for (let i = s; i < s + step; i += 1) e += L[i] * L[i] + R[i] * R[i];
		const r = Math.sqrt(e / (2 * step));
		const v = Math.max(0, Math.min(9, Math.round((db(r) + 70) / 5)));
		line += " .:-=+*#%@"[v];
	}
	console.log(`${file.padEnd(22)} ${(n / sr).toFixed(1)}s  peak ${db(peak).toFixed(1)}  rms ${db(rms).toFixed(1)}  maxΔ ${md.toFixed(3)} @${(mdAt / sr).toFixed(2)}s  L/R ${width.toFixed(2)}`);
	console.log(`   ${line}`);
}
