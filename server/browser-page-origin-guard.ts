/**
 * Rule BROWSER-ORIGIN-DENY-1 for `browser_page` (Ops #895, Security rm-868b482d R2): the page-picker
 * extension acts in the owner's OWN browser, where his chat-app passkey session lives, so an agent's
 * browser_page call must never touch the chat app's origins. Same rule, same setting file and same
 * origin matcher (parity vectors in tests/unit/browser-origin-vectors.json) as pi-worktree's
 * browser-origin-guard.ts, which owns the change log; this side only reads the setting.
 *
 * `makeBrowserPageTool` (agent-service.ts) calls `checkBrowserPageCall` before `pageCall` and
 * `checkBrowserPageResult` after it. The probe reads through `pageCall` itself, read-only: `pages`
 * for the paired list, `read {what:"html", selector:"iframe,frame", all:true}` for frame sources.
 *
 * SEAM (task 1/2): types and signatures are the contract; task 2 fills the bodies and wires them in.
 */
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

const NOT_BUILT = "browser-page-origin-guard: not built (Ops #895 task 2)";

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

/** `scheme://host[:port]` lower-cased with the default port dropped, or null for a string that is not a URL. */
export function browserOriginOf(url: string): string | null {
	void url;
	throw new Error(NOT_BUILT);
}

/** The first denied origin named in `text` (a whole URL or its host[:port] inside other text), or null. */
export function deniedOriginInText(text: string, denied: readonly string[]): string | null {
	void text;
	void denied;
	throw new Error(NOT_BUILT);
}

/** Read the setting: missing, unparsable or wrongly shaped = the built-in origins plus a warning. Never reads the environment. */
export function readDeniedOrigins(path: string): { origins: string[]; warning: string | null } {
	void path;
	throw new Error(NOT_BUILT);
}

/** The production probe: read-only `pageCall`s (`pages`, the iframe read) on the same bridge. */
export function pageCallProbe(
	pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>,
	ownerId?: string,
): BrowserPageProbe {
	void pageCall;
	void ownerId;
	throw new Error(NOT_BUILT);
}

/** Refuse a denied target, an omitted target while any paired page is denied, a denied URL in any arg, a denied frame. */
export async function checkBrowserPageCall(
	req: PageCallRequest,
	deps: { denied: readonly string[]; probe: BrowserPageProbe },
): Promise<BrowserPageVerdict> {
	void req;
	void deps;
	throw new Error(NOT_BUILT);
}

/** After the call: `pages`/`status` rows of denied origins become `{host, open, denied}`; a result naming a denied URL is replaced by the refusal. */
export function checkBrowserPageResult(
	req: PageCallRequest,
	result: PageCallResult,
	denied: readonly string[],
): PageCallResult {
	void req;
	void result;
	void denied;
	throw new Error(NOT_BUILT);
}
