/**
 * 水墨江湖 — the application theme, as data.
 *
 * Two definitions, not one, because the contract says so: `ThemeDefinition` carries a
 * single `colorScheme` per id, so a theme that wants to serve both paper and night must
 * register `ink-jianghu` (light) and `ink-jianghu-dark` (dark). Both are built from the
 * SAME key list below, which is what keeps the two palettes from drifting apart — a token
 * that exists in one and not the other would silently fall back to the app's own colour
 * the moment someone switches appearance.
 *
 * The names are not invented: they are the `--dsw-*` custom properties the application's
 * own stylesheets declare (404 of them, collected from the running app into
 * `splash-capture/theme-tokens.json`), and a check asserts every key written here is in
 * that captured list. The built-in themes register no tokens at all — the presenter only
 * writes `snapshot.active.tokens` onto `<body>` — so this table is the whole palette.
 *
 * The colours are measured, not picked from a mood board: the ink and paper tones come out
 * of the four shipped paintings (`splash-assets/air-ink-tones.mjs` and the luminance tails
 * of each JPEG), so the interface and the splash are the same ink on the same paper.
 *
 * @module dsh-ink-splash/theme
 */

/** The attribute this plugin owns on `<html>` while one of its themes is active. */
export const MARKER = "data-dsh-ink-theme";

/** Registered ids, in the order the settings row offers them. */
export const INK_LIGHT = "ink-jianghu";
export const INK_DARK = "ink-jianghu-dark";

/**
 * One key per token, and two values. `LIGHT` is 宣纸: warm paper #f5f0e6 measured off
 * bg-xuan.jpg's lit field, ink #17110c measured off its darkest 0.4 % of pixels. `DARK` is
 * 夜山: the night sheets' sky sits at #292827–#494949 and their ink is a pale silver
 * #d2cdc5, so the dark UI is a warm charcoal rather than pure black — a black panel would
 * not be the same picture.
 */
