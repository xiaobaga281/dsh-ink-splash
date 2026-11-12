#!/usr/bin/env node
/**
 * Offline renderer for the splash voices.
 *
 * The splash makes its sound out of oscillators, one noise buffer and a
 * handful of filters — the same primitives Web Audio exposes. This file
 * re-implements those primitives in plain JS at 48 kHz so a recipe can be
 * auditioned as a WAV without booting the application, and so the same
 * numbers can be ported back into `lib/client.js` unchanged.
 *
 * Usage:
 *   node tools/audition/render.mjs                 # every known recipe
 *   node tools/audition/render.mjs new             # only the new ones
 *   node tools/audition/render.mjs legacy          # only the current ones
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "试听");

const SR = 48000;
const DUR_MS = 2600;              // the splash's default duration
const DUR = DUR_MS / 1000;
const TAIL = 6.2;                 // the context is closed 6.2 s after the stroke
const TOTAL = DUR + TAIL;
const N = Math.round(TOTAL * SR);
const LEVEL = 0.45 * 0.9;         // the app's default master gain (volume 45)

/* ---------------------------------------------------------------- helpers */

const TAU60 = Math.log(1000);     // ln(1/0.0005) ≈ 6.9078

/** `eased` from client.js, verbatim: the same curve the eye sees. */
function eased(x) {
	if (!(x > 0)) return 0;
	if (x >= 1) return 1;
	const [x1, y1, x2, y2] = [0.5, 0, 0.5, 1];
	let t = x;
	for (let i = 0; i < 8; i += 1) {
		const mt = 1 - t;
		const cx = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
		const dx = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
		if (Math.abs(dx) < 1e-9) break;
		t = Math.max(0, Math.min(1, t - (cx - x) / dx));
	}
	const mt = 1 - t;
	return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const panGains = (pan) => {
	const th = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4;
	return [Math.cos(th), Math.sin(th)];
};

/** Equal-power pan into a stereo pair. */
class Bus {
	constructor(length = N) {
		this.L = new Float32Array(length);
		this.R = new Float32Array(length);
	}
	/** Add one mono sample stream, already enveloped. */
	addAt(i, v, pan) {
		const [gl, gr] = panGains(pan);
		this.L[i] += v * gl;
		this.R[i] += v * gr;
	}
}

/** RBJ biquad coefficients, the formulas Web Audio's BiquadFilterNode uses. */
function biquad(type, f, q, gainDb = 0) {
	const w0 = 2 * Math.PI * Math.min(f, SR * 0.45) / SR;
	const cw = Math.cos(w0);
	const sw = Math.sin(w0);
	const alpha = sw / (2 * q);
	const A = Math.pow(10, gainDb / 40);
	let b0; let b1; let b2; let a0; let a1; let a2;
	if (type === "lowpass") {
		b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
		a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
	} else if (type === "highpass") {
		b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
		a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
	} else if (type === "bandpass") {
		b0 = alpha; b1 = 0; b2 = -alpha;
		a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
	} else if (type === "peak") {
		b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
		a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
	} else { // allpass
		b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha;
		a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
	}
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** State-variable style biquad runner whose coefficients may change over time. */
function runBiquad(input, length, coefFn, step = 32) {
	const out = new Float32Array(length);
	let c = coefFn(0, input);
	let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
	for (let i = 0; i < length; i += 1) {
		if (i % step === 0) c = coefFn(i / SR, input);
		const x = input[i];
		const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1; x1 = x; y2 = y1; y1 = y;
		out[i] = y;
	}
	return out;
}

/* ------------------------------------------------------------------- FFT */

function fft(re, im, inverse) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i += 1) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (inverse ? 2 : -2) * Math.PI / len;
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
	if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** Partitioned overlap-add convolution, enough for ~10 s against a long IR. */
function convolve(x, h) {
	const block = 32768;
	const size = 65536;
	const parts = Math.max(1, Math.ceil(h.length / block));
	const blocks = Math.ceil(x.length / block) + parts;
	const H = [];
	for (let k = 0; k < parts; k += 1) {
		const re = new Float64Array(size); const im = new Float64Array(size);
		for (let i = 0; i < block; i += 1) {
			const idx = k * block + i;
			re[i] = idx < h.length ? h[idx] : 0;
		}
		fft(re, im, false);
		H.push([re, im]);
	}
	const acc = Array.from({ length: blocks }, () => [new Float64Array(size), new Float64Array(size)]);
	for (let b = 0; b < Math.ceil(x.length / block); b += 1) {
		const re = new Float64Array(size); const im = new Float64Array(size);
		for (let i = 0; i < block; i += 1) {
			const idx = b * block + i;
			re[i] = idx < x.length ? x[idx] : 0;
		}
		fft(re, im, false);
		for (let k = 0; k < parts; k += 1) {
			const [hr, hi] = H[k];
			const [ar, ai] = acc[b + k];
			for (let i = 0; i < size; i += 1) {
				ar[i] += re[i] * hr[i] - im[i] * hi[i];
				ai[i] += re[i] * hi[i] + im[i] * hr[i];
			}
		}
	}
	const out = new Float32Array(x.length + size);
	for (let b = 0; b < blocks; b += 1) {
		const [ar, ai] = acc[b];
		for (let i = 0; i < size; i += 1) ar[i] += 0;
		fft(ar, ai, true);
		const at = b * block;
		for (let i = 0; i < size; i += 1) {
			const idx = at + i;
			if (idx < out.length) out[idx] += ar[i];
		}
	}
	return out.subarray(0, x.length);
}

/* --------------------------------------------------------------- timeline */

/**
 * The service tick, as the real splash runs it: 125 ms, the eased position
 * rounded to the grid, and the per-tick slope the bed level is derived from.
 */
function ticks() {
	const list = [];
	const step = 125;
	let prev = 0;
	for (let t = 0; t <= TOTAL * 1000 + 1; t += step) {
		const ratio = Math.max(0, Math.min(1, t / DUR_MS));
		const visual = eased(ratio);
		const dv = Math.max(0, visual - prev);
		prev = visual;
		const speed = (dv / step) * DUR_MS;
		list.push({ t: t / 1000, tMs: t, visual, speed });
	}
	return list;
}
const TICKS = ticks();
const MAX_SPEED = Math.max(...TICKS.map((k) => k.speed));

/** The first tick at which the front has passed `p` — cue timing, quantised like the app. */
function atMark(p) {
	const hit = TICKS.find((k) => k.visual >= p);
	return hit === undefined ? TOTAL : hit.t;
}

/** Smoothed parameter following tick targets (Web Audio setTargetAtTime). */
function follow(tickTargets, tau, initial = 0, length = N) {
	const out = new Float32Array(length);
	let v = initial;
	let i = 0;
	for (const tick of tickTargets) {
		const end = Math.min(length, Math.round((tick.t + 0.125) * SR));
		const target = tick.v;
		while (i < end) {
			v += (target - v) * (1 - Math.exp(-1 / (tau * SR)));
			out[i] = v;
			i += 1;
		}
	}
	while (i < length) { v += (0 - v) * (1 - Math.exp(-1 / (tau * SR))); out[i] = v; i += 1; }
	return out;
}

/* -------------------------------------------------------------- primitives */

/** One decaying partial with an optional glide and vibrato. */
function partial(bus, wet, opts) {
	const {
		t0, len, ratio, amp, rt60, attack = 0.004, pan = 0,
		from, to, glide = 0, vibHz = 0, vibCents = 0, phase0 = 0,
	} = opts;
	const start = Math.max(0, Math.round(t0 * SR));
	const stop = Math.min(N, Math.round((t0 + len) * SR));
	let phase = phase0;
	const tau = rt60 / TAU60;
	const env = (t) => (attack > 0 ? 1 - Math.exp(-t / attack) : 1) * Math.exp(-t / tau);
	for (let i = start; i < stop; i += 1) {
		const t = i / SR - t0;
		let f = from !== undefined ? from : ratio;
		if (from !== undefined && to !== undefined) {
			const k = glide > 0 ? Math.min(1, t / glide) : 1;
			f = from * Math.pow(to / from, k);
		} else {
			f = ratio;
		}
		if (vibHz > 0) f *= Math.pow(2, (vibCents / 1200) * Math.sin(2 * Math.PI * vibHz * t));
		phase += 2 * Math.PI * f / SR;
		const v = Math.sin(phase) * amp * env(t);
		bus.addAt(i, v, pan);
		if (wet > 0) wetBus.addAt(i, v * wet, pan);
	}
}

/** A burst of noise through a downward-swept band — paper, cloth, a blade. */
function burst(wet, opts) {
	const { t0, len, hz, hzTo = Math.max(hz * 0.35, 60), q = 1, amp, pan = 0, attack = 0.004, wetSend = 0.2 } = opts;
	const start = Math.max(0, Math.round(t0 * SR));
	const stop = Math.min(N, Math.round((t0 + len) * SR));
	const rnd = mulberry32(Math.round(t0 * 1009) + 17);
	const band = runBiquad(
		(() => { const a = new Float32Array(stop - start); for (let i = 0; i < a.length; i += 1) a[i] = rnd() * 2 - 1; return a; })(),
		stop - start,
		(tt) => biquad("bandpass", hz * Math.pow(hzTo / hz, Math.min(1, tt / len)), q),
	);
	for (let i = start; i < stop; i += 1) {
		const t = i / SR - t0;
		const e = (attack > 0 ? 1 - Math.exp(-t / attack) : 1) * Math.pow(0.0005, t / len);
		const v = band[i - start] * amp * e * 3.2;
		bus.addAt(i, v, pan);
		if (wet > 0) wetBus.addAt(i, v * wet * wetSend, pan);
	}
}

/** Filtered noise bed whose level follows the brush. */
function bed(wet, opts) {
	const { bands, peak, floor = 0, tauA = 0.14, wetSend = 0.18, followTicks, hp = 0, fadeAt = DUR, tilt = [1, 1] } = opts;
	const target = followTicks.map((k) => ({
		t: k.t,
		v: k.t >= fadeAt ? 0
			: Math.min(1.35, floor + (1 - floor) * Math.min(1.35, k.speed / MAX_SPEED)) * peak,
	}));
	const level = follow(target, tauA, 0);
	const L = new Float32Array(N);
	const R = new Float32Array(N);
	const rndL = mulberry32(0x51ed);
	const rndR = mulberry32(0x77a3);
	for (let i = 0; i < N; i += 1) { L[i] = rndL() * 2 - 1; R[i] = rndR() * 2 - 1; }
	const pAt = (tt) => tilt[0] + (tilt[1] - tilt[0]) * eased(Math.min(1, tt / DUR));
	const mixed = bands.map((band) => {
		const a = runBiquad(L, N, (tt) => biquad(band.type ?? "bandpass", band.hz * pAt(tt), band.q));
		const b = runBiquad(R, N, (tt) => biquad(band.type ?? "bandpass", band.hz * pAt(tt), band.q));
		return [a, b, band.mix ?? 1];
	});
	const sumL = new Float32Array(N);
	const sumR = new Float32Array(N);
	for (let i = 0; i < N; i += 1) {
		for (const [a, b, m] of mixed) { sumL[i] += a[i] * m; sumR[i] += b[i] * m; }
	}
	// A bed is air, never rumble: one high pass in series after the sum, exactly
	// as a BiquadFilterNode would sit in the chain.
	const hpL = hp > 0 ? runBiquad(sumL, N, () => biquad("highpass", hp, 0.7)) : sumL;
	const hpR = hp > 0 ? runBiquad(sumR, N, () => biquad("highpass", hp, 0.7)) : sumR;
	// `close()` fades the friction out when the stroke ends; a bed that keeps
	// hissing under the application is the one thing this layer must never do.
	const release = (t) => (t < fadeAt ? 1 : Math.exp(-(t - fadeAt) / 0.22));
	for (let i = 0; i < N; i += 1) {
		const t = i / SR;
		const v = level[i] * release(t) * (t > fadeAt + 1.2 ? 0 : 1);
		bus.L[i] += hpL[i] * v;
		bus.R[i] += hpR[i] * v;
		if (wet > 0) { wetBus.L[i] += hpL[i] * v * wet * wetSend; wetBus.R[i] += hpR[i] * v * wet * wetSend; }
	}
}

/* ---------------------------------------------------------- current voices */

/** client.js #bell — seven classical partials, energy peaking at the fourth. */
function legacyBell(t0, hz, seconds, peak) {
	const partials = [
		[0.5, 0.34, 2.4], [1, 0.72, 1.6], [1.201, 0.5, 1.15], [1.498, 1, 0.95],
		[2, 0.62, 0.7], [2.998, 0.22, 0.5], [4.001, 0.12, 0.35],
	];
	for (const [ratio, amp, length] of partials) {
		const len = seconds * length;
		const start = Math.round(t0 * SR);
		const stop = Math.min(N, Math.round((t0 + len) * SR));
		let phase = 0;
		for (let i = start; i < stop; i += 1) {
			const t = i / SR - t0;
			phase += 2 * Math.PI * hz * ratio / SR;
			const v = Math.sin(phase) * peak * amp * Math.pow(0.0005, t / len);
			bus.addAt(i, v, 0);
		}
	}
}

/** client.js #guqin — inharmonic partials, sub-octave phantom, finger noise. */
function legacyGuqin(t0, hz, seconds, peak) {
	const B = 0.0007;
	for (let n = 1; n <= 8; n += 1) {
		const f = hz * n * Math.sqrt(1 + B * n * n);
		const amp = peak / Math.pow(n, 1.15);
		const len = seconds / (1 + 0.42 * (n - 1));
		const start = Math.round(t0 * SR);
		const stop = Math.min(N, Math.round((t0 + len) * SR));
		let phase = 0;
		for (let i = start; i < stop; i += 1) {
			const t = i / SR - t0;
			phase += 2 * Math.PI * f / SR;
			let v;
			if (n === 1) {
				// Web Audio's triangle: the band-limited odd series.
				v = Math.sin(phase) + Math.sin(3 * phase) / 9 + Math.sin(5 * phase) / 25 + Math.sin(7 * phase) / 49;
				v *= 0.78;
			} else {
				v = Math.sin(phase);
			}
			v *= amp * Math.pow(0.0005, t / len);
			bus.addAt(i, v, 0);
		}
	}
	const len = seconds * 1.1;
	const start = Math.round(t0 * SR);
	const stop = Math.min(N, Math.round((t0 + len) * SR));
	let phase = 0;
	for (let i = start; i < stop; i += 1) {
		const t = i / SR - t0;
		phase += 2 * Math.PI * hz / 2 / SR;
		const v = Math.sin(phase) * peak * 0.3 * Math.pow(0.0005, t / len);
		bus.addAt(i, v, 0);
	}
	burst(0, { t0, len: 0.07, hz: Math.min(hz * 9, 5200), q: 1.4, amp: peak * 0.3, wetSend: 0 });
}

/** The two current beds. */
function legacyBed(kind, dry) {
	bed(0, {
		bands: kind === "foley"
			? [{ hz: dry ? 3400 : 2600, q: dry ? 1.1 : 0.6, mix: dry ? 1 : 0.8 },
				{ hz: dry ? 1000 : 780, q: 0.45, mix: dry ? 0.3 : 0.5 }]
			: [{ hz: dry ? 900 : 620, q: 0.35, mix: 1 }],
		peak: kind === "foley" ? 0.3 : 0.12,
		floor: 0,
		tauA: 0.05,
		tauR: 0.05,
		wetSend: 0,
		tilt: [0.7, 1.3],
		followTicks: TICKS,
	});
}

/** client.js #burst cue, as the recipes call it. */
function legacyCueBurst(t0, q, hz, seconds, peak) {
	burst(0, { t0, len: seconds, hz, q, amp: peak, wetSend: 0 });
}

const LEGACY = {
	"paper": () => {
		legacyBed("foley", false);
		legacyCueBurst(atMark(0.02), 0.8, 3200, 0.05, 0.34);
		legacyCueBurst(atMark(0.55), 0.8, 2400, 0.09, 0.42);
		legacyCueBurst(atMark(0.97), 1.2, 1700, 0.13, 0.26);
	},
	"guqin": () => {
		legacyBed("brush", false);
		legacyGuqin(atMark(0.02), 146.83, 2.6, 0.6);
		// hero artwork: a blade's shimmer
		legacyCueBurst(atMark(0.34), 14, 5200, 0.6, 0.4);
		legacyGuqin(atMark(0.86), 293.66, 2.2, 0.5);
		legacyBell(atMark(0.93), 523.25, 3.4, 0.5);
	},
	"bed": () => {
		legacyBell(atMark(0.05), 196.0, 5.2, 0.46);
		legacyBell(atMark(0.4), 293.66, 4.4, 0.4);
		legacyBell(atMark(0.75), 392.0, 3.8, 0.36);
	},
};

/* ------------------------------------------------------------ new voices */

/**
 * 「琴」 — the guqin voice: the open string at the drop of the ink, a harmonic
 * while the brush travels, one 走手 slide in the turn, and one stone chime
 * left ringing. D throughout, with A only as the answering fifth.
 */
function newGuqin() {
	// a barely-there draught, so the silence is not a vacuum
	bed(0.4, {
		bands: [{ type: "lowpass", hz: 240, q: 0.5, mix: 1 }],
		peak: 0.040,
		floor: 0.40,
		tauA: 0.26,
		tauR: 0.42,
		wetSend: 0.4,
		tilt: [0.95, 1.15],
		followTicks: TICKS,
	});

	// 散音 D4 with D3 riding under it — the ink touching the paper
	pluckNote(atMark(0.02), 293.66, {
		amp: 0.20, rt60: 3.0, pan: -0.13, wet: 0.45, attack: 0.008,
		brightness: 0.72, sub: 0.45, finger: 0.5,
	});
	// 泛音 D5 — the brush travelling: glass-clear, placed high and right
	pluckNote(atMark(0.42), 587.33, {
		amp: 0.085, rt60: 1.6, pan: 0.30, wet: 0.55, attack: 0.004,
		brightness: 0.30, sub: 0, finger: 0.16, harmonic: true,
	});
	// 按音 A3 -> B3: the finger walking the string, the signature guqin gesture
	pluckNote(atMark(0.66), 220.0, {
		amp: 0.13, rt60: 2.4, pan: 0.10, wet: 0.44, attack: 0.006,
		glideTo: 246.94, glide: 0.60, brightness: 0.85, sub: 0.18, finger: 0.42,
	});
	// 磬 D4 — the last drop of ink, left ringing
	chime(atMark(0.90), 293.66, { amp: 0.100, rt60: 3.4, pan: 0.16, wet: 0.62 });
}

/** A guqin pluck: stretched partials, a sub-octave, and a finger attack. */
function pluckNote(t0, hz, o) {
	const {
		amp, rt60, pan, wet, attack, brightness = 1, sub = 0.2, finger = 0.4,
		glideTo, glide = 0, harmonic = false,
	} = o;
	const B = harmonic === true ? 0.00008 : 0.00035;
	const count = harmonic === true ? 3 : 7;
	for (let n = 1; n <= count; n += 1) {
		const f = hz * n * Math.sqrt(1 + B * n * n);
		const a = amp * (harmonic === true ? (n === 1 ? 1 : 0.10 / n) : Math.pow(n, -1.25 * brightness));
		const len = rt60 * (harmonic === true ? 1 : 1 / (1 + 0.30 * (n - 1)));
		partial(bus, wet, {
			t0, len, ratio: f, amp: a, rt60: len, attack,
			pan, from: glideTo === undefined ? undefined : f,
			to: glideTo === undefined ? undefined : f * (glideTo / hz),
			glide, phase0: (n * 1.3) % (2 * Math.PI),
			vibHz: glideTo !== undefined ? 4.4 : 0, vibCents: glideTo !== undefined ? 6 : 0,
		});
	}
	if (sub > 0) {
		partial(bus, wet, {
			t0, len: rt60 * 1.15, ratio: hz / 2, amp: amp * sub, rt60: rt60 * 1.15,
			attack, pan, phase0: 0.7,
		});
	}
	if (finger > 0) {
		burst(wet, {
			t0, len: 0.075, hz: Math.min(hz * 8, 4800), hzTo: Math.min(hz * 3.5, 2400), q: 1.3,
			amp: amp * finger * 0.22, attack: 0.003, pan, wetSend: 0.35,
		});
	}
}

/** A chime: a fundamental with two faint, slightly stretched companions. */
function chime(t0, hz, o) {
	const { amp, rt60, pan, wet } = o;
	for (const [ratio, a, k] of [[1, 1, 1], [2.76, 0.16, 0.55], [5.4, 0.05, 0.35]]) {
		partial(bus, wet, {
			t0, len: rt60 * k, ratio: hz * ratio, amp: amp * a, rt60: rt60 * k,
			attack: 0.002, pan, phase0: (ratio * 2.1) % (2 * Math.PI),
		});
	}
}

/**
 * 「空山」 — the ambient voice: a xiao over a whisper of a drone, water, and
 * two chimes far away. Sparse on purpose; the rests are the instrument.
 */
function newBed() {
	// 山谷 drone: D2 and its octave, entering under the first frame — a whisper
	for (const [f, a] of [[73.42, 1], [146.83, 0.34], [220.0, 0.10]]) {
		const attack = 1.7;
		const release = DUR + 1.3;
		let phase = 0;
		for (let i = 0; i < N; i += 1) {
			const t = i / SR;
			phase += 2 * Math.PI * f / SR;
			const rise = 1 - Math.exp(-t / attack);
			const fall = t < release ? 1 : Math.exp(-(t - release) / 1.1);
			const v = Math.sin(phase) * a * rise * fall * 0.010;
			bus.addAt(i, v, 0);
			wetBus.addAt(i, v * 0.4, 0);
		}
	}
	// 箫 A3, then D3: two breathy notes, the second answering a fourth below
	xiao(atMark(0.04), 220.0, { amp: 0.25, rt60: 2.2, pan: 0.06, wet: 0.5 });
	xiao(atMark(0.40), 146.83, { amp: 0.21, rt60: 2.4, pan: -0.20, wet: 0.5 });
	// 水滴 two, high and tiny
	drip(atMark(0.66), 1046.5, { amp: 0.05, pan: 0.32 });
	drip(atMark(0.70), 1568.0, { amp: 0.032, pan: -0.26, delay: 0.09 });
	// 磬 A4, distant; 低磬 D3 — the mountain answers
	chime(atMark(0.86), 440.0, { amp: 0.115, rt60: 3.0, pan: 0.24, wet: 0.62 });
	chime(atMark(0.95), 146.83, { amp: 0.105, rt60: 3.6, pan: -0.10, wet: 0.6 });
}

/** A xiao note: a hollow sine, breath above it, a slow attack. */
function xiao(t0, hz, o) {
	const { amp, rt60, pan, wet } = o;
	partial(bus, wet, {
		t0, len: rt60, ratio: hz, amp, rt60, attack: 0.16, pan, phase0: 1.1,
		vibHz: 4.2, vibCents: 7,
	});
	partial(bus, wet, {
		t0, len: rt60 * 0.6, ratio: hz * 2, amp: amp * 0.13, rt60: rt60 * 0.6, attack: 0.2, pan, phase0: 2.4,
	});
	// breath: noise around the third harmonic, plus a wide soft band up top
	burst(wet, {
		t0, len: rt60 * 0.85, hz: hz * 3, hzTo: hz * 2.4, q: 2.2, amp: amp * 0.30,
		attack: 0.14, pan, wetSend: 0.45,
	});
	burst(wet, {
		t0, len: rt60 * 0.7, hz: 3200, hzTo: 2600, q: 0.65, amp: amp * 0.10,
		attack: 0.22, pan, wetSend: 0.5,
	});
}

/** A water drop: a short rising sine, which is what makes it read as water. */
function drip(t0, hz, o) {
	const { amp, pan, delay = 0 } = o;
	const at = t0 + delay;
	partial(bus, 0.5, {
		t0: at, len: 0.14, ratio: hz, amp, rt60: 0.12, attack: 0.002, pan,
		from: hz * 0.55, to: hz, glide: 0.035,
	});
	burst(0.5, { t0: at, len: 0.012, hz: hz * 2.2, q: 3, amp: amp * 0.5, attack: 0.001, pan, wetSend: 0.3 });
}

/**
 * 「墨韵」 — the blend: the open string when the ink lands, the xiao answering
 * from the valley, one drop of water, one chime to close. No friction bed at
 * all — the stroke is carried by the notes and the drone, not by air.
 */
function newInk() {
	for (const [f, a] of [[73.42, 1], [220.0, 0.28]]) {
		const attack = 1.4;
		const release = DUR + 1.3;
		let phase = 0;
		for (let i = 0; i < N; i += 1) {
			const t = i / SR;
			phase += 2 * Math.PI * f / SR;
			const rise = 1 - Math.exp(-t / attack);
			const fall = t < release ? 1 : Math.exp(-(t - release) / 1.1);
			const v = Math.sin(phase) * a * rise * fall * 0.010;
			bus.addAt(i, v, 0);
			wetBus.addAt(i, v * 0.4, 0);
		}
	}
	// 落墨：the string, while the first ink lands
	pluckNote(atMark(0.03), 146.83, {
		amp: 0.19, rt60: 3.2, pan: -0.12, wet: 0.45, attack: 0.008, brightness: 0.85, sub: 0.16, finger: 0.4,
	});
	// 箫 A3 — the valley answering
	xiao(atMark(0.32), 220.0, { amp: 0.14, rt60: 2.2, pan: 0.16, wet: 0.55 });
	// 走手 D4 -> E4
	pluckNote(atMark(0.60), 293.66, {
		amp: 0.17, rt60: 2.6, pan: 0.05, wet: 0.45, attack: 0.006,
		glideTo: 329.63, glide: 0.5, brightness: 0.8, sub: 0.16, finger: 0.4,
	});
	drip(atMark(0.78), 1046.5, { amp: 0.04, pan: 0.3 });
	chime(atMark(0.92), 293.66, { amp: 0.115, rt60: 3.4, pan: 0.18, wet: 0.6 });
}

/* ------------------------------------------------------------------ master */

const bus = new Bus();
const wetBus = new Bus();

/** Reverb impulse: a dark, decorrelated stereo tail with a few early taps. */
function impulse(rt60, predelay, cutoff, seed) {
	const len = Math.round((predelay + rt60 * 1.15) * SR);
	const out = new Float32Array(len);
	const rnd = mulberry32(seed);
	for (let i = 0; i < len; i += 1) {
		const t = i / SR - predelay;
		out[i] = t < 0 ? 0 : (rnd() * 2 - 1) * Math.pow(0.001, t / rt60);
	}
	const low = runBiquad(out, len, () => biquad("lowpass", cutoff, 0.72));
	// a little pre-emphasis on the earliest 120 ms keeps the tail from sounding like fog
	for (let i = 0; i < len; i += 1) {
		const t = i / SR - predelay;
		if (t > 0 && t < 0.12) low[i] *= 1 + 0.6 * (1 - t / 0.12);
	}
	// sparse early reflections, so a transient has somewhere to land
	const taps = [[0.011, 0.55], [0.019, -0.42], [0.027, 0.36], [0.041, -0.28], [0.058, 0.22]];
	for (const [ms, a] of taps) {
		const idx = Math.round((predelay + ms) * SR);
		if (idx < len) low[idx] += a;
		if (idx + 7 < len) low[idx + 7] += a * 0.6;
	}
	let energy = 0;
	for (let i = 0; i < len; i += 1) energy += low[i] * low[i];
	const norm = 1 / Math.sqrt(energy || 1);
	for (let i = 0; i < len; i += 1) low[i] *= norm;
	return low;
}

const IR_L = impulse(2.9, 0.035, 3100, 0x1f3d);
const IR_R = impulse(2.9, 0.039, 2900, 0x9c41);

function finish(name, gain = 1) {
	// wet return is fixed; a recipe decides how much it sends
	const wetL = convolve(wetBus.L.length === N ? wetBus.L : wetBus.L.subarray(0, N), IR_L);
	const wetR = convolve(wetBus.R.length === N ? wetBus.R : wetBus.R.subarray(0, N), IR_R);

	const outL = new Float32Array(N);
	const outR = new Float32Array(N);
	const WET = 0.30;
	for (let i = 0; i < N; i += 1) {
		outL[i] = (bus.L[i] + (wetL[i] ?? 0) * WET) * LEVEL * gain;
		outR[i] = (bus.R[i] + (wetR[i] ?? 0) * WET) * LEVEL * gain;
	}

	// the app's ceiling: threshold -12, knee 8, ratio 4, attack 4 ms, release 180 ms
	const thrDb = -12;
	const kneeDb = 8;
	const ratio = 4;
	const aA = 1 - Math.exp(-1 / (0.004 * SR));
	const aR = 1 - Math.exp(-1 / (0.18 * SR));
	let env = 0;
	for (let i = 0; i < N; i += 1) {
		const peak = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
		env += (peak > env ? aA : aR) * (peak - env);
		let grDb = 0;
		const overDb = 20 * Math.log10(Math.max(env, 1e-9)) - thrDb;
		if (overDb > 0) {
			grDb = (1 - 1 / ratio)
				* (overDb < kneeDb ? (overDb * overDb) / (2 * kneeDb) : overDb - kneeDb / 2);
		}
		const gain = Math.pow(10, -grDb / 20);
		outL[i] *= gain;
		outR[i] *= gain;
	}

	let peak = 0;
	let sum = 0;
	for (let i = 0; i < N; i += 1) {
		peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
		sum += outL[i] * outL[i] + outR[i] * outR[i];
	}
	const rms = Math.sqrt(sum / (2 * N));
	const db = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x));

	// 5 ms fades so nothing starts or stops with a step
	const fade = Math.round(0.005 * SR);
	for (let i = 0; i < fade; i += 1) {
		const k = i / fade;
		outL[i] *= k; outR[i] *= k;
		outL[N - 1 - i] *= k; outR[N - 1 - i] *= k;
	}

	// Audition normalisation by loudness, not by peak: a dense noise bed has a
	// higher crest factor than a plucked string, and equal peaks would make the
	// paper read twice as loud as the guqin. The 95th percentile of 200 ms RMS
	// is the stand-in for "how loud this feels"; peaks are kept under -1 dBFS.
	const win = Math.round(0.2 * SR);
	const loud = [];
	for (let s = 0; s + win <= N; s += win) {
		let e = 0;
		for (let i = s; i < s + win; i += 1) e += outL[i] * outL[i] + outR[i] * outR[i];
		loud.push(Math.sqrt(e / (2 * win)));
	}
	loud.sort((a, b) => a - b);
	const l95 = loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.95))] || 1e-9;
	let normDb = -18 - db(l95);
	if (db(peak) + normDb > -1) normDb = -1 - db(peak);
	const norm = Math.pow(10, normDb / 20);
	const peakL = new Int16Array(N);
	const peakR = new Int16Array(N);
	for (let i = 0; i < N; i += 1) {
		peakL[i] = Math.max(-32768, Math.min(32767, Math.round(outL[i] * norm * 32767)));
		peakR[i] = Math.max(-32768, Math.min(32767, Math.round(outR[i] * norm * 32767)));
	}

	mkdirSync(OUT, { recursive: true });
	const path = join(OUT, name + ".wav");
	writeFileSync(path, wav(peakL, peakR));
	const spec = spectrum(outL, outR);
	console.log(
		`${name.padEnd(28)} peak ${db(peak).toFixed(1).padStart(6)} dB  rms ${db(rms).toFixed(1).padStart(6)} dB` +
		`  L95 ${db(l95).toFixed(1).padStart(6)}  +${normDb.toFixed(1)} dB   bands ${spec}`,
	);
	return { path, peak: db(peak), rms: db(rms) };
}

