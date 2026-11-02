/**
 * Host half of `dsh-ink-splash`.
 *
 * Two things the browser half cannot do:
 *
 *   - own the volatile Config schema served under the `ink-splash` namespace,
 *     which is what the Settings sub-page reads and writes through
 *     `configForms` — exactly like DSH's own preference rows;
 *   - serve the ink assets. The renderer's origin is `dsh-app://app`, and the
 *     Desktop shell forwards every path it does not own to the Host HTTP
 *     server, so a plugin route under `/ink-splash/` reaches the browser as a
 *     plain relative URL. `iconOf` in `dsh-app-boot` is capped at one manifest
 *     icon, so a multi-file asset set has to go this way.
 *
 * @module dsh-ink-splash
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { injectionRows } from "./inject.mjs";
import { planRange, rangeHeaders } from "./range.mjs";

/** Loader row id, and the namespace the Settings document serves. */
export const name = "ink-splash";

/** Route prefix both halves agree on; never read from user input. */
export const ASSET_PREFIX = "/ink-splash/";

/** Where the settings page hands the host its own copy of the axes. */
export const MIRROR_ROUTE = ASSET_PREFIX + "config";

export const WORDMARKS = ["wet", "dry"];
export const BACKGROUNDS = ["sweep", "rise", "bloom"];
export const ARTWORKS = ["hero", "whale"];
export const VOICES = ["paper", "guqin", "bed"];

/** Filename → media type. The key set is the whole route table. */
export const ASSETS = {
	"wordmark-mask.png": "image/png",
	"wordmark-mask-night.png": "image/png",
	"seal.png": "image/png",
	"seal-night.png": "image/png",
	"mark-mask.png": "image/png",
	"grain.png": "image/png",
	"bg-xuan.jpg": "image/jpeg",
	"bg-night.jpg": "image/jpeg",
	"bg-whale-xuan.jpg": "image/jpeg",
	"bg-whale-night.jpg": "image/jpeg",
	// Pre-blurred far view: the wash layer used to carry `filter: blur(13px)`
	// over a full-window image, which re-rasterised every frame during the one
	// moment the main thread is busiest loading plugins.
	"bg-xuan-blur.jpg": "image/jpeg",
	"bg-night-blur.jpg": "image/jpeg",
	"bg-whale-xuan-blur.jpg": "image/jpeg",
	"bg-whale-night-blur.jpg": "image/jpeg",
	// The background is the user's own image-to-video clip, served from inside the
	// package so a boot needs no network. The `.jpg` of the same name stays as the
	// poster and as the picture the frame falls back to when the clip cannot play.
	"bg-xuan.mp4": "video/mp4",
	"bg-night.mp4": "video/mp4",
	"bg-whale-xuan.mp4": "video/mp4",
	"bg-whale-night.mp4": "video/mp4",
	/* The whole splash as one film: the mark, the dot, the stroke and the painting coming
	 * up, rendered from these same layers by `splash-capture/film/bake.mjs` at 1920×1232 —
	 * the window's own device pixels (1280×822 css at DPR 1.5), so the common case is a
	 * 1:1 blit rather than a resample — and encoded 1080-line H.264, 24 fps, silent. One
	 * file per painting × palette for the axis pairs that are filmed; the names are
	 * `filmName()`'s, and a route missing here is a boot that silently falls back to the
	 * live layers, which is exactly what the gate in the lane is for. */
	/* `-v2` matches `FILM_VERSION` in prelude.js: every asset is served immutable for a
	 * year, so re-rendered films must arrive under a new address or the renderer keeps the
	 * old bytes. */
	"splash-hero-xuan-dry-bloom-v4.mp4": "video/mp4",
	"splash-hero-night-dry-bloom-v4.mp4": "video/mp4",
	"splash-whale-xuan-dry-bloom-v4.mp4": "video/mp4",
	"splash-whale-night-dry-bloom-v4.mp4": "video/mp4",
	"splash-hero-xuan-wet-bloom-v4.mp4": "video/mp4",
	"splash-hero-night-wet-bloom-v4.mp4": "video/mp4",
	"splash-whale-xuan-wet-bloom-v4.mp4": "video/mp4",
	"splash-whale-night-wet-bloom-v4.mp4": "video/mp4",
};

export const Config = z.object({
	/** Off means off: no overlay is mounted at all. */
	enabled: z.boolean().default(true).volatile(),
	/** How the wordmark is painted: wet ink soaking in, or a dry brush. */
	wordmark: z.union(WORDMARKS).default("wet").volatile(),
	/** How the ink front travels across the painting. */
	background: z.union(BACKGROUNDS).default("sweep").volatile(),
	/** Who stands in the painting. */
	artwork: z.union(ARTWORKS).default("hero").volatile(),
	/** 声音档：三套配方在 client 的 VOICE_SPECS 里。 */
	voice: z.union(VOICES).default("guqin").volatile(),
	/** Whether the brush makes sound: friction, ink landing, the seal, one struck tone. */
	sound: z.boolean().default(true).volatile(),
	/** Master level. The mix is quiet on purpose — this is a two-second splash, not an alert. */
	volume: z.number().step(1).min(0).max(100).default(45).volatile(),
	/** Nominal length in ms; the real front follows boot progress and this only paces a replay. */
	duration: z.number().step(100).min(900).max(4000).default(2600).volatile(),
	/** 应用内壁纸的亮度，单位是原画的百分比：100 就是今天这张画，一个像素都不改。
	 * 只管主题那六层画，开屏的画不读它。 */
	wallLight: z.number().step(5).min(40).max(160).default(100).volatile(),
});