const PALETTE = {
	"--dsw-alias-bg-base": ["rgba(245,240,230,0.40)", "rgba(23,21,19,0.34)"],
	"--dsw-alias-bg-layer-1": ["rgba(238,232,220,0.62)", "rgba(31,29,26,0.62)"],
	"--dsw-alias-bg-layer-2": ["rgba(252,249,242,0.88)", "rgba(41,38,34,0.80)"],
	"--dsw-alias-bg-layer-3": ["rgba(255,253,248,0.94)", "rgba(54,50,44,0.88)"],
	"--dsw-alias-bg-overlay": ["rgba(250,246,238,0.90)", "rgba(30,28,25,0.88)"],
	"--dsw-alias-bg-skeleton": ["rgba(227,219,202,0.55)", "rgba(51,47,42,0.60)"],
	"--dsw-alias-bg-mask-1": ["rgba(26,21,15,0.45)", "rgba(10,9,8,0.62)"],
	"--dsw-alias-bg-mask-2": ["rgba(26,21,15,0.18)", "rgba(10,9,8,0.34)"],
	"--dsw-alias-bg-mask-3": ["rgba(26,21,15,0.42)", "rgba(10,9,8,0.60)"],
	"--dsw-alias-bg-mask-drop": ["rgba(243,236,223,0.80)", "rgba(32,31,28,0.80)"],
	"--dsw-alias-bg-mask-photo": ["rgba(20,16,10,0.86)", "rgba(6,6,5,0.90)"],
	"--dsw-alias-bg-document-preview": ["rgba(246,241,231,0.70)", "rgba(26,24,21,0.66)"],
	"--dsw-alias-bg-document-selection": ["rgba(168,50,42,0.20)", "rgba(176,54,44,0.30)"],
	"--dsw-alias-bg-multi-select": ["rgba(23,17,12,0.12)", "rgba(232,226,214,0.16)"],
	"--dsw-alias-bg-module-platform": ["rgba(241,235,221,0.80)", "rgba(32,31,28,0.80)"],

	"--dsw-alias-label-primary": ["#17110c", "#e8e2d6"],
	"--dsw-alias-label-primary-dimmed": ["#2a2118", "#d8d2c6"],
	"--dsw-alias-label-primary-bluish": ["#17110c", "#e8e2d6"],
	"--dsw-alias-label-primary-foreground": ["#f5f0e6", "#17161a"],
	"--dsw-alias-label-primary-inverted": ["#f5f0e6", "#26241f"],
	"--dsw-alias-label-secondary": ["#4a4038", "#bdb6aa"],
	"--dsw-alias-label-tertiary": ["#7b6f63", "#948d81"],
	"--dsw-alias-label-caption": ["#8b8073", "#847d72"],
	"--dsw-alias-label-dimmed": ["#5a5048", "#a8a196"],
	"--dsw-alias-label-shimmer": ["#b9ac9b", "#5b564e"],
	"--dsw-alias-label-deep-diving": ["#2f5d54", "#9dbfb6"],
	"--dsw-alias-label-deep-diving-shimmer": ["#9ab3ac", "#4d5f5a"],
	"--dsw-alias-label-document-preview": ["#241d16", "#d3cdc1"],

	"--dsw-alias-border-l1": ["rgba(23,17,12,0.10)", "rgba(232,226,214,0.10)"],
	"--dsw-alias-border-l2": ["rgba(23,17,12,0.16)", "rgba(232,226,214,0.16)"],
	"--dsw-alias-border-l2-darkmode-thin": ["rgba(23,17,12,0.10)", "rgba(232,226,214,0.10)"],
	"--dsw-alias-border-l3": ["rgba(23,17,12,0.24)", "rgba(232,226,214,0.24)"],
	"--dsw-alias-border-l4": ["rgba(23,17,12,0.34)", "rgba(232,226,214,0.34)"],
	"--dsw-alias-border-inverted": ["rgba(245,240,230,0.10)", "rgba(27,26,24,0.12)"],
	"--dsw-alias-border-inverted2": ["rgba(245,240,230,0.16)", "rgba(27,26,24,0.18)"],

	"--dsw-alias-brand-primary": ["#a8322a", "#c2503f"],
	"--dsw-alias-brand-primary-invert": ["#f5f0e6", "#17161a"],
	"--dsw-alias-brand-text": ["#17110c", "#e8e2d6"],
	"--dsw-alias-link": ["#2f5d54", "#96beb2"],

	"--dsw-alias-button-primary-fill": ["#a8322a", "#b0362c"],
	"--dsw-alias-button-primary-hover": ["#8f2a23", "#c0453a"],
	"--dsw-alias-button-primary-dimmed": ["rgba(168,50,42,0.86)", "rgba(176,54,44,0.86)"],
	"--dsw-alias-button-contrast-fill": ["#f5f0e6", "#17161a"],
	"--dsw-alias-button-elevated-fill": ["#e8e1d3", "#37362f"],
	"--dsw-alias-button-floating-fill": ["rgba(245,240,230,0.86)", "rgba(32,31,28,0.86)"],
	"--dsw-alias-button-floating-hover": ["#e3dbca", "#42403a"],
	"--dsw-alias-button-ghost-active-fill": ["#e6dfd0", "#2c2b28"],
	"--dsw-alias-button-ghost-active-hover": ["#d9d0be", "#37362f"],
	"--dsw-alias-button-ghost-active-border": ["rgba(23,17,12,0.30)", "rgba(232,226,214,0.30)"],
	"--dsw-alias-button-tool-bar-fill": ["rgba(23,17,12,0.07)", "rgba(232,226,214,0.07)"],
	"--dsw-alias-button-tool-bar-fill-invisible": ["rgba(23,17,12,0.02)", "rgba(232,226,214,0.02)"],
	"--dsw-alias-button-tool-bar-hover": ["rgba(23,17,12,0.13)", "rgba(232,226,214,0.13)"],
	"--dsw-alias-button-info-fill": ["#2f5d54", "#7aa79b"],
	"--dsw-alias-button-info-hover": ["#24463f", "#96beb2"],

	"--dsw-alias-interactive-bg-hover": ["rgba(23,17,12,0.06)", "rgba(232,226,214,0.06)"],
	"--dsw-alias-interactive-bg-hover-accent": ["rgba(23,17,12,0.13)", "rgba(232,226,214,0.13)"],
	"--dsw-alias-interactive-bg-active": ["rgba(23,17,12,0.16)", "rgba(232,226,214,0.17)"],
	"--dsw-alias-interactive-bg-hover-solid": ["#e6dfd0", "#37362f"],
	"--dsw-alias-interactive-bg-hover-danger": ["rgba(178,58,46,0.12)", "rgba(200,101,79,0.16)"],

	"--dsw-alias-state-business-primary": ["#2f5d54", "#96beb2"],
	"--dsw-alias-state-business-tertiary": ["rgba(47,93,84,0.14)", "rgba(150,190,178,0.16)"],
	"--dsw-alias-state-success-primary": ["#3f6d4a", "#84ab88"],
	"--dsw-alias-state-success-secondary": ["rgba(63,109,74,0.16)", "rgba(132,171,136,0.18)"],
	"--dsw-alias-state-success-tertiary": ["rgba(63,109,74,0.08)", "rgba(132,171,136,0.10)"],
	"--dsw-alias-state-error-primary": ["#b23a2e", "#c8654f"],
	"--dsw-alias-state-error-secondary": ["rgba(178,58,46,0.16)", "rgba(200,101,79,0.18)"],
	"--dsw-alias-state-warn-primary": ["#a8791f", "#c9a05e"],
	"--dsw-alias-state-warn-secondary": ["rgba(168,121,31,0.16)", "rgba(201,160,94,0.18)"],
	"--dsw-alias-state-warn-tertiary": ["rgba(168,121,31,0.08)", "rgba(201,160,94,0.10)"],
	"--dsw-alias-state-warn-label": ["#7a5714", "#e0c08a"],
	"--dsw-alias-state-idle-primary": ["#7b6f63", "#948d81"],

	"--dsw-alias-switch-thumb": ["#f7f3ea", "#efe9dd"],
	"--dsw-alias-tooltip-bg": ["#17110c", "#e8e2d6"],
	"--dsw-alias-tooltip-label": ["#f5f0e6", "#17161a"],
	"--dsw-alias-tooltip-key-bg": ["#2a2118", "#d3cdc1"],
	"--dsw-alias-menu-group-header-fill": ["#efe9dd", "#232220"],
	"--dsw-alias-menu-icon": ["#6b6055", "#a8a196"],
	"--dsw-alias-toast-bg": ["#17110c", "#26241f"],
	"--dsw-alias-toast-label": ["#f5f0e6", "#e8e2d6"],
	"--dsw-alias-turn-trigger-bg": ["rgba(23,17,12,0.05)", "rgba(232,226,214,0.05)"],
	"--dsw-alias-turn-trigger-bg-hover": ["rgba(23,17,12,0.10)", "rgba(232,226,214,0.10)"],
	"--dsw-alias-settings-card-fill": ["#f0eadd", "#232220"],
	"--dsw-alias-settings-card-stroke": ["rgba(23,17,12,0.12)", "rgba(232,226,214,0.12)"],

	"--dsw-alias-scrollbar-bg-l1": ["rgba(23,17,12,0.14)", "rgba(232,226,214,0.14)"],
	"--dsw-alias-scrollbar-bg-l2": ["rgba(23,17,12,0.20)", "rgba(232,226,214,0.20)"],
	"--dsw-alias-scrollbar-hover-l1": ["rgba(23,17,12,0.28)", "rgba(232,226,214,0.28)"],
	"--dsw-alias-scrollbar-hover-l2": ["rgba(23,17,12,0.36)", "rgba(232,226,214,0.36)"],

	"--dsw-alias-markdown-code-block": ["#eae3d4", "#232220"],
	"--dsw-alias-markdown-code-block-banner": ["#ded6c6", "#2c2b28"],
	"--dsw-alias-markdown-inline-code": ["rgba(23,17,12,0.07)", "rgba(232,226,214,0.08)"],
	"--dsw-alias-markdown-code-segment-selected": ["#ded6c6", "#37362f"],
	"--dsw-alias-markdown-code-segment-unselected": ["#eae3d4", "#232220"],
	"--dsw-alias-markdown-citation": ["#6b6055", "#a8a196"],
	"--dsw-alias-markdown-placeholder": ["#8b8073", "#847d72"],
	"--dsw-alias-markdown-tag": ["#2f5d54", "#96beb2"],
	"--dsw-alias-code-diff-added": ["rgba(63,109,74,0.14)", "rgba(132,171,136,0.16)"],
	"--dsw-alias-code-diff-deleted": ["rgba(178,58,46,0.14)", "rgba(200,101,79,0.16)"],
	"--dsw-alias-file-diff-added-bg": ["rgba(63,109,74,0.10)", "rgba(132,171,136,0.10)"],
	"--dsw-alias-file-diff-added-gutter": ["rgba(63,109,74,0.26)", "rgba(132,171,136,0.26)"],
	"--dsw-alias-file-diff-added-marker": ["#3f6d4a", "#84ab88"],
	"--dsw-alias-file-diff-deleted-bg": ["rgba(178,58,46,0.10)", "rgba(200,101,79,0.10)"],
	"--dsw-alias-file-diff-deleted-gutter": ["rgba(178,58,46,0.26)", "rgba(200,101,79,0.26)"],
	"--dsw-alias-file-diff-deleted-marker": ["#b23a2e", "#c8654f"],

	"--dsw-specific-bubble": ["#ece5d7", "#26241f"],
	"--dsw-specific-bubble-highlight": ["#e2dacb", "#332f2a"],
	"--dsw-specific-input-major": ["#f7f3ea", "#232220"],
	"--dsw-specific-login-input": ["#f7f3ea", "#232220"],
	"--dsw-specific-menu": ["#f5f0e6", "#201f1c"],
	"--dsw-specific-selector": ["#eae3d4", "#2c2b28"],
	"--dsw-specific-sidebar-fill": ["#efe8d9", "#2d2a27"],
	"--dsw-specific-sidebar-nav-item-active": ["rgba(23,17,12,0.10)", "rgba(232,226,214,0.10)"],
	"--dsw-specific-sidebar-nav-item-active-accent": ["rgba(168,50,42,0.14)", "rgba(194,80,63,0.20)"],
	"--dsw-specific-sidebar-nav-item-hover": ["rgba(23,17,12,0.06)", "rgba(232,226,214,0.06)"],
	"--dsw-specific-tip": ["#eae3d4", "#2c2b28"],

	/* The glass and the geometry. `--dsw-mask-blur` is deliberately absent: the app
	 * paints a permanent full-window layer carrying `data-shell-overlay` (measured in
	 * his running instance: 1280x822, position absolute, z-index 20), so overriding
	 * that token frosted the whole application instead of a panel. Only
	 * `menu-*`/`hovercard` fills, which the transient surfaces consume, are touched.
	 * The geometry (`--dsw-radius-*`, `--dsw-corner-shape`) is deliberately absent too —
	 * see the note at the bottom of this table. */
	"--dsw-menu-backdrop-filter": ["blur(18px) saturate(1.08)", "blur(22px) saturate(1.12)"],
	"--dsw-menu-surface-fill": ["rgba(245,240,230,0.86)", "rgba(29,28,25,0.84)"],
	"--dsw-hovercard-bg": ["rgba(245,240,230,0.92)", "rgba(32,31,28,0.90)"],
	"--dsw-elevation-soft": ["0 1px 2px rgba(23,17,12,0.06)", "0 1px 2px rgba(0,0,0,0.30)"],
	"--dsw-elevation-panel": ["0 6px 20px rgba(23,17,12,0.10)", "0 6px 22px rgba(0,0,0,0.42)"],
	"--dsw-elevation-prominent": ["0 14px 40px rgba(23,17,12,0.16)", "0 14px 44px rgba(0,0,0,0.55)"],
	"--dsw-elevation-stroke": ["1px", "1px"],
	"--dsw-elevation-stroke-color": ["rgba(23,17,12,0.10)", "rgba(232,226,214,0.10)"],
	"--dsw-shadow-lv1": ["0 1px 2px rgba(23,17,12,0.08)", "0 1px 2px rgba(0,0,0,0.34)"],
	"--dsw-shadow-lv2": ["0 4px 14px rgba(23,17,12,0.12)", "0 4px 16px rgba(0,0,0,0.44)"],
	"--dsw-shadow-lv3": ["0 12px 34px rgba(23,17,12,0.18)", "0 12px 38px rgba(0,0,0,0.58)"],
	"--dsw-focus-ring-color": ["rgba(47,93,84,0.55)", "rgba(150,190,178,0.55)"],
	"--dsw-focus-ring-width": ["2px", "2px"],
};

