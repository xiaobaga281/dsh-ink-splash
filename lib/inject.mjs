/**
 * The two rows that put the ink on screen before the plugin chunk is fetched.
 *
 * Split out from `index.js` on purpose: the Host half imports
 * `@deepseek-ai/schemastery` for its Config schema, which drags the whole
 * profile's module graph into anything that wants to check this substitution.
 * This file has no dependencies, so the shipped rows can be tested directly.
 *
 * @module dsh-ink-splash/inject
 */

import { readFile } from "node:fs/promises";
import { INK_THEMES, MARKER } from "./theme.js";

/** The fade-out length, baked into the stylesheet at serve time. */
export const EXIT_MS = 460;

const CSS_SOURCE = await readFile(new URL("./ink.css", import.meta.url), "utf8");
const UI_SOURCE = await readFile(new URL("./ink-ui.css", import.meta.url), "utf8");
const PRELUDE_SOURCE = await readFile(new URL("./prelude.js", import.meta.url), "utf8");

/** What the browser half needs to register the theme: ids, schemes and tokens. */
const THEME_JSON = JSON.stringify({ marker: MARKER, themes: INK_THEMES });

/**
 * @param config - the axes to bake into the prelude.
 * @returns index-injection rows: the two stylesheets into head, the frame builder
 *          into body, all ahead of the shell module.
 */
export function injectionRows(config) {
	const css = CSS_SOURCE.split("{{EXIT}}").join(String(EXIT_MS))
		.split("{{CLOCK}}").join(String(config.duration))
		+ "\n" + UI_SOURCE;
	const script = PRELUDE_SOURCE.replace(/\/\*CONFIG\*\/[\s\S]*?\/\*CONFIG\*\//, JSON.stringify(config))
		.replace(/\/\*THEME\*\/[\s\S]*?\/\*THEME\*\//, THEME_JSON);
	return [
		{ kind: "style", text: css },
		{ kind: "script", placement: "body", text: script },
	];
}
