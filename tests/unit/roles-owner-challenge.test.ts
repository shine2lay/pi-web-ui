// O0 (#140): authorized owner challenge handler, on inert native responses and fixture principals only.
// The native inputs (T03 admitter, clocks) are replaced here with vi.mock, the only way to reach them: production
// passes no admitter, clock or randomness (Security rm-4c755cd7 B1). Each case names the naive behaviour it rules out.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RTPI_LIMITS, type RtpiRef } from "../../server/rtpi-core.js";
import {
	createOwnerChallengeHandler,
	isOwnerActionReceipt,
	OWNER_CHALLENGE_LIMITS,
	type OwnerActionTarget,
	type OwnerHostConnection,
	type OwnerPrincipalAdmission,
} from "../../server/roles-owner-challenge.js";

const native = vi.hoisted(() => ({
	admit: null as null | ((c: OwnerHostConnection) => OwnerPrincipalAdmission),
	wall: 1_000_000,
	mono: 5_000,
	draws: [] as { size: number; bytes: Buffer }[],
}));
// randomBytes is observed, never replaced: the real bytes pass through, so the B4a test can see which draw became
// the value and which became the id.
vi.mock("node:crypto", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:crypto")>();
	return {
		...real,
		randomBytes: (size: number) => {
			const bytes = real.randomBytes(size);
			native.draws.push({ size, bytes: Buffer.from(bytes) });
			return bytes;
		},
	};
});
vi.mock("../../server/roles-owner-native.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/roles-owner-native.js")>();
	return {
		...real,
		admitNativeOwnerPrincipal: (c: OwnerHostConnection) =>
			native.admit ? native.admit(c) : real.admitNativeOwnerPrincipal(c),
		serverWallNow: () => native.wall,
		serverMonotonicNow: () => native.mono,
	};
});

const ref = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const OWNER = ref("owner", "owner-1");
const admitFixture = () => {
	native.admit = () => ({ admitted: true, principal: OWNER });
};
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const conn = (over: Partial<OwnerHostConnection> = {}): OwnerHostConnection => ({
	scope: "owner-client",
	channel: "browser",
	principalBasis: "t03-native",
	pseudoClient: false,
	session: ref("session", "s-1", "branch-1"),
	window: ref("window", "w-1", "load-1"),
	client: { id: "c-1", incarnation: "inc-1", build: "build-b" },
	...over,
});
const target = (over: Partial<OwnerActionTarget> = {}): OwnerActionTarget => ({
	action: "render",
	artifact: ref("artifact", "roles-page", "rev-7"),
	projection: ref("projection", "p-1", "rev-7"),
	coverage: ref("coverage", "cov-1", "complete"),
	policy: ref("policy", "o0-display", "1"),
	...over,
});

function setup() {
	const live = new Map<string, string>([["c-1", "inc-1"]]);
	const handler = createOwnerChallengeHandler({
		currentBuild: "build-b",
		currentIncarnation: (id) => live.get(id) ?? null,
	});
	return { handler, live };
}
function issued(r: ReturnType<ReturnType<typeof setup>["handler"]["issue"]>) {
	if (r.status !== "issued") throw new Error("not issued: " + JSON.stringify(r));
	return r;
}
/** Wall and monotonic clocks moved together. */
const advance = (ms: number) => {
	native.wall += ms;
	native.mono += ms;
};

beforeEach(() => {
	native.admit = null;
	native.wall = 1_000_000;
	native.mono = 5_000;
});
afterEach(() => vi.restoreAllMocks());

