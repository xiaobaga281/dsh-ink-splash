/**
 * Browser half of `dsh-ink-splash` — one package, two components.
 *
 *   1. `InkSplash`   — the visuals. Plain DOM, no React: it has to be mountable
 *                      while the kernel's framework-free boot page is still on
 *                      screen. The four ten-second album films already carry the
 *                      brush, the lettering, the seal and the soundtrack; artwork +
 *                      palette choose the file, and the picture is the whole splash.
 *   2. `InkSplashSettings` — the Settings sub-page: artwork, theme, wallpaper
 *                      brightness and a replay that runs the same component the boot
 *                      path runs.
 *
 * The two live in one self-contained chunk because the client module system
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
		/** The four album films are ten seconds; this is only the clock before metadata. */
		const FILM_NOMINAL_MS = 10100;

		const WORDMARKS = ["wet", "dry"];
		const BACKGROUNDS = ["sweep", "rise", "bloom"];
		const ARTWORKS = ["hero", "whale"];
		const DEFAULTS = {
			enabled: true,
			wordmark: "wet",
			background: "sweep",
			artwork: "hero",
			/** The album film's nominal clock; not a user control. */
			duration: FILM_NOMINAL_MS,
			wallLight: 100,
		};

		const EXIT_MS = 460;
		const WATCHDOG_MS = 12500;
		const FILM_LOAD_TIMEOUT_MS = 1800;
		/** How long a still arc counts as "loading is over". */
		const PLATEAU_MS = 700;
		/** How far the clock may outrun real loading before the picture is frozen. */
		const HOLD_EPS = 0.02;
		/** How far the clock must have moved for the stroke to count as started: past this,
		 * freezing is off the table, because a pause snaps the compositor back. Below it the
		 * picture is still at its opening state, so a freeze costs nothing you can see. */
		const BEGAN_EPS = 0.05;
		/** Animation.currentTime is sampled from a live compositor clock, not a monotone
		 * receipt: a style re-base can report it one frame older without any visual
		 * rollback. Only a backward step larger than a 30 fps frame is evidence of the
		 * defect this census exists to catch. */
		const STEP_BACK_TOLERANCE_MS = 34;
		const STEP_START_TOLERANCE_MS = 16;
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
		/* Once the application is both painted and loaded, the long conservative wait
		 * buys less than it costs: most of the remaining work is settling, not mounting.
		 * These are deliberately separate from the control values above so the A/B receipt
		 * can attribute a change in first-stroke time to this gate and nothing else. */
		const READY_QUIET_MS = 250;
		const READY_QUIET_DEADLINE_MS = 1000;
		/** The kernel's own arc: 72deg with nothing loaded, 288deg when all entries are active. */
		const ARC_MIN = 72;
		const ARC_MAX = 288;
		/* A nearly complete arc plus a real app paint is stronger evidence than a bare
		 * 700ms plateau. It completes earlier without mistaking an early plugin pause
		 * for the end of loading; the conservative plateau remains the fallback. */
		const READY_ARC = 0.9;
		const READY_PLATEAU_MS = 150;

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
				} catch {
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
				const ramp = Math.min(1, (now - this.startedAt) / WARP.ramp);
				const t0 = now;
				gl.uniform1f(this.u.amp, WARP.amp * ramp * (this.box[0] / this.canvas.width || 1));
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
				return { kind: "off", useImage: () => {}, stop: () => {}, witness: () => "off · 系统要求减少动效" };
			}
			const still = stillOf(root);
			if (still === undefined) return { kind: "off", useImage: () => {}, stop: () => {}, witness: () => "off · 调色里没有静图" };
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
				stop: () => host.remove(),
				witness: () => "css 退路(" + why + ") · " + warp.witness(),
			};
		}

		//#region component 1 · InkSplash
		/**
		 * The splash itself, mounted on `document.body`: the app mount point is
		 * hydrated by React, and anything left inside the kernel boot page is
		 * snapshotted as inert markup.
		 */
		class InkSplash {
			constructor(options) {
				const ink = options.ink;
				this.artwork = options.artwork;
				this.duration = Number(options.duration) > 0 ? Number(options.duration) : FILM_NOMINAL_MS;
				this.simulated = options.simulated === true;
				this.audioRetry = false;
				this.audioWake = false;
				this.onDone = options.onDone;
				this.done = false;
				this.startedAt = performance.now();
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
				this.lastAnim = this.carried;
				this.rewind = undefined;
				this.layers = new Map();
				this.steps = "";
				// The authoritative end. Filtered by target because every child's
				// animationend bubbles through the root — the halo finishes at 64%, and
				// an unfiltered listener would hand the frame over there.
				this.root.addEventListener("animationend", (event) => {
					if (event.target === this.root) this.animEnded = true;
					/* A mover that has finished no longer needs a private compositor surface.
					 * Keep the layer and its final pixels; only release the promotion hint. */
					if (event.target instanceof Element && event.target.matches(".dsh-ink-wash,.dsh-ink-scene,.dsh-ink-halo,.dsh-ink-mark,.dsh-ink-seal")) {
						event.target.style.willChange = "auto";
					}
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
				this.lastSample = this.startedAt;
				this.stallMs = 0;
				this.stallAt = 0;
				this.stallIn = 0;
				/* Release is not the same thing as visible motion. Keep the two clocks,
				 * the reason for every hold, and the worst gap after release so a cold-boot
				 * comparison cannot hide behind one aggregate "boot" number. */
				this.firstReleaseAt = undefined;
				this.firstStrokeAt = this.carried > 0.01 ? 0 : undefined;
				this.preludeGate = this.root.mountSignal ?? "pending";
				this.holdStartedAt = undefined;
				this.holdWaitMs = 0;
				this.holdEvents = [];
				this.postReleaseStallMs = 0;
				this.postReleaseStallAt = 0;
				this.postReleaseStallIn = 0;
				this.lastCensus = 0;
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
				/* The film, when these axes have one: it is the whole splash — mark, dot, stroke
				 * and the painting coming up — so it owns two things the live layers used to
				 * negotiate, and both are the rules he set. It is never fast-forwarded to make a
				 * boot look quicker, and the frame is not handed over until it has finished
				 * rolling. `error` is the only way back to the live layers, and it is one
				 * attribute: the sheet below this one is already painted. */
				this.film = this.root.querySelector(".dsh-ink-film");
				this.word = this.root.querySelector(".dsh-ink-word");
				if (this.artwork === "whale" && this.word !== null && this.word !== undefined) {
					/* Belt and braces against a cached stylesheet: the letters stay invisible
					 * and unanimated until the film clock says the mark has left. */
					this.word.style.animation = "none";
					this.word.style.opacity = "0";
					this.word.style.clipPath = "inset(0 100% 0 0)";
				}
				this.filmState = this.film === null || this.film === undefined || this.root.dataset.splash !== "film"
					? "absent" : "loading";
				this.filmRate = 1;
				this.filmWordStarted = false;
				if (this.filmState !== "absent") {
					/* The film is the whole splash now, not a layer behind the live CSS
					 * choreography. Nothing in the old mount/quiet gate applies to it: drop
					 * the prelude hold and start the video as soon as this half owns the
					 * frame, so the authored ten seconds is the first thing the user sees. */
					delete this.root.dataset.hold;
					const witness = (state) => {
						this.filmState = state;
						this.root.dataset.film = state;
					};
					this.film.addEventListener("loadedmetadata", () => {
						/* A theme flip reloads the film from its head; clear the fallback's
						 * live-word marker so a refused file starts from a clean state. */
						this.filmWordStarted = false;
						delete this.root.dataset.wordstart;
						this.#tieClockToFilm();
					});
					this.film.addEventListener("playing", () => {
						witness("playing");
						this.#tieClockToFilm();
					});
					this.film.addEventListener("error", () => {
						witness("error");
						delete this.root.dataset.splash;
						/* No film to wait for: the live fallback takes the frame, and the
						 * icon still leaves before the letters arrive. */
						if (this.artwork === "whale") {
							this.#revealWord();
						}
					});
					this.film.addEventListener("ended", () => {
						witness("ended");
						if (this.artwork === "whale" && this.filmWordStarted !== true) {
							this.#revealWord();
						}
					});
					/* A hot reload can adopt a film that has already fired `playing`; tie the
					 * clock to the file before the first service tick. */
					if (this.film.readyState >= 1) this.#tieClockToFilm();
					if (this.film.paused !== true && this.film.readyState >= 2) witness("playing");
					/* The prelude starts the film at first paint; this is the fallback for a
					 * host that refused that call, not the normal starter. */
					this.#driveFilm();
					/* The prelude may have started it muted because audio autoplay was
					 * refused. Try the soundtrack now, then on the first gesture. */
					if (this.film.paused !== true && this.film.muted === true
						&& this.root.dataset.filmword === "baked") this.#wakeFilmAudio();
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
				} catch {
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
				/* A film is one decoded picture, not a stack of CSS movers. Enumerating
				 * every animation in the subtree is a style flush; on this machine that
				 * flush has been measured in the same second as the handoff long frame,
				 * and there are no live layers left to diagnose under a film. */
				if (this.root.dataset.splash === "film" && this.filmState !== "error") return;
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
						const back = at + STEP_BACK_TOLERANCE_MS < seen.at;
						const again = seen.start !== null && start !== null && Math.abs(start - seen.start) > STEP_START_TOLERANCE_MS;
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
				else if (this.mounted && this.ceiling >= READY_ARC && performance.now() - this.lastMove >= READY_PLATEAU_MS) this.complete("mounted-plateau");
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


			/** The film's own length is a fact about the file, not about the setting, so the
			 * clock is told which one wins — once, when the header arrives. The four album
			 * films are 10 s at real speed; a shorter setting never fast-forwards the picture. */
			#tieClockToFilm() {
				const ms = Number(this.film?.duration) * 1000;
				if (!(ms > 0) || this.filmTied === true) return;
				this.filmTied = true;
				this.filmMs = Math.round(ms);
				this.duration = this.filmMs;
				this.root.style.setProperty("--dsh-ink-dur", this.filmMs + "ms");
				this.film.playbackRate = 1;
				this.filmRate = 1;
			}

			/** The live letters are owed only to a refused whale film: when the video cannot
			 * play, take the CSS clip away and let the live lettering wipe in from the left.
			 * The normal album film already carries the painted wordmark, so this never runs
			 * while a film is playing. */
			#revealWord() {
				if (this.filmWordStarted === true || this.artwork !== "whale") return;
				this.filmWordStarted = true;
				if (this.word !== null && this.word !== undefined) {
					this.word.style.animation = "";
					this.word.style.opacity = "";
					this.word.style.clipPath = "";
				}
				this.root.dataset.wordstart = "1";
			}

			/** The film has its own authored clock, so it is not held where the live picture is:
			 * it starts as soon as the browser half takes over. A paused video keeps the frame
			 * it is on, while a paused CSS animation is re-committed main-thread-side and snaps
			 * the reveal back; only the live stroke still waits for the mount/quiet gate. Once
			 * the film rolls it is never interrupted, so its travel is continuous. */
			#driveFilm() {
				const el = this.film;
				if (el === null || el === undefined) return;
				if (el.ended === true) {
					this.filmState = "ended";
					this.root.dataset.film = "ended";
					return;
				}
				if (this.filmState === "ended") return;
				if (el.paused === true) {
					const baked = this.root.dataset.filmword === "baked";
					/* The baked films are the only ones with a soundtrack. Prefer playing
					 * unmuted; if the host refuses an audio autoplay, fall back to a muted
					 * start and unmute on the first gesture rather than losing the picture. */
					if (baked === true && this.audioRetry !== true) {
						el.muted = false;
						el.volume = 1;
					}
					let started;
					try {
						started = el.play();
					} catch {
						if (baked === true && this.audioRetry !== true && this.root.isConnected === true) {
							this.audioRetry = true;
							el.muted = true;
							this.root.dataset.filmstart = "muted";
							let retry;
							try { retry = el.play(); } catch { retry = undefined; }
							if (retry !== undefined && typeof retry.catch === "function") retry.catch(() => {});
							this.#armFilmAudioWake(el);
						}
						return;
					}
					if (started !== undefined && typeof started.catch === "function") {
						started.catch(() => {
							if (baked !== true || this.audioRetry === true || this.root.isConnected !== true) return;
							this.audioRetry = true;
							el.muted = true;
							this.root.dataset.filmstart = "muted";
							let retry;
							try { retry = el.play(); } catch { retry = undefined; }
							if (retry !== undefined && typeof retry.catch === "function") retry.catch(() => {});
							this.#armFilmAudioWake(el);
						});
					}
				}
			}

			/** One gesture is enough to restore the soundtrack; a detached splash is not. */
			#armFilmAudioWake(el) {
				const wake = () => {
					if (this.root.isConnected !== true) return;
					if (el.ended === true) return;
					el.muted = false;
					el.volume = 1;
					let again;
					try { again = el.play(); } catch { el.muted = true; }
					if (again !== undefined && typeof again.catch === "function") {
						again.catch(() => { el.muted = true; });
					}
					window.removeEventListener("pointerdown", wake);
					window.removeEventListener("keydown", wake);
				};
				window.addEventListener("pointerdown", wake, { once: true });
				window.addEventListener("keydown", wake, { once: true });
			}

			/** Recover the soundtrack after the prelude's muted autoplay fallback. */
			#wakeFilmAudio() {
				const el = this.film;
				if (el === null || el === undefined || this.root.isConnected !== true || this.audioWake === true) return;
				this.audioWake = true;
				el.muted = false;
				el.volume = 1;
				let begun;
				try {
					begun = el.play();
				} catch {
					el.muted = true;
					this.#armFilmAudioWake(el);
					return;
				}
				if (begun !== undefined && typeof begun.then === "function") {
					begun.then(() => {
						this.audioWake = false;
						this.root.dataset.filmstart = "playing";
					}).catch(() => {
						el.muted = true;
						let retry;
						try { retry = el.play(); } catch { retry = undefined; }
						if (retry !== undefined && typeof retry.catch === "function") retry.catch(() => {});
						this.#armFilmAudioWake(el);
					});
				} else {
					this.#armFilmAudioWake(el);
				}
			}

			/** Does the film still own the frame? A file this machine refuses is not a picture
			 * in progress, and the live layers take the frame back instead. */
			#filmRolling() {
				return this.filmState === "loading" || this.filmState === "playing";
			}

			/** The whole job, eight times a second: look at what the kernel loaded,
			 * look at where the clock is, and freeze the live picture if the clock has
			 * outrun reality. Nothing here produces a pixel — the live pixels come from
			 * compositor-run keyframes; a film is already a decoded picture and is not gated.
			 * Public because that is exactly the part a browser-free test can exercise. */
			service() {
				if (this.done) return;
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
				if (this.firstReleaseAt !== undefined && gap > this.postReleaseStallMs) {
					this.postReleaseStallMs = Math.round(gap);
					this.postReleaseStallAt = ratio;
					this.postReleaseStallIn = Math.round(now - this.startedAt);
				}
				this.lastSample = now;
				this.p = ratio;
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
				const ready = this.mounted && this.loadingDone;
				const quietMs = ready ? READY_QUIET_MS : QUIET_MS;
				const quietDeadline = ready
					? Math.min(READY_QUIET_DEADLINE_MS, this.duration * QUIET_DEADLINE_SHARE)
					: Math.min(QUIET_DEADLINE_MS, this.duration * QUIET_DEADLINE_SHARE);
				const quiet = this.longAt === undefined
					|| now - this.startedAt >= quietDeadline
					|| now - this.longAt() >= quietMs;
				const behind = ratio > this.ceiling + HOLD_EPS;
				// Latched before the decision, so the tick that crosses the line cannot be the
				// one that freezes the picture.
				if (ratio > BEGAN_EPS) this.began = true;
				/* A film is the whole authored picture and is already a decoded video: the
				 * mount/quiet gate belongs to the live stroke, where a boot-time pause can
				 * snap the compositor back. Holding a film behind the application's first
				 * paint only adds dead time at the head. `error` still returns through the
				 * live gate below, so a file this machine refuses keeps the old fallback. */
				const filmOwnsFrame = this.filmState !== "absent" && this.filmState !== "error"
					&& this.root.dataset.splash === "film";
				const ahead = !this.began && !filmOwnsFrame && (!this.mounted || !quiet || behind);
				// Once the brush has visibly travelled it is never frozen again. A pause is
				// committed main-thread-side, and while the boot blocks this thread the
				// compositor has already painted ahead — so pausing snaps the picture back to
				// where the main thread last was. That snap is the "回退一点" on screen, measured
				// at two captured frames: the reveal edge at 67% of the window, then at 55%.
				// Loading that has not caught up is waited out on a finished painting instead.

				if (ahead !== this.held) {
					const at = Math.round(now - this.startedAt);
					if (ahead) {
						this.holdStartedAt = now;
						if (this.holdEvents.length < 8) {
							const reasons = [!this.mounted ? "mounted" : "", !quiet ? "quiet" : "", behind ? "behind" : ""].filter(Boolean);
							this.holdEvents.push(at + "ms hold:" + reasons.join("+"));
						}
					} else {
						if (this.held && this.holdStartedAt !== undefined) this.holdWaitMs += now - this.holdStartedAt;
						this.holdStartedAt = undefined;
						this.firstReleaseAt ??= at;
						if (this.holdEvents.length < 8) this.holdEvents.push(at + "ms release");
					}
					this.carried = ratio;
					this.epoch = performance.now();
					this.held = ahead;
					this.holds += 1;
					if (ahead) this.root.dataset.hold = "";
					else delete this.root.dataset.hold;
				}
				if (!ahead) this.firstReleaseAt ??= Math.round(now - this.startedAt);
				/* A live stroke follows the hold verdict; a film was already started when
				 * this half took over and is not gated by it. */
				if (this.filmState !== "absent" && this.filmState !== "error") this.#driveFilm();
				this.anim = this.#animRatio();
				if (this.firstStrokeAt === undefined && this.anim > 0.01) {
					this.firstStrokeAt = Math.round(now - this.startedAt);
				}
				// The master clock can say "no rewind" while a single layer restarts: a
				// re-inserted node, or an animation whose name or timing just re-resolved,
				// only moves that layer back. So every animation inside the frame is watched
				// by name, and the one that steps backwards is reported by name too.
				/* The census is a diagnostic, not the animation: half the rate costs
				 * nothing in what it can catch (a layer that moved backwards stays moved
				 * backwards against a remembered sample) and halves the forced style
				 * flush that `getAnimations({subtree:true})` performs on a live frame. */
				const censusMs = this.firstStrokeAt === undefined ? ARC_POLL_MS : 900;
				if (now - this.lastCensus >= censusMs) {
					this.lastCensus = now;
					this.#watchLayers(now);
				}
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
				/* A missing route can remain `loading` forever without dispatching `error`
				 * (for example when a server answers an HTML error page). Hand the frame back
				 * to the live compositor instead of waiting for the global watchdog. */
				if (this.filmState === "loading" && this.firstReleaseAt !== undefined
					&& now - this.startedAt - this.firstReleaseAt > FILM_LOAD_TIMEOUT_MS) {
					this.filmState = "error";
					this.root.dataset.film = "error";
					this.filmEndBy = "load-timeout";
					delete this.root.dataset.splash;
					this.film?.pause();
				}
				/* `ended` is an event, not a clock. A busy host can deliver it late even after
				 * the file reached its last frame. Accept the media clock itself, and bound an
				 * actually stalled decode well before the 12.5 s watchdog has to tear the frame down. */
				if (this.filmState === "playing" && this.film !== null && this.film !== undefined) {
					const position = Number(this.film.currentTime) || 0;
					const mediaMs = Number(this.film.duration) * 1000 || this.filmMs || 4000;
					const atLastFrame = position * 1000 >= mediaMs - 50;
					const overran = this.firstReleaseAt !== undefined
						&& now - this.startedAt - this.firstReleaseAt > mediaMs + 1250;
					if (atLastFrame || overran) {
						this.filmState = "ended";
						this.root.dataset.film = "ended";
						this.filmEndBy = atLastFrame ? "currentTime" : "bounded-wait";
						if (overran) this.film.pause();
					}
				}
				if (this.loadingDone && (this.animEnded || ratio >= 0.999) && !this.#filmRolling()) this.dismiss();
			}

			/**
			 * Read the layer state after the handoff task, not inside it. `layerState`
			 * asks for computed styles and boxes of every painted mover; on the exact
			 * mutation batch where the application has just become ready, that is a style
			 * flush and a layout in front of its first frame. The frame is still connected
			 * until `drop()`, so an idle callback has a real window to read it, and a late
			 * report overwrites the receipt with the same detail the old synchronous read
			 * produced. A watchdog path that drops before idle simply keeps "deferred".
			 */
			collectLayersLater() {
				if (this.layersQueued === true) return;
				this.layersQueued = true;
				const read = () => {
					this.layersQueued = false;
					if (this.root === undefined || this.root.isConnected !== true) return;
					try {
						this.layerReport = layerState(this.root);
					} catch (error) {
						this.layerReport = "layerState threw: " + String(error?.message ?? error);
					}
					report.layers = this.layerReport;
					reportNow("layers");
				};
				if (typeof window.requestIdleCallback === "function") {
					window.requestIdleCallback(read, { timeout: 300 });
				} else {
					window.setTimeout(read, 120);
				}
			}

			dismiss() {
				if (this.done) return;
				this.done = true;
				this.dismissedAt = Math.round(performance.now() - this.startedAt);
				/* The splash is over at this instant, not when the 460 ms exit fade has
				 * finished removing a node that no longer paints the opening. Freeze the
				 * frame meter here so its p95 describes the splash, not the app behind it. */
				window.__DSH_INK__?.stopPerf?.();
				window.clearInterval(this.timer);
				this.mountWatcher?.disconnect();
				this.stopTheme?.();
				/* The frame is still connected and the stroke has just ended — the exact
				 * moment the blank-splash reports were about. Reading it here is the only
				 * place a receipt can name the layer, because every later read happens after
				 * `drop()` and `getComputedStyle` on a detached node answers "" for every
				 * custom property (which is what "frame detached" in the earlier receipts
				 * was: a broken instrument, not a fact about the picture). */
				this.collectLayersLater();
				const paint = this.root.querySelector(".dsh-ink-paint");
				/* The root itself carries the paper as an opaque backdrop. If only the
				 * paint layer fades, that backdrop keeps the application hidden until the
				 * node is removed — the exit reads as "image → black → app" instead of a
				 * crossfade. Drop the backdrop for the exit so the application is already
				 * underneath while the painting dissolves. */
				this.root.style.background = "transparent";
				/* Geometry and computed URLs are captured while the frame is connected;
			 * the actual image decodes complete asynchronously after the drop. */
			try {
				this.assetMetricsPromise = measureAssets(this.root);
			} catch (error) {
				this.assetMetricsPromise = Promise.resolve("error: " + String(error?.message ?? error));
			}
			paint.classList.add("is-out");
				/* The final painting is already on screen; pausing here stops the video
				 * decoder from competing with the application's first frame while the
				 * overlay fades. It is resumed nowhere: the frame is about to be dropped. */
				this.film?.pause();
				const drop = () => {
					this.root.remove();
					this.disposed = true;
					/* A removed video element is not a stopped one: the decoder keeps pulling
					 * frames until the last reference goes, and the application is on screen by
					 * now and wants that capacity back. */
					this.film?.pause();
					// The breath is a timer on the prelude's side; a frame that is gone
					// must not keep writing style every 33 ms for the rest of the session.
					window.__DSH_INK__?.stopWave?.(this.root);
					/* The frame meter has no question left once the frame is gone. Stop it
					 * in the same task, or a 60 Hz no-op keeps the renderer awake. */
					window.__DSH_INK__?.stopPerf?.();
					/* Same rule for the engine, with more reason: a WebGL context left alive
					 * after the splash is a few megabytes of GPU memory held for a picture
					 * that is no longer anywhere. The witness is taken before the object goes,
					 * because `onDone` — which writes the receipt — runs after this. */
					this.ambienceWitness = this.ambience?.witness?.() ?? "none";
					this.ambience?.stop();
					this.ambience = undefined;
					// The other palette is now worth its four decodes: the stroke is over,
					// the application is on screen, and nothing is waiting on this frame.
					/* The other palette is worth its four decodes, but not while the
					 * application is painting its first frame. Put them behind idle work
					 * instead of in the same task as the drop. */
					const warm = () => window.__DSH_INK__?.warm?.(this.artwork);
					if (typeof window.requestIdleCallback === "function") {
						window.requestIdleCallback(warm, { timeout: 1600 });
					} else {
						window.setTimeout(warm, 900);
					}
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

		function InkSplashSettings({ useConfig, setField, replay, t }) {
			useEffect(() => insertStyles(PKG + "/settings.css", PANEL_CSS), []);
			const state = useConfig((snapshot) => snapshot);
			const value = state.status === "ready" ? state.value : undefined;
			/* A control is controlled by the served document. That document is written by
			 * the Host, so a click otherwise waits for the next snapshot before the selected
			 * segment moves. Keep the local choice over the served one until the Host echoes
			 * the same value; this is UI acknowledgement, not a second source of truth. */
			const [pending, setPending] = useState({});
			const view = value === undefined ? undefined : { ...value, ...pending };
			const disabled = state.writable !== true || view?.enabled === false;
			/* The switch that turns the splash on may not be governed by the thing it turns
		 * off: with `disabled` in its place, switching the splash off left no way back on. */
			const writable = state.writable !== true;
			/* One transient readout for the wallpaper slider: the number under the thumb is
			 * the value being dragged, not the one the Host has echoed back yet. */
			const [shown, setShown] = useState({});
			const showValue = (field, next) => setShown((prev) => ({ ...prev, [field]: next }));
			/* The theme is not in the config form, so the row re-renders on the service's own
			 * change event — including a change made outside this page. Keep the requested
			 * id as a short local overlay until the theme service reports that same id. */
			const [themePending, setThemePending] = useState(undefined);
			const [, themeTick] = useState(0);
			useEffect(() => inkTheme.subscribe(() => {
				setThemePending((prev) => (prev !== undefined && (prev === inkTheme.active
					|| (prev === "off" && inkTheme.active === undefined)) ? undefined : prev));
				themeTick((n) => n + 1);
			}), []);
			useEffect(() => {
				if (value === undefined) return;
				setPending((prev) => {
					let changed = false;
					const next = {};
					for (const [key, held] of Object.entries(prev)) {
						if (value[key] === held) changed = true;
						else next[key] = held;
					}
					return changed ? next : prev;
				});
			}, [value]);

			if (view === undefined) return h("div", { className: "dsh-ink-section" }, t("loading"));

			const commit = (field, next) => {
				/* Never create an overlay for a click on the value that is already shown:
				 * a pending entry that the Host never needs to echo would stay in the map
				 * and could mask a later external change on that same field. */
				if (view[field] === next) {
					setField(field, next);
					return;
				}
				setPending((prev) => ({ ...prev, [field]: next }));
				setField(field, next);
			};
			const setTheme = (next) => {
				const current = themePending ?? inkTheme.active ?? "off";
				if (next !== current) setThemePending(next);
				inkTheme.set(next);
			};

			const axis = (key, options, index) => h("div", { className: "dsh-ink-row", key: index }, [
				h("div", { key: "text" }, [
					h("div", { className: "dsh-ink-row-title", key: "title" }, t(key + ".title")),
					h("div", { className: "dsh-ink-row-desc", key: "description" }, t(key + ".description")),
				]),
				h(SegmentedControl, {
					key: "control",
					id: "dsh-ink-" + key,
					label: t(key + ".title"),
					value: view[key],
					disabled,
					options: options.map((id) => ({ value: id, label: t(key + "." + id) })),
					onChange: (next) => commit(key, next),
				}),
			]);
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
							checked: view.enabled,
							disabled: writable,
							label: t("enabled.title"),
							onChange: (next) => commit("enabled", next),
						}),
					]),
					axis("artwork", ARTWORKS, 3),
					/* The wordmark, brush-motion and sound-recipe rows are gone: the four
					 * album films already carry their lettering, their motion and their
					 * soundtrack. What is left is the pair that actually chooses a film. */
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
							value: themePending ?? inkTheme.active ?? "off",
							options: [{ value: "off", label: t("theme.off") }].concat(
								inkTheme.ids.map((id) => ({ value: id, label: t("theme." + id) }))),
							onChange: (next) => setTheme(next),
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
								defaultValue: view.wallLight ?? DEFAULTS.wallLight,
								disabled: writable,
								"aria-label": t("wallLight.title"),
								/* Painting on every step, committing on release: a brightness dial you
								 * cannot watch while dragging it is a dial you have to guess at. */
								onChange: (event) => {
									const next = Number(event.currentTarget.value);
									showValue("wallLight", next);
									paintWallLight(next);
								},
								onPointerUp: (event) => commit("wallLight", Number(event.currentTarget.value)),
								onKeyUp: (event) => commit("wallLight", Number(event.currentTarget.value)),
								onBlur: (event) => commit("wallLight", Number(event.currentTarget.value)),
							}),
							h("span", {
								className: "dsh-ink-value",
								key: "value",
							}, (shown.wallLight ?? view.wallLight ?? DEFAULTS.wallLight) + "%"),
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
					/* The measured receipt of the last boot used to be printed here. He asked
					that block out of the page: the same numbers are in .boot.json and in
					the inject log, which is where a measurement belongs. */
				]),
			]);
		}
		//#endregion

		//#region wiring
		const inject = ["configForms", "slots", "locale", "theme"];

		const zh = {
			nav: "开屏水墨",
			loading: "读取配置…",
			"page.title": "开屏水墨",
			"page.intro": "四段十秒成片已经把山水、字标与落印烘在同一条时间线上；这里只选谁站在画里，以及宣纸或夜山。",
			"enabled.title": "开屏动画",
			"enabled.description": "关闭后启动过程保持内核原样。",
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
			"replay.title": "预览重播",
			"replay.description": "用当前搭配重放一次开屏（含原片背景音），改完立刻看到结果。",
			"replay.action": "重播",
		};
		const en = {
			nav: "Ink Splash",
			loading: "Loading configuration…",
			"page.title": "Ink Splash",
			"page.intro": "Four ten-second films already carry the landscape, the lettering and the seal on one timeline; choose who stands in the painting, and paper or night.",
			"enabled.title": "Splash animation",
			"enabled.description": "When off, startup keeps the kernel's own boot page.",
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
			"replay.title": "Preview replay",
			"replay.description": "Replay the current combination once, with the film's own soundtrack.",
			"replay.action": "Replay",
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
			} catch {
				return undefined;
			}
		}

		function writeJson(key, value) {
			try {
				if (value === null) window.localStorage.removeItem(key);
				else window.localStorage.setItem(key, JSON.stringify(value));
			} catch { /* a private mode without storage is not a reason to stop */ }
		}

		/** Edits this document made, kept until the Host's own document agrees. A preview
		 * must show them the instant they are made — the served snapshot can lag an edit —
		 * but they must not hand the whole mirror a permanent veto over the served
		 * document: a stale mirror can otherwise replay a combination the Host never
		 * baked. */
		const pendingEdits = new Map();

		function writeCache(value) {
			try {
				window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
			} catch {
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
			} catch {
				// no fetch, no route: the mirror above still stands
			}
		}

		/** What the last boot actually measured; the receipt is the one reader. */
		const report = {
			css: "not yet measured", frame: "not yet measured", handover: "-", boot: "-",
			loadingDoneAt: "-", pace: "-", loaf: "-", mount: "-", doneBy: undefined, error: "-",
			docs: "-", frames: "-", retake: "-", rewind: "-", origin: "-", stall: "-", steps: "-",
			served: "-", applied: "-", mirror: "-", snapshot: "-", warp: "-", theme: "-", skin: "-",
			wall: "-", layers: "-", assets: "-", assetMetrics: "-",
			firstRelease: "-", firstStroke: "-", holdWait: "-", postReleaseStall: "-",
			lastLongAt: "-", preludeGate: "-", smooth: "-", prelude: "-",
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

		/** The application wallpaper follows the same 「画面」 axis as the splash.
		 * The theme palette itself has only light/dark; the artwork is a separate saved
		 * axis, so the root wears it as a marker and ink-ui.css swaps the picture pair.
		 * `hero` stays the fallback for every value that is not 鲸娘. */
		function paintArtwork(artwork) {
			const art = artwork === "whale" ? "whale" : "hero";
			document.documentElement.setAttribute("data-dsh-ink-art", art);
			report.art = art;
		}

		/** Hand the measured facts to the Host half, which appends them to .boot.json. */
		function sendReport() {
			/* The frame meter lives in the prelude because it must start before the shell;
			 * read it at send time instead of storing a snapshot that would freeze at the
			 * first stage. Both fields are one line, so the 8 KB diagnostic fence still
			 * has room for the layer report. */
			const ink = window.__DSH_INK__;
			const perf = ink?.perf;
			report.smooth = perf === undefined ? "-" : (ink?.smooth?.() ?? "-");
			report.prelude = perf?.phase ?? "-";
			fetch("/ink-splash/boot-report", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
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
		 * The ink state and the picture can disagree: a receipt once said the stroke ran
		 * to 47 % while the window showed bare paper, a progress bar and sound, and
		 * nothing recorded *why*. Every layer answers with its own state — the splash
		 * mode the palette chose, whether the film decoded, and each mover's display and
		 * opacity — so the next reading of the receipt settles it instead of another
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

		/** Effective device-pixel scaling for the two raster assets that define clarity. */
		async function measureAssets(root) {
			const style = getComputedStyle(root);
			const rect = root.getBoundingClientRect();
			const dpr = Number(window.devicePixelRatio || 1);
			const urlOf = (name) => {
				const raw = String(style.getPropertyValue(name)).trim();
				const match = raw.match(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/);
				return match === null ? "" : String(match[1] ?? match[2] ?? match[3] ?? "").trim();
			};
			const load = (src) => new Promise((resolve) => {
				if (src === "") { resolve({ w: 0, h: 0 }); return; }
				const img = new Image();
				const done = (ok) => resolve({ w: ok ? img.naturalWidth : 0, h: ok ? img.naturalHeight : 0 });
				img.onload = () => done(true);
				img.onerror = () => done(false);
				window.setTimeout(() => done(false), 4000);
				img.src = src;
			});
			const [bg, word] = await Promise.all([load(urlOf("--dsh-ink-bg")), load(urlOf("--dsh-ink-wm"))]);
			if (!(bg.w > 0) || !(word.w > 0)) return "viewport=" + Math.round(rect.width) + "x" + Math.round(rect.height) + "@" + dpr + " · asset decode failed";
			/* Values above 1 are genuine upscaling in device pixels; below 1 the source
			 * has more pixels than the box needs. cover uses the larger of the two axes. */
			const bgUpscale = Math.max(rect.width / bg.w, rect.height / bg.h) * dpr;
			const widthPct = Number.parseFloat(style.getPropertyValue("--dsh-ink-wms")) || (root.dataset.theme === "light" ? 63 : 57);
			const wordUpscale = rect.width * widthPct / 100 * dpr / word.w;
			return "viewport=" + Math.round(rect.width) + "x" + Math.round(rect.height) + "@" + dpr
				+ " · bg=" + bg.w + "x" + bg.h + " upscale=" + bgUpscale.toFixed(2) + "x"
				+ " · wordmark=" + word.w + "x" + word.h + " upscale=" + wordUpscale.toFixed(2) + "x";
		}

		/**
		 * Which address the *paint* stack can actually load, not just `fetch`.
		 * Both forms are tried after the stroke, never on its critical path.
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
			 * a stale mirror at the schema defaults must never outrank the Host's baked
			 * axes, or the frame can paint a different combination from the receipt.
			 * Edits made in this document are carried separately (`pendingEdits`), so a
			 * preview still shows a change the instant it is made without giving the
			 * whole mirror a veto. */
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
			/* Publish the list before `paint` below can notify the settings row. The row builds
			 * its options as `off + inkTheme.ids`; assigning ids after that first notification
			 * left an already-open settings page showing only 跟随应用 until it was reopened. */
			inkTheme.ids = ids;
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
			 * A settings write from anywhere — this wallpaper dial, another plugin's
			 * row — makes the theme registry re-adopt its durable section, and that section still
			 * names the pre-ink value, so a non-ink snapshot can arrive minutes into a session and is
			 * indistinguishable from the boot churn the window was built to forgive. A reported
			 * case was exactly that: 拖壁纸亮度, 主题没了 — and the old rule deleted the mirror too,
			 * so nothing could bring the theme back. */
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
			paint(ctx.theme.getTheme());
			/* `ctx.on(name, callback)` — the same call the application's own theme presenter and
			 * its settings-account row use. `ctx.events` is the bus underneath that helper,
			 * and `ctx.events.on` is not a method: calling it threw during activation, and an
			 * entry that throws is refused, which took the whole plugin down. */
			ctx.effect(() => ctx.on("theme/change", paint), PKG + ": theme marker");
			/* The boot report is written before this injected scope resolves; without
			 * this second report a hot-enabled theme works in the UI while the receipt
			 * still says 未注册. */
			report.theme = inkTheme.state;
			reportNow("theme");
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
			 * browser mirror for the same reason they win in the prelude: a stale browser
			 * mirror at the schema defaults must not leave the boot at the wrong brightness
			 * while the Host already has the saved value. */
			const coldConfig = window.__DSH_INK__ !== undefined && window.__DSH_INK__ !== null
				? window.__DSH_INK__.CONFIG : undefined;
			paintWallLight(coldConfig?.wallLight ?? readCache()?.wallLight);
			paintArtwork(coldConfig?.artwork ?? readCache()?.artwork);
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
				try { document.documentElement.removeAttribute("data-dsh-ink-theme"); } catch { /* no document at all */ }
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
			 * config document or the mirror: a receipt once showed the Host config
			 * (wet/bloom/whale, 4000) and the browser config (wet/sweep/hero, 2600)
			 * disagreeing, and the frame is the one the eye sees. Pacing the clock from a
			 * duration the running animation does not have would also cut the stroke
			 * short at the wrong ratio. */
			const ink = window.__DSH_INK__;
			const inkAxes = ink !== undefined && ink !== null ? ink.CONFIG : undefined;
			const config = inkAxes !== undefined && inkAxes !== null ? { ...DEFAULTS, ...inkAxes } : resolved;
			paintArtwork(config.artwork);
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
					const splash = new InkSplash({ ...config, root: boot.frame, ink, longAt: () => loaf.at, onDone: () => finish() });
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
						report.postReleaseStall = splash.postReleaseStallMs + "ms gap at " + (splash.postReleaseStallAt * 100).toFixed(0) + "% of the stroke, " + splash.postReleaseStallIn + "ms in";
						report.firstRelease = splash.firstReleaseAt === undefined ? "-" : splash.firstReleaseAt + "ms";
						report.firstStroke = splash.firstStrokeAt === undefined ? "-" : splash.firstStrokeAt + "ms";
						report.holdWait = Math.round(splash.holdWaitMs) + "ms · " + (splash.holdEvents.join(" | ") || "no hold");
						report.preludeGate = splash.preludeGate;
						report.lastLongAt = loaf.at > 0 ? Math.round(loaf.at - splash.startedAt) + "ms" : "-";
						report.mount = splash.mountAt + "ms via " + splash.mountSignal;
					report.rewind = splash.rewind ?? "no";
					report.steps = splash.steps === "" ? "no layer stepped" : splash.steps;
						report.warp = splash.ambienceWitness ?? splash.ambience?.witness?.() ?? "never armed";
						/* Whether the boot was one decoded film or a dozen choreographed layers is the
						 * first fact about this splash's cost, so it is on the receipt. */
						report.film = splash.filmState === "absent" ? "no film for these axes"
							: splash.filmState + " " + Math.round(splash.filmMs ?? 0) + "ms@" + splash.filmRate
							+ " · t=" + Math.round((splash.film?.currentTime ?? 0) * 1000) + "ms"
							+ " · start=" + (splash.root?.dataset?.filmstart ?? "-")
							+ (splash.filmEndBy ? " · " + splash.filmEndBy : "");
						/* Which palette the frame is wearing — the splash decides it before the
						 * browser half exists, and a wrong verdict is only visible as a picture. */
					report.skin = String(splash.root?.dataset?.theme ?? "-");
					report.theme = inkTheme.state;
					report.loaf = loaf.n + " long frames · worst " + loaf.worst + "ms · paint " + loaf.paint
						+ "ms · layout " + loaf.layout + "ms · blocking " + loaf.blocked + "ms · " + loaf.owner;
						report.samples = splash.samples.join(" ");
							report.trace = splash.trace.join(" ");
							/* The detailed census is idle work; see `collectLayersLater`. */
							splash.collectLayersLater();
							report.layers = splash.layerReport ?? "deferred to idle";
							/* Which asset address the document can really fetch. Recorded after
							 * the stroke so two HEADs never sit in the splash's critical path. */
							const hostOrigin = window.__DSH_TRANSPORT__ !== undefined && window.__DSH_TRANSPORT__ !== null && typeof window.__DSH_TRANSPORT__.streamBaseUrl === "string" && window.__DSH_TRANSPORT__.streamBaseUrl !== "" ? window.__DSH_TRANSPORT__.streamBaseUrl.replace(/\/+$/, "") + "/ink-splash/" : "";
							void Promise.all([assetProbe(hostOrigin), splash.assetMetricsPromise ?? Promise.resolve("-")]).then(([line, metrics]) => {
								report.assets = line;
								report.assetMetrics = metrics;
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
					paintArtwork(state.value.artwork);
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
						 * so a panel edit has to land in it. Without this write, an edit could
						 * leave the mirror on the old value while the switch showed the new
						 * one, because the snapshot never re-emitted on the edit; the next
						 * start would then paint the old choice. */
						pendingEdits.set(field, value);
						writeCache({ ...(readCache() ?? {}), [field]: value });
						if (field === "artwork") paintArtwork(value);
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
						live = new InkSplash({
							...value,
							ink: window.__DSH_INK__,
							simulated: true,
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
							live.collectLayersLater();
							report.layers = live.layerReport ?? "deferred to idle";
							reportNow("replay");
						};
						filmEl?.addEventListener("ended", replayDone, { once: true });
						/* The film is ten seconds even when an old mirror still carries the
						 * pre-video 2.6 s duration; report after the picture, not before it. */
						window.setTimeout(replayDone, Math.max(Number(value.duration) || 0, FILM_NOMINAL_MS) + 1200);
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
		exports.InkSplashSettings = InkSplashSettings;
		exports.WORDMARKS = WORDMARKS;
		exports.BACKGROUNDS = BACKGROUNDS;
		exports.ARTWORKS = ARTWORKS;
		exports.DEFAULTS = DEFAULTS;
		// Exported so the test can assert on the shipped stylesheet itself;
		// reading the page would pass vacuously when apply() never ran.
		return module.exports;
	},
});
