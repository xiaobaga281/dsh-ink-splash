/**
 * The byte-range plan for one asset response.
 *
 * Split out of `index.js` for the same reason the injection rows were: the Host half
 * imports `@deepseek-ai/schemastery`, so nothing that wants to exercise this logic can
 * import it. A `<video>` asks for ranges the moment it is pointed at a URL, and a server
 * that answers every request with a full 200 body either delays the first frame by the
 * whole file or fails outright depending on the engine — so this table is tested, not
 * assumed.
 *
 * @module dsh-ink-splash/range
 */

/** What the route advertises; the media stack keys its retry behaviour off this. */
export const ACCEPT_RANGES = "bytes";

/**
 * @param size - the file's length in bytes.
 * @param header - the request's `Range` header, verbatim, or undefined.
 * @returns `{ status, start, end }` where `start`/`end` are the inclusive span to write,
 *          or `undefined` span fields for a whole-body 200.
 */
export function planRange(size, header) {
	const full = { status: 200, start: 0, end: size - 1 };
	if (typeof header !== "string" || header.trim() === "") return full;
	const spec = header.trim();
	/* One range only. Chromium's media stack sends one; a multi-range request is answered
	 * with the whole body rather than a multipart response nobody asked this server for. */
	if (!/^bytes=/i.test(spec) || spec.includes(",")) return full;
	const body = spec.replace(/^bytes=/i, "");
	const dash = body.indexOf("-");
	if (dash < 0) return full;
	const rawFirst = body.slice(0, dash).trim();
	const rawLast = body.slice(dash + 1).trim();
	if (rawFirst === "" && rawLast === "") return full;
	const digits = (text) => /^\d+$/.test(text);
	if (rawFirst === "") {
		/* `bytes=-N` means the last N bytes. */
		if (!digits(rawLast)) return full;
		const n = Number(rawLast);
		if (n === 0) return { status: 416, start: 0, end: -1 };
		return { status: 206, start: Math.max(0, size - n), end: size - 1 };
	}
	if (!digits(rawFirst)) return full;
	const start = Number(rawFirst);
	const end = rawLast === "" ? size - 1 : Number(rawLast);
	if (!digits(rawLast) && rawLast !== "") return full;
	if (start >= size || end < start || size === 0) return { status: 416, start: 0, end: -1 };
	return { status: 206, start, end: Math.min(end, size - 1) };
}

/** The headers that must accompany a plan; `content-range` only exists on a 206. */
export function rangeHeaders(plan, size) {
	const headers = {
		"accept-ranges": ACCEPT_RANGES,
		"content-length": String(Math.max(0, plan.end - plan.start + 1)),
	};
	if (plan.status === 206) headers["content-range"] = `bytes ${plan.start}-${plan.end}/${size}`;
	if (plan.status === 416) headers["content-range"] = `bytes */${size}`;
	return headers;
}