describe("O0 owner challenge handler: principal and scope (B1, B3)", () => {
	it("issues nothing while T03 is missing (native admitter): unknown, never a challenge", () => {
		const { handler } = setup();
		expect(handler.issue(conn(), target())).toEqual({ status: "unknown", reason: "owner-principal-not-admitted" });
		expect(handler.pendingCount).toBe(0);
	});

	it("an admitter, clock or randomness passed as an option is ignored (not selectable by argument)", () => {
		const handler = createOwnerChallengeHandler({
			currentBuild: "build-b",
			currentIncarnation: () => "inc-1",
			admit: () => ({ admitted: true, principal: OWNER }),
			now: () => 0,
			random: (n: number) => new Uint8Array(n),
		} as never);
		expect(handler.issue(conn(), target())).toEqual({ status: "unknown", reason: "owner-principal-not-admitted" });
	});

	it("never takes browser origin, Ops108 mark, Telegram chat, client label or a model/tool/plugin flag as principal", () => {
		let calls = 0;
		native.admit = () => {
			calls++;
			return { admitted: true, principal: OWNER };
		};
		const { handler } = setup();
		for (const basis of [
			"browser-origin",
			"native-client-session",
			"ops108-owner-channel",
			"telegram-chat",
			"client-label",
			"model-flag",
			"tool-flag",
			"plugin-flag",
		] as const) {
			expect(handler.issue(conn({ principalBasis: basis }), target())).toEqual({
				status: "rejected",
				reason: "origin-admission-not-owner-auth",
			});
		}
		// Naive "origin allowlist = owner" would have admitted; the admitter is never even asked.
		expect(calls).toBe(0);
	});

	it("gives observers (host scope) no challenge and lets them answer none, whatever the client says", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		const observer = conn({ scope: "observer" });
		expect(handler.issue(observer, target())).toEqual({ status: "rejected", reason: "observer-no-challenge" });
		expect(handler.answer(observer, target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "observer-no-challenge",
		});
		// The owner's pending challenge is untouched by the observer's attempt.
		expect(handler.pendingCount).toBe(1);
	});

	it("refuses a pseudo client and a non-browser channel (Telegram cannot render or open)", () => {
		admitFixture();
		const { handler } = setup();
		expect(handler.issue(conn({ pseudoClient: true }), target())).toEqual({
			status: "rejected",
			reason: "pseudo-client",
		});
		expect(handler.issue(conn({ channel: "telegram" }), target())).toEqual({
			status: "rejected",
			reason: "channel-not-browser",
		});
		expect(handler.issue(conn({ channel: "unknown" }), target()).status).toBe("rejected");
	});

	it("an admitter answer that is not an owner ref stays unknown", () => {
		native.admit = () => ({ admitted: true, principal: ref("role", "ops") });
		const { handler } = setup();
		expect(handler.issue(conn(), target())).toEqual({ status: "unknown", reason: "owner-principal-not-admitted" });
	});

	it("client reload: the old incarnation is stale, the new one has no challenge until a fresh issue", () => {
		admitFixture();
		const { handler, live } = setup();
		const i = issued(handler.issue(conn(), target()));
		live.set("c-1", "inc-2");
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "stale-client-fresh-challenge-required",
		});
		// Client id, incarnation and build come from the ANSWERING connection: the reloaded client cannot use the
		// old challenge, and its answer payload has no field that could claim the old incarnation.
		const reloaded = conn({ client: { id: "c-1", incarnation: "inc-2", build: "build-b" } });
		expect(handler.answer(reloaded, target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "binding-changed-pending-invalidated",
		});
		issued(handler.issue(reloaded, target()));
		expect(handler.invalidateClient("c-1")).toBe(1);
		expect(handler.pendingCount).toBe(0);
	});

	it("refuses a client from a prior build, and a changed subject invalidates the pending action", () => {
		admitFixture();
		const { handler } = setup();
		expect(handler.issue(conn({ client: { id: "c-1", incarnation: "inc-1", build: "build-a" } }), target())).toEqual({
			status: "rejected",
			reason: "prior-build-client",
		});
		const i = issued(handler.issue(conn(), target()));
		const moved = target({ artifact: ref("artifact", "roles-page", "rev-8") });
		expect(handler.answer(conn(), moved, { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "binding-changed-pending-invalidated",
		});
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value }).status).toBe("rejected");
	});

	it("acknowledge/approve remain forbidden; confirm without G0 binding cannot be challenged", () => {
		admitFixture();
		const { handler } = setup();
		for (const action of ["acknowledge", "approve"]) {
			expect(handler.issue(conn(), target({ action: action as "render" }))).toEqual({
				status: "rejected",
				reason: "action-not-in-o0",
			});
		}
		expect(handler.issue(conn(), target({ action: "confirm" }))).toEqual({
			status: "rejected",
			reason: "confirm-gate-binding-required",
		});
	});
});

