import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const path = "D:/5/新建文件夹/plugins/dsh-ink-splash/lib/client.js";
const src = readFileSync(path, "utf8");
const from = src.indexOf("const VOICES = ");
const to = src.indexOf("//#region component 1 · InkSplash");
if (from < 0 || to < 0) throw new Error("cannot slice the audio section");
const body = src.slice(from, to);

class Param {
	constructor(v) {
		this.value = v;
	}
	check(v, t) {
		if (!Number.isFinite(v)) throw new Error("non-finite value");
		if (!Number.isFinite(t) || t < 0) throw new Error("bad time " + t);
	}
	setValueAtTime(v, t) {
		this.check(v, t);
		return this;
	}
	linearRampToValueAtTime(v, t) {
		this.check(v, t);
		return this;
	}
	exponentialRampToValueAtTime(v, t) {
		this.check(v, t);
		if (!(v > 0)) throw new Error("exponential ramp to " + v);
		return this;
	}
	setTargetAtTime(v, t, tau) {
		this.check(v, t);
		if (!(tau > 0)) throw new Error("bad tau " + tau);
		return this;
	}
}

class Node {
	constructor(kind) {
		this.kind = kind;
	}
	connect(next) {
		if (next === undefined || next === null) throw new Error(this.kind + " connected to nothing");
		return next;
	}
	disconnect() {}
}

const count = { osc: 0, src: 0, gain: 0, filter: 0, pan: 0, conv: 0 };

const ctx = {
	currentTime: 0,
	sampleRate: 48000,
	state: "running",
	destination: new Node("destination"),
	createGain() {
		count.gain += 1;
		const n = new Node("gain");
		n.gain = new Param(1);
		return n;
	},
	createOscillator() {
		count.osc += 1;
		const n = new Node("osc");
		n.type = "sine";
		n.frequency = new Param(440);
		n.detune = new Param(0);
		n.start = (t) => {
			if (!Number.isFinite(t) || t < 0) throw new Error("osc start " + t);
		};
		n.stop = (t) => {
			if (!Number.isFinite(t) || t < 0) throw new Error("osc stop " + t);
		};
		return n;
	},
	createBufferSource() {
		count.src += 1;
		const n = new Node("src");
		n.loop = false;
		n.buffer = undefined;
		n.start = (t, off) => {
			if (!Number.isFinite(t) || t < 0) throw new Error("src start " + t);
			if (off !== undefined && (!Number.isFinite(off) || off < 0)) throw new Error("src offset " + off);
		};
		n.stop = (t) => {
			if (!Number.isFinite(t) || t < 0) throw new Error("src stop " + t);
		};
		return n;
	},
	createBiquadFilter() {
		count.filter += 1;
		const n = new Node("filter");
		n.type = "lowpass";
		n.frequency = new Param(350);
		n.Q = new Param(1);
		n.gain = new Param(0);
		return n;
	},
	createStereoPanner() {
		count.pan += 1;
		const n = new Node("pan");
		n.pan = new Param(0);
		return n;
	},
	createConvolver() {
		count.conv += 1;
		const n = new Node("conv");
		n.normalize = true;
		n.buffer = undefined;
		return n;
	},
	createAnalyser() {
		const n = new Node("analyser");
		n.fftSize = 2048;
		n.getFloatTimeDomainData = (arr) => {
			for (let i = 0; i < arr.length; i += 1) arr[i] = Math.random() * 0.2 - 0.1;
		};
		return n;
	},
	createDynamicsCompressor() {
		const n = new Node("comp");
		for (const k of ["threshold", "knee", "ratio", "attack", "release"]) n[k] = new Param(1);
		return n;
	},
	createBuffer(channels, length, rate) {
		const data = [];
		for (let c = 0; c < channels; c += 1) data.push(new Float32Array(Math.max(length, 0)));
		return {
			numberOfChannels: channels,
			length,
			sampleRate: rate,
			duration: length / rate,
			getChannelData: (c) => {
				if (c < 0 || c >= channels) throw new Error("channel " + c);
				return data[c];
			},
		};
	},
	async resume() {},
	async close() {
		this.state = "closed";
	},
};

const factory = new Function("window", body + "; return InkAudio;");
const pending = [];
const InkAudio = factory({
	AudioContext: function AudioContext() {
		return ctx;
	},
	// `#armRoom` defers the impulse to a timer; here the timer is run by hand so the two
	// halves of open() can be timed apart.
	setTimeout: (fn) => {
		pending.push(fn);
		return 0;
	},
});

function eased(x) {
	const EASE = [0.5, 0, 0.5, 1];
	const [x1, y1, x2, y2] = EASE;
	let t = x;
	for (let i = 0; i < 8; i += 1) {
		const cx = 3 * x1;
		const bx = 3 * (x2 - x1) - cx;
		const ax = 1 - cx - bx;
		const cy = 3 * y1;
		const by = 3 * (y2 - y1) - cy;
		const ay = 1 - cy - by;
		const f = ((ax * t + bx) * t + cx) * t;
		if (Math.abs(f - x) < 1e-6) break;
		const df = (3 * ax * t + 2 * bx) * t + cx;
		if (Math.abs(df) < 1e-6) break;
		t = Math.max(0, Math.min(1, t - (f - x) / df));
	}
	const mt = 1 - t;
	return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

function ticks(duration) {
	const list = [];
	const step = 125;
	let prev = 0;
	for (let t = 0; t <= 8800; t += step) {
		const ratio = Math.max(0, Math.min(1, t / duration));
		const visual = eased(ratio);
		const dv = Math.max(0, visual - prev);
		prev = visual;
		list.push({ t: t / 1000, visual, dv });
	}
	return list;
}

async function main() {
	for (const voice of ["paper", "guqin", "bed"]) {
		// The mock context is shared between iterations, so `close()` from the last voice
		// would leave this one staring at a closed context; each voice gets it back.
		ctx.state = "running";
		pending.length = 0;
		const audio = new InkAudio({ voice, volume: 45, duration: 2600, wordmark: "wet", artwork: "hero" });
		const started = performance.now();
		await audio.open();
		const opened = performance.now();
		// The impulse build, on the timer `#armRoom` handed off.
		pending.splice(0).forEach((fn) => fn());
		const armed = performance.now();
		const list = ticks(2600);
		audio.start();
		let fired = 0;
		for (const tick of list) {
			ctx.currentTime = tick.t;
			audio.front(tick.visual, tick.dv, 125);
			audio.observe();
			const before = audio.fired.size;
			audio.cue(tick.visual);
			fired += audio.fired.size - before;
		}
		audio.close();
		const done = performance.now();
		console.log(
			voice.padEnd(6),
			"marks", String(fired).padEnd(2),
			"| open", (opened - started).toFixed(1) + "ms (boot path)",
			"| room", (armed - opened).toFixed(1) + "ms (deferred)",
			"| ticks", (done - armed).toFixed(1) + "ms",
			"| state", audio.state,
			"| level", audio.level.toFixed(3),
			"| roomBuffer", audio.room?.buffer === undefined ? "missing" : "built",
		);
		ctx.currentTime = 0;
	}
	console.log("nodes", JSON.stringify(count));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
