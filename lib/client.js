/**
 * Browser half of `dsh-ink-splash` — one package, three components.
 *
 *   1. `InkSplash`   — the visuals. Plain DOM, no React: it has to be mountable
 *                      while the kernel's framework-free boot page is still on
 *                      screen. Everything in the frame reads one custom
 *                      property (`--dsh-ink-p`); brush, motion and artwork are
 *                      three independent axes over that single front, so any
 *                      combination stays in step.
 *   2. `InkSplashSettings` — the Settings sub-page: the three axes, sound,
 *                      replay length, a replay that runs the same component the
 *                      boot path runs, and the measured autoplay verdict.
 *   3. `InkAudio`    — the instrument. Synthesised, no audio files, and driven
 *                      by the same front the brush travels along, so what you
 *                      hear is the stroke you see rather than a generic whoosh.
 *
 * The three live in one self-contained chunk because the client module system
 * serves self-contained chunks only (`@deepseek-ai/dsh-client-modules` README:
 * relative file imports have no resolver) — not because they are one concern.
 *
 * @module dsh-ink-splash/client
 */

window.__ModuleLoader__.load({
	id: "dsh-ink-splash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Button, SegmentedControl, Switch } = primitives;
		const { createElement: h, useEffect, useState } = React;

		const NS = "ink-splash";
		const PKG = "dsh-ink-splash";
		/** Mirrored so the next boot can read the choice before the config is served. */
		const CACHE_KEY = "dsh-ink-splash:config";

		/** The reveal's curve: the same four numbers the stylesheet puts on the curtain,
		 * the front, the stroke and the bead. The friction and the brush are one gesture,
		 * so the audio has to run this curve too — a linear sound over an eased stroke
		 * would be loudest exactly where the ink is slowest. Two copies of a formula that
		 * cannot import each other, so test/splash.node.mjs compares them. */
		const EASE = [0.5, 0, 0.5, 1];
		function eased(x) {
			if (!(x > 0)) return 0;
			if (x >= 1) return 1;
			const x1 = EASE[0];
			const y1 = EASE[1];
			const x2 = EASE[2];
			const y2 = EASE[3];
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

		const WORDMARKS = ["wet", "dry"];
		const BACKGROUNDS = ["sweep", "rise", "bloom"];
		const ARTWORKS = ["hero", "whale"];
		/**
		 * The three sound recipes, all of them 古风 now: 墨韵 (the blend), 古琴 (one
		 * guqin phrase), 空山 (a xiao over a drone). Every one is notes, water and a
		 * shared room — no friction layer, which is what the old 纸墨 recipe was.
		 *
		 * The key `paper` is historical: it used to name that friction recipe and the
		 * id is the value saved in existing profiles, so the key stays and only its
		 * content changed. Its label in the settings page is 墨韵.
		 *
		 * `trim` is each recipe's own master attenuation, applied before the limiter —
		 * the level it was auditioned at. The amplitudes in `#play` are the numbers the
		 * offline render used, so the WAV you heard and the splash agree.
		 */
		const VOICES = ["paper", "guqin", "bed"];
		const VOICE_SPECS = {
			/** 墨韵 — the open string, the xiao answering, one drop, one chime, a drone. */
			paper: {
				trim: 3.2,
				drone: [[73.42, 1], [220.0, 0.28]],
				marks: { stringInk: 0.03, xiaoInk: 0.32, walk4: 0.60, dripInk: 0.78, bellInk: 0.92 },
			},
			/**
			 * 古琴 — one phrase: the open string as the ink lands, a harmonic while the
			 * brush travels, a 走手 slide in the turn, one stone chime left ringing.
			 * The only voice that keeps a bed, and it is a draught, not a hiss: noise
			 * under a 240 Hz low pass, following the brush.
			 */
			guqin: {
				trim: 2.9,
				bed: { lowpass: 240, peak: 0.040, floor: 0.40, tauA: 0.26, send: 0.16, tilt: [0.95, 1.15] },
				marks: { stringQin: 0.02, harmonic: 0.42, walk3: 0.66, bellQin: 0.90 },
			},
			/** 空山 — xiao twice, two drops of water, two chimes far off, a drone under it. */
			bed: {
				trim: 5.2,
				drone: [[73.42, 1], [146.83, 0.34], [220.0, 0.10]],
				marks: { xiaoHi: 0.04, xiaoLo: 0.40, drip1: 0.66, drip2: 0.70, bellHi: 0.86, bellLo: 0.95 },
			},
		};
		const DEFAULTS = {
			enabled: true,
			wordmark: "wet",
			background: "sweep",
			artwork: "hero",
			voice: "guqin",
			sound: true,
			volume: 45,
			duration: 2600,
			wallLight: 100,
		};

		const EXIT_MS = 460;
		const WATCHDOG_MS = 8000;
		/** How long a still arc counts as "loading is over". */
		const PLATEAU_MS = 700;
		/** How far the clock may outrun real loading before the picture is frozen. */
		const HOLD_EPS = 0.02;
		/** How far the clock must have moved for the stroke to count as started: past this,
		 * freezing is off the table, because a pause snaps the compositor back. Below it the
		 * picture is still at its opening state, so a freeze costs nothing you can see. */
		const BEGAN_EPS = 0.05;
		/** How long the brush waits for the application to paint before starting anyway.
		 * Bounded on purpose: a splash that waits on someone else's paint schedule is
		 * otherwise the thing that traps the user. */
		const MOUNT_WAIT_MS = 2600;
		/** How often the clock and the kernel arc are read; the arc moves ~once per entry. */
		const ARC_POLL_MS = 125;
		/** How long the main thread must have been quiet before the brush is let move. The
		 * boot's long frames are ~900 ms each on this box, and a stroke that starts inside
		 * that storm gets its composited animations re-committed backwards when the layer
		 * tree settles — the rollback. Traced over CDP: every one of the 324 dropped frames
		 * in a boot lands in the 3-6 s window, and the stroke starting at ~5 s overlaps the
		 * tail of it, which is what still reads as a hitch. One long frame plus margin is
		 * the shortest wait that cannot be interrupted by the next one arriving. */
		const QUIET_MS = 1100;
		/** …and for how long that gate may hold the brush at all. Bounded on purpose: a
		 * splash that waits on someone else's paint schedule is otherwise the thing that
		 * traps the user behind a sheet of paper. The bound is half the stroke's own length,
		 * because the updated app boots in 5.5 s with long frames spread across all of it:
		 * a fixed 3 s cap let the wait eat the whole animation, and the receipt showed the
		 * clock frozen at 0.00 → 0.05 while the paper just sat there. */
		const QUIET_DEADLINE_MS = 3000;
		const QUIET_DEADLINE_SHARE = 0.5;
		/** The kernel's own arc: 72deg with nothing loaded, 288deg when all entries are active. */
		const ARC_MIN = 72;
		const ARC_MAX = 288;

		//#region shared styles

		function insertStyles(tagId, text) {
			if (typeof document === "undefined") return;
			const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (existing !== null) {
				if (existing.textContent !== text) existing.textContent = text;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = PKG;
			tag.dataset.pluginCss = tagId;
			tag.textContent = text;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region component 3 · InkAudio
		/**
		 * The instrument. Nothing here is a sample: every voice is oscillators plus one
		 * reused noise buffer, because synthesis measured cheaper than shipping files
		 * (0.69 ms to arm) and because the timing has to follow the front.
		 *
		 * Timbre parameters come from published instrument acoustics, not from my taste:
		 * the bell uses the seven classical partials at their measured ratios, with the
		 * energy peaking at the fourth partial and the hum outlasting the nominal; the
		 * guqin uses inharmonic partials, a sub-octave phantom partial and a friction-noise
		 * attack; the brush is two bands, because one band near 700Hz is what made two
		 * recipes sound identical.
		 */
		//#region the warp engine — the painting moves, and is never repainted
		/**
		 * The rules this engine exists to satisfy, all three measured rather than asserted:
		 *
		 * - **No new bytes.** The field is computed in the shader from the shipped painting
		 *   itself, so there is no mask, no sprite, no clip: the engine's whole storage cost
		 *   is the source below, inside a file the package already carries.
		 * - **No seams, ever.** Time enters only as integer multiples of one base phase, so
		 *   the field is periodic — the loop cannot show a joint, which is the thing the
		 *   4.042 s clips could not do (their first and last frames differ by mean |dL| 12-17).
		 * - **No dropped frames, guaranteed by construction.** The engine watches its own
		 *   cost — the main-thread time of each draw and the interval between animation
		 *   frames — and answers by drawing less often: 30, then 20, then 12 fps. The last
		 *   tier is a floor, not an exit; the painting never stops because the machine is
		 *   busy. What bounds the whole exposure is the splash itself: the engine is created
		 *   with the frame and destroyed when the frame goes, so the worst case on the
		 *   weakest machine is a few seconds of a 12 fps drift, and the count is reported.
		 *
		 * The displacement is scaled by how *soft* the picture is at that pixel — a gradient
		 * measured from the texture, four extra taps — so open wash drifts while a stroke
		 * edge, a rock, a pine needle or the moon's rim does not move at all. That is what
		 * the two rejected cut-out attempts were missing: nothing here is lifted off the
		 * painting, so there is no edge to tear and no hole to fill.
		 */
		const WARP = {
			/** One full cycle, in ms. Periodic, so the loop point is not a special moment. */
			loop: 8000,
			/** ms between draws at the top rate: 30 fps, which is plenty for a slow drift. */
			budget: 33,
			/** Slower tiers, tried in order. The last one is a floor, not an exit: at 12 fps a
			 * drift this slow is still a living picture, and the painting does not get to stop
			 * because the machine is busy — it only ever gets to move less often. */
			tiers: [33, 50, 83],
			/** Displacement at full strength, in picture pixels of the 1120x640 source. */
			amp: 2.6,
			/** ms over which the amplitude and the opacity come up, so the swap is invisible. */
			ramp: 700,
			/** How much harder the drift pulls once it has taken over from the clip. */
			tailAmp: 5,
			/** One draw may cost this much main-thread time before it is counted, and reported.
			 * Measured on a real boot the submit time sits under 1 ms and spikes to 2.7 when
			 * the plugin loader holds the thread — which the gap rule already catches, so this is
			 * deliberately not the tight trigger. */
			maxDrawMs: 4,
			/** An animation frame slower than this is counted — but only when nobody else
			 * held the thread, see `blocked`. */
			maxGapMs: 40,
			/** How many consecutive unexplained slow frames cost a tier. One spike during the
			 * boot's own 900 ms long frames must not spend the whole splash at the floor. */
			run: 3,
			/** Draws at a clean cadence that buy a tier back. Without this the ladder is a
			 * ratchet, and a single bad moment decides the rest of the stroke. */
			cleanUp: 24,
			/** A long animation frame younger than this explains a slow tick away from us. */
			blockWindowMs: 250,
		};

		const WARP_VS = "attribute vec2 p; varying vec2 uv;"
			+ "void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }";

		const WARP_FS = [
			"precision highp float;",
			"varying vec2 uv;",
			"uniform sampler2D tex;",
			"uniform float uAmp;",
			"uniform float uPhase;",
			"uniform vec2 uTexel;",
			"uniform vec2 uOrigin;",
			"float lum(vec2 at){ return dot(texture2D(tex, at).rgb, vec3(0.2126, 0.7152, 0.0722)); }",
			/* 1 in open wash, 0 on a stroke edge: the field dies where the drawing is. */
			"float softness(vec2 at){",
			"  float gx = abs(lum(at + vec2(uTexel.x, 0.0)) - lum(at - vec2(uTexel.x, 0.0)));",
			"  float gy = abs(lum(at + vec2(0.0, uTexel.y)) - lum(at - vec2(0.0, uTexel.y)));",
			"  return 1.0 - smoothstep(0.02, 0.16, (gx + gy) * 0.5);",
			"}",
			"void main(){",
			"  vec2 q = (uv - uOrigin) * 6.2831853;",
			"  float t = uPhase * 6.2831853;",
			"  float fx = sin(q.y + t) * 0.55 + sin(2.0 * q.y - 2.0 * t + 1.3) * 0.30 + sin(q.x + q.y + 3.0 * t) * 0.15;",
			"  float fy = cos(q.x - t) * 0.45 + cos(2.0 * q.x + 2.0 * t - 0.7) * 0.25 + sin(2.0 * q.y - 3.0 * t) * 0.30;",
			"  float low = smoothstep(0.15, 0.85, uv.y);",
			"  vec2 d = vec2(fx, fy) * uAmp * softness(uv) * (0.45 + 0.55 * low) * uTexel;",
			"  gl_FragColor = texture2D(tex, uv + d);",
			"}",
		].join("\n");

		class InkWarp {
			constructor(root, image, longAt) {
				this.root = root;
				this.src = image;
				this.longAt = longAt;
				this.canvas = undefined;
				this.gl = undefined;
				/* The measured box, and the resize hook that invalidates it. Read from the
				 * draw loop it would be a forced layout thirty times a second. */
				this.box = undefined;
				this.onResize = undefined;
				this.timer = undefined;
				this.tier = 0;
				this.phase = 0;
				this.last = 0;
				this.lastDraw = 0;
				this.startedAt = 0;
				this.frames = 0;
				this.strikes = 0;
				this.bad = 0;
				this.blamed = 0;
				this.clean = 0;
				this.worstDraw = 0;
				this.state = "queued";
				this.reason = "";
			}

			/** The one question that decides everything else: is there a GPU path at all? */
			static available() {
				if (typeof document === "undefined" || typeof window === "undefined") return false;
				if (window.matchMedia("(prefers-reduced-motion: reduce)").matches === true) return false;
				try {
					const probe = document.createElement("canvas");
					return (probe.getContext("webgl2") || probe.getContext("webgl")) !== null;
				} catch (error) {
					return false;
				}
			}

			/** @returns false when the machine refused the job, which is the caller's cue. */
			start() {
				if (InkWarp.available() === false) {
					this.stop("no webgl, or motion is off");
					return false;
				}
				const scene = this.root.querySelector(".dsh-ink-scene");
				if (scene === null) {
					this.stop("no scene layer to copy");
					return false;
				}
				const host = document.createElement("div");
				host.className = "dsh-ink-warp";
				host.setAttribute("aria-hidden", "true");
				const canvas = document.createElement("canvas");
				host.appendChild(canvas);
				/* Right after the scene, under the mist and the curtain: it has to be revealed
				 * by the front, not sit on top of it. */
				scene.insertAdjacentElement("afterend", host);
				const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" })
					|| canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
				if (gl === null) {
					host.remove();
					this.stop("context creation failed");
					return false;
				}
				this.host = host;
				this.canvas = canvas;
				this.gl = gl;
				/* The frame is `fixed; inset: 0`, so its box only moves on a window resize (or a
				 * zoom). `clientWidth` is a forced layout, and paying it inside the draw loop
				 * means paying it inside the application's own boot; the box is measured on
				 * load and re-measured when the event says it may have changed. */
				this.onResize = () => { this.box = undefined; };
				window.addEventListener("resize", this.onResize);
				if (this.build() === false) return false;
				const image = new window.Image();
				this.image = image;
				image.addEventListener("load", () => this.load(image));
				image.addEventListener("error", () => this.stop("the painting would not decode"));
				image.src = this.src;
				return true;
			}

			build() {
				const gl = this.gl;
				const shader = (type, text) => {
					const s = gl.createShader(type);
					gl.shaderSource(s, text);
					gl.compileShader(s);
					return gl.getShaderParameter(s, gl.COMPILE_STATUS) === true ? s : null;
				};
				const vs = shader(gl.VERTEX_SHADER, WARP_VS);
				const fs = shader(gl.FRAGMENT_SHADER, WARP_FS);
				if (vs === null || fs === null) {
					this.stop("shader refused: " + String(gl.getShaderInfoLog(vs === null ? vs : fs)).slice(0, 60));
					return false;
				}
				const prog = gl.createProgram();
				gl.attachShader(prog, vs);
				gl.attachShader(prog, fs);
				gl.linkProgram(prog);
				if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
					this.stop("program refused");
					return false;
				}
				gl.useProgram(prog);
				const buf = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buf);
				/* One triangle that covers the clip space: no index buffer, no vertices to ship. */
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
				const loc = gl.getAttribLocation(prog, "p");
				gl.enableVertexAttribArray(loc);
				gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
				this.u = {
					amp: gl.getUniformLocation(prog, "uAmp"),
					phase: gl.getUniformLocation(prog, "uPhase"),
					texel: gl.getUniformLocation(prog, "uTexel"),
					origin: gl.getUniformLocation(prog, "uOrigin"),
				};
				this.tex = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, this.tex);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				return true;
			}

			/** The texture is uploaded once. Re-uploading per frame would measure the bus. */
			load(image) {
				/* A decode that lands after the frame was torn down: the context is handed
				 * back in `stop()`, and an upload into a released context is an uncaught
				 * error in the renderer — the picture is gone, so the right answer is to
				 * do nothing. `step()` guards the same way. */
				if (this.gl === undefined) return;
				const gl = this.gl;
				this.natural = [image.naturalWidth || 1, image.naturalHeight || 1];
				gl.bindTexture(gl.TEXTURE_2D, this.tex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
				this.state = "ready";
				this.startedAt = performance.now();
				this.last = this.startedAt;
				this.box = undefined;
				this.size();
				this.timer = window.requestAnimationFrame(() => this.step());
			}

			/** One measurement of the box: [css width, css height, dpr, pixels wide, pixels
			 * tall]. It is the only place `clientWidth` / `clientHeight` are read, because
			 * both are forced layouts, and a forced layout belongs to load and to a resize —
			 * never to the draw loop. */
			measure() {
				const dpr = Math.min(2, window.devicePixelRatio || 1);
				const cssW = this.root.clientWidth;
				const cssH = this.root.clientHeight;
				return [cssW, cssH, dpr, Math.max(1, Math.round(cssW * dpr)), Math.max(1, Math.round(cssH * dpr))];
			}

			/** Match what CSS `center / cover` would show, so the two layers agree. */
			size() {
				const gl = this.gl;
				if (this.box === undefined) this.box = this.measure();
				const w = this.box[3];
				const h = this.box[4];
				if (this.canvas.width !== w || this.canvas.height !== h) {
					this.canvas.width = w;
					this.canvas.height = h;
				}
				gl.viewport(0, 0, w, h);
				const s = Math.max(w / this.natural[0], h / this.natural[1]);
				this.cover = [(this.natural[0] * s) / w, (this.natural[1] * s) / h];
			}

			step() {
				if (this.gl === undefined) return;
				const now = performance.now();
				const gap = now - this.last;
				this.last = now;
				/* The phase advances by wall time and can only ever take a capped step: a
				 * blocked second makes the drift slow down instead of jumping, which is the
				 * same rule the waiting mark breathes by, and the reason a stall here cannot
				 * turn into a rollback. */
				this.phase = (this.phase + Math.min(gap, 90) / WARP.loop) % 1;
				/* Whose fault is a slow tick? If the application's own long animation frame is
				 * younger than the block window, the thread was held by someone else — during
				 * boot that is the plugin loader, and it costs 900 ms at a time. Charging that
				 * to the engine spent the whole splash at the 12 fps floor on a real boot,
				 * while the engine's own worst draw was 0.8 ms. Only unexplained slowness,
				 * sustained over a run of ticks, costs a tier; a clean run buys one back. */
				const blocked = typeof this.longAt === "function" && now - this.longAt() < WARP.blockWindowMs;
				if (gap > WARP.maxGapMs && blocked !== true) {
					this.bad += 1;
					if (this.bad >= WARP.run) this.strike("frame gap " + gap.toFixed(0) + "ms x" + this.bad);
				} else if (gap > WARP.maxGapMs) {
					this.blamed += 1;
				} else {
					this.bad = 0;
				}
				if (now - this.lastDraw < WARP.tiers[this.tier]) {
					this.timer = window.requestAnimationFrame(() => this.step());
					return;
				}
				this.lastDraw = now;
				this.size();
				const gl = this.gl;
				const ramp = Math.min(1, (now - this.startedAt) / (this.rampMs ?? WARP.ramp));
				const t0 = now;
				gl.uniform1f(this.u.amp, WARP.amp * ramp * (this.ampScale || 1) * (this.box[0] / this.canvas.width || 1));
				gl.uniform1f(this.u.phase, this.phase);
				gl.uniform2f(this.u.texel, 1 / this.natural[0], 1 / this.natural[1]);
				gl.uniform2f(this.u.origin, (1 - this.cover[0]) / 2, (1 - this.cover[1]) / 2);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
				const cost = performance.now() - t0;
				if (cost > this.worstDraw) this.worstDraw = cost;
				if (cost > WARP.maxDrawMs) this.strike("draw " + cost.toFixed(1) + "ms");
				this.frames += 1;
				this.clean += 1;
				if (this.clean >= WARP.cleanUp && this.tier > 0) {
					this.tier -= 1;
					this.clean = 0;
				}
				if (ramp >= 1 && this.state !== "live") {
					this.state = "live";
					this.root.dataset.warp = "live";
				}
				this.canvas.style.opacity = String(ramp);
				this.timer = window.requestAnimationFrame(() => this.step());
			}

			/** Cost is met with a slower cadence, never with absence. The count goes into the
			 * receipt, so a machine that spent the splash at the 12 fps floor is visible
			 * afterwards instead of having quietly switched the painting off. */
			strike(why) {
				this.strikes += 1;
				this.reason = why;
				if (this.tier < WARP.tiers.length - 1) this.tier += 1;
			}

			/** One mechanism at a time: the CSS 退路 is only ever installed by the caller
			 * after this returns false, so the two can never both be on screen. */
			stop(why) {
				if (this.timer !== undefined) window.cancelAnimationFrame(this.timer);
				this.timer = undefined;
				if (this.onResize !== undefined) {
					window.removeEventListener("resize", this.onResize);
					this.onResize = undefined;
				}
				if (this.gl !== undefined) {
					/* Hand the context back: a splash that is gone must not keep GPU memory. */
					const lose = this.gl.getExtension("WEBGL_lose_context");
					if (lose !== null) lose.loseContext();
					this.gl = undefined;
				}
				if (this.host !== undefined) this.host.remove();
				this.state = "off";
				this.reason = String(why);
				delete this.root.dataset.warp;
			}

			/** A theme flip mid-splash changes the painting; the program and buffers stay. */
			useImage(src) {
				if (this.gl === undefined || this.src === src) return;
				this.src = src;
				const image = new window.Image();
				this.image = image;
				image.addEventListener("load", () => this.load(image));
				image.addEventListener("error", () => this.stop("the other palette would not decode"));
				image.src = src;
			}

			/**
			 * Take over from the clip. The element is paused on its own last frame, so the first
			 * thing drawn is exactly that frame at zero displacement: the picture keeps moving
			 * without a cut and without a rewind. The amplitude is raised because the video's
			 * own motion is far larger than a 2.6 px drift — at the splash amplitude he read the
			 * tail as a still image, which is the other failure mode.
			 */
			useFrame(el) {
				if (this.gl === undefined || el.readyState < 2) return false;
				this.ampScale = WARP.tailAmp;
				/* No ramp: the takeover happens in the last third of a second of a held boot,
				 * and a 700 ms fade meant the engine had drawn ten frames at a fraction of its
				 * amplitude before the frame came down — which is what still read as 静止. */
				this.rampMs = 0;
				this.canvas.style.opacity = "1";
				this.natural = [el.videoWidth || 1, el.videoHeight || 1];
				this.load(el);
				this.reason = "接手 clip 尾帧 x" + WARP.tailAmp;
				return true;
			}

			/** What the receipt says. "It is in the DOM" is not a liveness claim; this is. */
			witness() {
				return this.state + " · " + this.frames + "帧 @ " + Math.round(1000 / WARP.tiers[this.tier]) + "fps档"
					+ " · 最差绘制 " + this.worstDraw.toFixed(1) + "ms"
					+ (this.strikes === 0 ? "" : " · 降档 " + this.strikes + "次")
					+ (this.blamed === 0 ? "" : " · 归他人的长帧 " + this.blamed + "次")
					+ (this.reason === "" ? "" : " · 最后原因:" + this.reason);
			}
		}
		//#endregion

		/** The painting this frame is showing, read back off the palette instead of being
		 * re-derived here — a second naming rule is a second truth that can disagree. */
		function stillOf(root) {
			return (root.style.getPropertyValue("--dsh-ink-bg").match(/url\("?([^")]+)"?\)/) || [])[1];
		}

		/**
		 * The ladder, in the order the user's two requirements force: the engine where the
		 * machine has a GPU path, and a transform-only 退路 where it does not. The second is
		 * not a worse picture — it is the same painting, breathing through the compositor —
		 * and it asks nothing of the hardware beyond what the splash already uses to move.
		 * Nothing moves only when the person asked for that with their OS setting.
		 */
		function startAmbience(root, longAt) {
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches === true) {
				return { kind: "off", useImage: () => {}, useFrame: () => false, stop: () => {}, witness: () => "off · 系统要求减少动效" };
			}
			const still = stillOf(root);
			if (still === undefined) return { kind: "off", useImage: () => {}, useFrame: () => false, stop: () => {}, witness: () => "off · 调色里没有静图" };
			const warp = new InkWarp(root, still, longAt);
			if (warp.start() === true) return warp;
			const why = warp.reason;
			const host = document.createElement("div");
			host.className = "dsh-ink-drift";
			host.setAttribute("aria-hidden", "true");
			root.querySelector(".dsh-ink-scene").insertAdjacentElement("afterend", host);
			return {
				kind: "css",
				useImage: () => {},
				/* The drift layer moves the whole scene, so it can take the tail too. */
				useFrame: () => true,
				stop: () => host.remove(),
				witness: () => "css 退路(" + why + ") · " + warp.witness(),
			};
		}

		class InkAudio {
			/**
			 * The instrument. No sample is shipped: every voice is oscillators, one
			 * reused noise buffer, and one convolver whose impulse is generated at open
			 * — a few milliseconds of work instead of a file to fetch at boot.
			 *
			 * Three things are different from the friction era: a note is placed in
			 * stereo instead of summed to mono, every voice shares one room, and every
			 * envelope rises from zero instead of jumping to full gain (that jump was
			 * the audible click at 1–8 kHz).
			 */
			constructor(options) {
				this.duration = options.duration;
				this.voice = VOICES.includes(options.voice) ? options.voice : "guqin";
				this.spec = VOICE_SPECS[this.voice];
				// One attenuation, not two. It used to be volume/100 * 0.5 while every
				// recipe carried its own make-up gain, so the slider meant something
				// different in every voice. The trim lives in the spec now.
				this.level = Math.max(0, Math.min(1, options.volume / 100)) * 0.9 * this.spec.trim;
				this.ctx = undefined;
				this.state = "uninitialised";
				this.noise = undefined;
				this.air = undefined;
				this.fired = new Set();
				this.peak = 0;
			}

			async open() {
				const Ctor = window.AudioContext ?? window.webkitAudioContext;
				if (Ctor === undefined) {
					this.state = "unsupported";
					return this.state;
				}
				try {
					this.ctx = new Ctor();
					// Chromium hands back a suspended context when the splash opens before
					// any input; resume is the only thing that makes the first tick audible.
					if (this.ctx.state !== "running") await this.ctx.resume();
					this.state = this.ctx.state;
				} catch (error) {
					this.state = "error";
					this.ctx = undefined;
				}
				if (this.ctx === undefined) return this.state;

				this.master = this.ctx.createGain();
				this.master.gain.value = this.level;
				// The voices now aim near full scale, so the ceiling is a limiter rather
				// than a safety net: threshold above the loudest note, gentle ratio, and
				// the slow release keeps a chime's tail from pumping.
				const guard = this.ctx.createDynamicsCompressor();
				guard.threshold.value = -12;
				guard.knee.value = 8;
				guard.ratio.value = 4;
				guard.attack.value = 0.004;
				guard.release.value = 0.18;
				this.analyser = this.ctx.createAnalyser();
				this.analyser.fftSize = 512;
				this.waveform = new Float32Array(this.analyser.fftSize);
				this.master.connect(guard).connect(this.analyser).connect(this.ctx.destination);

				// One room for the whole splash. Its impulse is decaying noise shaped by
				// a low pass, with a handful of early reflections in front. It is stereo,
				// so a note's pan survives into the tail instead of collapsing back to
				// mono — the old voices were 0.99-correlated left to right, which is why
				// they sounded like a speaker rather than a space.
				this.room = this.ctx.createConvolver();
				// `normalize` would rescale by the impulse's own RMS at run time; the
				// energy is normalised once in `#impulse` instead, which is what the
				// preview did.
				this.room.normalize = false;
				this.wet = this.ctx.createGain();
				this.wet.gain.value = 0.30;
				this.room.connect(this.wet).connect(this.master);
				// The impulse is built after this frame, not inside it — see `#armRoom`.
				this.#armRoom();
				return this.state;
			}

			/**
			 * Build the room's impulse off the boot path.
			 *
			 * It is a four-pass walk over ~160k samples per channel: measured 16–45 ms,
			 * median 29 ms, all of it synchronous. `open()` runs inside the window the
			 * splash spends waiting for the main thread to go quiet, so building it here
			 * stalls the first frames of the animation it belongs to. Nothing is sent
			 * into the room before the first note at ~0.3 s, and a convolver with no
			 * buffer is simply silent, so the wait costs nothing audible.
			 */
			#armRoom() {
				const build = () => {
					if (this.ctx === undefined || this.ctx.state === "closed") return;
					if (this.room.buffer !== null && this.room.buffer !== undefined) return;
					try {
						this.room.buffer = this.#impulse(2.9, 0.035, 3100, 0x1f3d);
					} catch {
						// A context that died between the mount and this slot: the notes are
						// already dry and a missing room is not worth a crash.
					}
				};
				if (typeof requestIdleCallback === "function") requestIdleCallback(build, { timeout: 90 });
				else window.setTimeout(build, 0);
			}

			running() {
				return this.ctx !== undefined && this.ctx.state === "running";
			}

			observe() {
				if (!this.running()) return this.peak;
				this.analyser.getFloatTimeDomainData(this.waveform);
				let peak = 0;
				for (let i = 0; i < this.waveform.length; i += 1) {
					const v = Math.abs(this.waveform[i]);
					if (v > peak) peak = v;
				}
				this.peak = peak;
				return peak;
			}

			/** Two seconds of white noise, reused by every noise-shaped event. */
			#noiseBuffer() {
				if (this.noise !== undefined) return this.noise;
				const ctx = this.ctx;
				const length = Math.round(ctx.sampleRate * 2);
				const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
				const data = buffer.getChannelData(0);
				for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
				this.noise = buffer;
				return buffer;
			}

			/**
			 * The room: decayed noise, band-limited, energy normalised to one per channel.
			 * Early reflections are added after the low pass so the first 60 ms stays dry
			 * and directional, which is what keeps a splash from sounding like a bath.
			 */
			#impulse(rt60, predelay, cutoff, seed) {
				const ctx = this.ctx;
				const length = Math.round((predelay + rt60 * 1.15) * ctx.sampleRate);
				const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
				const pre = Math.round(predelay * ctx.sampleRate);
				for (let channel = 0; channel < 2; channel += 1) {
					const data = buffer.getChannelData(channel);
					let state = seed + channel * 7919;
					for (let i = 0; i < length; i += 1) {
						// xorshift, not Math.random: the two channels must not be the same
						// noise, or the tail is mono again.
						state ^= state << 13;
						state ^= state >>> 17;
						state ^= state << 5;
						const t = i / ctx.sampleRate - predelay;
						data[i] = t < 0 ? 0 : ((state >>> 0) / 0xffffffff * 2 - 1) * Math.pow(0.001, t / rt60);
					}
					let energy = this.#filter(data, "lowpass", cutoff, 0.7);
					for (const [ms, amp] of [[11, 0.55], [19, -0.42], [27, 0.36], [41, -0.28], [58, 0.22]]) {
						const at = pre + Math.round(ms * ctx.sampleRate);
						if (at + 9 >= length) continue;
						data[at] += amp;
						data[at + 3] += amp * 0.45;
						data[at + 9] += amp * 0.22;
					}
					const scale = 1 / Math.sqrt(energy > 0 ? energy : 1);
					for (let i = 0; i < length; i += 1) data[i] *= scale;
				}
				return buffer;
			}

			/** One RBJ biquad, run once over an array — used only to shape the impulse. */
			#filter(data, type, hz, q) {
				const rate = this.ctx.sampleRate;
				const w0 = 2 * Math.PI * Math.min(hz, rate * 0.45) / rate;
				const cw = Math.cos(w0);
				const alpha = Math.sin(w0) / (2 * q);
				let b0 = (1 + cw) / 2;
				let b1 = -(1 + cw);
				let b2 = (1 + cw) / 2;
				if (type === "lowpass") {
					b0 = (1 - cw) / 2;
					b1 = 1 - cw;
					b2 = (1 - cw) / 2;
				}
				const a0 = 1 + alpha;
				const a1 = -2 * cw;
				const a2 = 1 - alpha;
				const n0 = b0 / a0;
				const n1 = b1 / a0;
				const n2 = b2 / a0;
				const d1 = a1 / a0;
				const d2 = a2 / a0;
				let x1 = 0;
				let x2 = 0;
				let y1 = 0;
				let y2 = 0;
				// The sum of squares comes out of the same pass: the impulse has to be
				// measured after filtering, and a second walk over 160k samples per
				// channel is a second walk over 160k samples per channel.
				let energy = 0;
				for (let i = 0; i < data.length; i += 1) {
					const x = data[i];
					const y = n0 * x + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
					x2 = x1;
					x1 = x;
					y2 = y1;
					y1 = y;
					data[i] = y;
					energy += y * y;
				}
				return energy;
			}

			/** Begin the continuous material: the bed, the drone. Notes fire on marks. */
			start() {
				if (!this.running()) return;
				if (this.spec.bed !== undefined) this.#airBed();
				if (this.spec.drone !== undefined) this.#drone();
			}

			/**
			 * The bed follows the brush. A quarter of a second, not the old 50 ms: at
			 * 50 ms the level tracked every service tick and the noise pulsed at 8 Hz,
			 * which is heard as a flutter rather than as air.
			 */
			front(p, dp, dtMs) {
				if (this.air === undefined || !this.running()) return;
				const spec = this.spec.bed;
				if (p >= 0.999) return;
				// Same shape the offline render used: the front's speed normalised by the
				// fastest tick of the eased curve, floored so a slow stroke is not silence.
				const speed = (dp / Math.max(dtMs, 1)) * this.duration;
				const load = Math.min(1.35, speed / 1.88);
				const target = Math.min(1.35, spec.floor + (1 - spec.floor) * load) * spec.peak;
				this.air.gain.setTargetAtTime(target, this.ctx.currentTime, spec.tauA);
			}

			/** Fire every mark the front has passed. */
			cue(p) {
				if (!this.running()) return;
				for (const key of Object.keys(this.spec.marks)) {
					if (this.fired.has(key) || p < this.spec.marks[key]) continue;
					this.fired.add(key);
					this.#play(key);
				}
			}

			/**
			 * The notes. Amplitudes and distances are the ones the audition WAV was
			 * rendered with — change one here and the file in 试听 stops being a preview
			 * of the splash.
			 */
			#play(key) {
				switch (key) {
					// 墨韵：落墨时一声散音 D3
					case "stringInk":
						this.#pluck(146.83, { amp: 0.19, seconds: 3.2, pan: -0.12, wet: 0.45, brightness: 0.85, sub: 0.16, finger: 0.4 });
						break;
					// 古琴：散音 D4，D3 在下面托着
					case "stringQin":
						this.#pluck(293.66, { amp: 0.20, seconds: 3.0, pan: -0.13, wet: 0.45, brightness: 0.72, sub: 0.45, finger: 0.5 });
						break;
					// 古琴：泛音 D5，行笔时最清的一声
					case "harmonic":
						this.#pluck(587.33, { amp: 0.085, seconds: 1.6, pan: 0.30, wet: 0.55, brightness: 0.30, sub: 0, finger: 0.16, harmonic: true, attack: 0.004 });
						break;
					// 古琴：按音 A3 -> B3，走手
					case "walk3":
						this.#pluck(220.0, { amp: 0.13, seconds: 2.4, pan: 0.10, wet: 0.44, brightness: 0.85, sub: 0.18, finger: 0.42, glideTo: 246.94, glide: 0.6 });
						break;
					// 墨韵：走手 D4 -> E4
					case "walk4":
						this.#pluck(293.66, { amp: 0.17, seconds: 2.6, pan: 0.05, wet: 0.45, brightness: 0.80, sub: 0.16, finger: 0.4, glideTo: 329.63, glide: 0.5 });
						break;
					case "xiaoInk":
						this.#xiao(220.0, { amp: 0.14, seconds: 2.2, pan: 0.16, wet: 0.55 });
						break;
					case "xiaoHi":
						this.#xiao(220.0, { amp: 0.25, seconds: 2.2, pan: 0.06, wet: 0.50 });
						break;
					case "xiaoLo":
						this.#xiao(146.83, { amp: 0.21, seconds: 2.4, pan: -0.20, wet: 0.50 });
						break;
					case "dripInk":
						this.#drip(1046.5, { amp: 0.04, pan: 0.30 });
						break;
					case "drip1":
						this.#drip(1046.5, { amp: 0.05, pan: 0.32 });
						break;
					case "drip2":
						this.#drip(1568.0, { amp: 0.032, pan: -0.26, delay: 0.09 });
						break;
					case "bellInk":
						this.#chime(293.66, { amp: 0.115, seconds: 3.4, pan: 0.18, wet: 0.60 });
						break;
					case "bellQin":
						this.#chime(293.66, { amp: 0.100, seconds: 3.4, pan: 0.16, wet: 0.62 });
						break;
					case "bellHi":
						this.#chime(440.0, { amp: 0.115, seconds: 3.0, pan: 0.24, wet: 0.62 });
						break;
					case "bellLo":
						this.#chime(146.83, { amp: 0.105, seconds: 3.6, pan: -0.10, wet: 0.60 });
						break;
					default:
						break;
				}
			}

			/**
			 * One sine partial: rise from zero, decay to nothing, panned, and sent into
			 * the room. `from`/`glideTo` make a 走手 or a drop's rising pitch; `lfo` adds
			 * the 6-cent vibrato every note in this pack shares.
			 */
			#tone(hz, amp, seconds, options) {
				if (!(amp > 0)) return;
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const { pan = 0, wet = 0.4, attack = 0.004, from, glideTo, glide = 0, lfo, delay = 0 } = options;
				const start = now + delay;
				const osc = ctx.createOscillator();
				osc.type = "sine";
				osc.frequency.setValueAtTime(from === undefined ? hz : from, start);
				if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, start + glide);
				const env = ctx.createGain();
				env.gain.setValueAtTime(0, start);
				env.gain.linearRampToValueAtTime(amp, start + attack);
				env.gain.exponentialRampToValueAtTime(0.0005, start + seconds);
				const place = ctx.createStereoPanner();
				place.pan.value = pan;
				osc.connect(env).connect(place);
				place.connect(this.master);
				if (wet > 0) {
					const send = ctx.createGain();
					send.gain.value = wet;
					place.connect(send).connect(this.room);
				}
				if (lfo !== undefined) {
					const depth = ctx.createGain();
					depth.gain.value = hz * (Math.pow(2, 6 / 1200) - 1);
					lfo.connect(depth).connect(osc.frequency);
				}
				osc.start(start);
				osc.stop(start + seconds + 0.05);
			}

			/**
			 * One plucked string: partials stretched by n, each decaying on its own
			 * curve, a sub octave underneath, and a short band of finger noise at the
			 * attack. `brightness` below 1 darkens the upper partials; `harmonic` turns
			 * the whole thing into a 泛音: three partials, no sub octave.
			 */
			#pluck(hz, options) {
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const { amp, seconds, pan = 0, wet = 0.4, sub = 0, brightness = 0.8, finger = 0, harmonic = false, glideTo, glide = 0, attack = 0.006 } = options;
				const B = harmonic ? 0.00008 : 0.00035;
				const count = harmonic ? 3 : 7;
				let lfo;
				if (glideTo !== undefined) {
					lfo = ctx.createOscillator();
					lfo.type = "sine";
					lfo.frequency.value = 4.4;
					lfo.start(now);
					lfo.stop(now + seconds + 0.2);
				}
				for (let n = 1; n <= count; n += 1) {
					const f = hz * n * Math.sqrt(1 + B * n * n);
					const a = amp * (harmonic ? (n === 1 ? 1 : 0.10 / n) : Math.pow(n, -1.25 * brightness));
					const len = seconds * (harmonic ? 1 : 1 / (1 + 0.30 * (n - 1)));
					this.#tone(f, a, len, { pan, wet, attack, glideTo: glideTo === undefined ? undefined : f * (glideTo / hz), glide, lfo });
				}
				if (sub > 0) this.#tone(hz * 0.5, amp * sub, seconds * 1.15, { pan, wet, attack: attack * 1.5, lfo });
				if (finger > 0) {
					this.#burst({
						hz: Math.min(hz * 8, 4800), hzTo: Math.min(hz * 3.5, 2400), q: 1.3,
						amp: amp * finger * 0.22, seconds: 0.075, attack: 0.003, pan, send: wet * 0.35,
					});
				}
			}

			/** A chime: a fundamental with two faint, slightly stretched companions. */
			#chime(hz, options) {
				const { amp, seconds, pan = 0, wet = 0.6 } = options;
				for (const [ratio, a, k] of [[1, 1, 1], [2.76, 0.16, 0.55], [5.4, 0.05, 0.35]]) {
					this.#tone(hz * ratio, amp * a, seconds * k, { pan, wet, attack: 0.002 });
				}
			}

			/** A xiao note: a hollow sine, a second partial, and breath above it. */
			#xiao(hz, options) {
				const { amp, seconds, pan = 0, wet = 0.5 } = options;
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const lfo = ctx.createOscillator();
				lfo.type = "sine";
				lfo.frequency.value = 4.2;
				lfo.start(now);
				lfo.stop(now + seconds + 0.2);
				this.#tone(hz, amp, seconds, { pan, wet, attack: 0.16, lfo });
				this.#tone(hz * 2, amp * 0.13, seconds * 0.6, { pan, wet, attack: 0.2, lfo });
				this.#burst({ hz: hz * 3, hzTo: hz * 2.4, q: 2.2, amp: amp * 0.30, seconds: seconds * 0.85, attack: 0.14, pan, send: wet * 0.45 });
				this.#burst({ hz: 3200, hzTo: 2600, q: 0.65, amp: amp * 0.10, seconds: seconds * 0.7, attack: 0.22, pan, send: wet * 0.5 });
			}

			/** A drop of water: a rising sine with a 12 ms tick of noise on top of it. */
			#drip(hz, options) {
				const { amp, pan = 0, delay = 0 } = options;
				this.#tone(hz, amp, 0.14, { pan, wet: 0.5, attack: 0.002, from: hz * 0.55, glideTo: hz, glide: 0.035, delay });
				this.#burst({ hz: hz * 2.2, q: 3, amp: amp * 0.5, seconds: 0.012, attack: 0.001, pan, send: 0.15, delay });
			}

			/**
			 * A burst of noise through a downward-swept band. `amp` is the band's peak,
			 * scaled by 3.2 the way the offline render did, so a 0.02 here is the same
			 * burst in the WAV. `send` is the absolute level into the room.
			 */
			#burst(options) {
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const { hz, hzTo = Math.max(hz * 0.35, 60), q = 1, amp, seconds, pan = 0, attack = 0.004, send = 0, delay = 0 } = options;
				if (!(amp > 0)) return;
				const start = now + delay;
				const src = ctx.createBufferSource();
				src.buffer = this.#noiseBuffer();
				src.loop = true;
				const band = ctx.createBiquadFilter();
				band.type = "bandpass";
				band.Q.value = q;
				band.frequency.setValueAtTime(hz, start);
				band.frequency.exponentialRampToValueAtTime(Math.max(hzTo, 60), start + seconds);
				const env = ctx.createGain();
				env.gain.setValueAtTime(0, start);
				env.gain.linearRampToValueAtTime(amp * 3.2, start + attack);
				env.gain.exponentialRampToValueAtTime(0.0005, start + seconds);
				const place = ctx.createStereoPanner();
				place.pan.value = pan;
				src.connect(band).connect(env).connect(place);
				place.connect(this.master);
				if (send > 0) {
					const bus = ctx.createGain();
					bus.gain.value = send;
					place.connect(bus).connect(this.room);
				}
				src.start(start, Math.random() * 1.9);
				src.stop(start + seconds + 0.02);
			}

			/**
			 * 古琴's draught: two noise channels under one 240 Hz low pass, panned apart
			 * so the bed is air and not a mono hiss, and levelled by `front`.
			 */
			#airBed() {
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const spec = this.spec.bed;
				const level = ctx.createGain();
				level.gain.setValueAtTime(0, now);
				// The room gets a slice of the bed too, so the draught sits in the same space
				// as the notes instead of in front of them.
				const send = ctx.createGain();
				send.gain.value = spec.send;
				level.connect(this.master);
				level.connect(send).connect(this.room);
				for (const [side, pan] of [[0, -0.45], [1, 0.45]]) {
					const src = ctx.createBufferSource();
					src.buffer = this.#noiseBuffer();
					src.loop = true;
					const shape = ctx.createBiquadFilter();
					shape.type = "lowpass";
					shape.Q.value = 0.5;
					shape.frequency.setValueAtTime(spec.lowpass * spec.tilt[0], now);
					shape.frequency.linearRampToValueAtTime(spec.lowpass * spec.tilt[1], now + this.duration / 1000);
					const place = ctx.createStereoPanner();
					place.pan.value = pan;
					src.connect(shape).connect(place).connect(level);
					src.start(now, side === 0 ? 0.2 : 1.1);
					src.stop(now + this.duration / 1000 + 1.6);
				}
				level.gain.setTargetAtTime(spec.peak * spec.floor, now, spec.tauA);
				// A bed that keeps hissing under the application is the one thing this
				// layer must never do: it is zero by the time the splash ends.
				level.gain.setTargetAtTime(0, now + this.duration / 1000, 0.22);
				this.air = level;
			}

			/** The valley drone: two or three sine tones, a slow rise, a slower fade. */
			#drone() {
				const ctx = this.ctx;
				const now = ctx.currentTime;
				const attack = 1.4;
				const release = this.duration / 1000 + 1.3;
				const gain = ctx.createGain();
				gain.gain.setValueAtTime(0, now);
				gain.gain.linearRampToValueAtTime(1, now + attack);
				gain.gain.setValueAtTime(1, now + release);
				gain.gain.exponentialRampToValueAtTime(0.0005, now + release + 1.1);
				gain.connect(this.master);
				const send = ctx.createGain();
				send.gain.value = 0.4;
				gain.connect(send).connect(this.room);
				for (const [hz, amp] of this.spec.drone) {
					const osc = ctx.createOscillator();
					osc.type = "sine";
					osc.frequency.value = hz;
					const tone = ctx.createGain();
					tone.gain.value = amp * 0.010;
					osc.connect(tone).connect(gain);
					osc.start(now);
					osc.stop(now + release + 1.2);
				}
			}

			/** Silence the bed at once and let the tails ring on their own. */
			close() {
				if (this.ctx === undefined) return;
				if (this.air !== undefined) this.air.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
				const ctx = this.ctx;
				// Closing the context at the last cue would cut the chime and the room
				// mid-decay, so it waits out the longest tail in the pack.
				window.setTimeout(() => {
					ctx.close().catch(() => {});
				}, 6200);
			}
		}
		//#endregion

		//#region component 1 · InkSplash
		/**
		 * The splash itself, mounted on `document.body`: the app mount point is
		 * hydrated by React, and anything left inside the kernel boot page is
		 * snapshotted as inert markup.
		 */
		class InkSplash {
			constructor(options) {
				const ink = options.ink;
				this.wordmark = options.wordmark;
				this.background = options.background;
				this.artwork = options.artwork;
				this.duration = options.duration;
				this.simulated = options.simulated === true;
				this.onDone = options.onDone;
				this.done = false;
				this.startedAt = performance.now();
				this.audio = options.audio;
				/** `() => performance.now()` of the last long animation frame, when the host
				 * can observe them at all. Absent means the thread is always quiet. */
				this.longAt = options.longAt;

				// The prelude has been painting since the first frame of the window, and
				// the clock that drives it is a CSS animation on the root: adopting the
				// frame means the same animation keeps running, so there is nothing to
				// carry and no jump to hide. A fresh frame is built only for a replay.
				this.root = options.root ?? ink.mount(options, false);
				this.root.classList.remove("is-prelude");
				// From here the frame is a gate, not a decoration: nothing underneath can
				// be clicked until the stroke is finished and the node is gone.
				this.root.dataset.takeover = "";
				// The prelude's own watchdog only matters while it is unclaimed.
				if (this.root === ink.prelude) window.clearTimeout(ink.guard);
				// Sole owner of the hold from here on: the prelude's watcher and fallback
				// timer must not be writing the same attribute.
				ink.gate?.cancel();
				// Seed the estimate from a timeline that is still live at this moment:
				// the handover happens while the app is busy, so the read is real, and
				// from here the picture is moved by the compositor alone.
				this.carried = this.#animRatio();
				this.epoch = performance.now();
				this.animEnded = false;
				this.p = this.carried;
				this.visual = eased(this.carried);
				this.lastAnim = this.carried;
				this.rewind = undefined;
				this.layers = new Map();
				this.steps = "";
				// The authoritative end. Filtered by target because every child's
				// animationend bubbles through the root — the halo finishes at 64%, and
				// an unfiltered listener would hand the frame over there.
				this.root.addEventListener("animationend", (event) => {
					if (event.target === this.root) this.animEnded = true;
				});
				// The front can never run ahead of this ceiling, and the ceiling is
				// the real loading progress until loading is declared over.
				this.ceiling = this.simulated ? 1 : 0;
				this.loadingDone = this.simulated;
				this.held = false;
				this.holds = 0;
				// Seed from where the prelude already got: if the brush has visibly moved,
				// the stroke is underway and must never be frozen again.
				this.began = this.carried > BEGAN_EPS;
				this.lastAt = this.startedAt;
				this.lastSample = this.startedAt;
				this.stallMs = 0;
				this.stallAt = 0;
				this.stallIn = 0;
				// The stroke waits for the application's own first real paint. The boot
				// node's removal is no good here: measured, it happens at ~216 ms while the
				// heavy render lands at 1.1-1.9 s. LCP is the signal, and my full-window
				// paper is itself the largest contentful element until it is gone, so an
				// entry pointing inside the splash is refused.
				this.mounted = this.simulated;
				this.mountAt = 0;
				this.mountSignal = "none";
				if (!this.mounted) this.#watchMount();
				this.lastMove = this.startedAt;
				this.lastArc = 0;
				/* Two forced style recalculations a tick live behind these two handles — the
				 * boot arc (`getComputedStyle`) and the clock (`getAnimations`) — and both are
				 * answered from the cache after the first read. This loop runs eight times a
				 * second while the application is still building the document they walk. */
				this.spinner = undefined;
				this.clockAnim = undefined;
				/* The clip is rolled to its head once, when the stroke starts; what the head
				 * was worth when that happened is what `clipAt` carries into the receipt. */
				this.clipRolled = false;
				this.clipAt = "-";
				this.samples = [];
				this.trace = [];
				this.themeName = this.root.dataset.theme;
				this.stopTheme = ink.watch(this.root, this.artwork, (name) => {
					this.themeName = name;
					/* The palette rewrote `--dsh-ink-bg` for the new theme. The engine samples
					 * that picture, so it has to be told; the 退路 reads the same variable
					 * through CSS and needs nothing. */
					this.ambience?.useImage?.(stillOf(this.root));
				});
				/* The clip IS the background's motion whenever it plays; the warp engine only
				 * ever runs in its place. Two movers on one picture read as a wobble, and the
				 * ladder has to be honest about which one is holding the frame. */
				this.movie = this.root.querySelector(".dsh-ink-movie");
				this.movieState = this.movie === null || this.movie === undefined
					? "absent" : String(this.root.dataset.movie ?? "loading");
				if (this.movie !== null && this.movie !== undefined) {
					this.movie.addEventListener("playing", () => {
						this.movieState = "playing";
						if (this.ambience !== undefined) {
							this.ambience.stop();
							this.ambience = undefined;
						}
					});
					this.movie.addEventListener("error", () => {
						this.movieState = "error";
						if (this.disposed !== true && this.ambience === undefined) {
							this.ambience = startAmbience(this.root, this.longAt);
						}
					});
					this.movie.addEventListener("ended", () => {
						this.movieState = "ended";
						if (this.disposed === true) return;
						if (this.ambience === undefined) this.ambience = startAmbience(this.root, this.longAt);
						this.root.dataset.tail = this.ambience?.useFrame?.(this.movie) === true ? "warp" : "still";
					});
				}
				/* The film, when these axes have one: it is the whole splash — mark, dot, stroke
				 * and the painting coming up — so it owns two things the live layers used to
				 * negotiate, and both are the rules he set. It is never fast-forwarded to make a
				 * boot look quicker, and the frame is not handed over until it has finished
				 * rolling. `error` is the only way back to the live layers, and it is one
				 * attribute: the sheet below this one is already painted. */
				this.film = this.root.querySelector(".dsh-ink-film");
				this.filmState = this.film === null || this.film === undefined || this.root.dataset.splash !== "film"
					? "absent" : "loading";
				this.filmRate = 1;
				if (this.filmState !== "absent") {
					const witness = (state) => {
						this.filmState = state;
						this.root.dataset.film = state;
					};
					this.film.addEventListener("loadedmetadata", () => this.#tieClockToFilm());
					this.film.addEventListener("playing", () => {
						witness("playing");
						this.#tieClockToFilm();
					});
					this.film.addEventListener("error", () => {
						witness("error");
						delete this.root.dataset.splash;
					});
					this.film.addEventListener("ended", () => witness("ended"));
				}
				/* Deferred on purpose: creating a GL context measured 21ms and uploading the
				 * painting 10ms, and the one moment that cannot afford either is the boot's own
				 * long-frame storm. The idle queue puts both behind the application's work, and
				 * the amplitude ramp means the layer arrives without a seam whenever it lands. */
				this.ambience = undefined;
				const arm = () => {
					if (this.disposed === true || this.ambience !== undefined) return;
					/* The film is already the moving picture; an engine painting motion behind a
					 * hidden layer is a GL context and a rAF loop paid for nothing. */
					if (this.root.dataset.splash === "film") return;
					/* Only a clip that never held the frame needs a mover behind it. While it
					 * plays there is already motion; once it has ended the sheet is meant to rest
					 * on the still, not start breathing again. */
					if (this.movieState === "playing" || this.movieState === "ended") return;
					this.ambience = startAmbience(this.root, this.longAt);
				};
				if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(arm, { timeout: 1200 });
				else window.setTimeout(arm, 200);
				this.service();
				this.timer = window.setInterval(() => this.service(), ARC_POLL_MS);
			}

			/**
			 * Where the master clock is, in the same units the user set. Measured, the
			 * animation's own timeline is not a safe witness: with every mover on the
			 * compositor the renderer stopped producing main-thread frames, `currentTime`
			 * froze at 0.65 for the remaining 6 seconds, and the frame was never handed
			 * over. The estimate is therefore wall time since the last position that was
			 * read off a live timeline, and it stops accumulating while the picture is
			 * frozen — the delay goes to the end of the stroke, never into a fast-forward.
			 */
			/** Arm the mount gate. No observer means no wait, never a hang. */
			#watchMount() {
				const self = this;
				try {
					const watcher = new PerformanceObserver((list) => {
						for (const entry of list.getEntries()) {
							if (self.mounted) break;
							if (entry.element !== undefined && entry.element !== null && self.root.contains(entry.element)) continue;
							self.mounted = true;
							self.mountSignal = "lcp";
							self.mountAt = Math.round(performance.now() - self.startedAt);
						}
					});
					watcher.observe({ type: "largest-contentful-paint", buffered: true });
					this.mountWatcher = watcher;
				} catch (error) {
					this.mounted = true;
					this.mountSignal = "unavailable";
					this.mountAt = Math.round(performance.now() - self.startedAt);
				}
			}

			clockRatio() {
				if (this.held) return this.carried;
				return Math.max(0, Math.min(this.carried + (performance.now() - this.epoch) / this.duration, 1));
			}

			/** The position the animation reports; trusted only while the timeline moves. */
			#animRatio() {
				/* The lookup flushes style; the animation's own `currentTime` does not. The
				 * root's clock outlives every tick, so it is found once and only read after
				 * that — a forced style recalculation a tick is exactly what the application's
				 * own boot cannot spare. A hold pauses the animation without replacing it, so
				 * the cached handle stays valid; `idle` is the one state that means it is gone. */
				const cached = this.clockAnim;
				if (cached !== undefined && cached.playState !== "idle") {
					const held = Number(cached.currentTime ?? 0);
					if (Number.isFinite(held)) return Math.max(0, Math.min(held / this.duration, 1));
				}
				const list = this.root.getAnimations?.() ?? [];
				const clock = list.find((a) => a.effect?.target === this.root);
				if (clock === undefined) return this.#clockP();
				this.clockAnim = clock;
				const at = Number(clock.currentTime ?? 0);
				if (!Number.isFinite(at)) return this.#clockP();
				return Math.max(0, Math.min(at / this.duration, 1));
			}

			/** Fallback for an engine without getAnimations: the clock's own property. */
			#clockP() {
				const raw = getComputedStyle(this.root).getPropertyValue("--dsh-ink-p").trim();
				const value = Number.parseFloat(raw);
				return Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;
			}

			/**
			 * Watch every animation in the frame for a step backwards or a restart.
			 * `startTime` is null while an animation is paused, which is a hold and not a
			 * regression, so a null on either side of the comparison is skipped rather than
			 * read as a change.
			 */
			#watchLayers(now) {
				/* `getAnimations` flushes style, and a flush is the last thing the main thread
				 * can spare while the application is building itself — so the census stands down
				 * for a moment after a long frame. Nothing is lost by waiting: a step is read
				 * against a remembered sample, not against the previous tick, so the next quiet
				 * tick compares the same pair this one would have.
				 *
				 * Entries without an `animationName` are transitions, not animations — the
				 * breathing re-targets one on every integrator write, and a re-targeted
				 * transition continues from where it is, which is no step at all. Counting
				 * them turned `steps` into noise on every boot that carried the transition. */
				if (this.longAt !== undefined && now - this.longAt() < WARP.blockWindowMs) return;
				const list = this.root.getAnimations?.({ subtree: true }) ?? [];
				for (const animation of list) {
					if (animation.animationName === undefined) continue;
					const name = String(animation.animationName ?? "?");
					const owner = String(animation.effect?.target?.className ?? "?").split(" ")[0];
					const key = name + "@" + owner;
					const at = Number(animation.currentTime ?? 0);
					const start = animation.startTime === null ? null : Number(animation.startTime);
					const seen = this.layers.get(key);
					if (seen !== undefined && this.steps === "") {
						const back = at + 1 < seen.at;
						const again = seen.start !== null && start !== null && Math.abs(start - seen.start) > 1;
						if (back || again) {
							this.steps = Math.round(now - this.startedAt) + "ms " + key
								+ " time " + seen.at.toFixed(0) + " to " + at.toFixed(0)
								+ " start " + String(seen.start) + " to " + String(start);
						}
					}
					this.layers.set(key, { at, start });
				}
			}

			/**
			 * Read the progress the kernel is already publishing. This binds to the
			 * same number its boot page shows rather than to cordis' fiber state
			 * ordinals, which are inlined and renamed in the shipped bundle.
			 * @returns the ratio, or undefined while the boot page is on screen but
			 * has not painted an arc yet.
			 */
			#bootArc() {
				let spinner = this.spinner;
				if (spinner === undefined || spinner.isConnected === false) {
					spinner = document.querySelector("[data-dsh-boot-spinner]");
					this.spinner = spinner ?? null;
				}
				if (spinner === null || spinner === undefined) return 1;
				/* The inline declaration first: the kernel writes the arc there, and an inline
				 * read costs nothing, where `getComputedStyle` is a forced style recalculation of
				 * the whole document — eight of those a second, into a document that is still
				 * being built, is the most expensive possible moment for them. The computed read
				 * stays as the fallback for an engine that animates the arc instead. */
				const raw = String(spinner.style.getPropertyValue("--dsh-boot-arc")
					|| getComputedStyle(spinner).getPropertyValue("--dsh-boot-arc")).trim();
				const deg = Number.parseFloat(raw);
				if (!Number.isFinite(deg)) return undefined;
				return Math.max(0, Math.min((deg - ARC_MIN) / (ARC_MAX - ARC_MIN), 1));
			}

			/**
			 * Sample the kernel arc at ~8Hz. It advances about once per plugin entry.
			 * The read is off the cached node's inline declaration, so it is cheap; the
			 * animation loop still reads no DOM of its own.
			 */
			#pollArc() {
				const arc = this.#bootArc();
				if (arc === undefined) return;
				if (arc > this.lastArc + 0.001) this.lastMove = performance.now();
				this.lastArc = Math.max(this.lastArc, arc);
				if (!this.loadingDone) this.ceiling = Math.max(this.ceiling, Math.min(arc, 1));
				if (this.samples.length < 24) this.samples.push(Math.round(performance.now() - this.startedAt) + "ms:" + arc.toFixed(2));
				// A full arc means every entry activated. The arc also freezes once React
				// re-mounts the boot page as a snapshot, so a still arc after real movement
				// counts as loading being over too. Waiting for the boot page node to
				// disappear is not a signal at all: measured, it never fired.
				if (arc >= 1) this.complete("arc");
				else if (this.ceiling > 0.2 && performance.now() - this.lastMove >= PLATEAU_MS) this.complete("plateau");
			}

			/**
			 * Loading finished — but the stroke may not have. Run the remaining ink
			 * to its end over the rest of the nominal duration and only then hand
			 * the frame over: being cut off mid-brush is what this prevents.
			 */
			complete(by) {
				if (this.loadingDone || this.done) return;
				this.loadingDone = true;
				this.doneBy = by ?? "boot-page";
				this.loadingDoneAt = Math.round(performance.now() - this.startedAt);
				// Releasing the ceiling lets the stroke run out. The clock is linear and
				// fixed-length, so what is left of it is what is left to draw — never more.
				this.ceiling = 1;
			}

			/**
			 * Put the clip back at its head so the stroke and the clip share one clock.
			 *
			 * The clip is set playing at mount and it is 4.042 s long, while the boot can take
			 * ten seconds or more to get here: by the time the ink actually moves, part or all
			 * of the animation has been spent behind the paper, where nobody could see it — and
			 * what the reveal then shows is a spent clip's tail (or the engine's drift on it),
			 * not the animation. The replay never has this problem, because there the clip
			 * starts when the stroke starts; this is that, on the boot path.
			 *
			 * Nothing is revealed yet at the moment this runs, so the seek cannot be seen. A
			 * clip still inside its first quarter second is left alone: a seek flushes the
			 * decoder, and one that has hardly travelled is already where the stroke wants it.
			 * A refused roll leaves whatever the frame already had — the shipped still, or the
			 * tail the engine took over — never a black rectangle.
			 */
			#rollClip() {
				const el = this.movie;
				if (el === null || el === undefined) return;
				/* The film already carries the painting's own motion — it is in the file. A clip
				 * started under it is a second decoder running for a layer nobody can see. */
				if (this.root.dataset.splash === "film") return;
				try {
					const ended = el.ended === true;
					const was = Number(el.currentTime || 0);
					/* The clip is mounted paused at its head and started with the stroke —
					 * by the browser half here, or by the prelude's escape hatch when the
					 * stroke was released before the takeover arrived. A clip that is
					 * already playing is in step with the brush; rolling it would restart
					 * the picture in the middle of the reveal. Only a spent clip (the
					 * stroke began after 4 s) or a still-paused one (the hatch never fired
					 * and the tick got here first) is corrected. */
					if (ended) el.currentTime = 0;
					this.clipAt = (ended ? "已放完回头" : el.paused === true ? "自停顿起播(在" + was.toFixed(2) + "s)" : "随笔画进行 " + was.toFixed(2) + "s")
						+ " · " + Math.round(performance.now() - this.startedAt) + "ms";
					if (el.paused === true || ended) {
						const started = el.play();
						if (started !== undefined && started !== null && typeof started.catch === "function") {
							started.catch(() => {});
						}
					}
				} catch (error) { /* the still stays, which is the shipped fallback */ }
			}

			/**
			 * The whole job, eight times a second: look at what the kernel loaded,
			 * look at where the clock is, and freeze the picture if the clock has
			 * outrun reality. Nothing here produces a pixel — the pixels come from
			 * compositor-run keyframes, which keep moving while the main thread is
			 * busy mounting the application. Public because that is exactly the part
			 * a browser-free test can and must exercise.
			 */
			/**
			 * One clock for the picture and the clip. The master property is held on a real boot
			 * while the application paints its first frame, but a video free-runs through that
			 * hold — so the 4.042 s clip ended early and the tail went still. The rate is whatever
			 * makes the clip finish with the stroke: never a seek, never a loop, never a rewind.
			 * Clamped at both ends, because below 0.5x the slowdown shows, and the handover covers
			 * a boot long enough to outrun even that.
			 */
			#paceMovie() {
				const el = this.movie;
				if (el === null || el === undefined || this.movieState !== "playing") return;
				const media = el.duration - el.currentTime;
				const clock = (1 - this.p) * this.duration / 1000;
				if (media <= 0 || clock <= 0) return;
				const want = Math.max(0.5, Math.min(1.5, media / clock));
				if (Math.abs(el.playbackRate - want) < 0.02) return;
				el.playbackRate = Number(want.toFixed(2));
				this.movieRate = el.playbackRate;
			}

			/** The film's own length is a fact about the file, not about the setting, so the
			 * clock is told which one wins — once, when the header arrives. Slower is allowed:
			 * a 6 s splash is a picture permitted to linger, and the film stretched to fill it
			 * is the same ink moving more quietly. Faster is not: making a 4 s stroke fit a
			 * 2.6 s setting is the fast-forward he banned, so a short setting means the film
			 * decides when the brush is done, not that the brush hurries. */
			#tieClockToFilm() {
				const ms = Number(this.film?.duration) * 1000;
				if (!(ms > 0) || this.filmTied === true) return;
				this.filmTied = true;
				this.filmMs = Math.round(ms);
				const rate = Math.min(1, ms / this.duration);
				this.film.playbackRate = Number(rate.toFixed(3));
				this.filmRate = this.film.playbackRate;
			}

			/** The film is held exactly where the picture is held: a boot that has not painted
			 * its first frame waits on the mark. It can wait anywhere, which the live stroke
			 * cannot — a paused video keeps the frame it is on, while a paused CSS animation is
			 * re-committed main-thread-side and snaps the reveal back. Once the roll starts it
			 * is never interrupted again, so the stroke has one continuous travel. */
			#driveFilm() {
				const el = this.film;
				if (el === null || el === undefined) return;
				if (this.held === true) {
					if (el.paused === false) el.pause();
					return;
				}
				if (this.filmState === "ended") return;
				if (el.paused === true) {
					const started = el.play();
					if (started !== undefined && typeof started.catch === "function") started.catch(() => {});
				}
				/* The clip behind it is not on screen while the film rolls; a decode of a hidden
				 * layer is capacity taken from the application for nothing. */
				if (this.movieState === "playing") this.movie?.pause();
			}

			/** Is the animation still owed to the user? A file this machine refuses is not an
			 * animation in progress, and the live layers take the frame back instead. */
			#filmRolling() {
				return this.filmState === "loading" || this.filmState === "playing";
			}

			service() {
				if (this.done) return;
				/* The clip has to be paced to the clock only while the clock is the picture. With
				 * a film rolling the file is the picture, and the clock is its witness. */
				if (this.filmState === "absent" || this.filmState === "error") this.#paceMovie();
				if (!this.simulated && !this.loadingDone) this.#pollArc();
				const ratio = this.clockRatio();
				const now = performance.now();
				// Where the picture stood still is a fact worth more than "有点卡": the gap
				// between two samples and the stroke position it happened at.
				const gap = now - this.lastSample;
				if (gap > this.stallMs) {
					this.stallMs = Math.round(gap);
					this.stallAt = ratio;
					this.stallIn = Math.round(now - this.startedAt);
				}
				this.lastSample = now;
				const dt = now - this.lastAt;
				this.p = ratio;
				// The ear follows the brush, not the clock: the curve is what the eye sees,
				// so the level and the accents are placed on the eased position.
				const visual = eased(ratio);
				const dv = Math.max(0, visual - this.visual);
				this.visual = visual;
				if (this.audio !== undefined) {
					this.audio.front(visual, dv, dt);
					this.audio.observe();
					this.audio.cue(visual);
				}
				// A paused CSS animation resumes where it stopped rather than repaying
				// the frozen time, so being held back delays the ending, never rushes it.
				// The estimate has to be told the same thing, or it would keep running on
				// while the picture stands still.
				if (!this.mounted && performance.now() - this.startedAt >= MOUNT_WAIT_MS) {
					this.mounted = true;
					this.mountSignal = "timeout";
					this.mountAt = Math.round(performance.now() - this.startedAt);
				}
				// Before the brush starts, wait for the main thread to go quiet: a reveal that
				// begins inside a long frame is a reveal that stops halfway. The wait is
				// bounded, because a splash that waits on someone else's schedule is the thing
				// that traps the user.
				const quiet = this.longAt === undefined
					|| now - this.startedAt >= Math.min(QUIET_DEADLINE_MS, this.duration * QUIET_DEADLINE_SHARE)
					|| now - this.longAt() >= QUIET_MS;
				const behind = ratio > this.ceiling + HOLD_EPS;
				// Latched before the decision, so the tick that crosses the line cannot be the
				// one that freezes the picture.
				if (ratio > BEGAN_EPS) this.began = true;
				const ahead = !this.began && (!this.mounted || !quiet || behind);
				// Once the brush has visibly travelled it is never frozen again. A pause is
				// committed main-thread-side, and while the boot blocks this thread the
				// compositor has already painted ahead — so pausing snaps the picture back to
				// where the main thread last was. That snap is the "回退一点" on screen, measured
				// at two captured frames: the reveal edge at 67% of the window, then at 55%.
				// Loading that has not caught up is waited out on a finished painting instead.

				if (ahead !== this.held) {
					this.carried = ratio;
					this.epoch = performance.now();
					this.held = ahead;
					this.holds += 1;
					if (ahead) this.root.dataset.hold = "";
					else delete this.root.dataset.hold;
				}
				/* The film is driven off the same hold verdict the picture uses, and off the
				 * fresh one: a tick of lag here is 125 ms of a stroke shown while the
				 * application is still painting its first frame. */
				if (this.filmState !== "absent" && this.filmState !== "error") this.#driveFilm();
				/* The stroke is running and the reveal has not moved yet: this is where the clip
				 * is put back on its first frame, so what the ink uncovers is the animation
				 * itself — the picture the replay shows — and not the tail of a clip that was
				 * spent while the paper was still up. See #rollClip for the whole argument. */
				if (this.clipRolled !== true && this.held === false) {
					this.clipRolled = true;
					this.#rollClip();
				}
				this.anim = this.#animRatio();
				// The master clock can say "no rewind" while a single layer restarts: a
				// re-inserted node, or an animation whose name or timing just re-resolved,
				// only moves that layer back. So every animation inside the frame is watched
				// by name, and the one that steps backwards is reported by name too.
				this.#watchLayers(now);
				// A clock that moves backwards is the stroke being re-laid, from whatever
				// cause: a second frame, or an animation whose name or timing just changed.
				if (this.rewind === undefined && this.anim < this.lastAnim - 0.03) {
					this.rewind = Math.round(performance.now() - this.startedAt) + "ms "
						+ this.lastAnim.toFixed(2) + " to " + this.anim.toFixed(2);
				}
				this.lastAnim = Math.max(this.lastAnim, this.anim);
				if (this.trace.length < 24) {
					this.trace.push(Math.round(performance.now() - this.startedAt) + "ms:"
						+ ratio.toFixed(2) + "/" + this.anim.toFixed(2) + (this.held ? "|hold" : ""));
				}
				if (this.loadingDone && (this.animEnded || ratio >= 0.999) && !this.#filmRolling()) this.dismiss();
			}

			dismiss() {
				if (this.done) return;
				this.done = true;
				this.dismissedAt = Math.round(performance.now() - this.startedAt);
				window.clearInterval(this.timer);
				this.mountWatcher?.disconnect();
				this.stopTheme?.();
				if (this.audio !== undefined) this.audio.close();
				/* The frame is still connected and the stroke has just ended — the exact
				 * moment the blank-splash reports were about. Reading it here is the only
				 * place a receipt can name the layer, because every later read happens after
				 * `drop()` and `getComputedStyle` on a detached node answers "" for every
				 * custom property (which is what "frame detached" in the earlier receipts
				 * was: a broken instrument, not a fact about the picture). */
				try {
					this.layerReport = layerState(this.root);
				} catch (error) {
					this.layerReport = "layerState threw: " + String(error?.message ?? error);
				}
				const paint = this.root.querySelector(".dsh-ink-paint");
				paint.classList.add("is-out");
				const drop = () => {
					this.root.remove();
					this.disposed = true;
					/* A removed video element is not a stopped one: the decoder keeps pulling
					 * frames until the last reference goes, and the application is on screen by
					 * now and wants that capacity back. */
					this.movie?.pause();
					this.film?.pause();
					// The breath is a timer on the prelude's side; a frame that is gone
					// must not keep writing style every 33 ms for the rest of the session.
					window.__DSH_INK__?.stopWave?.(this.root);
					/* Same rule for the engine, with more reason: a WebGL context left alive
					 * after the splash is a few megabytes of GPU memory held for a picture
					 * that is no longer anywhere. The witness is taken before the object goes,
					 * because `onDone` — which writes the receipt — runs after this. */
					this.ambienceWitness = this.ambience?.witness?.() ?? "none";
					this.ambience?.stop();
					this.ambience = undefined;
					// The other palette is now worth its four decodes: the stroke is over,
					// the application is on screen, and nothing is waiting on this frame.
					window.__DSH_INK__?.warm?.(this.artwork);
					if (this.onDone !== undefined) this.onDone();
				};
				if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) drop();
				else window.setTimeout(drop, EXIT_MS);
			}
		}
		//#endregion

		//#region component 2 · InkSplashSettings
		const PANEL_CSS = [
			".dsh-ink-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
			".dsh-ink-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dsh-ink-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}",
			".dsh-ink-rows{flex-direction:column;margin:12px 0 0;display:flex}",
			".dsh-ink-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px 24px;padding:16px 0;display:flex;flex-wrap:wrap}",
			".dsh-ink-row>div:first-child{flex:1;min-width:200px}",
			".dsh-ink-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
			".dsh-ink-row-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:21px}",
			".dsh-ink-slider{width:160px;accent-color:var(--dsw-alias-brand-primary)}",
			".dsh-ink-value{min-width:60px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:13px}",
			".dsh-ink-flag{border-radius:5px;padding:1px 7px;font-size:12px}",
			".dsh-ink-flag[data-ok=true]{background:rgb(70 160 90 / 16%);color:var(--dsw-alias-label-primary)}",
			".dsh-ink-flag[data-ok=false]{background:rgb(200 120 60 / 18%);color:var(--dsw-alias-label-primary)}",
		].join("\n");

		function InkSplashSettings({ useConfig, setField, replay, t, audio }) {
			useEffect(() => insertStyles(PKG + "/settings.css", PANEL_CSS), []);
			const state = useConfig((snapshot) => snapshot);
			const value = state.status === "ready" ? state.value : undefined;
			const disabled = state.writable !== true || value?.enabled === false;
			/* The switch that turns the splash on may not be governed by the thing it turns
		 * off: with `disabled` in its place, switching the splash off left no way back on. */
			const writable = state.writable !== true;
			/* One transient readout per slider, keyed by the field it belongs to. A single shared
			 * number let two sliders rewrite each other's display — dragging 重播时长 printed
			 * `3000%` for 音量 — and the `shown >= 900` test in the other row was a patch that
			 * only held while the two ranges stayed apart. */
			const [shown, setShown] = useState({});
			const showValue = (field, next) => setShown((prev) => ({ ...prev, [field]: next }));
			/* The theme is not in the config form, so the row re-renders on the service's own
			 * change event — including a change made outside this page. */
			const [, themeTick] = useState(0);
			useEffect(() => inkTheme.subscribe(() => themeTick((n) => n + 1)), []);

			if (value === undefined) return h("div", { className: "dsh-ink-section" }, t("loading"));

			const axis = (key, options, index) => h("div", { className: "dsh-ink-row", key: index }, [
				h("div", { key: "text" }, [
					h("div", { className: "dsh-ink-row-title", key: "title" }, t(key + ".title")),
					h("div", { className: "dsh-ink-row-desc", key: "description" }, t(key + ".description")),
				]),
				h(SegmentedControl, {
					key: "control",
					id: "dsh-ink-" + key,
					label: t(key + ".title"),
					value: value[key],
					disabled,
					options: options.map((id) => ({ value: id, label: t(key + "." + id) })),
					onChange: (next) => setField(key, next),
				}),
			]);

			const ms = value.duration;
			return h("div", { className: "dsh-ink-section" }, [
				h("h2", { className: "dsh-ink-title", key: "title" }, t("page.title")),
				h("p", { className: "dsh-ink-intro", key: "intro" }, t("page.intro")),
				h("div", { className: "dsh-ink-rows", key: "rows" }, [
					h("div", { className: "dsh-ink-row", key: "enabled" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("enabled.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("enabled.description")),
						]),
						h(Switch, {
							key: "switch",
							checked: value.enabled,
							disabled: writable,
							label: t("enabled.title"),
							onChange: (next) => setField("enabled", next),
						}),
					]),
					axis("wordmark", WORDMARKS, 1),
					axis("background", BACKGROUNDS, 2),
					axis("artwork", ARTWORKS, 3),
					axis("voice", VOICES, 4),
					/* The application theme lives here because the app's own appearance picker
					 * is a fixed set of light/dark/system cubes and cannot list a plugin's id. */
					h("div", { className: "dsh-ink-row", key: "theme" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("theme.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("theme.description")),
						]),
						h(SegmentedControl, {
							key: "control",
							id: "dsh-ink-theme",
							label: t("theme.title"),
							value: inkTheme.active ?? "off",
							options: [{ value: "off", label: t("theme.off") }].concat(
								inkTheme.ids.map((id) => ({ value: id, label: t("theme." + id) }))),
							onChange: (next) => inkTheme.set(next),
						}),
					]),
					/* The wallpaper's own dimmer, and it belongs to the theme row above, not to the
					 * splash: 关掉开屏动画 leaves the window wearing the painting, so this格 must
					 * still move. Only the write permission governs it. */
					h("div", { className: "dsh-ink-row", key: "wallLight" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("wallLight.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("wallLight.description")),
						]),
						h("div", { key: "control", style: { display: "flex", alignItems: "center", gap: "12px" } }, [
							h("input", {
								key: "slider",
								className: "dsh-ink-slider",
								type: "range",
								min: 40,
								max: 160,
								step: 5,
								/* A saved document from before this row has no field at all, and the
								 * host's snapshot is what lands here — so the default is named, not
								 * assumed. undefined would print as a readout of its own. */
								defaultValue: value.wallLight ?? DEFAULTS.wallLight,
								disabled: writable,
								"aria-label": t("wallLight.title"),
								/* Painting on every step, committing on release: a brightness dial you
								 * cannot watch while dragging it is a dial you have to guess at. */
								onChange: (event) => {
									const next = Number(event.currentTarget.value);
									showValue("wallLight", next);
									paintWallLight(next);
								},
								onPointerUp: (event) => setField("wallLight", Number(event.currentTarget.value)),
								onKeyUp: (event) => setField("wallLight", Number(event.currentTarget.value)),
								onBlur: (event) => setField("wallLight", Number(event.currentTarget.value)),
							}),
							h("span", {
								className: "dsh-ink-value",
								key: "value",
							}, (shown.wallLight ?? value.wallLight ?? DEFAULTS.wallLight) + "%"),
						]),
					]),
					h("div", { className: "dsh-ink-row", key: "sound" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("sound.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("sound.description")),
						]),
						h(Switch, {
							key: "switch",
							checked: value.sound,
							disabled,
							label: t("sound.title"),
							onChange: (next) => setField("sound", next),
						}),
					]),
					h("div", { className: "dsh-ink-row", key: "volume" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("volume.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("volume.description")),
						]),
						h("div", { key: "control", style: { display: "flex", alignItems: "center", gap: "12px" } }, [
							h("input", {
								key: "slider",
								className: "dsh-ink-slider",
								type: "range",
								min: 0,
								max: 100,
								step: 1,
								defaultValue: value.volume,
								disabled,
								"aria-label": t("volume.title"),
								onChange: (event) => showValue("volume", Number(event.currentTarget.value)),
								onPointerUp: (event) => setField("volume", Number(event.currentTarget.value)),
								onKeyUp: (event) => setField("volume", Number(event.currentTarget.value)),
								onBlur: (event) => setField("volume", Number(event.currentTarget.value)),
							}),
							h("span", { className: "dsh-ink-value", key: "value" }, (shown.volume ?? value.volume) + "%"),
						]),
					]),
					h("div", { className: "dsh-ink-row", key: "duration" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("duration.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("duration.description")),
						]),
						h("div", { key: "control", style: { display: "flex", alignItems: "center", gap: "12px" } }, [
							h("input", {
								key: "slider",
								className: "dsh-ink-slider",
								type: "range",
								min: 900,
								max: 4000,
								step: 100,
								defaultValue: ms,
								disabled,
								"aria-label": t("duration.title"),
								onChange: (event) => showValue("duration", Number(event.currentTarget.value)),
								onPointerUp: (event) => setField("duration", Number(event.currentTarget.value)),
								onKeyUp: (event) => setField("duration", Number(event.currentTarget.value)),
								onBlur: (event) => setField("duration", Number(event.currentTarget.value)),
							}),
							h("span", { className: "dsh-ink-value", key: "value" }, (shown.duration ?? ms) + " ms"),
						]),
					]),
					h("div", { className: "dsh-ink-row", key: "replay" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("replay.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("replay.description")),
						]),
						h(Button, {
							key: "button",
							variant: "outline",
							size: "sm",
							onClick: () => replay(),
						}, t("replay.action")),
					]),
					h("div", { className: "dsh-ink-row", key: "audio" }, [
						h("div", { key: "text" }, [
							h("div", { className: "dsh-ink-row-title", key: "title" }, t("audio.title")),
							h("div", { className: "dsh-ink-row-desc", key: "description" }, t("audio.description")),
						]),
						h("span", {
							key: "flag",
							className: "dsh-ink-flag",
							dataset: { ok: String(audio.state === "running") },
						}, audio.state + " · " + report.audioPeak),
					]),
					/* The measured receipt of the last boot used to be printed here. He asked
					that block out of the page: the same numbers are in .boot.json and in
					the inject log, which is where a measurement belongs. */
				]),
			]);
		}
		//#endregion

		//#region wiring
		const inject = ["configForms", "slots", "locale"];

		const zh = {
			nav: "开屏水墨",
			loading: "读取配置…",
			"page.title": "开屏水墨",
			"page.intro": "一条墨锋扫过整幅：背景、字标与落印共用同一条进度曲线，所以三轴怎么搭配都不会各动各的。",
			"enabled.title": "开屏动画",
			"enabled.description": "关闭后启动过程保持内核原样。",
			"wordmark.title": "字标",
			"wordmark.description": "墨如何落在纸上。",
			"wordmark.wet": "湿墨洇显",
			"wordmark.dry": "枯笔疾书",
			"background.title": "背景运笔",
			"background.description": "墨锋走过画面的方向。",
			"background.sweep": "横扫",
			"background.rise": "山起",
			"background.bloom": "生山",
			"artwork.title": "画面",
			"theme.title": "界面主题",
			"theme.description": "把整套界面换成同一张纸上的墨：面板变玻璃、边界变界牙、选中变笔锋。这里只管主题，深浅两色制各一套，选完立刻生效。",
			"theme.off": "跟随应用",
			"theme.ink-jianghu": "宣纸",
			"theme.ink-jianghu-dark": "夜山",
			"wallLight.title": "壁纸亮度",
			"wallLight.description": "只压壁纸那张画本身：纸纹、压在上层的纸和正文文字都不跟着动。往里压暗，往外提亮成雾，100% 就是原画。",
			"artwork.description": "画里站着谁；深浅主题各配一张。",
			"artwork.hero": "侠客",
			"artwork.whale": "鲸娘",
			"voice.title": "声音档",
			"voice.description": "三种古风写法，都是琴、箫、水滴、磬加一室混响，没有一声是笔锋摩擦的沙沙。改完点下面的重播立刻能听。",
			"voice.paper": "墨韵",
			"voice.guqin": "古琴",
			"voice.bed": "空山",
			"sound.title": "开屏音效",
			"sound.description": "全部实时合成，不打包音频文件；发声随墨锋强弱，具体哪几件出声由下面的声音档决定。",
			"volume.title": "音量",
			"volume.description": "混音本身很轻——这是两秒的开屏，不是提醒。",
			"duration.title": "重播时长",
			"duration.description": "只影响下面的重播预览；真实开屏跟着加载进度走。",
			"replay.title": "预览重播",
			"replay.description": "用当前搭配重放一次开屏（含声音），改完立刻看到结果。",
			"replay.action": "重播",
			"audio.title": "启动时音频状态",
			"audio.description": "上次开屏真实拿到的 AudioContext 状态。浏览器策略可能在没有用户手势前挂起音频，这一格是实测，不是设置。",
		};
		const en = {
			nav: "Ink Splash",
			loading: "Loading configuration…",
			"page.title": "Ink Splash",
			"page.intro": "One ink front crosses the whole frame: landscape, wordmark and seal all read the same progress curve, so any combination of axes stays in step.",
			"enabled.title": "Splash animation",
			"enabled.description": "When off, startup keeps the kernel's own boot page.",
			"wordmark.title": "Wordmark",
			"wordmark.description": "How the ink lands on paper.",
			"wordmark.wet": "Wet wash",
			"wordmark.dry": "Dry brush",
			"background.title": "Brush motion",
			"background.description": "The direction the front travels.",
			"background.sweep": "Sweep",
			"background.rise": "Rise",
			"background.bloom": "Bloom",
			"artwork.title": "Artwork",
			"theme.title": "Interface theme",
			"theme.description": "Turns the whole application into the same ink on the same paper: glass panels, toothed borders, a brush stroke for the selected tab. This is the theme only — two palettes, one per colour scheme, applied the moment you choose.",
			"theme.off": "Follow the app",
			"theme.ink-jianghu": "Paper",
			"theme.ink-jianghu-dark": "Night",
			"wallLight.title": "Wallpaper brightness",
			"wallLight.description": "Moves the painting itself only: the fibre, the paper washes above it and the text all stay put. Inward dims it, outward lifts it into mist; 100% is the shipped picture.",
			"artwork.description": "Who stands in the painting; each theme pairs its own.",
			"artwork.hero": "Swordsman",
			"artwork.whale": "Whale maiden",
			"voice.title": "Sound recipe",
			"voice.description": "Three 古风 settings, each built from a plucked string, a xiao, water and one room — no brush friction in any of them. Press replay below to hear it at once.",
			"voice.paper": "Ink resonance",
			"voice.guqin": "Guqin",
			"voice.bed": "Empty hills",
			"sound.title": "Splash sound",
			"sound.description": "Everything is synthesised at boot, no audio files; the level follows the brush, and the recipe below decides which parts speak.",
			"volume.title": "Volume",
			"volume.description": "The mix is quiet by design: this is a two-second splash, not an alert.",
			"duration.title": "Replay length",
			"duration.description": "Paces the replay below only; the real splash follows load progress.",
			"replay.title": "Preview replay",
			"replay.description": "Replay the current combination once, sound included.",
			"replay.action": "Replay",
			"audio.title": "Audio state at startup",
			"audio.description": "The AudioContext state the last splash actually got. Browser policy can hold audio suspended until a user gesture — this cell is measured, not configured.",
		};

		function readCache() {
			return readJson(CACHE_KEY);
		}

		/** One JSON value under one key, or undefined. The theme preference and the config
		 * mirror are different facts with the same storage shape, and a second hand-rolled
		 * try/catch per key is how one of them stops being parseable. */
		function readJson(key) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? undefined : JSON.parse(raw);
			} catch (error) {
				return undefined;
			}
		}

		function writeJson(key, value) {
			try {
				if (value === null) window.localStorage.removeItem(key);
				else window.localStorage.setItem(key, JSON.stringify(value));
			} catch (error) { /* a private mode without storage is not a reason to stop */ }
		}

		/** Edits this document made, kept until the Host's own document agrees. A preview
		 * must show them the instant they are made — the served snapshot can lag an edit —
		 * but they must not hand the whole mirror a permanent veto over the served
		 * document: measured 2026-10-17, the mirror was stale at the schema defaults and a
		 * replay painted the wrong combination. */
		const pendingEdits = new Map();

		function writeCache(value) {
			try {
				window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
			} catch (error) {
				// A private-mode quota is not worth failing boot over.
			}
			/* The host needs the same fact at index-build time, before any renderer storage
			 * is consulted: the prelude reads localStorage, but the baked CONFIG and the film
			 * choice are made in the host half. Best-effort — a refused POST leaves the
			 * localStorage mirror, which is what a replay reads anyway. */
			try {
				const sent = window.fetch("/ink-splash/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(value),
					credentials: "omit",
				});
				if (sent !== undefined && typeof sent.catch === "function") sent.catch(() => {});
			} catch (error) {
				// no fetch, no route: the mirror above still stands
			}
		}

		/** What the last boot actually measured; the settings page shows this verbatim. */
		const audio = { state: "not yet measured" };
		const report = {
			css: "not yet measured", frame: "not yet measured", handover: "-", boot: "-",
			loadingDoneAt: "-", pace: "-", loaf: "-", mount: "-", audioPeak: "-", doneBy: undefined, error: "-",
			docs: "-", frames: "-", retake: "-", rewind: "-", origin: "-", stall: "-", steps: "-",
			served: "-", applied: "-", mirror: "-", snapshot: "-", warp: "-", theme: "-", movie: "-", clip: "-", skin: "-",
			wall: "-", layers: "-", assets: "-",
		};

		/* ---------- 应用内壁纸的亮度 ----------
		 * The name the wallpaper stacks read. One constant because the two ends live in
		 * different files: a renamed half here is a knob that moves nothing and says nothing.
		 * `--dsh-ink-walllight` deliberately does not reuse `--dsh-ink-washo`, which is the
		 * opening's own wash layer. */
		const WALLLIGHT_VAR = "--dsh-ink-walllight";

		/** The one mapping from the 壁纸亮度 number to a colour: a veil laid on top of the
		 * painting and under the paper, so the dial moves the picture without touching the
		 * fibre, the washes, or a single glyph.
		 *
		 * Both directions are a source-over veil, which is exactly the two halves of a
		 * brightness control in 8-bit terms: black at alpha (1 - b) scales every channel down,
		 * white at alpha (b - 1) lifts it and caps the highlights, which is what fog does to a
		 * landscape. 100 % is `transparent`, i.e. the pixels shipped before this row existed.
		 *
		 * Total on purpose. An invalid custom-property value does not merely drop the one
		 * layer: it makes the whole `background-image` list invalid at computed-value time, so
		 * the wallpaper would vanish rather than dim. Every input answers a colour. */
		function wallWash(light) {
			const b = Number(light);
			if (!(b > 0)) return "transparent";
			const t = Math.min(Math.abs(100 - b) / 100, 1);
			if (t === 0) return "transparent";
			return "rgba(" + (b < 100 ? "0, 0, 0, " : "255, 255, 255, ") + t.toFixed(3) + ")";
		}

		/** Put the current brightness on the root, where every wallpaper rule reads it. The
		 * stylesheet's own fallback is `transparent`, so a document that never runs this still
		 * paints the shipped picture.
		 *
		 * Three triggers, one writer: the mirror at activation (the wallpaper has to be right
		 * before the theme marker goes up), every step of the slider (a brightness dial you
		 * cannot watch while dragging is not a dial), and the served snapshot (an edit made in
		 * another window). */
		function paintWallLight(light) {
			const wash = wallWash(light);
			document.documentElement.style.setProperty(WALLLIGHT_VAR, wash);
			/* The read-back is the difference between "the knob was turned" and "the document
			 * carries the colour": an unregistered custom property comes back verbatim. */
			report.wall = String(light) + " → " + wash + " · 读到 "
				+ (getComputedStyle(document.documentElement).getPropertyValue(WALLLIGHT_VAR).trim() || "空");
		}

		/** Hand the measured facts to the Host half, which appends them to .boot.json. */
		function sendReport() {
			fetch("/ink-splash/boot-report", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...report, audio: audio.state }),
			}).catch(() => {});
		}

		/** Called as early as possible: proves the chunk ran and the route answers. */
		function reportNow(stage) {
			report.stage = stage;
			sendReport();
		}

		/**
		 * What the frame on screen actually is, read off that frame.
		 *
		 * The ink state and the picture can disagree: on 2026-07-17 the receipt said the
		 * stroke ran to 47 % while the window showed bare paper, a progress bar and sound,
		 * and nothing recorded *why*. Every layer answers with its own state — the splash
		 * mode the palette chose, whether the film decoded, and each mover's display and
		 * opacity — so the next reading of `.boot.json` settles it instead of another
		 * round of guesses.
		 *
		 * Must be read while the node is still connected: `getComputedStyle` on a
		 * detached element answers with empty strings for every custom property.
		 * @param root - the frame to inspect.
		 */
		function layerState(root) {
			if (root === undefined || root === null) return "no frame";
			if (root.isConnected !== true) return "frame detached";
			const shown = (sel) => {
				const node = root.querySelector(sel);
				if (node === null) return sel + "=absent";
				const s = getComputedStyle(node);
				return sel + "=" + s.display + "/" + (s.opacity === "" ? "?" : s.opacity);
			};
			const film = root.querySelector(".dsh-ink-film");
			const scene = root.querySelector(".dsh-ink-scene");
			const clock = getComputedStyle(root).getPropertyValue("--dsh-ink-p").trim();
			/* The geometry that decides whether the picture is painted or merely present:
			 * an element can be display:block, opacity:1 and still be invisible because a
			 * later sibling (the paper curtain) covers it, or because its own box is 0x0,
			 * or because the style engine refused the url(). Each of those shows here. */
			const box = (sel) => {
				const node = root.querySelector(sel);
				if (node === null) return sel + "=absent";
				const s = getComputedStyle(node);
				const r = node.getBoundingClientRect();
				return sel + "{" + Math.round(r.width) + "x" + Math.round(r.height)
					+ " op=" + s.opacity + " tf=" + String(s.transform)
					+ " bg=" + (s.backgroundImage === "none" ? "none" : "yes")
					+ (s.maskImage !== "none" ? " mask=" + (s.maskImage === "" ? "?" : "yes") : "") + "}";
			};
			return [root.dataset.word + "/" + root.dataset.bg + "/" + root.dataset.art,
				"splash=" + (root.dataset.splash ?? "live"),
				"p=" + (clock === "" ? "?" : clock),
				"sceneBg=" + (scene === null ? "-" : getComputedStyle(scene).backgroundImage),
				"filmSrc=" + (film === null ? "-" : (film.getAttribute("src") ?? "-").split("/").pop()),
				"filmReady=" + (film === null ? "-" : film.readyState),
				/* The custom properties that carry every picture and mask. An empty one
				 * paints nothing — and a failing mask paints nothing *silently*, which is
				 * how a frame can be display:block/opacity:1 and still be invisible.
				 * `theme`/`paper`/`grad` are here because a missing `--dsh-ink-grad` makes
				 * `background: var(--dsh-ink-grad)` compute to `none` (the word layer), and
				 * a missing `--dsh-ink-paper` invalidates the curtain's paper stop. */
				"vars[theme=" + (root.dataset.theme ?? "MISSING")
					+ " paper=" + String(getComputedStyle(root).getPropertyValue("--dsh-ink-paper")).trim()
					+ " grad=" + (String(getComputedStyle(root).getPropertyValue("--dsh-ink-grad")).trim() === "" ? "EMPTY" : "set")
					+ " solid=" + String(getComputedStyle(root).getPropertyValue("--dsh-ink-solid")).trim()
					+ " w=" + String(getComputedStyle(root).getPropertyValue("--dsh-ink-wm")).trim()
					+ " b=" + String(getComputedStyle(root).getPropertyValue("--dsh-ink-bg")).trim() + "]",
				shown(".dsh-ink-paint"), shown(".dsh-ink-mark"), shown(".dsh-ink-word"),
				shown(".dsh-ink-prog"),
				box(".dsh-ink-scene"), box(".dsh-ink-curtain"), box(".dsh-ink-mark"),
				box(".dsh-ink-word")].join(" · ");
		}

		/**
		 * Which address the *paint* stack can actually load, not just `fetch`.
		 *
		 * `fetch` and the network stack are different clients. Measured 2026-07-17: a
		 * `fetch("/ink-splash/bg-night.jpg")` from the page returned 200 with the right
		 * bytes (85474B, ffd8ff), while the screen was 99.4 % bare `#15161b` paper with
		 * only the gradient progress bar on it — i.e. every layer that paints a `url()`
		 * produced nothing. So the question is not "can `fetch` reach it" but "can an
		 * `Image` reach it", which is the same stack CSS `url()` and `<video src>` use.
		 *
		 * Both forms are tried, and the answer is recorded as naturalWidth (0 = the
		 * image never decoded):
		 *   relative — `/ink-splash/…`, which the document resolves against its base URI;
		 *   absolute — the Host origin the Desktop publishes.
		 * @param absolute - the absolute prefix, or "" when the document has no origin.
		 * @returns a compact line for the receipt.
		 */
		async function assetProbe(absolute) {
			const load = (src) => new Promise((resolve) => {
				const img = new Image();
				let settled = false;
				const done = (value) => { if (settled !== true) { settled = true; resolve(value); } };
				img.onload = () => done(img.naturalWidth + "x" + img.naturalHeight);
				img.onerror = () => done("error");
				window.setTimeout(() => done("timeout"), 4000);
				img.src = src;
			});
			const relative = await load("/ink-splash/bg-night.jpg");
			const byAbsolute = absolute === "" ? "n/a" : await load(absolute + "bg-night.jpg");
			/* A picture that decodes is not the same as a picture that may be READ.
			 * CSS masks and backgrounds are painted by the same decoder, so this pixel
			 * read is the closest in-page proxy for "would the style engine paint it":
			 * a tainted canvas (SecurityError) means the response carried no CORS
			 * clearance, which is exactly how a custom-scheme subresource gets silently
			 * refused for CSS while a <video> still plays. */
			const pixel = await new Promise((resolve) => {
				const img = new Image();
				img.onload = () => {
					try {
						const canvas = document.createElement("canvas");
						canvas.width = 1;
						canvas.height = 1;
						const ctx = canvas.getContext("2d");
						ctx.drawImage(img, 0, 0, 1, 1);
						const data = ctx.getImageData(0, 0, 1, 1).data;
						resolve("rgb(" + data[0] + "," + data[1] + "," + data[2] + ")");
					} catch (error) {
						resolve("tainted:" + String(error?.name ?? error));
					}
				};
				img.onerror = () => resolve("error");
				img.src = "/ink-splash/bg-night.jpg";
			});
			return "img-relative=" + relative + " img-absolute=" + byAbsolute + " pixel=" + pixel;
		}


		/** Did the injected stylesheet actually reach the document? Desktop renders rows. */
		function cssState() {
			for (const tag of document.querySelectorAll("head style")) {
				if (typeof tag.textContent === "string" && tag.textContent.includes(".dsh-ink-letters")) return "injected";
			}
			return "MISSING";
		}

		let live = undefined;

		/**
		 * Which frame the boot path paints on — and whether it may paint on one at all.
		 * Ownership hangs on the document, not on this module: a chunk evaluated twice
		 * resets `live` and would otherwise build a second frame over the painting
		 * already moving, which is the stroke restarting halfway.
		 * @returns `{ taken, prelude, frame }`; an undefined `frame` means none exists.
		 */
		function adoptBootFrame(ink) {
			const prelude = ink.prelude;
			if (ink.taken === true) return { taken: true, prelude, frame: undefined };
			return { taken: false, prelude, frame: prelude ?? document.querySelector(".dsh-ink-root") ?? undefined };
		}

		/**
		 * One precedence for both the boot path and the preview: the mirror always, and
		 * the served document on top of it only once the Host has actually answered with
		 * it. `status` is the host's own word for that — its namespace controller reports
		 * `loading` then `ready`, and a `loading` snapshot still carries the schema
		 * default, which is exactly the value that must never win.
		 */
		function resolveConfig(served, cached) {
			/* defaults ← the mirror ← the served document, the served document only once
			 * the Host has actually answered. The mirror is a fill-in, not an oracle:
			 * measured 2026-10-17, it was stale at the schema defaults while the Host
			 * baked the user's own axes, and anything that let it outrank a served
			 * document painted 横扫/人物 under a 生山/鲸落 receipt. Edits made in this
			 * document are carried separately (`pendingEdits`), so a preview still shows
			 * a change the instant it is made without giving the whole mirror a veto. */
			return {
				...DEFAULTS,
				...cached,
				...(served !== undefined && served !== null && served.status === "ready" ? served.value : {}),
			};
		}

		/**
		 * The settings nav glyph, declared — not repainted.
		 *
		 * `navIcon(id)` in the shipped shell is a hard-coded if-chain whose final return
		 * is the gear, so a third-party page wears 通用设置's icon unless it fills the
		 * seat the shell already renders: `settings.section.icon` is a root list "addressed
		 * by the matching settings.section id", and the shell keeps its own glyph only
		 * when nothing matches. That is the whole of the bug behind 「图标不是自定义图标」.
		 *
		 * `paintNavGlyph` below stays as the fallback for a shell that predates the slot;
		 * it finds the row by its label text, never by a CSS-module class name, because
		 * those hashes (`AnXs9G_navCell`) are rebuilt per version.
		 */
		const NAV_PANEL = "[data-shortcut-modal=\"settings\"]";
		/* Both dictionaries' labels, because the nav row is matched on its text and the
		 * user may browse the settings in either language. */
		const NAV_LABELS = [zh.nav, en.nav];
		const GLYPH_PATHS = [
			"M8 2.2c2.4 2.6 3.7 4.4 3.7 5.9a3.7 3.7 0 1 1-7.4 0c0-1.5 1.3-3.3 3.7-5.9Z",
			"M2.2 12.6c1.7 1.2 3.6 1.8 5.8 1.8s4.1-.6 5.8-1.8",
		];

		/** The nav seat itself: one ink drop over one swell, drawn in the host's series —
		 * 16 viewBox, no fill, 1.3 stroke, currentColor — so it inherits the row's own
		 * colour in both skins. The row's label names the page, so the glyph is hidden
		 * from the accessibility tree rather than given a second name. */
		function InkSplashNavIcon({ size = 16 }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				"aria-hidden": "true",
				"data-dsh-ink-glyph": "1",
			}, GLYPH_PATHS.map((d) => h("path", { d, key: d })));
		}

		/** @returns how many rows were repainted, which is 0 for almost every mutation. */
		function paintNavGlyph(labels) {
			const panel = document.querySelector(NAV_PANEL);
			if (panel === null) return 0;
			const nav = panel.querySelector("nav");
			if (nav === null) return 0;
			let done = 0;
			for (const cell of nav.querySelectorAll("button")) {
				/* The cell's own text is the label and nothing else: the icon seat is an
				 * empty span rendered *above* it, so `querySelector("span")` finds the icon
				 * and every row reads as unlabelled — which is why the gear survived. */
				if (labels.indexOf((cell.textContent || "").trim()) < 0) continue;
				const svg = cell.querySelector("svg");
				if (svg === null || svg.getAttribute("data-dsh-ink-glyph") === "1") continue;
				while (svg.firstChild !== null) svg.removeChild(svg.firstChild);
				svg.setAttribute("viewBox", "0 0 16 16");
				svg.setAttribute("width", "16");
				svg.setAttribute("height", "16");
				svg.setAttribute("fill", "none");
				svg.setAttribute("stroke-width", "1.3");
				for (const d of GLYPH_PATHS) {
					const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path.setAttribute("d", d);
					path.setAttribute("stroke", "currentColor");
					path.setAttribute("fill", "none");
					svg.appendChild(path);
				}
				svg.setAttribute("data-dsh-ink-glyph", "1");
				done += 1;
			}
			return done;
		}

		/** Where the last non-ink preference lived, so 关 restores what the user had. */
		const THEME_CACHE_KEY = "dsh-ink-splash:theme";
		/** The ink theme the user last picked, mirrored for the same reason the splash axes
		 * are: the host resets a preference that points at a theme it has not seen registered,
		 * and at boot that is exactly the state it wakes in — the registration happens later
		 * than the restore. Without this mirror the choice dies with the process. */
		const THEME_CHOSEN_KEY = "dsh-ink-splash:theme-chosen";

		/**
		 * 水墨江湖 · the theme half.
		 *
		 * The table comes from `lib/theme.js` through the prelude row, so the ids, the
		 * tokens and the component stylesheet all start from one source. Registration is
		 * the only sanctioned way in — `setTheme` for the preference, `theme/change` to
		 * follow it — and both definitions are disposed on unload, which the contract says
		 * resets a preference that pointed at them, so removing the plugin cannot leave the
		 * app wearing a palette nobody registered.
		 *
		 * The marker is ours: the app's presenter writes the tokens and `color-scheme` but
		 * never the theme id, and the component CSS is scoped on that attribute, so without
		 * this the sheet would either never apply or apply to everyone.
		 */
		/** Registered on an injected scope: `ctx.theme` only exists on the child context
		 * that declared the dependency. */
		function registerInkTheme(ctx) {
			/* Reading `ctx.theme` outside an injected scope throws "cannot get property
		 * \"theme\" without inject" — the receipt said exactly that while the row showed a
		 * single option, because registration never got as far as the ids. */
			if (typeof ctx.theme?.register !== "function") {
				inkTheme.state = "未注册：这个上下文里没有主题服务";
				return;
			}
			const table = window.__DSH_INK__?.theme;
			if (table === undefined || Array.isArray(table.themes) !== true || table.themes.length === 0) {
				inkTheme.state = "未注入：prelude 行里没有主题表";
				return;
			}
			const ids = table.themes.map((t) => t.id);
			for (const def of table.themes) {
				ctx.effect(() => ctx.theme.register({
					id: def.id,
					colorScheme: def.colorScheme,
					tokens: def.tokens,
				}), PKG + ": theme " + def.id);
			}
			/** Keep the durable preference as the baseline. `light`/`dark`/`system` are the only
			 * values the registry persists (`setTheme` writes the store for those three and for
			 * nothing else), so an ink pick lives in memory while the store keeps naming whatever the
			 * user had before it — and that stored value is the one thing that tells a replay of the
			 * store apart from a new decision. Written on every non-ink snapshot, so it cannot go
			 * stale: leaving to 白天 makes 白天 the baseline, and the next ink pick is judged
			 * against it. While an ink theme is active the preference *is* the ink id, so this is a
			 * no-op and the baseline keeps holding the store's value. */
			const remember = (durable) => {
				if (typeof durable !== "string" || ids.includes(durable)) return;
				writeJson(THEME_CACHE_KEY, durable);
			};
			/* Why the timed grace window is gone: it scheduled the suspicion instead of judging it.
			 * A settings write from anywhere — 音量, 重播时长, this wallpaper dial, another plugin's
			 * row — makes the theme registry re-adopt its durable section, and that section still
			 * names the pre-ink value, so a non-ink snapshot can arrive minutes into a session and is
			 * indistinguishable from the boot churn the window was built to forgive. His report was
			 * exactly that: 拖壁纸亮度, 主题没了 — and the old rule deleted the mirror too, so nothing
			 * could bring the theme back. */
			let replayed = 0;
			const paint = (snapshot) => {
				const active = snapshot?.active?.id;
				const durable = snapshot?.preference;
				const on = ids.includes(active);
				/* Read the baseline before refreshing it: comparing a value against itself would
				 * call every replay a decision and every decision a replay. */
				const back = readJson(THEME_CACHE_KEY);
				remember(durable);
				let wanted;
				if (on) {
					wanted = active;
					writeJson(THEME_CHOSEN_KEY, active);
					document.documentElement.setAttribute(table.marker, active);
				} else {
					const chosen = readJson(THEME_CHOSEN_KEY);
					/* Three conditions, because each one has been a false accusation: the pick must
					 * still be mirrored, it must still be **registered** (a real dispose — the plugin
					 * unloaded — is a real leave, and re-asserting an unregistered id would throw), and
					 * the snapshot must name the baseline rather than something the user chose since. */
					const replay = typeof chosen === "string" && ids.includes(chosen)
						&& (snapshot?.themes ?? []).some((t) => t.id === chosen)
						&& durable === back;
					wanted = replay ? chosen : undefined;
					if (replay) {
						replayed += 1;
						/* The marker rides straight through the replay. Dropping it here is the flash
						 * he would see even when the re-assert lands one publish later, and the palette
						 * is still registered and about to be re-applied. */
						document.documentElement.setAttribute(table.marker, chosen);
					} else {
						writeJson(THEME_CHOSEN_KEY, null);
						document.documentElement.removeAttribute(table.marker);
					}
				}
				inkTheme.active = wanted;
				inkTheme.preference = durable ?? "-";
				/* Counted on the live element, not on the definition: a registered theme whose
				 * tokens never reached <body> would otherwise be reported as applied. */
				let written = 0;
				for (let i = 0; i < document.body.style.length; i += 1) {
					if (/^--dsw-/.test(document.body.style.item(i))) written += 1;
				}
				inkTheme.state = (wanted ? "已应用 " + wanted : "未启用（当前 " + inkTheme.preference + "）")
					+ " · body 上生效的 --dsw- token " + written + " 个"
					+ " · 注册 " + ids.length + " 套"
					+ " · 基线 " + (readJson(THEME_CACHE_KEY) ?? "无")
					+ " · 重放接回 " + replayed + " 次";
				inkTheme.notify();
				/* Last, not first: `setTheme` publishes synchronously, so the nested paint has to be
				 * the one that writes the final state — otherwise this call would overwrite it with
				 * the very snapshot it is reacting to. */
				if (wanted !== undefined && wanted !== active) ctx.theme.setTheme(wanted);
			};
			/* The boot case the old code carried by hand — the saved preference names a theme the
			 * registry has not seen registered yet, so the host wakes on the base palette with the
			 * mirror intact — needs no special pass now: that wake-up is a non-ink active with the
			 * mirror still pointing at a registered theme and the snapshot naming the stored value,
			 * which is exactly the replay rule above. One paint, one decision path. */
			paint(ctx.theme.getTheme());
			/* `ctx.on(name, callback)` — the same call the application's own theme presenter and
			 * its settings-account row use. `ctx.events` is the bus underneath that helper,
			 * and `ctx.events.on` is not a method: calling it threw during activation, and an
			 * entry that throws is refused, which took the whole plugin down. */
			ctx.effect(() => ctx.on("theme/change", paint), PKG + ": theme marker");
			inkTheme.ids = ids;
			inkTheme.set = (id) => {
				if (id === "off") {
					const back = readJson(THEME_CACHE_KEY) ?? "system";
					writeJson(THEME_CACHE_KEY, null);
					writeJson(THEME_CHOSEN_KEY, null);
					ctx.theme.setTheme(String(back));
					return;
				}
				writeJson(THEME_CHOSEN_KEY, id);
				ctx.theme.setTheme(id);
			};
		}

		/** The theme is not part of the plugin's own config form, so the settings row cannot
		 * get it through `useConfig`; it subscribes instead. `paint` calls these after every
		 * `theme/change`, which is also the only path that knows a theme was changed from
		 * somewhere else (another window, the built-in appearance picker). */
		const inkTheme = {
			ids: [], active: undefined, preference: "-", state: "未注册", set: () => undefined,
			listeners: [],
			subscribe(fn) {
				this.listeners.push(fn);
				return () => { this.listeners = this.listeners.filter((x) => x !== fn); };
			},
			notify() {
				for (const fn of this.listeners) fn();
			},
		};

		function apply(ctx) {
			/* The wallpaper's brightness goes on before the theme is even registered: the
			 * marker can go up inside `registerInkTheme` below, and a document that starts
			 * wearing 宣纸 a beat before this ran would show the picture at 100 % first and
			 * dim afterwards. The axes the Host baked are the freshest copy on this disk
			 * (it merges its own mirror of the last applied document), so they win over the
			 * browser mirror for the same reason they win in the prelude: measured
			 * 2026-10-17, the browser mirror was stale at the schema defaults and the boot
			 * stayed at 100 % brightness while the saved value was 40. */
			const coldConfig = window.__DSH_INK__ !== undefined && window.__DSH_INK__ !== null
				? window.__DSH_INK__.CONFIG : undefined;
			paintWallLight(coldConfig?.wallLight ?? readCache()?.wallLight);
			// Register before binding, in this order: the effect body runs at
			// declaration, and binding an unregistered namespace is not a thing
			// the shipped precedent does.
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), PKG + ": dictionaries");
			/* Fenced separately from the rest of activation, and deliberately not inside the
			 * splash's own try: an interface theme is a decoration, and the way a decoration
			 * fails is by not appearing, never by taking the plugin down with it. */
			try {
				ctx.inject(["theme"], (child) => registerInkTheme(child));
			} catch (error) {
				inkTheme.state = "注册失败：" + String(error && error.message || error);
				try { document.documentElement.removeAttribute("data-dsh-ink-theme"); } catch (inner) { /* no document at all */ }
			}
			/* Written here, not only at the end of the stroke: the theme state has to reach the
			 * receipt even when the splash is switched off, which is exactly the case where
			 * nothing else reports and a silent failure would be invisible. */
			report.theme = inkTheme.state;
			const t = ctx.locale.bind(NS);
			const form = ctx.configForms.get(NS);
			/* Only a *served* document may rewrite the mirror. `getSnapshot()` answers
			 * before the Host has read the saved document — the same race that makes the
			 * index-time config the schema default — and writing that would overwrite the
			 * mirror the pre-roll had just read, which is what makes a changed axis show
			 * up one boot late. The same rule decides the merge order below. */
			const served = form.getSnapshot();
			/* `servedValue`, not `live`: the boot path below assigns the module's own
			 * `live = splash`, and a `const live` in this scope would shadow it and throw
			 * on the one path that has no replay to fall back on. */
			const servedValue = served?.status === "ready" ? served.value : undefined;
			if (servedValue !== undefined && servedValue !== null) writeCache(servedValue);
			const cached = readCache() ?? {};
			const resolved = resolveConfig(served, cached);
			/* The frame is already on screen, built by the prelude from the axes the Host
			 * baked at index time, and its inline `--dsh-ink-dur` is the clock it is
			 * running. The splash must wear those axes, not a second opinion from the
			 * config document or the mirror: measured 2026-10-17, the receipt's Host
			 * config (wet/bloom/whale, 4000) and the config the browser resolved
			 * (wet/sweep/hero, 2600) disagreed, and the frame is the one the eye sees.
			 * Pacing the clock from a duration the running animation does not have would
			 * also cut the stroke short at the wrong ratio. */
			const ink = window.__DSH_INK__;
			const inkAxes = ink !== undefined && ink !== null ? ink.CONFIG : undefined;
			const config = inkAxes !== undefined && inkAxes !== null ? { ...DEFAULTS, ...inkAxes } : resolved;
			report.served = JSON.stringify(resolved);
			report.applied = JSON.stringify(config);
			report.mirror = JSON.stringify(cached);
			report.snapshot = String(served?.status ?? "none") + (servedValue === undefined ? " (no served document)" : " (served wins)");
			reportNow("applied");

			// The boot path: mount, follow the kernel's own entry states, and
			// measure the audio verdict on the way in.
			ctx.effect(() => {
				// Fenced on purpose: the web boot audit rejects startup when an
				// entry throws, so a visual failure has to degrade to "no splash"
				// here rather than become a failed boot.
				try {
					const ink = window.__DSH_INK__;
					if (ink === undefined) {
						// The Host owns the frame; a second builder here would be a
						// second source of truth for the same markup.
						console.error(PKG + ": prelude was not injected, nothing to take over");
						return undefined;
					}
					if (config.enabled === false
						|| window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
						// The frame can already be on screen from the served index.
						ink.prelude?.remove();
						return undefined;
					}
					// Ownership is recorded on the document, not in this module: a chunk
					// that gets evaluated a second time resets `live` to undefined and would
					// build a second frame over the one already painting.
					const boot = adoptBootFrame(ink);
					if (boot.taken === true) {
						report.retake = Math.round(performance.now()) + "ms refused";
						return undefined;
					}

					// The residual jank, named rather than guessed: a long-animation-frame entry
					// says how long the frame took *and* which script held the main thread, so
					// "还有一点小卡" ends up owned by somebody specific.
					const loaf = { n: 0, worst: 0, owner: "-", paint: 0, layout: 0, blocked: 0, at: 0 };
					let loafWatcher = undefined;
					try {
						const watcher = new PerformanceObserver((list) => {
							for (const entry of list.getEntries()) {
								loaf.n += 1;
								loaf.at = performance.now();
								/* "nothing attributed" is not an answer: an entry carries where the frame
								 * stopped, so render time (rasterising my full-window layers, decoding a
								 * picture) separates from script time (somebody's bundle) by number. */
								const renderStart = Number(entry.renderStart ?? entry.startTime);
								loaf.paint += Math.max(0, Math.round(entry.duration - Math.max(0, renderStart - entry.startTime)));
								if (entry.styleAndLayoutStart !== undefined) {
									loaf.layout += Math.max(0, Math.round(renderStart - entry.styleAndLayoutStart));
								}
								loaf.blocked += Math.max(0, Math.round(entry.blockingDuration ?? 0));
								if (entry.duration <= loaf.worst) continue;
								loaf.worst = Math.round(entry.duration);
								const top = (entry.scripts ?? []).slice().sort((a, b) => b.duration - a.duration)[0];
								loaf.owner = top === undefined ? "nothing attributed"
									: String(top.sourceURL ?? top.invoker ?? "?").split("/").pop().slice(0, 40)
										+ " " + Math.round(top.duration) + "ms";
							}
						});
						watcher.observe({ type: "long-animation-frame", buffered: true });
						loafWatcher = watcher;
					} catch { /* the bundled Chromium may not expose LoAF */ }
					let sound = undefined;
					if (config.sound === true && config.volume > 0) {
						sound = new InkAudio(config);
						sound.open().then((state) => {
							audio.state = state;
							if (state === "running") sound.start();
						});
					}
					const splash = new InkSplash({ ...config, root: boot.frame, ink, audio: sound, longAt: () => loaf.at, onDone: () => finish() });
					ink.prelude = undefined;
					ink.taken = true;
					report.css = cssState();
					report.frame = boot.frame === undefined ? "built by the plugin (late)"
						: boot.frame === boot.prelude ? "adopted from the index" : "adopted an orphan frame";
					report.docs = ink.wit === undefined ? "-" : ink.wit.docs;
					// Two documents can paint the same origin's ink; timeOrigin is the only
					// number that says which document wrote which line.
					report.origin = Math.round(performance.timeOrigin);
					report.frames = ink.wit === undefined ? "-" : ink.wit.frames.join(" | ");
					report.handover = splash.p.toFixed(2);
					reportNow("mounted");
					live = splash;

					const root = document.getElementById("root") ?? document.body;
					const finish = (by) => {
						// The first trigger wins: a later watchdog pass must not relabel what
						// actually ended the stroke; timings come off the splash itself.
						report.doneBy = splash.doneBy ?? by ?? "boot-page";
						report.loadingDoneAt = splash.loadingDoneAt + "ms";
						report.boot = (splash.dismissedAt ?? 0) + "ms";
						report.pace = splash.holds + " holds · clock " + (splash.p * 100).toFixed(0) + "% · anim " + ((splash.anim ?? 0) * 100).toFixed(0) + "%";
					report.stall = splash.stallMs + "ms gap at " + (splash.stallAt * 100).toFixed(0) + "% of the stroke, " + splash.stallIn + "ms in";
					report.mount = splash.mountAt + "ms via " + splash.mountSignal;
					report.rewind = splash.rewind ?? "no";
					report.steps = splash.steps === "" ? "no layer stepped" : splash.steps;
					report.warp = splash.ambienceWitness ?? splash.ambience?.witness?.() ?? "never armed";
					/* Which mover held the background is the fact that decides whether the warp
					 * ran at all: `playing` means the clip did, and the engine stood down. */
					report.movie = String(splash.movieState ?? "none");
					/* Whether the boot was one decoded film or a dozen choreographed layers is the
					 * first fact about this splash's cost, so it is on the receipt next to the clip. */
					report.film = splash.filmState === "absent" ? "no film for these axes"
						: splash.filmState + " " + Math.round(splash.filmMs ?? 0) + "ms@" + splash.filmRate;
					report.clip = splash.clipAt ?? "-";
					/* Which palette the frame is wearing — the splash decides it before the
					 * browser half exists, and a wrong verdict is only visible as a picture. */
					report.skin = String(splash.root?.dataset?.theme ?? "-");
					report.theme = inkTheme.state;
					const loud = (splash.audio ?? audio).peak;
					report.audioPeak = loud <= 0 ? "no signal" : (20 * Math.log10(loud)).toFixed(1) + " dBFS";
					report.loaf = loaf.n + " long frames · worst " + loaf.worst + "ms · paint " + loaf.paint
						+ "ms · layout " + loaf.layout + "ms · blocking " + loaf.blocked + "ms · " + loaf.owner;
						report.samples = splash.samples.join(" ");
							report.trace = splash.trace.join(" ");
							/* Read while the frame is still connected — see `layerState`. */
							report.layers = splash.layerReport ?? layerState(splash.root);
							/* Which asset address the document can really fetch. Recorded after
							 * the stroke so two HEADs never sit in the splash's critical path. */
							const hostOrigin = window.__DSH_TRANSPORT__ !== undefined && window.__DSH_TRANSPORT__ !== null && typeof window.__DSH_TRANSPORT__.streamBaseUrl === "string" && window.__DSH_TRANSPORT__.streamBaseUrl !== "" ? window.__DSH_TRANSPORT__.streamBaseUrl.replace(/\/+$/, "") + "/ink-splash/" : "";
							void assetProbe(hostOrigin).then((line) => {
								report.assets = line;
								reportNow("probe");
							});
						reportNow("finished");
						splash.complete();
					};
					/* This callback fires on every mutation batch the application makes while it
					 * builds itself, so the node is looked up once and only its connection is
					 * re-read: a document-wide query per batch is a walk of the very tree the
					 * batch is about, which is how a diagnostic turns into the jank it measures.
					 * A node that is gone stays gone — the first branch hands over immediately —
					 * so the one case that keeps looking is "never seen", and it does so on a
					 * clock rather than on the mutation rate. */
					let bootNode = document.querySelector("[data-dsh-boot]");
					let lookedAt = performance.now();
					const observer = new MutationObserver(() => {
						if (bootNode !== null && bootNode.isConnected === true) return;
						const now = performance.now();
						if (bootNode === null && now - lookedAt < 200) return;
						lookedAt = now;
						const found = document.querySelector("[data-dsh-boot]");
						bootNode = found;
						if (found !== null && found.isConnected === true) return;
						observer.disconnect();
						finish();
					});
					observer.observe(root, { childList: true, subtree: true });
					// A failed entry can leave the kernel's own arc short forever; the
					// splash must never be what traps someone behind it.
					const watchdog = window.setTimeout(() => {
						observer.disconnect();
						finish("watchdog");
						// Reporting a stuck frame is not escaping it: the splash must never
						// be the thing that traps someone behind it, so this path tears it down.
						splash.dismiss();
					}, WATCHDOG_MS);
					return () => {
						window.clearTimeout(watchdog);
						observer.disconnect();
						loafWatcher?.disconnect();
					};
				} catch (error) {
					report.error = String(error?.message ?? error);
					reportNow("failed");
					console.error(PKG + ": splash skipped", error);
					return undefined;
				}
			}, PKG + ": splash");

			ctx.effect(() => form.subscribe((state) => {
				/* The same rule as at takeover: a change is worth mirroring only once the
				 * Host has accepted it, never while the form is still answering with the
				 * schema default. An edit this document already applied stays in
				 * `pendingEdits` until the Host's own document carries it back. */
				if (state?.status === "ready" && state.value !== undefined && state.value !== null) {
					for (const [field, value] of pendingEdits) {
						if (state.value[field] === value) pendingEdits.delete(field);
					}
					writeCache(state.value);
					/* And painted, because this subscription is the only path that learns
					 * about an edit made somewhere else — another window's settings page. */
					paintWallLight(state.value.wallLight);
				}
			}) ?? undefined, PKG + ": config cache");

			ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: NS,
				// 6 keeps it clear of the neighbouring plugin pages.
				order: 6,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({
					hooks: { config: form },
					setField: (field, value) => {
						/* The mirror decides the pre-roll's fill-in and the preview's fallback,
						 * so a panel edit has to land in it. Measured in his instance: four
						 * clicks on 开屏动画 left the mirror on `false` while the switch showed
						 * on, because the snapshot never re-emitted on an edit and the next
						 * start then painted nothing. */
						pendingEdits.set(field, value);
						writeCache({ ...(readCache() ?? {}), [field]: value });
						const result = form.set(field, value);
						/* Confirm, never correct: re-reading here would put the *old* snapshot back
						 * into the mirror whenever the Host answers late, which is the failure this
						 * line exists to fix. Only a snapshot that already agrees is trusted. */
						const snapshot = form.getSnapshot();
						if (snapshot?.status === "ready" && snapshot.value?.[field] === value) {
							pendingEdits.delete(field);
							writeCache(snapshot.value);
						}
						return result;
					},
					audio,
					replay: () => {
						live?.dismiss();
						// One frame at a time: dismiss() takes 460 ms to drop its node, and a
						// leftover would sit under the new one and read as a replayed stroke.
						for (const stale of document.querySelectorAll(".dsh-ink-root")) stale.remove();
						/* Same precedence as the boot path, plus this document's not-yet-echoed
						 * edits: the served document when the Host has answered, the mirror as
						 * the fallback, and the hand that just moved a control on top. */
						const replayed = form.getSnapshot();
						const value = { ...resolveConfig(replayed, readCache() ?? {}), ...Object.fromEntries(pendingEdits) };
						let sound = undefined;
						if (value.sound === true && value.volume > 0) {
							sound = new InkAudio(value);
							sound.open().then((state) => {
								audio.state = state;
								if (state === "running") sound.start();
							});
						}
						live = new InkSplash({
							...value,
							ink: window.__DSH_INK__,
							simulated: true,
							audio: sound,
						});
						/* The boot path is fenced twice over: a watchdog tears the frame down
						 * whatever the kernel arc says, and the receipt names the mode it
						 * actually mounted. The replay had neither, so a stalled clock or a
						 * film that never decoded left a full progress bar over bare paper —
						 * 「只有黑色背景加进度条和声音」, with nothing in the receipts to say
						 * why. Same bound, same receipt, and the answer stops being a guess. */
						const replayRoot = live.root;
						const filmEl = replayRoot.querySelector(".dsh-ink-film");
						/* One report per replay: the film may end and the timer also fire. */
						let replayReported = false;
						const replayWatchdog = window.setTimeout(() => {
							report.frame = "replay watchdog " + replayRoot.dataset.word + "/" + replayRoot.dataset.bg + "/" + replayRoot.dataset.art;
							report.film = "watchdog · splash=" + (replayRoot.dataset.splash ?? "-") + " · ready=" + (filmEl?.readyState ?? "-");
							reportNow("replay");
							live.dismiss();
						}, WATCHDOG_MS);
						const replayDone = () => {
							if (replayReported === true) return;
							replayReported = true;
							window.clearTimeout(replayWatchdog);
							report.frame = "replay " + replayRoot.dataset.word + "/" + replayRoot.dataset.bg + "/" + replayRoot.dataset.art;
							report.film = (replayRoot.dataset.splash ?? "live") + " · src=" + (filmEl?.getAttribute("src") ?? "-")
								+ " · ready=" + (filmEl?.readyState ?? "-") + " · ct=" + Number(filmEl?.currentTime ?? 0).toFixed(2);
							report.layers = live.layerReport ?? layerState(replayRoot);
							reportNow("replay");
						};
						filmEl?.addEventListener("ended", replayDone, { once: true });
						// A replay that never reaches the film still has to say what it painted.
						window.setTimeout(replayDone, Number(value.duration) + 1200);
					},
				}),
			}, InkSplashSettings))), PKG + ": settings section");

			/* The icon seat, keyed by the same id the section registered, which is what
			 * `renderSlot(..., { only: row.id })` matches on. Registered beside the page
			 * and disposed with it — the ledger row without its glyph is exactly the state
			 * this exists to avoid. */
			ctx.effect(() => ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
				name: "settings.section.icon",
				id: NS,
				order: 6,
			}, InkSplashNavIcon)), PKG + ": settings nav icon");

			/* The settings panel is portalled onto body, so watching body's own children
			 * catches open and close; the nav subtree is watched only while the panel
			 * exists, and a repaint that changes nothing does no work. */
			ctx.effect(() => {
				let navWatch = undefined;
				const watchNav = () => {
					const panel = document.querySelector(NAV_PANEL);
					if (panel === null) {
						navWatch?.disconnect();
						navWatch = undefined;
						return;
					}
					if (navWatch === undefined) {
						navWatch = new MutationObserver(() => paintNavGlyph(NAV_LABELS));
						navWatch.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true });
					}
					paintNavGlyph(NAV_LABELS);
				};
				watchNav();
				const body = new MutationObserver(watchNav);
				body.observe(document.body, { childList: true });
				return () => {
					body.disconnect();
					navWatch?.disconnect();
				};
			}, PKG + ": settings nav glyph");
		}

		exports.apply = apply;
		exports.eased = eased;
		exports.paintNavGlyph = paintNavGlyph;
		exports.resolveConfig = resolveConfig;
		exports.report = report;
		exports.wallWash = wallWash;
		exports.WALLLIGHT_VAR = WALLLIGHT_VAR;
		exports.paintWallLight = paintWallLight;
		exports.WARP = WARP;
		exports.inkTheme = inkTheme;
		exports.registerInkTheme = registerInkTheme;
		exports.stillOf = stillOf;
		exports.startAmbience = startAmbience;
		exports.NAV_PANEL = NAV_PANEL;
		exports.NAV_LABELS = NAV_LABELS;
		exports.GLYPH_PATHS = GLYPH_PATHS;
		exports.adoptBootFrame = adoptBootFrame;
		exports.inject = inject;
		exports.InkSplash = InkSplash;
		exports.InkAudio = InkAudio;
		exports.InkSplashSettings = InkSplashSettings;
		exports.WORDMARKS = WORDMARKS;
		exports.BACKGROUNDS = BACKGROUNDS;
		exports.ARTWORKS = ARTWORKS;
		exports.VOICES = VOICES;
		exports.DEFAULTS = DEFAULTS;
		// Exported so the test can assert on the shipped stylesheet itself;
		// reading the page would pass vacuously when apply() never ran.
		return module.exports;
	},
});
