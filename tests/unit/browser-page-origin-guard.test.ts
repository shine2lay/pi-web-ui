/**
 * browser_page refuses the chat app's origins (rule BROWSER-ORIGIN-DENY-1, Ops #895, Security rm-868b482d R2):
 * the acceptance cases, written by the seam task (rule 18 Task 1) before the guard is built. Each is marked
 * `todo` so the suite stays green while it fails; task 2 removes TODO and turns them green, and may never
 * weaken or delete an assertion. To see them fail now: BROWSER_ORIGIN_DENY_ACCEPTANCE=1 npx vitest run <this file>.
 * The owner's browser is a fake probe and a fake page bridge in this file: no browser, extension or page is touched.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeBrowserPageTool, type PageCallRequest, type PageCallResult } from "../../server/agent-service.js";
import {
	BROWSER_ORIGIN_DENY_RULE,
	BUILTIN_DENIED_ORIGINS,
	browserOriginDenySettingPath,
	browserOriginOf,
	checkBrowserPageCall,
	checkBrowserPageResult,
	deniedOriginInText,
	readDeniedOrigins,
	type BrowserPageProbe,
	type PairedPage,
} from "../../server/browser-page-origin-guard.js";

const TODO = { todo: process.env.BROWSER_ORIGIN_DENY_ACCEPTANCE !== "1" };
const DENIED = ["https://pi.wai2shine.com", "https://spark.tailbb5055.ts.net:8787"];
const ALLOWED = ["https://example.com", "http://127.0.0.1:8787", "http://localhost:8787"];
const SECRET_TITLE = "Owner's secret chat";
/** The same pin sits in pi-worktree tests/browser-origin-guard.test.ts. */
const VECTORS_SHA256 = "d989f06b92fbd76ac52ad604fd5441859dd354fb24fd9d1f6b0624281f388a24";
/** Every op that acts on a page (pages and status act on none). */
const PAGE_OPS: [string, Record<string, unknown>][] = [
	["read", { what: "text" }],
	["click", { selector: "button" }],
	["type", { selector: "input", text: "x" }],
	["scroll", { by: { x: 0, y: 100 } }],
	["goto", { url: "https://example.com/next" }],
	["wait", { selector: "main" }],
	["eval", { code: "document.title" }],
	["shot", {}],
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const req = (op: string, target?: string, args: Record<string, unknown> = {}): PageCallRequest => ({
	op,
	target,
	args,
	timeoutMs: 30_000,
});

/** The paired pages and each page's frame sources; records which pages had their frames read. */
class FakeProbe implements BrowserPageProbe {
	paired: PairedPage[];
	frames: Record<string, string[]>;
	frameReads: (string | undefined)[] = [];
	constructor(paired: PairedPage[], frames: Record<string, string[]> = {}) {
		this.paired = paired;
		this.frames = frames;
	}
	async pages(): Promise<PairedPage[]> {
		return this.paired.map((p) => ({ ...p }));
	}
	async frameUrls(target: string | undefined): Promise<string[]> {
		this.frameReads.push(target);
		const key = target ?? this.paired[0]?.origin ?? "";
		return this.frames[key] ?? [`${key}/`];
	}
}
const paired = (...origins: string[]): PairedPage[] =>
	origins.map((origin) => ({ origin, title: SECRET_TITLE, open: true }));

function expectRefused(v: { ok: true } | { ok: false; error: string }, origin?: string): void {
	expect(v.ok, "expected a refusal, the call was let through").toBe(false);
	const error = v.ok ? "" : v.error;
	expect(error).toContain(`[rule ${BROWSER_ORIGIN_DENY_RULE}]`);
	if (origin) expect(error).toContain(origin);
}

describe("browser_page origin deny (BROWSER-ORIGIN-DENY-1)", () => {
	for (const origin of DENIED) {
		// 1. Each op on each denied origin.
		for (const [op, args] of PAGE_OPS) {
			it(`${op} on target ${origin}: refused, its frames never read`, TODO, async () => {
				const probe = new FakeProbe(paired(origin, "https://example.com"));
				expectRefused(await checkBrowserPageCall(req(op, origin, args), { denied: DENIED, probe }), origin);
				expect(probe.frameReads).not.toContain(origin);
			});
		}

		it(`omitted target while ${origin} is a paired page: every op refused`, TODO, async () => {
			const probe = new FakeProbe(paired(origin));
			for (const [op, args] of PAGE_OPS) {
				expectRefused(await checkBrowserPageCall(req(op, undefined, args), { denied: DENIED, probe }), origin);
			}
		});

		it(`target ${origin} written another way (upper case, :443, a path): still refused`, TODO, async () => {
			const probe = new FakeProbe(paired(origin));
			const u = new URL(origin);
			for (const target of [origin.toUpperCase(), `${origin}/c/secret`, u.port ? origin : `${origin}:443`]) {
				expectRefused(await checkBrowserPageCall(req("read", target), { denied: DENIED, probe }), origin);
			}
		});

		// 2. A denied origin in the arguments, on an allowed page.
		for (const [op, args] of [
			["goto", { url: `${origin}/c/secret` }],
			["goto", { url: `${origin.toUpperCase()}/` }],
			["eval", { code: `fetch("${origin}/api/chats").then((r) => r.text())` }],
			["eval", { code: `location.href = "${origin}/"` }],
		] as const) {
			it(`${op} ${JSON.stringify(args)} on example.com: refused`, TODO, async () => {
				const probe = new FakeProbe(paired("https://example.com"));
				expectRefused(
					await checkBrowserPageCall(req(op, "https://example.com", args), { denied: DENIED, probe }),
					origin,
				);
			});
		}

		// 3. An allowed page holding an iframe of a denied origin.
		it(`example.com holding an iframe of ${origin}: every op refused`, TODO, async () => {
			const frames = { "https://example.com": ["https://example.com/", `${origin}/embed/chat`] };
			const probe = new FakeProbe(paired("https://example.com"), frames);
			for (const [op, args] of PAGE_OPS) {
				expectRefused(
					await checkBrowserPageCall(req(op, "https://example.com", args), { denied: DENIED, probe }),
					origin,
				);
			}
		});

		// 4. pages / status list a denied page by host only.
		for (const op of ["pages", "status"]) {
			it(`${op}: the ${origin} page is listed as host only, no title`, TODO, () => {
				const listing = {
					...(op === "status" ? { installed: true, aiControl: true } : {}),
					pages: [
						{ origin, title: SECRET_TITLE, open: true },
						{ origin: "https://example.com", title: "Example Domain", open: false },
					],
				};
				const out = checkBrowserPageResult(req(op), { ok: true, result: listing }, DENIED);
				expect(out.ok).toBe(true);
				const result = (out.ok ? out.result : {}) as { pages: Record<string, unknown>[]; installed?: boolean };
				expect(JSON.stringify(result)).not.toContain(SECRET_TITLE);
				expect(result.pages[0]).toEqual({ host: new URL(origin).host, open: true, denied: BROWSER_ORIGIN_DENY_RULE });
				expect(result.pages[1]).toEqual({ origin: "https://example.com", title: "Example Domain", open: false });
				if (op === "status") expect(result.installed).toBe(true);
			});
		}

		// 5. A result that reports a denied URL is replaced by the refusal.
		for (const [op, result] of [
			["read", { url: `${origin}/c/secret` }],
			["goto", { navigating: true, url: `${origin}/c/secret` }],
		] as const) {
			it(`${op} on example.com whose result names ${origin}: replaced by the refusal`, TODO, () => {
				const out = checkBrowserPageResult(req(op, "https://example.com"), { ok: true, result }, DENIED);
				expect(out.ok).toBe(false);
				const error = out.ok ? "" : out.error;
				expect(error).toContain(`[rule ${BROWSER_ORIGIN_DENY_RULE}]`);
				expect(error).toContain(origin);
				expect(error).not.toContain("/c/secret");
			});
		}
	}

	// 6. Other origins are unaffected.
	for (const origin of ALLOWED) {
		it(`${origin}: every op runs and its results are kept`, TODO, async () => {
			const probe = new FakeProbe(paired(origin));
			for (const [op, args] of PAGE_OPS) {
				expect(await checkBrowserPageCall(req(op, origin, args), { denied: DENIED, probe })).toEqual({ ok: true });
				expect(await checkBrowserPageCall(req(op, undefined, args), { denied: DENIED, probe })).toEqual({ ok: true });
			}
			expect(
				await checkBrowserPageCall(req("goto", origin, { url: `${origin}/chat` }), { denied: DENIED, probe }),
			).toEqual({
				ok: true,
			});
			const kept: PageCallResult = { ok: true, result: { url: `${origin}/chat` } };
			expect(checkBrowserPageResult(req("read", origin, { what: "url" }), kept, DENIED)).toEqual(kept);
		});
	}

	// 7. The setting: missing or garbage still denies both; only the owner's well-formed edit changes it.
	describe("setting file", () => {
		let dir = "";
		const envNames = ["BROWSER_ORIGIN_DENY", "PI_BROWSER_ORIGIN_DENY", "BROWSER_ORIGIN_DENY_OFF"];
		afterEach(() => {
			if (dir) rmSync(dir, { recursive: true, force: true });
			dir = "";
			for (const name of envNames) delete process.env[name];
		});
		const settingAt = (content: string | null) => {
			dir = mkdtempSync(join(tmpdir(), "browser-page-origin-"));
			const path = join(dir, "browser-origin-deny.json");
			if (content !== null) writeFileSync(path, content);
			return path;
		};

		for (const [label, content] of [
			["missing", null],
			["not JSON", "{not json"],
			["origins not a list", JSON.stringify({ v: 1, origins: "https://pi.wai2shine.com" })],
			["unknown version with an empty list", JSON.stringify({ v: 2, origins: [] })],
		] as const) {
			it(`${label}: both built-in origins, with a warning; environment ignored`, TODO, () => {
				for (const name of envNames) process.env[name] = "off";
				const read = readDeniedOrigins(settingAt(content));
				expect(read.origins).toEqual(DENIED);
				expect(read.warning).toBeTruthy();
			});
		}

		it("the owner's well-formed edit is what changes the list", TODO, () => {
			expect(readDeniedOrigins(settingAt(JSON.stringify({ v: 1, origins: [] })))).toEqual({
				origins: [],
				warning: null,
			});
			const one = readDeniedOrigins(settingAt(JSON.stringify({ v: 1, origins: ["https://example.com"] })));
			expect(one).toEqual({ origins: ["https://example.com"], warning: null });
		});
	});

	// 8. No input lifts it.
	it("no argument or flag in the request lifts the rule", TODO, async () => {
		for (const origin of DENIED) {
			const probe = new FakeProbe(paired(origin));
			for (const extra of [
				{ override: true },
				{ allowDenied: true },
				{ force: true },
				{ [BROWSER_ORIGIN_DENY_RULE]: false },
			]) {
				expectRefused(
					await checkBrowserPageCall(req("read", origin, { what: "text", ...extra }), { denied: DENIED, probe }),
					origin,
				);
			}
		}
	});

	// 9. Wired into the tool: a refused call never reaches the page; an allowed one does.
	describe("through makeBrowserPageTool", () => {
		const ctx = {} as never;
		let home = "";
		const realHome = process.env.HOME;
		afterEach(() => {
			process.env.HOME = realHome;
			if (home) rmSync(home, { recursive: true, force: true });
			home = "";
		});
		function bridge(pages: PairedPage[], reply: (r: PageCallRequest) => unknown) {
			home = mkdtempSync(join(tmpdir(), "browser-page-home-"));
			process.env.HOME = home; // no setting file here: the built-in origins apply
			const seen: PageCallRequest[] = [];
			const session = {
				pageCall: async (r: PageCallRequest): Promise<PageCallResult> => {
					seen.push(r);
					if (r.op === "pages") return { ok: true, result: { pages } };
					if (r.op === "read" && r.args?.selector === "iframe,frame") return { ok: true, result: [] };
					return { ok: true, result: reply(r) };
				},
			};
			return { seen, tool: makeBrowserPageTool(session, "c1") };
		}

		for (const origin of DENIED) {
			it(`read on ${origin}: the tool fails with the rule and nothing reaches that page`, TODO, async () => {
				const { seen, tool } = bridge(paired(origin), () => SECRET_TITLE);
				expect(browserOriginDenySettingPath().startsWith(home)).toBe(true);
				await expect(tool.execute("t1", { op: "read", target: origin }, undefined, undefined, ctx)).rejects.toThrow(
					`[rule ${BROWSER_ORIGIN_DENY_RULE}]`,
				);
				expect(seen.filter((r) => r.op !== "pages")).toEqual([]);
			});

			it(`pages through the tool: ${origin} by host only`, TODO, async () => {
				const { tool } = bridge(paired(origin, "https://example.com"), () => null);
				const out = (await tool.execute("t1", { op: "pages" }, undefined, undefined, ctx)) as {
					content: { text: string }[];
				};
				expect(out.content[0].text).not.toContain(SECRET_TITLE);
				expect(out.content[0].text).toContain(new URL(origin).host);
			});
		}

		it("read on example.com: runs as before", TODO, async () => {
			const { seen, tool } = bridge([{ origin: "https://example.com", title: "Example", open: true }], () => "hello");
			const out = (await tool.execute(
				"t1",
				{ op: "read", target: "https://example.com" },
				undefined,
				undefined,
				ctx,
			)) as {
				content: { text: string }[];
			};
			expect(out.content[0].text).toBe("hello");
			expect(
				seen.some((r) => r.op === "read" && r.target === "https://example.com" && r.args?.selector !== "iframe,frame"),
			).toBe(true);
		});
	});

	// 10. Both repos' origin matchers agree on the same vectors (pi-worktree pins the same sha256).
	it("origin vectors: parse and match as pinned, file identical to pi-worktree's", TODO, () => {
		const raw = readFileSync(new URL("./browser-origin-vectors.json", import.meta.url), "utf8");
		expect(sha(raw)).toBe(VECTORS_SHA256);
		expect([...BUILTIN_DENIED_ORIGINS]).toEqual(DENIED);
		const v = JSON.parse(raw) as {
			urls: { url: string; origin: string | null; denied: boolean }[];
			texts: { text: string; denied: string | null }[];
		};
		for (const c of v.urls) {
			expect(browserOriginOf(c.url), c.url).toBe(c.origin);
			expect(c.origin !== null && DENIED.includes(c.origin), c.url).toBe(c.denied);
		}
		for (const c of v.texts) expect(deniedOriginInText(c.text, DENIED), c.text).toBe(c.denied);
	});
});
