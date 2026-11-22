/* dsh-ink-splash — the shared DOM builder.
 *
 * This file is injected into the served index by the Host half (a body script
 * row, which runs before the shell module), and the browser half then *adopts*
 * what it made rather than building a second copy. One implementation of the
 * markup and the palette, used by both the prelude and the replay.
 *
 * The Host substitutes the CONFIG literal below with the user's saved axes.
 */
(function () {
	"use strict";

	/* Where the pictures live.
	 *
	 * Root-relative is the only form that answers in the Desktop document: the Shell
	 * forwards `/ink-splash/…` (with the app's credentials) while the published Host
	 * origin is not reachable from that document. Keep assets on this prefix; do not
	 * route them through `__DSH_TRANSPORT__.streamBaseUrl`. */
	var ASSET = "/ink-splash/";
	var CONFIG = /*CONFIG*/ { "enabled": true, "wordmark": "wet", "background": "sweep", "artwork": "hero", "voice": "guqin", "duration": 2600 } /*CONFIG*/;

	/* The Host bakes the axes this frame is going to paint with: `currentConfig` on the
	 * Host half merges the profile row with the last applied document, so a value here
	 * is one somebody chose. The browser mirror below is a FILL-IN for a key the Host
	 * did not send, never an override: a stale mirror that outranked the Host would be
	 * a second source of truth for the painting. */
	try {
		var mirrored = JSON.parse(window.localStorage.getItem("dsh-ink-splash:config") || "null");
		if (mirrored !== null && mirrored !== undefined) {
			for (var held in mirrored) {
				if (CONFIG[held] === undefined && mirrored[held] !== undefined && mirrored[held] !== null) {
					CONFIG[held] = mirrored[held];
				}
			}
		}
	} catch {
		/* A corrupt mirror leaves the axes the Host served in place. */
	}

	/* Instrument · 为什么重播. "播到一半又从头播放" has exactly two shapes: a second
	 * frame inside this document, or a second document. Both are witnessed here, in
	 * the first line of script the page runs, so a restart cannot outrun the record.
	 * The log belongs to the document rather than to this run of the file: rows are
	 * pushed per index build, so a duplicated script row must keep writing into the
	 * same record instead of starting one the browser half never reads. */
	var WIT = (function () {
		var prev = window.__DSH_INK__;
		if (prev !== undefined && prev.wit !== undefined) return prev.wit;
		var fresh = { frames: [], docs: -1, runs: 0, watching: false, perf: null };
		try {
			fresh.docs = Number(window.sessionStorage.getItem("dsh-ink-docs") || 0) + 1;
			window.sessionStorage.setItem("dsh-ink-docs", String(fresh.docs));
		} catch {
			fresh.docs = -1;
		}
		return fresh;
	})();

	/* One frame-gap meter for the splash. It is arithmetic only — one rAF callback
	 * and a 4 ms histogram, no DOM and no style read — and it exists because the
	 * receipt could say how long a long frame was but not how many ordinary frames
	 * the splash actually got. Buckets are 4 ms wide up to 208 ms; the exact worst
	 * gap and where it landed are kept separately. */
	var PERF = WIT.perf;
	if (PERF === null || PERF === undefined) {
		PERF = WIT.perf = {
			start: window.performance && performance.now ? performance.now() : Date.now(),
			last: 0, n: 0, hist: [], max: 0, maxAt: 0, over33: 0, over50: 0,
			stopped: false, phase: "-",
		};
		for (var b = 0; b < 53; b += 1) PERF.hist.push(0);
		(function sample() {
			if (PERF.stopped) return;
			window.requestAnimationFrame(function (now) {
				if (PERF.stopped) return;
				if (PERF.last > 0) {
					var gap = now - PERF.last;
					if (gap >= 0) {
						var at = Math.min(52, Math.floor(gap / 4));
						PERF.hist[at] += 1;
						PERF.n += 1;
						if (gap > PERF.max) {
							PERF.max = gap;
							PERF.maxAt = now - PERF.start;
						}
						if (gap > 33.4) PERF.over33 += 1;
						if (gap > 50) PERF.over50 += 1;
					}
				}
				PERF.last = now;
				if (PERF.n >= 2400) { PERF.stopped = true; return; }
				sample();
			});
		})();
	}

	function perfPick(p) {
		if (PERF.n === 0) return 0;
		var want = PERF.n * p;
		var seen = 0;
		for (var i = 0; i < PERF.hist.length; i += 1) {
			seen += PERF.hist[i];
			if (seen >= want) return i * 4;
		}
		return 52 * 4;
	}

	/** The one-line version that goes into the receipt; `≈` marks the histogram edge. */
	function perfSummary() {
		if (PERF.final !== undefined) return PERF.final;
		if (PERF.n === 0) return "n=0";
		var span = (window.performance && performance.now ? performance.now() : Date.now()) - PERF.start;
		return "n=" + PERF.n + " span=" + Math.round(span) + "ms"
			+ " p50≈" + perfPick(0.5) + " p95≈" + perfPick(0.95)
			+ " max=" + PERF.max.toFixed(1) + "@" + Math.round(PERF.maxAt) + "ms"
			+ " >33=" + PERF.over33 + " >50=" + PERF.over50;
	}

	function perfNow() {
		return window.performance && performance.now ? performance.now() : Date.now();
	}

	function perfStop() {
		if (PERF.stopped === true) return;
		PERF.final = perfSummary();
		PERF.stopped = true;
	}

	function note(text) {
		if (WIT.frames.length < 16) WIT.frames.push(Math.round(performance.now()) + "ms " + text);
	}

	WIT.runs += 1;

	/** Body's direct children only: the frame is always one of them, and a subtree
	 * observer would run against the whole application for the rest of the session. */
	function watchBody() {
		if (document.body === null || WIT.watching === true) return;
		WIT.watching = true;
		try {
			new MutationObserver(function (records) {
				for (var i = 0; i < records.length; i += 1) {
					for (var a = 0; a < records[i].addedNodes.length; a += 1) mark("+", records[i].addedNodes[a]);
					for (var r = 0; r < records[i].removedNodes.length; r += 1) mark("-", records[i].removedNodes[r]);
				}
			}).observe(document.body, { childList: true });
		} catch { /* an engine without observers simply keeps silent */ }
	}

	function mark(kind, node) {
		if (node !== null && node.classList !== undefined && node.classList.contains("dsh-ink-root")) {
			note(kind + " frame " + node.dataset.word + "/" + node.dataset.bg + "/" + node.dataset.art);
		}
	}

	/** An axis or palette rewrite on a frame that is already painting is the other
	 * way to restart the stroke, and it leaves no second node behind. `data-hold`
	 * is refused on purpose: the hold is written eight times a second by design. */
	function watchFrame(root) {
		try {
			new MutationObserver(function () {
				note("rewrite " + root.dataset.word + "/" + root.dataset.bg + "/" + root.dataset.art + " " + root.dataset.theme);
			}).observe(root, {
				attributes: true,
				attributeFilter: ["data-word", "data-bg", "data-art", "data-theme", "style", "class"],
			});
		} catch { /* ditto */ }
	}

	var MARKUP =
		'<div class="dsh-ink-paint">' +
		'<div class="dsh-ink-lay dsh-ink-wash"></div>' +
		'<div class="dsh-ink-lay dsh-ink-scene">' +
		/* The clip waits for the stroke: it is mounted paused at its head and started in
		 * the stroke's first tick — by the browser half, or by the escape hatch in
		 * `mountGate` if the takeover never comes. It used to autoplay behind the held
		 * paper, which spent decode while the application's boot was fighting for the
		 * thread and then needed a mid-play seek back to zero — a hitch at the one
		 * moment that cannot afford one. Muted + playsinline keep the programmatic
		 * `play()` legal without a user gesture. */
		'<video class="dsh-ink-movie" tabindex="-1" muted playsinline preload="metadata"></video>' +
		"</div>" +
		'<div class="dsh-ink-mist dsh-ink-m1"></div>' +
		'<div class="dsh-ink-mist dsh-ink-m2"></div>' +
		'<div class="dsh-ink-halo"></div>' +
		'<div class="dsh-ink-word"><div class="dsh-ink-grain"><div class="dsh-ink-letters"></div></div></div>' +
		'<div class="dsh-ink-curtain"></div>' +
		'<div class="dsh-ink-front"></div>' +
		'<div class="dsh-ink-mark"><div class="dsh-ink-breathe"><div class="dsh-ink-glow"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="dsh-ink-whale"></div></div></div>' +
		'<div class="dsh-ink-seal"></div>' +
		'<div class="dsh-ink-prog"><i></i><b></b></div>' +
		/* The film rides above every live layer and replaces them while it plays (see
		 * `[data-splash=film]` in the stylesheet). Mounted paused with no source until the
		 * palette says these axes have one: an empty video costs nothing. */
		'<video class="dsh-ink-film" tabindex="-1" muted playsinline preload="auto"></video>' +
		"</div>";

	/** The four files that make up one palette for the chosen artwork. Pick from the
	 * actual device-pixel demand, not the CSS window width alone: a 1280×822 window at
	 * DPR 1.5 uses `cover`, so the height alone asks for 1440 device pixels across before
	 * the width does. The painting's 1120:640 aspect therefore has to enter the demand
	 * calculation; width-only selection left the 1920 tier enlarged by 1.13× on a 1.5×
	 * screen. Originals remain as fallback assets. */
	function assets(dark, artwork) {
		var art = artwork === "whale" ? "whale-" : "";
		var sheet = dark ? "night" : "xuan";
		var dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
		var width = Math.max(1, Number(window.innerWidth) || 1280) * dpr;
		var height = Math.max(1, Number(window.innerHeight) || 822) * dpr;
		var need = Math.max(width, height * 1120 / 640);
		var tier = need > 2560 ? "-3200" : need > 1920 ? "-2560" : need > 1600 ? "-1920" : "-1600";
		var maskTier = width * (dark ? 0.57 : 0.595) > 760 ? "-2x" : "";
		return [
			"bg-" + art + sheet + tier + ".jpg",
			"bg-" + art + sheet + "-blur.jpg",
			dark ? "wordmark-mask-night" + maskTier + ".png" : "wordmark-mask" + maskTier + ".png",
			dark ? "seal-night.png" : "seal.png",
		];
	}

	/** The four ten-second album films are the whole picture. There is no separate
	 * background clip any more: the old `bg-*.mp4` pair was a narrower crop that the
	 * album films replaced, and shipping both would leave two videos for one surface. */
	function movieName() {
		return "";
	}

	/* Four 10 s album films, one for each artwork × palette pair. Their wordmark,
	 * seal, scenery and soundtrack are already baked into the clip, so the wordmark/
	 * background axes no longer choose a film. `v4` is a cache key, not decoration. */
	var ALBUM_FILMS = {
		"hero/night": "splash-hero-night-album-v4.mp4",
		"hero/xuan": "splash-hero-xuan-album-v4.mp4",
		"whale/night": "splash-whale-night-album-v4.mp4",
		"whale/xuan": "splash-whale-xuan-album-v4.mp4"
	};

	function filmName(dark, artwork) {
		return ALBUM_FILMS[(artwork === "whale" ? "whale" : "hero") + "/" + (dark ? "night" : "xuan")] || "";
	}

	/** The splash's palette verdict. Base: the kernel resolves light / dark /
	 * follow-system before any plugin runs and writes it to `body[data-ds-dark-theme]`.
	 * Above it sits the active ink theme — 宣纸 is paper and 夜山 is ink by night, and
	 * the user picked that skin for the whole window, splash included, so it outranks
	 * the kernel's verdict in both directions. The marker is written by the browser
	 * half, which is fetched after the shell boots, so on a cold start the copy that
	 * is already on this disk is the choice mirrored by the last session
	 * (`dsh-ink-splash:theme-chosen`, the same row the browser half writes on apply). */
	function isDark() {
		var id = null;
		try { id = document.documentElement.getAttribute("data-dsh-ink-theme"); } catch { id = null; }
		if (id === null || id === "") {
			try { id = JSON.parse(window.localStorage.getItem("dsh-ink-splash:theme-chosen") || "null"); } catch { id = null; }
		}
		if (typeof id === "string" && id !== "") {
			var themes = [];
			try {
				if (api !== undefined && api.theme !== undefined && Array.isArray(api.theme.themes)) themes = api.theme.themes;
			} catch { themes = []; }
			for (var i = 0; i < themes.length; i += 1) {
				if (themes[i].id === id) return themes[i].colorScheme === "dark";
			}
			/* An id the baked table does not know (a mirror from a newer build): this
			 * plugin names its night variant with the -dark suffix. */
			return /-dark$/.test(id);
		}
		return document.body.hasAttribute("data-ds-dark-theme");
	}

	/**
	 * Decode the palette the frame is not showing, so a theme flip mid-splash swaps
	 * without a flash. Never from `palette()`: these are four full-window files, and
	 * the boot receipt measured the block as render time with no script blamed
	 * (`13 long frames · worst 917ms · nothing attributed`) — the stroke must not pay
	 * for a picture it may never show. Idle first, and the browser half warms again
	 * when the frame comes down, which is the path that always runs.
	 */
	function warm(artwork) {
		var list = assets(!isDark(), artwork);
		for (var i = 0; i < list.length; i += 1) {
			var image = new Image();
			image.src = ASSET + list[i];
		}
	}

	/**
	 * Apply a palette. The verdict is `isDark()`: the active ink theme — the marker
	 * now, or the choice mirrored by the last session on a cold start — outranks the
	 * kernel's `body[data-ds-dark-theme]`, because 宣纸/夜山 are skins the user picked
	 * for the whole window, splash included.
	 *
	 * This is the one writer for the clip's address too: the theme flip the browser
	 * half watches lands here, so the still and the motion cannot describe two
	 * different palettes.
	 */
	function palette(root, artwork) {
		var dark = isDark();
		var list = assets(dark, artwork);
		root.dataset.theme = dark ? "dark" : "light";
		root.style.setProperty("--dsh-ink-bg", "url(" + ASSET + list[0] + ")");
		root.style.setProperty("--dsh-ink-bgw", "url(" + ASSET + list[1] + ")");
		root.style.setProperty("--dsh-ink-wm", "url(" + ASSET + list[2] + ")");
		root.style.setProperty("--dsh-ink-wms", dark ? "57% auto" : "59.5% auto");
		root.style.setProperty("--dsh-ink-sealimg", "url(" + ASSET + list[3] + ")");
		/* The grain tile is the one picture the stylesheet names itself, so it has to come
		 * from the same resolved prefix — a `/ink-splash/…` there is exactly the silent miss
		 * that left 枯笔 with no fibre on the Desktop. */
		root.style.setProperty("--dsh-ink-grainimg", "url(" + ASSET + "grain.png)");
		loadMovie(root);
		/* One writer for the film's address too, next to the clip's: a theme flip has to
		 * move the whole splash and the background together or they describe two pictures.
		 * Assigning `src` resets a media element, so an unchanged address is left alone —
		 * the same rule `loadMovie` follows for the same reason. */
		var el = root.querySelector(".dsh-ink-film");
		var name = filmName(dark, artwork);
		var baked = name.indexOf("-album-") >= 0;
		if (el !== null && el !== undefined) {
			if (name === "") {
				delete root.dataset.splash;
				delete root.dataset.filmword;
			} else {
				root.dataset.splash = "film";
				root.dataset.filmword = baked ? "baked" : "";
				if (el.getAttribute("src") !== ASSET + name) {
					/* The album clip is the picture and the soundtrack: never muted. */
					el.muted = false;
					el.volume = 1;
					el.src = ASSET + name;
				}
			}
		}
		return root.dataset.theme;
	}

	/** Clear the old background-clip seat. The album film is the only moving picture
	 * now, so this is always empty; the still underneath supplies the fallback. */
	function loadMovie(root) {
		var el = root.querySelector(".dsh-ink-movie");
		if (el === null) return "-";
		delete root.dataset.movie;
		if (el.hasAttribute("src")) {
			el.removeAttribute("src");
			el.load();
		}
		return "";
	}

	/** Build (or rebuild) the frame for one set of axes. */
	function mount(config, prelude) {
		var root = document.createElement("div");
		root.className = "dsh-ink-root" + (prelude === true ? " is-prelude" : "");
		root.dataset.word = config.wordmark;
		root.dataset.bg = config.background;
		root.dataset.art = config.artwork;
		root.setAttribute("aria-hidden", "true");
		// One ruler for the clock: the stylesheet carries the length the Host baked,
		// and the mirror may disagree with it. Inline wins, so the animation the eye
		// sees and the number the browser half estimates with are the same length.
		root.style.setProperty("--dsh-ink-dur", config.duration + "ms");
		/* Markup first: `palette` is the one writer for the clip's address, and it can
		 * only find the element once it exists. Nothing is on screen yet, so the order
		 * costs no paint — and the fetch starts before the node reaches the document. */
		var at = perfNow();
		root.innerHTML = MARKUP;
		var built = perfNow();
		palette(root, config.artwork);
		var painted = perfNow();
		if (prelude === true) root.dataset.hold = "";
		document.body.appendChild(root);
		var appended = perfNow();
		PERF.phase = "build=" + Math.round(built - at) + " palette=" + Math.round(painted - built)
			+ " append=" + Math.round(appended - painted) + " total=" + Math.round(appended - PERF.start);
		watchFrame(root);
		/* Opposite-palette decode is deferred to dismiss() in the browser half. */
		root.waveTimer = startWave(root, Number(config.duration) || 0);
		return root;
	}

	/* The breath is integrated, not keyframed. A CSS animation whose thread is blocked
	 * runs ahead on the compositor and then snaps back when it is re-committed — that is
	 * the hiccup on the mark, the same mechanism as the splash rollback. An integrated
	 * phase can only ever advance by the cap, so a blocked second makes the pulse slow
	 * down instead of jumping, and slow is what a wait looks like anyway. */
	var WAVE_MS = 2000;
	var WAVE_CYCLES = 1.2;
	var MIN_BREATH_MS = 760;
	var WAVE_CAP_MS = 90;

	/* The mark's visible life is delay + duration. One and a quarter breaths are fitted into
	 * that span, and the breath never runs shorter than 760 ms: the current 0.92 s mark gets
	 * one calm breath (plus the beginning of the next) instead of two fast ones, and a 1.85 s
	 * film gets a single slow cycle with a short rise. The film clock can replace the
	 * configured duration after mount; the observer below retimes it. */
	function timeMs(value) {
		var first = String(value || "").split(",")[0].trim();
		var amount = parseFloat(first);
		if (!(amount > 0)) return 0;
		return first.slice(-2) === "ms" ? amount : amount * 1000;
	}

	function markLifeMs(root, fallback) {
		var raw = root.style.getPropertyValue("--dsh-ink-dur");
		var duration = timeMs(raw);
		if (!(duration > 0)) duration = Number(fallback) || 0;
		/* The mark is `.06 dur` delayed plus `.22 dur` long in the stylesheet; read the
		 * inline clock instead of `getComputedStyle`, which is a style flush inside the
		 * one task that is building the splash. */
		return Math.max(0, duration * 0.28);
	}

	function startWave(root, durationMs) {
		/* The album clips breathe their own icon. The live mark underneath is hidden
		 * by the stylesheet, so animating it here would be writes nobody can see. */
		if (root.dataset.filmword === "baked") return undefined;
		var mark = root.querySelector(".dsh-ink-mark");
		if (mark === null) return undefined;
		var clock = typeof performance === "undefined" ? Date : performance;
		var lifeMs = durationMs > 0 ? durationMs * 0.28 : markLifeMs(root, CONFIG.duration);
		var breathMs = lifeMs > 0 ? Math.max(MIN_BREATH_MS, lifeMs / WAVE_CYCLES) : WAVE_MS;
		var phase = 0;
		var last = clock.now();
		var lastValue = "";
		var retime = new MutationObserver(function () {
			var next = markLifeMs(root, CONFIG.duration) / WAVE_CYCLES;
			if (next > 0 && Math.abs(next - breathMs) > 40) breathMs = Math.max(MIN_BREATH_MS, next);
		});
		retime.observe(root, { attributes: true, attributeFilter: ["style"] });
		root.waveClock = retime;
		/* The mark fades out a third of the way through the clock and never comes back, so the
		 * breath stops with it: thirty style writes a second for the rest of the splash are
		 * thirty invalidations the application's own boot would have to pay for, on a mark that
		 * is already invisible. A held frame keeps the timer, because a held frame still shows
		 * the mark. */
		mark.addEventListener("animationend", function (event) {
			if (event.target === mark) stopWave(root);
		}, { once: true });
		return window.setInterval(function () {
			var now = clock.now();
			var dt = now - last;
			last = now;
			if (dt > WAVE_CAP_MS) dt = WAVE_CAP_MS;
			if (dt < 0) dt = 0;
			if (!root.isConnected) { stopWave(root); return; }
			/* A held prelude pauses the mark's CSS animation, but the mark is still on
			 * screen; the halo has to keep breathing while the boot waits, or the waiting
			 * icon sits at the dim end of the range and looks unlit. */
			if (document.hidden) return;
			phase = (phase + dt / breathMs) % 1;
			/* 0 at the seam, 1 mid-cycle, flat at both ends: the loop cannot show a joint.
			 * A value that has not moved is not written: at the flat ends the integration
			 * rounds to the same three decimals, and a custom-property write still dirties
			 * the style even when the text is identical. */
			var value = (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI)).toFixed(3);
			if (value !== lastValue) {
				lastValue = value;
				mark.style.setProperty("--dsh-ink-wave", value);
			}
		}, 33);
	}

	function stopWave(root) {
		if (root === null || root === undefined) return;
		if (root.waveTimer !== undefined) {
			window.clearInterval(root.waveTimer);
			root.waveTimer = undefined;
		}
		if (root.waveClock !== undefined) {
			root.waveClock.disconnect();
			root.waveClock = undefined;
		}
	}

	/** Follow an appearance change while the frame is on screen. The kernel's verdict
	 * lands on body; the ink theme's marker lands on the root element and can arrive
	 * mid-splash (the browser half registers late) or move when the user switches
	 * skins in settings while a replay is running. */	function watch(root, artwork, onChange) {
		var sync = function () {
			if (palette(root, artwork) !== root.dataset.previousTheme) root.dataset.previousTheme = root.dataset.theme;
			if (typeof onChange === "function") onChange(root.dataset.theme);
		};
		var observer = new MutationObserver(sync);
		observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
		var skin = new MutationObserver(sync);
		skin.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dsh-ink-theme"] });
		return function () {
			observer.disconnect();
			skin.disconnect();
		};
	}

	/**
	 * The pre-roll holds the paper and does NOT start the brush on its own signal.
	 * LCP lands at ~150 ms on this box while the boot's heavy render lands at 1.1-1.9 s,
	 * and a stroke that starts there has its composited animations re-committed to the
	 * main thread's lagging clock mid-flight — measured as `dsh-ink-scene-x` going from
	 * 1486 ms back to 1406 ms, which is the rollback the eye catches. The browser half
	 * owns the release: it can see the application's paint and the thread's quiet. This
	 * timer is only the escape hatch for a takeover that never arrives, so the wait can
	 * never become a trap.
	 */
	function mountGate(frame, holdMs) {
		var done = false;
		function release(signal) {
			if (done) return;
			done = true;
			frame.mountSignal = signal;
			delete frame.dataset.hold;
			/* The escape path: the browser half never came, so the stroke this timeout
			 * releases must start its own clip — mounted paused at the head, one play()
			 * and the picture moves with the brush. On the normal path the browser half
			 * does this in the stroke's first tick. */
			var el = frame.querySelector(".dsh-ink-movie");
			/* With a film on the frame the painting's motion is inside that file already;
			 * starting the clip here decodes a hidden layer for the rest of the splash. */
			if (frame.dataset.splash === "film") return;
			if (el !== null && el !== undefined && el.paused === true) {
				var started = el.play();
				if (started !== undefined && started !== null && typeof started.catch === "function") started.catch(function () {});
			}
		}
		var timer = window.setTimeout(function () { release("timeout"); }, holdMs);
		return {
			cancel: function () {
				window.clearTimeout(timer);
			}
		};
	}

	var api = {
		ASSET: ASSET, CONFIG: CONFIG, assets: assets, isDark: isDark, mount: mount,
		palette: palette, watch: watch, warm: warm, stopWave: stopWave, note: note, wit: WIT,
		perf: PERF, smooth: perfSummary, stopPerf: perfStop,
		loadMovie: loadMovie, movieName: movieName, filmName: filmName,
		/* The theme table, baked in by the Host from `lib/theme.js` — the same source the
		 * component stylesheet is built from, so an id or a token cannot exist in one and
		 * be missing from the other. It rides the prelude row because the browser half is
		 * fetched after the shell boots, and a theme registered late is a visible flash of
		 * the wrong palette on every start. */
		theme: /*THEME*/ { "marker": "data-dsh-ink-theme", "themes": [] } /*THEME*/,
	};

	watchBody();
	note("doc " + WIT.docs + " run " + WIT.runs + " config " + CONFIG.wordmark + "/" + CONFIG.background + "/" + CONFIG.artwork);

	var ink = window.__DSH_INK__;
	if (ink !== undefined && ink.prelude !== null && ink.prelude !== undefined) {
		// A hot-reloaded bundle re-ran this file: keep the frame already on screen.
		note("re-run kept the frame");
		api.prelude = ink.prelude;
		api.guard = ink.guard;
		api.gate = ink.gate;
		window.__DSH_INK__ = api;
		return;
	}

	if (CONFIG.enabled === true && document.body !== null && document.querySelector(".dsh-ink-root") === null) {
		api.prelude = mount(CONFIG, true);
		// Nobody took the frame over: get out of the way rather than sit on the
		// application forever. The browser half clears this when it adopts.
		api.guard = window.setTimeout(function () {
			if (api.prelude !== null && api.prelude !== undefined && api.prelude.isConnected === true) {
				api.prelude.remove();
				api.prelude = null;
				perfStop();
			}
		}, Math.max(CONFIG.duration * 4, 12000));

		// The same bound the browser half uses, so the wait has one length.
		api.gate = mountGate(api.prelude, 2600);
	}
	window.__DSH_INK__ = api;
})();
