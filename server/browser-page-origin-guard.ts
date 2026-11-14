/**
 * Rule BROWSER-ORIGIN-DENY-1 for `browser_page` (Ops #895/#896, Security rm-868b482d R2): the page-picker
 * extension acts in the owner's OWN browser, where his chat-app passkey session lives, so an agent's
 * browser_page call must never touch the chat app's origins. Same rule, same setting file and same
 * origin matcher (parity vectors in tests/unit/browser-origin-vectors.json) as pi-worktree's
 * browser-origin-match.ts, which owns the change log; this side only reads the setting.
 *
 * `makeBrowserPageTool` (agent-service.ts) goes through `originGuardedPageCall`, which calls
 * `checkBrowserPageCall` before `pageCall` and `checkBrowserPageResult` after it. The probe reads through `pageCall` itself, read-only: `pages`
 * for the paired list, `read {what:"query", selector:"iframe,frame"}` to count frames and, when there
 * are any, one `read {what:"query"}` whose selector matches frames whose `src` names a denied host.
 * Nothing here calls a model; nothing in a request, the environment or a chat lifts the rule.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PageCallRequest, PageCallResult } from "./agent-service.js";

/** The id every refusal ends with (same as pi-worktree's DENY_RULE). */
export const BROWSER_ORIGIN_DENY_RULE = "BROWSER-ORIGIN-DENY-1";

/** Denied whatever the setting says when it is missing or unreadable (fail closed). */
export const BUILTIN_DENIED_ORIGINS: readonly string[] = Object.freeze([
	"https://pi.wai2shine.com",
	"https://spark.tailbb5055.ts.net:8787",
]);

/** The owner's setting `{"v":1,"origins":[...]}`; only he edits it, pi-worktree logs its changes. Read at call time. */
export function browserOriginDenySettingPath(): string {
	return join(homedir(), ".pi", "agent", "browser-origin-deny.json");
}

/** One paired page as the extension's `pages` (and `status`) op lists it. */
export type PairedPage = { origin: string; title?: string; open?: boolean };

/** Read-only view of the owner's browser through the page bridge. */
export interface BrowserPageProbe {
	/** The paired pages (op `pages`). */
	pages(): Promise<PairedPage[]>;
	/** The routed page's frame sources (`target` undefined = the extension's own pick). */
	frameUrls(target: string | undefined): Promise<string[]>;
}

/** Before the call: `{ ok: false, error }` (loud, names the rule and the origin) or `{ ok: true }`. */
export type BrowserPageVerdict = { ok: true } | { ok: false; error: string };

const SETTING_SHOWN = "~/.pi/agent/browser-origin-deny.json";
const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };
/** Ops that touch no page: `pages`/`status` answer from the extension's own list (redacted after), `openOptions` opens its settings. */
const NO_PAGE_OPS = new Set(["pages", "status", "openOptions"]);
/** The probe's own frame read. */
const FRAME_SELECTOR = "iframe,frame";
/** Marks the probe's own read-only requests (the extension ignores it; models can't send it: not in the tool's args). */
export const ORIGIN_CHECK_ARG = "originCheck";
const PROBE_TIMEOUT_MS = 10_000;

/** The http(s) origin `input` parses to (against `base` when given), one trailing dot of the host dropped, or null. */
function parsedOrigin(input: string, base?: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(input.trim(), base);
	} catch {
		return null;
	}
	if (!(parsed.protocol in DEFAULT_PORT)) return null;
	const host = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
	return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

/**
 * `scheme://host[:port]` lower-cased with the default port and one trailing dot of the host dropped
 * (`https://pi.wai2shine.com./` is `https://pi.wai2shine.com`, Ops #901 L2), or null for a string that is not a URL.
 */
export function browserOriginOf(url: string): string | null {
	return parsedOrigin(url);
}

/** A character that continues a host name. */
const HOST_CHAR = /[a-z0-9.\-_]/;