function packageRoot() {
	return fileURLToPath(new URL("..", import.meta.url));
}

/** One line per index build and per boot report: the count of them is the answer to
 * "did the renderer load a second document", which is the only replay this package
 * cannot see from inside. `.boot.json` keeps only the last document's numbers, so the
 * per-document lines are what make two paintings in one launch visible. Written through
 * one queue, because two concurrent appends would drop a line — and a missing line is
 * exactly the evidence being asked for. */
let injectLogQueue = Promise.resolve();
function appendInjectLog(path, line) {
	injectLogQueue = injectLogQueue.then(async () => {
		const prior = (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).slice(-19);
		prior.push(JSON.stringify(line));
		await writeFile(path, prior.join("\n") + "\n");
	}).catch(() => {});
}

/** One writer for the merged receipt too: two documents reporting in the same breath
 * otherwise read-modify-write over each other and lose whichever landed second. */
let receiptQueue = Promise.resolve();
function writeReceipt(path, report) {
	receiptQueue = receiptQueue.then(async () => {
		const prior = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
		await writeFile(path, JSON.stringify({ ...prior, ...report }, null, 2) + "\n");
	}).catch(() => {});
}

/** Read this namespace's config without letting an unset field break the page. */
/** The shape the browser half boots with; kept in sync with client DEFAULTS by a test. */
export const DEFAULTS = {
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

/** Read this namespace's config without letting an unset field break the page.
 * Every declared field passes through: a hand-written subset is how volume and
 * voice silently never reached the boot at all.
 *
 * The order is defaults ← `ctx.config` ← the mirror file, and the mirror is LAST on purpose.
 * A schema field with `.default()` cannot tell "the user chose sweep" from "nobody ever chose",
 * so `ctx.config` alone was indistinguishable from the defaults — which is what bit us on
 * 2026-10-17: the profile was rebuilt by the update, the row that carried his axes in
 * `cordis.patch.yml` turned out not to reach this plugin at all (a non-default `volume: 85`
 * and `duration: 4000` still booted as 45/2600), and every splash went back to 横扫/人物/2600.
 * The mirror is written by the same apply path as the app's own config, so it cannot go stale
 * against the UI, and it lives outside the package directory so reinstalling the plugin does
 * not erase a person's settings. */
const MIRROR_PATH = join(homedir(), ".dsh", "ink-splash.json");

function readMirror() {
	try {
		const raw = readFileSync(MIRROR_PATH, "utf8");
		const value = JSON.parse(raw);
		return value !== null && typeof value === "object" ? value : {};
	} catch (error) {
		// No mirror yet, or an unreadable one: the app's own answer stands.
		return {};
	}
}

export function writeMirror(value) {
	try {
		mkdirSync(dirname(MIRROR_PATH), { recursive: true });
		writeFileSync(MIRROR_PATH, JSON.stringify(value));
		return true;
	} catch (error) {
		return false;
	}
}

function currentConfig(ctx) {
	let value = {};
	try {
		value = ctx.config ?? {};
	} catch (error) {
		value = {};
	}
	const mirrored = readMirror();
	const out = {};
	for (const [key, fallback] of Object.entries(DEFAULTS)) {
		const got = [mirrored[key], value?.[key]].find((x) => x !== undefined && x !== null);
		out[key] = got === undefined ? fallback : got;
	}
	return out;
}

export function apply(ctx) {
	// The pre-roll: the painting and the first stroke exist from the first
	// frame of the window, not from whenever this package's chunk is evaluated.
	/** Where the two sides of a boot leave their receipts, for post-mortems. */
	const RECEIPT = join(packageRoot(), ".boot.json");
	const INJECT_LOG = join(packageRoot(), ".injects.ndjson");
	const REPORT_PATH = "/ink-splash/boot-report";

	ctx.inject(["webServer", "connection"], (webCtx) => {
		webCtx.on("webserver/index-inject", (table) => {
			const config = currentConfig(ctx);
			void appendInjectLog(INJECT_LOG, {
				at: new Date().toISOString(),
				axes: [config.wordmark, config.background, config.artwork].join("/"),
				clock: config.duration,
				enabled: config.enabled !== false,
			});
			if (config.enabled === false) return;
			const rows = injectionRows(config);
			table.push(...rows);
			// The host can only vouch for what it handed over; the browser half
			// reports below whether the document actually got it.
			writeReceipt(RECEIPT, {
				injectedAt: new Date().toISOString(),
				kinds: rows.map((row) => row.kind + ":" + (row.placement ?? "head")),
				config,
			});
		});

		/* The settings page's own answer, kept outside the package directory. The browser half
	 * already mirrors it into localStorage, and that mirror is what the prelude reads; this is
	 * the copy the HOST needs at index-build time, when the renderer's storage has not been
	 * consulted and cannot be. */
	webCtx.effect(() => webCtx.webServer.register({
		kind: "exact",
		path: MIRROR_ROUTE,
		handler: async (req, res) => {
			if (webCtx.connection === undefined) {
				res.statusCode = 503;
				res.end();
				return;
			}
			const rejection = webCtx.connection.requestRejection(req);
			if (rejection !== undefined) {
				res.statusCode = rejection;
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.end();
				return;
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 8192) {
					res.statusCode = 413;
					res.end();
					req.destroy();
					return;
				}
				chunks.push(chunk);
			}
			let value;
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				// Only declared fields cross the boundary: the route must not become a way to
				// put arbitrary JSON where the boot reads its axes.
				value = {};
				for (const key of Object.keys(DEFAULTS)) {
					if (parsed?.[key] !== undefined && parsed[key] !== null) value[key] = parsed[key];
				}
			} catch (error) {
				res.statusCode = 400;
				res.end();
				return;
			}
			res.statusCode = writeMirror(value) ? 204 : 500;
			res.end();
		},
	}));

	webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: REPORT_PATH,
			handler: async (req, res) => {
				// An absent fence is a broken composition, not a denial; and an
				// undefined return from requestRejection means ADMITTED.
				if (webCtx.connection === undefined) {
					res.statusCode = 503;
					res.end();
					return;
				}
				const rejection = webCtx.connection.requestRejection(req);
				if (rejection !== undefined) {
					res.statusCode = rejection;
					res.end();
					return;
				}
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.end();
					return;
				}
				const chunks = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					// A diagnostic line is tiny; refuse anything pretending otherwise.
					if (size > 8192) {
						res.statusCode = 413;
						res.end();
						req.destroy();
						return;
					}
					chunks.push(chunk);
				}
				try {
					const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					report.receivedAt = new Date().toISOString();
					writeReceipt(RECEIPT, report);
					// The merged file keeps only the last document's numbers; this line is
					// what makes a second painting in one launch visible at all.
					void appendInjectLog(INJECT_LOG, {
						kind: "report",
						at: report.receivedAt,
						origin: report.origin,
						stage: report.stage,
						docs: report.docs,
						frame: report.frame,
						// The axes the splash actually wore, next to the axes the Host
						// baked: the 2026-10-17 boot had those two disagree and only a
						// manual read of .boot.json could tell.
						applied: report.applied,
						retake: report.retake,
						rewind: report.rewind,
						movie: report.movie,
						clip: report.clip,
						skin: report.skin,
						warp: report.warp,
						wall: report.wall,
						loaf: report.loaf,
						frames: report.frames,
						// Which layers were actually painting: the ink state and the
						// picture disagreed on 2026-07-17 and only this line can say why.
						layers: report.layers,
						assets: report.assets,
					});
					res.statusCode = 204;
				} catch (error) {
					res.statusCode = 400;
				}
				res.end();
			},
		}));
	});

	// The browser half contributes a dedicated Settings sub-page, so the
	// inventory should not also generate a form for this namespace.
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});

	ctx.inject(["webServer", "connection"], (child) => {
		for (const file of Object.keys(ASSETS)) {
			const mime = ASSETS[file];
			child.effect(() => child.webServer.register({
				kind: "exact",
				path: ASSET_PREFIX + file,
				handler: async (req, res) => {
					const rejection = child.connection.requestRejection(req);
					if (rejection !== undefined) {
						res.statusCode = rejection;
						res.end();
						return;
					}
					if (req.method !== "GET" && req.method !== "HEAD") {
						res.statusCode = 405;
						res.setHeader("allow", "GET, HEAD");
						res.end();
						return;
					}
					try {
						// `file` is a key of the static table above, never a
						// request segment, so this path cannot escape assets/.
						const path = join(packageRoot(), "assets", file);
						const { size } = await stat(path);
						const plan = planRange(size, req.headers?.range);
						res.statusCode = plan.status;
						res.setHeader("content-type", mime);
						res.setHeader("cache-control", "public, max-age=31536000, immutable");
						for (const [header, value] of Object.entries(rangeHeaders(plan, size))) {
							res.setHeader(header, value);
						}
						if (req.method === "HEAD" || plan.status === 416) {
							res.end();
							return;
						}
						/* Streamed rather than buffered: the whole point of the clip being
						 * seekable by byte range is that the media stack can start from the
						 * 2 KB of index at the head of the file instead of waiting for 800 KB. */
						createReadStream(path, plan.status === 206 ? { start: plan.start, end: plan.end } : undefined).pipe(res);
					} catch (error) {
						child.logger?.debug?.("ink-splash: asset missing", file, error);
						res.statusCode = 404;
						res.end();
					}
				},
			}));
		}
	});
}