describe("O0 owner challenge handler: value, time and single use (B4, B5)", () => {
	it("issues a 256-bit server-held value with an id drawn independently of it, bound for exactly 60000 ms", () => {
		admitFixture();
		const { handler } = setup();
		native.draws.length = 0;
		const a = issued(handler.issue(conn(), target()));
		// Two separate draws per issue: 32 bytes become the value, then 16 fresh bytes become the id. An id derived
		// from the value (re-encoded, sliced or hashed) is not the second draw.
		expect(native.draws.map((d) => d.size)).toEqual([OWNER_CHALLENGE_LIMITS.bytes, OWNER_CHALLENGE_LIMITS.idBytes]);
		expect(native.draws[0]?.bytes.toString("base64url")).toBe(a.value);
		expect("oc-" + native.draws[1]?.bytes.toString("hex")).toBe(a.challengeId);
		const b = issued(handler.issue(conn(), target({ action: "open" })));
		expect(native.draws).toHaveLength(4);
		expect(a.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(a.value, "base64url").length).toBe(OWNER_CHALLENGE_LIMITS.bytes);
		expect(a.challengeId).toMatch(/^oc-[0-9a-f]{32}$/);
		for (const x of [a, b]) {
			expect(x.challengeId).not.toContain(x.value.slice(0, 8));
			expect(x.value).not.toContain(x.challengeId.slice(3, 11));
		}
		expect(a.issuedAt).toBe(native.wall);
		expect(a.expiresAt - a.issuedAt).toBe(RTPI_LIMITS.challengeMs);
		expect(RTPI_LIMITS.challengeMs).toBe(60000);
		expect(a.value).not.toBe(b.value);
		expect(a.challengeId).not.toBe(b.challengeId);
	});

	it("accepts once at expiresAt - 1; the receipt never carries the challenge value", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		advance(RTPI_LIMITS.challengeMs - 1);
		const r = handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value });
		expect(r.status).toBe("accepted");
		if (r.status !== "accepted") return;
		expect(r.replay).toBe(false);
		expect(r.receipt.action).toBe("render");
		expect(r.receipt.principal).toEqual(OWNER);
		expect(r.receipt.client).toEqual(ref("client", "c-1", "inc-1"));
		expect(r.receipt.serverNow).toBe(i.expiresAt - 1);
		expect(JSON.stringify(r.receipt)).not.toContain(i.value.slice(0, 8));
		expect(isOwnerActionReceipt(r.receipt)).toBe(true);
		expect(isOwnerActionReceipt(JSON.parse(JSON.stringify(r.receipt)))).toBe(false);
		expect(handler.pendingCount).toBe(0);
	});

	it("refuses at expiresAt exactly, and on an unknown wall or monotonic clock", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		advance(RTPI_LIMITS.challengeMs);
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "pending-challenge-expired-or-unbound",
		});
		native.wall = Number.NaN;
		expect(handler.issue(conn(), target())).toEqual({ status: "unknown", reason: "server-clock-unknown" });
		native.wall = 2_000_000;
		native.mono = Number.NaN;
		expect(handler.issue(conn(), target())).toEqual({ status: "unknown", reason: "server-clock-unknown" });
	});

	it("enforces the 60 s on the monotonic clock too: a wall-clock step back does not extend it", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		// 60 s pass on the monotonic clock, but the wall clock was stepped back 30 s: wall says 30 s.
		native.mono += RTPI_LIMITS.challengeMs;
		native.wall += RTPI_LIMITS.challengeMs - 30_000;
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "pending-challenge-expired-or-unbound",
		});
		// Same step, one millisecond earlier on the monotonic clock: still inside, accepted.
		const j = issued(handler.issue(conn(), target()));
		native.mono += RTPI_LIMITS.challengeMs - 1;
		native.wall += RTPI_LIMITS.challengeMs - 30_000;
		expect(handler.answer(conn(), target(), { challengeId: j.challengeId, value: j.value }).status).toBe("accepted");
		// A wall-clock step forward past expiresAt ends it early (stricter), and a monotonic clock going back unbinds it.
		const k = issued(handler.issue(conn(), target({ action: "open" })));
		native.wall += RTPI_LIMITS.challengeMs;
		native.mono += 1;
		expect(
			handler.answer(conn(), target({ action: "open" }), { challengeId: k.challengeId, value: k.value }).status,
		).toBe("rejected");
		const l = issued(handler.issue(conn(), target({ action: "open" })));
		native.mono -= 1;
		expect(handler.answer(conn(), target({ action: "open" }), { challengeId: l.challengeId, value: l.value })).toEqual({
			status: "rejected",
			reason: "pending-challenge-expired-or-unbound",
		});
	});

	it("wrong answer: refused, nothing minted, and the pending challenge is gone (no reissue)", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value + "x" })).toEqual({
			status: "rejected",
			reason: "challenge-answer-mismatch",
		});
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "challenge-unknown-or-used",
		});
		// Exact bytes: a trailing LF is a different answer, nothing is trimmed.
		const j = issued(handler.issue(conn(), target()));
		expect(handler.answer(conn(), target(), { challengeId: j.challengeId, value: j.value + "\n" }).status).toBe(
			"rejected",
		);
		expect(handler.pendingCount).toBe(0);
	});

	it("compares exact bytes, never a decoded value: strings that base64url-decode to the same bytes are refused", () => {
		admitFixture();
		const { handler } = setup();
		const variants = (v: string): string[] => {
			// The last of 43 characters carries 2 unused bits: flipping its lowest bit decodes to the same 32 bytes.
			const last = B64URL[B64URL.indexOf(v[42]) ^ 1];
			return [v.slice(0, 42) + last, v + "=", v.slice(0, 10) + "!" + v.slice(10), v.slice(0, 20) + " " + v.slice(20)];
		};
		for (const make of [0, 1, 2, 3]) {
			const i = issued(handler.issue(conn(), target()));
			const forged = variants(i.value)[make];
			expect(forged).not.toBe(i.value);
			// Naive decoded compare would pass: Node's decoder maps the forged string to the same bytes.
			expect(Buffer.from(forged, "base64url").equals(Buffer.from(i.value, "base64url"))).toBe(true);
			expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: forged })).toEqual({
				status: "rejected",
				reason: "challenge-answer-mismatch",
			});
		}
		// A same-length answer with the other alphabet's characters is refused too.
		let i = issued(handler.issue(conn(), target()));
		for (let n = 0; n < 200 && !/[-_]/.test(i.value); n++) i = issued(handler.issue(conn(), target()));
		const std = i.value.replace(/-/g, "+").replace(/_/g, "/");
		expect(std.length).toBe(i.value.length);
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: std }).status).toBe("rejected");
	});

	it("identical duplicate = original receipt, even after expiry; conflicting duplicate = conflict, no second effect", () => {
		admitFixture();
		const { handler } = setup();
		const i = issued(handler.issue(conn(), target()));
		const first = handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value });
		if (first.status !== "accepted") throw new Error("not accepted");
		advance(3_600_000);
		const again = handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value });
		expect(again).toEqual({ status: "accepted", replay: true, receipt: first.receipt });
		if (again.status === "accepted") expect(again.receipt).toBe(first.receipt);
		expect(handler.answer(conn(), target(), { challengeId: i.challengeId, value: "other" })).toEqual({
			status: "rejected",
			reason: "dedup-key-conflict",
		});
		expect(handler.answer(conn(), target({ action: "open" }), { challengeId: i.challengeId, value: i.value })).toEqual({
			status: "rejected",
			reason: "dedup-key-conflict",
		});
		expect(handler.pendingCount).toBe(0);
	});

	it("keeps one pending challenge per binding (a new issue replaces it) and refuses when the global cap is full", () => {
		admitFixture();
		const { handler } = setup();
		const a = issued(handler.issue(conn(), target()));
		const b = issued(handler.issue(conn(), target()));
		expect(handler.pendingCount).toBe(1);
		expect(handler.answer(conn(), target(), { challengeId: a.challengeId, value: a.value })).toEqual({
			status: "rejected",
			reason: "challenge-unknown-or-used",
		});
		expect(handler.answer(conn(), target(), { challengeId: b.challengeId, value: b.value }).status).toBe("accepted");
		// Fill the cap with distinct bindings (one per window), then the next is refused, not queued or evicted.
		for (let n = 0; n < OWNER_CHALLENGE_LIMITS.pending; n++)
			issued(handler.issue(conn({ window: ref("window", "w-" + n, "load-1") }), target()));
		expect(handler.pendingCount).toBe(OWNER_CHALLENGE_LIMITS.pending);
		expect(handler.issue(conn({ window: ref("window", "w-extra", "load-1") }), target())).toEqual({
			status: "unavailable",
			reason: "challenge-capacity",
		});
		// Expired ones are dropped first; then there is room again.
		advance(RTPI_LIMITS.challengeMs);
		issued(handler.issue(conn({ window: ref("window", "w-extra", "load-1") }), target()));
		expect(handler.pendingCount).toBe(1);
	});

	it("no record, log or error carries the value or a prefix of it", () => {
		admitFixture();
		const logs: string[] = [];
		for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const)
			vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
		const out: unknown[] = [];
		const { handler, live } = setup();
		const values: string[] = [];
		const run = (fn: () => unknown) => {
			try {
				out.push(fn());
			} catch (e) {
				out.push(String(e));
			}
		};
		const i = issued(handler.issue(conn(), target()));
		values.push(i.value);
		run(() => handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value }));
		run(() => handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value }));
		run(() => handler.answer(conn(), target(), { challengeId: i.challengeId, value: i.value.slice(0, 20) }));
		const j = issued(handler.issue(conn(), target({ action: "open" })));
		values.push(j.value);
		run(() => handler.answer(conn(), target({ action: "open" }), { challengeId: j.challengeId, value: j.value + "x" }));
		run(() => handler.answer(conn(), target(), { challengeId: j.value, value: j.value }));
		const k = issued(handler.issue(conn(), target()));
		values.push(k.value);
		live.set("c-1", "inc-9");
		run(() => handler.answer(conn(), target(), { challengeId: k.challengeId, value: k.value }));
		run(() => handler.answer(null as never, target(), null as never));
		run(() =>
			handler.answer(conn({ client: { id: "c-1", incarnation: "inc-9", build: "build-b" } }), target(), null as never),
		);
		const text = JSON.stringify(out) + logs.join("\n") + JSON.stringify(handler);
		for (const v of values) expect(text).not.toContain(v.slice(0, 8));
		expect(logs).toEqual([]);
	});

	it("has no production importer, route, key, file, timer, env read or fixture admitter", () => {
		// Every production source, not a chosen few: only the named inert O0+G0 component may name itself.
		const sources = (dir: string): string[] =>
			existsSync(dir)
				? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
						d.isDirectory()
							? d.name === "node_modules" || d.name === "dist"
								? []
								: sources(join(dir, d.name))
							: /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(d.name)
								? [join(dir, d.name)]
								: [],
					)
				: [];
		const inert = new Set([
			"server/roles-contact.ts",
			"server/roles-owner-challenge.ts",
			"server/roles-owner-native.ts",
			"server/roles-artifact.ts",
			"server/roles-gates.ts",
			"server/roles-gates-native.ts",
		]);
		const files = ["server", "web/src", "plugins", "extensions", "bin", "desktop"].flatMap(sources);
		expect(files).toContain("server/index.ts");
		const importers = files.filter(
			(p) =>
				!inert.has(p) &&
				/(from\s+|import\(\s*|require\(\s*)["'][^"']*roles-(owner-challenge|owner-native|contact|artifact|gates|gates-native)\b/.test(
					readFileSync(p, "utf8"),
				),
		);
		expect(importers).toEqual([]);
		for (const path of ["server/roles-owner-challenge.ts", "server/roles-owner-native.ts"]) {
			const code = readFileSync(path, "utf8");
			expect(code).not.toMatch(/appendFile|writeFile|readFile|setInterval|setTimeout|process\.env|console\.|fetch\(/);
			expect(code).not.toMatch(/createRtpiFixtureCapability|rtpi-fixture|vitest/);
		}
		// The native module admits nobody: no return of an admitted principal anywhere in it.
		expect(readFileSync("server/roles-owner-native.ts", "utf8")).not.toMatch(/admitted:\s*true/);
	});
});