/** Raw-text scan: a denied host bounded on both sides (one trailing dot allowed), with its port when it has one. */
function deniedHostInText(lower: string, denied: readonly string[]): string | null {
	for (const origin of denied) {
		const u = new URL(origin);
		const name = u.hostname;
		const port = Number(u.port || DEFAULT_PORT[u.protocol]);
		for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
			if (at > 0 && HOST_CHAR.test(lower[at - 1])) continue;
			let rest = lower.slice(at + name.length);
			if (rest[0] === "." && !HOST_CHAR.test(rest[1] ?? "")) rest = rest.slice(1);
			if (HOST_CHAR.test(rest[0] ?? "")) continue;
			const named = /^:(\d+)/.exec(rest);
			if (u.port ? !named || Number(named[1]) !== port : named && Number(named[1]) !== port) continue;
			return origin;
		}
	}
	return null;
}

/** Where a URL may start inside text: a scheme, or `//` / `\\` (scheme-relative, resolved as https). */
const URL_START = /https?:|[\\/]{2}/gi;
/** What ends a URL token inside text: white space, quotes, brackets and separators. */
const TOKEN_END = /[\s"'`<>()[\]{},;|^]/;
const SCHEME_RELATIVE_BASE = "https://scheme-relative.invalid/";

/** URL parse: the whole string and each URL-like token, as written and with tabs and newlines removed (as `new URL` does). */
function deniedUrlInText(text: string, denied: readonly string[]): string | null {
	const variants = /[\t\n\r]/.test(text) ? [text, text.replace(/[\t\n\r]/g, "")] : [text];
	for (const variant of variants) {
		const whole = parsedOrigin(variant);
		if (whole && denied.includes(whole)) return whole;
		for (const m of variant.matchAll(URL_START)) {
			let end = m.index + m[0].length;
			while (end < variant.length && !TOKEN_END.test(variant[end])) end++;
			const token = variant.slice(m.index, end);
			const origin = /^h/i.test(m[0]) ? parsedOrigin(token) : parsedOrigin(token, SCHEME_RELATIVE_BASE);
			if (origin && denied.includes(origin)) return origin;
		}
	}
	return null;
}

/**
 * The first denied origin named in `text`, or null: its host[:port] in the raw text, or any URL in it that
 * `new URL()` resolves to a denied origin (`https://pi%2Ewai2shine.com/`, a fullwidth dot, a tab in the host;
 * Ops #901 L1). Same as pi-worktree's deniedOriginIn (parity vectors).
 */
export function deniedOriginInText(text: string, denied: readonly string[]): string | null {
	if (!denied.length) return null;
	return deniedHostInText(text.toLowerCase(), denied) ?? deniedUrlInText(text, denied);
}

/** Read the setting: missing, unparsable or wrongly shaped = the built-in origins plus a warning. Never reads the environment. */
export function readDeniedOrigins(path: string): { origins: string[]; warning: string | null } {
	const fallback = (why: string) => ({
		origins: [...BUILTIN_DENIED_ORIGINS],
		warning: `${BROWSER_ORIGIN_DENY_RULE}: setting ${path} ${why}; denying the built-in origins ${BUILTIN_DENIED_ORIGINS.join(", ")} (fail closed)`,
	});
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return fallback(code === "ENOENT" ? "is missing" : `can't be read (${(err as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fallback("is not JSON");
	}
	const value = parsed as { v?: unknown; origins?: unknown };
	if (!parsed || typeof parsed !== "object" || value.v !== 1) return fallback('has no "v":1');
	if (!Array.isArray(value.origins)) return fallback('has no "origins" list');
	const origins: string[] = [];
	for (const entry of value.origins) {
		const origin = typeof entry === "string" ? browserOriginOf(entry) : null;
		if (!origin) return fallback(`lists ${JSON.stringify(entry)}, which is not an http(s) origin`);
		if (!origins.includes(origin)) origins.push(origin);
	}
	return { origins, warning: null };
}

/** The refusal the model sees: the origin, what was refused, who can change it, and the rule id. */
function denyError(what: string, origin: string): string {
	return (
		`${BROWSER_ORIGIN_DENY_RULE}: ${origin} is closed to browser tools (owner setting ${SETTING_SHOWN}). ` +
		`Refused: ${what}. Agents may not use the chat app in a browser; only the owner can change this. [rule ${BROWSER_ORIGIN_DENY_RULE}]`
	);
}

/** A refusal with no single origin (the check itself could not run): names the cause and the next step. */
function cantCheckError(op: string, why: string): string {
	return (
		`${BROWSER_ORIGIN_DENY_RULE}: browser_page "${op}" refused because the origin check could not run (${why}). ` +
		`Next: try op:"pages" to see the paired pages, then name an allowed one as target (owner setting ${SETTING_SHOWN}). [rule ${BROWSER_ORIGIN_DENY_RULE}]`
	);
}

/** Every string inside `value`, at any depth (bounded). */
function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
	if (depth > 32) return out;
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
	else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
	return out;
}

/** A denied origin named by a URL-like string: parsed as a URL first, else found as text. */
function deniedIn(s: string, denied: readonly string[]): string | null {
	const origin = browserOriginOf(s);
	if (origin) return denied.includes(origin) ? origin : null;
	return deniedOriginInText(s, denied);
}

/** CSS selector matching frames whose `src` names any denied host (case-insensitive). */
function deniedFrameSelector(denied: readonly string[]): string {
	return denied
		.flatMap((origin) => {
			const host = new URL(origin).host.replace(/"/g, "");
			return [`iframe[src*="${host}" i]`, `frame[src*="${host}" i]`];
		})
		.join(",");
}

/** How many elements a `read {what:"query"}` answer reports, or the strings of a list answer. */
function frameAnswer(result: unknown): { count: number; strings: string[] } {
	if (Array.isArray(result)) return { count: result.length, strings: stringsIn(result) };
	const r = result as { count?: unknown; error?: unknown } | null;
	if (r && typeof r === "object" && typeof r.count === "number") return { count: r.count, strings: [] };
	const why =
		r && typeof r === "object" && typeof r.error === "string" ? r.error : JSON.stringify(result)?.slice(0, 120);
	throw new Error(`unexpected frame read answer: ${why}`);
}

/** The production probe: read-only `pageCall`s (`pages`, the frame reads) on the same bridge. */
export function pageCallProbe(
	pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>,
	ownerId?: string,
	denied: readonly string[] = BUILTIN_DENIED_ORIGINS,
): BrowserPageProbe {
	const call = async (op: string, target: string | undefined, args: Record<string, unknown>): Promise<unknown> => {
		const res = await pageCall(
			{ op, target, args: { ...args, [ORIGIN_CHECK_ARG]: BROWSER_ORIGIN_DENY_RULE }, timeoutMs: PROBE_TIMEOUT_MS },
			{ aborted: false },
			ownerId,
		);
		if (!res.ok) throw new Error(res.error);
		return res.result;
	};
	return {
		async pages() {
			const result = (await call("pages", undefined, {})) as { pages?: unknown } | null;
			if (!result || !Array.isArray(result.pages)) throw new Error("the extension's page list has no pages");
			return result.pages.map((p) => ({ ...(p as PairedPage) }));
		},
		async frameUrls(target) {
			const all = frameAnswer(await call("read", target, { what: "query", selector: FRAME_SELECTOR, limit: 100 }));
			if (all.count === 0 || all.strings.length > 0 || denied.length === 0) return all.strings;
			const hit = frameAnswer(await call("read", target, { what: "query", selector: deniedFrameSelector(denied) }));
			return hit.count > 0 ? denied.map((o) => `${o}/`) : [];
		},
	};
}

/** Refuse a denied target, an omitted target while any paired page is denied, a denied URL in any arg, a denied frame. */
export async function checkBrowserPageCall(
	req: PageCallRequest,
	deps: { denied: readonly string[]; probe: BrowserPageProbe },
): Promise<BrowserPageVerdict> {
	const { denied, probe } = deps;
	const op = req.op;
	if (req.target !== undefined) {
		const origin = deniedIn(req.target, denied);
		if (origin) return { ok: false, error: denyError(`browser_page ${op} on ${origin}`, origin) };
	}
	for (const s of stringsIn(req.args ?? {})) {
		const origin = deniedOriginInText(s, denied);
		if (origin) return { ok: false, error: denyError(`browser_page ${op} naming ${origin}`, origin) };
	}
	if (NO_PAGE_OPS.has(op) || denied.length === 0) return { ok: true };
	try {
		if (req.target === undefined) {
			const pick = (await probe.pages()).find((p) => typeof p.origin === "string" && deniedIn(p.origin, denied));
			if (pick) {
				const origin = deniedIn(pick.origin, denied) as string;
				return {
					ok: false,
					error: denyError(
						`browser_page ${op} with no target while ${origin} is a paired page (name an allowed target)`,
						origin,
					),
				};
			}
		}
		for (const frame of await probe.frameUrls(req.target)) {
			const origin = deniedIn(frame, denied);
			if (origin)
				return { ok: false, error: denyError(`browser_page ${op} on a page holding a frame of ${origin}`, origin) };
		}
	} catch (err) {
		return { ok: false, error: cantCheckError(op, err instanceof Error ? err.message : String(err)) };
	}
	return { ok: true };
}

/** URL-reporting fields of a result (`read url`, goto's `{navigating, url}`), at any depth (bounded). */
function reportedUrls(value: unknown, out: string[] = [], depth = 0): string[] {
	if (depth > 32 || !value || typeof value !== "object") return out;
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string" && /^(url|href|src|location|origin)$/i.test(k)) out.push(v);
		else reportedUrls(v, out, depth + 1);
	}
	return out;
}

/**
 * After the call: `pages`/`status` rows of denied origins become `{host, open, denied}`, and another row
 * whose title repeats a denied page's title loses it (the denied title never reaches the model); a result
 * naming a denied URL is replaced by the refusal.
 */
export function checkBrowserPageResult(
	req: PageCallRequest,
	result: PageCallResult,
	denied: readonly string[],
): PageCallResult {
	if (!result.ok || denied.length === 0) return result;
	const value = result.result as { pages?: unknown } | null;
	if ((req.op === "pages" || req.op === "status") && value && typeof value === "object" && Array.isArray(value.pages)) {
		const deniedOf = (row: unknown) => {
			const p = row as PairedPage | null;
			return p && typeof p === "object" && typeof p.origin === "string" ? deniedIn(p.origin, denied) : null;
		};
		const secretTitles = new Set(
			value.pages
				.filter(deniedOf)
				.map((row) => (row as PairedPage).title)
				.filter((t) => typeof t === "string"),
		);
		const pages = value.pages.map((row) => {
			const p = row as PairedPage;
			const origin = deniedOf(row);
			if (origin) return { host: new URL(origin).host, open: p.open === true, denied: BROWSER_ORIGIN_DENY_RULE };
			if (p && typeof p === "object" && typeof p.title === "string" && secretTitles.has(p.title)) {
				const { title: _hidden, ...rest } = p;
				return rest;
			}
			return row;
		});
		return { ok: true, result: { ...value, pages } };
	}
	const urls = typeof result.result === "string" ? [] : reportedUrls(result.result);
	for (const u of urls) {
		const origin = deniedIn(u, denied);
		if (origin) return { ok: false, error: denyError(`browser_page ${req.op} reached ${origin}`, origin) };
	}
	return result;
}

/**
 * The one entry `browser_page` uses: read the owner's setting, refuse before the call (throws the
 * refusal), run it, then refuse a result that names a denied origin. Nothing in the call lifts it.
 */
export async function originGuardedPageCall(
	pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>,
	req: PageCallRequest,
	signal: { aborted?: boolean },
	ownerId?: string,
): Promise<PageCallResult> {
	const deny = readDeniedOrigins(browserOriginDenySettingPath());
	if (deny.warning) console.warn(`[browser_page] ${deny.warning}`);
	const probe = pageCallProbe(pageCall, ownerId, deny.origins);
	const verdict = await checkBrowserPageCall(req, { denied: deny.origins, probe });
	if (!verdict.ok) throw new Error(verdict.error);
	return checkBrowserPageResult(req, await pageCall(req, signal, ownerId), deny.origins);
}