/** Band energy of the first five seconds, as a share of the total. */
function spectrum(L, R) {
	const size = 1 << 18;
									const skip = Math.round(0.2 * SR);
	const re = new Float64Array(size); const im = new Float64Array(size);
	const step = 3; // decimate: the ears care about bands, not the top octave
	const n = Math.min(size * step, N - skip);
	for (let i = 0; i < n; i += step) {
		const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
		re[i / step] = ((L[skip + i] + R[skip + i]) / 2) * w;
	}
	fft(re, im, false);
	const edges = [0, 120, 400, 1200, 3000, 6500, SR / 2];
	const sums = edges.slice(0, -1).map(() => 0);
	const binHz = (SR / step) / size;
	for (let b = 1; b < size / 2; b += 1) {
		const hz = b * binHz;
		const e = re[b] * re[b] + im[b] * im[b];
		for (let k = 0; k < sums.length; k += 1) {
			if (hz >= edges[k] && hz < edges[k + 1]) { sums[k] += e; break; }
		}
	}
	const total = sums.reduce((a, b) => a + b, 0) || 1;
	const labels = ["<120", "120-400", "400-1k2", "1k2-3k", "3k-6k5", ">6k5"];
	return labels.map((l, k) => `${l} ${(sums[k] / total * 100).toFixed(0)}%`).join(" · ");
}

