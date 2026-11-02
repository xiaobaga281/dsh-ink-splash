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
	 * Root-relative, and measured to be the only form that answers in the Desktop
	 * document. On 2026-07-17 the receipt carried both probes from inside the page:
	 *
	 *     relative=200   absolute=x   (http://127.0.0.1:<port>/ink-splash/)
	 *
	 * So `/ink-splash/…` is forwarded by the Shell (with the app's credentials) and the
	 * published Host origin is **not** reachable from the document — the absolute form
	 * throws, it does not merely 404. `__DSH_TRANSPORT__.streamBaseUrl` exists for the
	 * WebSocket and for `fetch`, not for the asset stack, so do not route pictures
	 * through it again: that experiment was tried and reverted.
	 *
	 * (The one thing this does mean: `/ink-splash/…` resolves against `dsh-app://app/`,
	 * which is fine precisely because the Shell forwards unknown paths.) */
	var ASSET = "/ink-splash/";
	var CONFIG = /*CONFIG*/ { "enabled": true, "wordmark": "wet", "background": "sweep", "artwork": "hero", "voice": "guqin", "duration": 2600 } /*CONFIG*/;

	/* The Host bakes the axes this frame is going to paint with: `currentConfig` on the
	 * Host half merges the profile row with the host-side copy of the last applied
	 * document, so a value here is one somebody chose. The browser mirror below is a
	 * FILL-IN for a key the Host did not send, never an override.
	 *
	 * It used to be the other way round, and that is what painted the wrong splash.
	 * Measured 2026-10-17 (the receipt's `served`/`mirror` in `.boot.json`): the mirror
	 * was stale at the schema defaults (wet/sweep/hero, 2600, volume 45) while the Host
	 * baked wet/bloom/whale, 4000 — every boot came up as 横扫/人物 with
	 * `film: "no film for these axes"`, because the artwork axis decides the film. A
	 * mirror that can outrank the Host is a second source of truth for the painting. */
	try {
		var mirrored = JSON.parse(window.localStorage.getItem("dsh-ink-splash:config") || "null");
		if (mirrored !== null && mirrored !== undefined) {
			for (var held in mirrored) {
				if (CONFIG[held] === undefined && mirrored[held] !== undefined && mirrored[held] !== null) {
					CONFIG[held] = mirrored[held];
				}
			}
		}
	} catch (error) {
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
		var fresh = { frames: [], docs: -1, runs: 0, watching: false };
		try {
			fresh.docs = Number(window.sessionStorage.getItem("dsh-ink-docs") || 0) + 1;
			window.sessionStorage.setItem("dsh-ink-docs", String(fresh.docs));
		} catch (error) {
			fresh.docs = -1;
		}
		return fresh;
	})();

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
		} catch (error) { /* an engine without observers simply keeps silent */ }
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
		} catch (error) { /* ditto */ }
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
		'<video class="dsh-ink-movie" tabindex="-1" muted playsinline preload="auto"></video>' +
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

	/** The four files that make up one palette for the chosen artwork. */
	function assets(dark, artwork) {
		var art = artwork === "whale" ? "whale-" : "";
		var sheet = dark ? "night" : "xuan";
		return [
			"bg-" + art + sheet + ".jpg",
			"bg-" + art + sheet + "-blur.jpg",
			dark ? "wordmark-mask-night.png" : "wordmark-mask.png",
			dark ? "seal-night.png" : "seal.png",
		];
	}

	/** The clip for one palette. Same name as the still, so the two always agree on
	 * which picture is being replaced, and the still is what shows when it cannot play. */
	function movieName(dark, artwork) {
		return "bg-" + (artwork === "whale" ? "whale-" : "") + (dark ? "night" : "xuan") + ".mp4";
	}

	/* The axis pairs that have the WHOLE splash baked as one film — the breathing mark, the
	 * condensing dot, the stroke and the blooming painting in a single decoded file. A film
	 * replaces the live choreography rather than sitting next to it, so it exists only for
	 * the pairs the bake actually covered; every other pair keeps the layers and the axes
	 * stay honest instead of all painting the same picture. */
	var FILMED = { "wet/bloom": true, "dry/bloom": true };

	/* `v2` is a cache-buster, not decoration: the Host serves every asset with
	 * `cache-control: public, max-age=31536000, immutable`, so a film replaced under the
	 * same address would keep playing the old bytes for a year — measured 2026-10-17: the
	 * first 1080p bake stayed on screen after the files were re-rendered at 1920×1232.
	 * Bump this whenever the films are baked again. */
	var FILM_VERSION = "v4";

	function filmName(dark, artwork, word, bg) {
		if (FILMED[word + "/" + bg] !== true) return "";
		return "splash-" + (artwork === "whale" ? "whale" : "hero") + "-"
			+ (dark ? "night" : "xuan") + "-" + word + "-" + bg + "-" + FILM_VERSION + ".mp4";
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
		try { id = document.documentElement.getAttribute("data-dsh-ink-theme"); } catch (error) { id = null; }
		if (id === null || id === "") {
			try { id = JSON.parse(window.localStorage.getItem("dsh-ink-splash:theme-chosen") || "null"); } catch (error) { id = null; }
		}
		if (typeof id === "string" && id !== "") {
			var themes = [];
			try {
				if (api !== undefined && api.theme !== undefined && Array.isArray(api.theme.themes)) themes = api.theme.themes;
			} catch (error) { themes = []; }
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

	function warmSoon(artwork) {
		if (typeof window.requestIdleCallback === "function") {
			window.requestIdleCallback(function () { warm(artwork); }, { timeout: 4000 });
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
		root.style.setProperty("--dsh-ink-wms", dark ? "57% auto" : "63% auto");
		root.style.setProperty("--dsh-ink-sealimg", "url(" + ASSET + list[3] + ")");
		/* The grain tile is the one picture the stylesheet names itself, so it has to come
		 * from the same resolved prefix — a `/ink-splash/…` there is exactly the silent miss
		 * that left 枯笔 with no fibre on the Desktop. */
		root.style.setProperty("--dsh-ink-grainimg", "url(" + ASSET + "grain.png)");
		loadMovie(root, artwork);
		/* One writer for the film's address too, next to the clip's: a theme flip has to
		 * move the whole splash and the background together or they describe two pictures.
		 * Assigning `src` resets a media element, so an unchanged address is left alone —
		 * the same rule `loadMovie` follows for the same reason. */
		var el = root.querySelector(".dsh-ink-film");
		var name = filmName(dark, artwork, root.dataset.word, root.dataset.bg);
		if (el !== null && el !== undefined) {
			if (name === "") delete root.dataset.splash;
			else {
				root.dataset.splash = "film";
				if (el.getAttribute("src") !== ASSET + name) {
					el.muted = true;
					el.src = ASSET + name;
				}
			}
		}
		return root.dataset.theme;
	}

	/** Point this frame's clip at the palette it belongs to. `muted` is set in JS as
	 * well as in the markup: an unmuted element is refused by the browser without a
	 * word, and the clip is started programmatically when the stroke starts. */
	function loadMovie(root, artwork) {
		var el = root.querySelector(".dsh-ink-movie");
		if (el === null) return "-";
		var name = movieName(isDark(), artwork);
		/* Assigning src — even the same address — resets the media element: paused, back
		 * to zero, and a clip that waits for the stroke would never start again. The
		 * palette pass that lands with the theme marker must not cost the moving
		 * picture, so an unchanged address is left untouched, its once-listeners with
		 * it. A real palette flip changes the address and reloads on purpose. */
		var address = ASSET + name;
		if (el.getAttribute("src") === address) return name;
		el.muted = true;
		el.src = address;
		/* Witnessed here rather than in the browser half: the frame has to be correct
		 * on its own, before any chunk is fetched and before the hand-over. */
		el.addEventListener("playing", function () { root.dataset.movie = "playing"; }, { once: true });
		el.addEventListener("error", function () { root.dataset.movie = "error"; }, { once: true });
		/* The clip is 4.042 s and a boot that waits on the application's own first paint
		 * outlives it. It does NOT loop: the opening animation plays once, by definition,
		 * and looping it was my invention. When it runs out, the browser half takes the
		 * last frame and keeps the picture moving — see `data-movie="ended"`. */
		el.addEventListener("ended", function () { root.dataset.movie = "ended"; }, { once: true });
		return name;
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
		// Markup first: `palette` is the one writer for the clip's address, and it can
		// only find the element once it exists. Nothing is on screen yet, so the order
		// costs no paint — and the fetch starts before the node reaches the document.
		root.innerHTML = MARKUP;
		palette(root, config.artwork);
		if (prelude === true) root.dataset.hold = "";
		document.body.appendChild(root);
		watchFrame(root);
		warmSoon(config.artwork);
		root.waveTimer = startWave(root);
		return root;
	}

	/* The breath is integrated, not keyframed. A CSS animation whose thread is blocked
	 * runs ahead on the compositor and then snaps back when it is re-committed — that is
	 * the hiccup on the mark, the same mechanism as the splash rollback. An integrated
	 * phase can only ever advance by the cap, so a blocked second makes the pulse slow
	 * down instead of jumping, and slow is what a wait looks like anyway. */
	var WAVE_MS = 1900;
	var WAVE_CAP_MS = 90;

	function startWave(root) {
		var mark = root.querySelector(".dsh-ink-mark");
		if (mark === null) return undefined;
		var clock = typeof performance === "undefined" ? Date : performance;
		var phase = 0;
		var last = clock.now();
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
			phase = (phase + dt / WAVE_MS) % 1;
			/* 0 at the seam, 1 mid-cycle, flat at both ends: the loop cannot show a joint. */
			mark.style.setProperty("--dsh-ink-wave", (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI)).toFixed(3));
		}, 33);
	}

	function stopWave(root) {
		if (root === null || root === undefined) return;
		if (root.waveTimer !== undefined) {
			window.clearInterval(root.waveTimer);
			root.waveTimer = undefined;
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
		loadMovie: loadMovie, movieName: movieName, filmName: filmName, FILMED: FILMED,
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
			}
		}, Math.max(CONFIG.duration * 4, 12000));

		// The same bound the browser half uses, so the wait has one length.
		api.gate = mountGate(api.prelude, 2600);
	}
	window.__DSH_INK__ = api;
})();