/* The geometry is deliberately NOT overridden. The app ships its own scale (asar
 * 0.2.0-rc.2, dsh-client-ui-theme: xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28)
 * and applies a continuous corner to every element through its own @supports rule
 * (`--dsw-corner-shape: superellipse(1.5)` on `*`). A theme-invented scale re-weights
 * every radius relationship in the app — surfaces that agreed by default drift apart
 * (measured on the start page: three action cards rendered three different radii
 * under 宣纸/夜山, his report) — so the palette carries only colour and material, and
 * the app's own geometry stands.
 *
 * @param mode - 0 for 宣纸, 1 for 夜山. */
function tokens(mode) {
	const out = {};
	for (const [name, pair] of Object.entries(PALETTE)) out[name] = pair[mode];
	return out;
}

/** The two definitions, in the shape `ctx.theme.register()` asks for. */
export const INK_THEMES = [
	{ id: INK_LIGHT, colorScheme: "light", label: "宣纸", tokens: tokens(0) },
	{ id: INK_DARK, colorScheme: "dark", label: "夜山", tokens: tokens(1) },
];

/** Ids this plugin owns, so a snapshot can be recognised without comparing strings twice. */
export const INK_IDS = INK_THEMES.map((t) => t.id);

/** Every token name this theme writes — the list a check holds against the app's own. */
export const INK_TOKEN_NAMES = Object.keys(PALETTE);