function wav(L, R) {
	const bytes = 44 + L.length * 4;
	const b = Buffer.alloc(bytes);
	b.write("RIFF", 0); b.writeUInt32LE(bytes - 8, 4); b.write("WAVE", 8);
	b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
	b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
	b.write("data", 36); b.writeUInt32LE(L.length * 4, 40);
	for (let i = 0; i < L.length; i += 1) {
		b.writeInt16LE(L[i], 44 + i * 4);
		b.writeInt16LE(R[i], 44 + i * 4 + 2);
	}
	return b;
}

/* -------------------------------------------------------------------- main */

const SETS = {
	legacy: [
		["旧-纸墨", LEGACY.paper, 1],
		["旧-古琴", LEGACY.guqin, 1],
		["旧-空山", LEGACY.bed, 1],
	],
	current: [
		["新-古琴（琴）", newGuqin, 2.9],
		["新-空山（箫与水）", newBed, 5.2],
		["新-墨韵（综合）", newInk, 3.2],
	],
};

const which = process.argv[2] ?? "all";
const picked = which === "all" ? [...SETS.current, ...SETS.legacy] : (SETS[which] ?? SETS.current);
for (const [name, fn, gain] of picked) {
	// reset the buses per file
	bus.L.fill(0); bus.R.fill(0); wetBus.L.fill(0); wetBus.R.fill(0);
	fn();
	finish(name, gain);
}
