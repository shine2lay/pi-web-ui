/**
 * subs-limits-box: the Limits box under History.
 *  1. server/subs-limits.ts: reading pi-multi-pass's readings file (checked, version 1 only), meeting
 *     pi-multi-pass on globalThis (either side may create the channel; another version is left alone),
 *     pushing changes to every window (no repeats), and the refresh button (joins, reports why it
 *     couldn't run, works with no chat loaded = file only).
 *  2. web/src/subs-limits-state.ts: the store (a press spins until the server answers it) and what a
 *     row shows (colors, "resets in", "checked N min ago", window order).
 * The browser side (rows on desktop and in the phone drawer) is tests/subs-limits-box-test.mjs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	joinLimitsChannel,
	LIMITS_CHANNEL_KEY,
	limitsFilePath,
	NO_CHECKER,
	readLimitsFile,
	sanitizeLimits,
	SubsLimitsHub,
	type LimitsChannelV1,
} from "../../server/subs-limits.js";
import type { ServerMessage, UiLimitsAccount } from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import {
	accountLimited,
	accountWho,
	agoParts,
	formatResetIn,
	getSubsLimits,
	limitLevel,
	orderedWindows,
	PRESS_TIMEOUT_MS,
	receiveSubsLimits,
	refreshSubsLimits,
	requestSubsLimits,
	resetSubsLimitsForTest,
} from "../../web/src/subs-limits-state.js";

const NOW = 1_790_000_000_000;

function account(provider: string, extra: Partial<UiLimitsAccount> = {}): UiLimitsAccount {
	return {
		provider,
		base: provider.replace(/-\d+$/, ""),
		number: Number(/-(\d+)$/.exec(provider)?.[1] ?? 1),
		name: provider,
		windows: [
			{ key: "5h", label: "5-hour", usedPercent: 12, resetAt: NOW / 1000 + 3600 },
			{ key: "7d", label: "Weekly", usedPercent: 40, resetAt: NOW / 1000 + 86400 },
		],
		checkedAt: NOW,
		source: "check",
		...extra,
	};
}

function readings(accounts: UiLimitsAccount[], checkedAt: number | undefined = NOW) {
	return { version: 1, updatedAt: NOW, ...(checkedAt !== undefined ? { checkedAt } : {}), accounts };
}

describe("server: the readings file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subs-limits-unit-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("lives in pi-multi-pass's own data folder", () => {
		expect(limitsFilePath("/a/agent")).toBe("/a/agent/multi-pass-quota/subs-limits.json");
	});

	it("keeps every account, cleans what it can't use, and drops what isn't version 1", () => {
		const view = sanitizeLimits(
			readings([
				account("anthropic"),
				account("anthropic-2", {
					windows: [
						{ key: "7d", label: "Weekly", usedPercent: 140, limited: true },
						{ key: "", label: "nameless" } as never,
					],
					failure: { reason: "busy", text: "provider busy (429)", at: NOW },
				}),
				{ provider: "no-name" } as never,
				account("openai-codex", { failure: { reason: "nonsense", text: "x", at: 1 } as never }),
			]),
		);
		expect(view?.checkedAt).toBe(NOW);
		expect(view?.accounts.map((a) => a.provider)).toEqual(["anthropic", "anthropic-2", "openai-codex"]);
		const two = view!.accounts[1];
		expect(two.windows).toEqual([{ key: "7d", label: "Weekly", usedPercent: 100, limited: true }]);
		expect(two.failure).toEqual({ reason: "busy", text: "provider busy (429)", at: NOW });
		expect(view!.accounts[2].failure).toBeUndefined();
		expect(sanitizeLimits({ version: 2, accounts: [] })).toBeUndefined();
		expect(sanitizeLimits(null)).toBeUndefined();
	});

	it("reads nothing from a missing or broken file", () => {
		expect(readLimitsFile(join(dir, "none.json"))).toBeUndefined();
		writeFileSync(join(dir, "bad.json"), "{not json");
		expect(readLimitsFile(join(dir, "bad.json"))).toBeUndefined();
	});
});

describe("server: the channel on globalThis", () => {
	it("creates version 1 when nobody has, joins pi-multi-pass's, and leaves another version alone", () => {
		const g: Record<symbol, unknown> = {};
		const made = joinLimitsChannel(g);
		expect(made?.v).toBe(1);
		expect(g[LIMITS_CHANNEL_KEY]).toBe(made);
		expect(joinLimitsChannel(g)).toBe(made);
		const other: Record<symbol, unknown> = { [LIMITS_CHANNEL_KEY]: { v: 2, listeners: new Set() } };
		expect(joinLimitsChannel(other)).toBeUndefined();
		expect((other[LIMITS_CHANNEL_KEY] as { v: number }).v).toBe(2);
	});
});

describe("server: SubsLimitsHub", () => {
	let dir: string;
	let file: string;
	let g: Record<symbol, unknown>;
	let sent: Extract<ServerMessage, { type: "subs_limits" }>[];
	let hub: SubsLimitsHub;
	const channel = () => g[LIMITS_CHANNEL_KEY] as LimitsChannelV1;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subs-limits-hub-"));
		file = join(dir, "multi-pass-quota", "subs-limits.json");
		g = {};
		sent = [];
		hub = new SubsLimitsHub({
			file,
			global: g,
			pollMs: 0,
			broadcast: (msg) => sent.push(msg as Extract<ServerMessage, { type: "subs_limits" }>),
		});
		hub.start();
	});
	afterEach(() => {
		hub.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const writeFile = (accounts: UiLimitsAccount[], checkedAt?: number) => {
		mkdirSync(join(dir, "multi-pass-quota"), { recursive: true });
		writeFileSync(file, JSON.stringify(readings(accounts, checkedAt)));
	};

	it("before any check: no accounts and no checkedAt (the box says Not checked yet)", () => {
		expect(hub.message()).toEqual({ type: "subs_limits", accounts: [], checking: false });
	});

	it("tells every window when pi-multi-pass announces readings, never the same thing twice", () => {
		const r = readings([account("anthropic"), account("openai-codex")]);
		channel().listeners.forEach((l) => l({ checking: false, readings: r }));
		channel().listeners.forEach((l) => l({ checking: false, readings: r }));
		expect(sent).toHaveLength(1);
		expect(sent[0].accounts.map((a) => a.provider)).toEqual(["anthropic", "openai-codex"]);
		expect(sent[0].checkedAt).toBe(NOW);
		channel().listeners.forEach((l) => l({ checking: true }));
		expect(sent.at(-1)?.checking).toBe(true);
	});

	it("shows the file when no chat has loaded pi-multi-pass, and refresh says why it can't check", async () => {
		writeFile([account("anthropic", { failure: { reason: "timeout", text: "timed out", at: NOW } })]);
		expect(hub.message().accounts[0].failure?.text).toBe("timed out");
		expect(await hub.refresh()).toBe(NO_CHECKER);
	});

	it("refresh runs pi-multi-pass's check, spins every window meanwhile, and joins a press while it runs", async () => {
		let finish!: () => void;
		const check = vi.fn(() => {
			if (!running) {
				running = new Promise<void>((resolve) => {
					finish = () => {
						writeFile([account("anthropic"), account("anthropic-2"), account("openai-codex")]);
						running = undefined;
						resolve();
					};
				});
			}
			return running;
		});
		let running: Promise<void> | undefined;
		channel().api = { check, checking: () => running !== undefined };
		const first = hub.refresh();
		const second = hub.refresh();
		expect(sent.at(-1)?.checking).toBe(true);
		finish();
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
		const last = sent.at(-1)!;
		expect(last.checking).toBe(false);
		expect(last.accounts.map((a) => a.provider)).toEqual(["anthropic", "anthropic-2", "openai-codex"]);
	});

	it("a check that throws is reported to the window that pressed, and the spinner stops", async () => {
		channel().api = { check: () => Promise.reject(new Error("boom")) };
		expect(await hub.refresh()).toBe("The check failed: boom");
		expect(sent.at(-1)?.checking).toBe(false);
	});

	it("follows a channel pi-multi-pass puts there later (a fresh one after a reload)", async () => {
		const fresh: LimitsChannelV1 = { v: 1, listeners: new Set(), api: { check: async () => undefined } };
		g[LIMITS_CHANNEL_KEY] = fresh;
		expect(await hub.refresh()).toBeUndefined();
		expect(fresh.listeners.size).toBe(1);
	});
});

describe("client: what a row shows", () => {
	it("colors: plain under 75%, amber from 75%, red from 90% or when limited", () => {
		expect(limitLevel({ usedPercent: 74.9 })).toBe("ok");
		expect(limitLevel({ usedPercent: 75 })).toBe("warn");
		expect(limitLevel({ usedPercent: 89 })).toBe("warn");
		expect(limitLevel({ usedPercent: 90 })).toBe("bad");
		expect(limitLevel({ usedPercent: 10, limited: true })).toBe("bad");
		expect(limitLevel({})).toBe("ok");
	});

	it("resets in days, hours, minutes; null once passed; nothing without a time", () => {
		const s = NOW / 1000;
		expect(formatResetIn(s + 4 * 86400 + 2 * 3600 + 60, NOW)).toBe("4d 2h");
		expect(formatResetIn(s + 3 * 3600 + 20 * 60, NOW)).toBe("3h 20m");
		expect(formatResetIn(s + 12 * 60 + 5, NOW)).toBe("12m");
		expect(formatResetIn(s + 20, NOW)).toBe("<1m");
		expect(formatResetIn(s - 1, NOW)).toBeNull();
		expect(formatResetIn(undefined, NOW)).toBeUndefined();
	});

	it("checked N ago in whole units", () => {
		expect(agoParts(NOW - 30_000, NOW)).toEqual({ unit: "now", n: 0 });
		expect(agoParts(NOW - 5 * 60_000, NOW)).toEqual({ unit: "min", n: 5 });
		expect(agoParts(NOW - 3 * 3_600_000, NOW)).toEqual({ unit: "h", n: 3 });
		expect(agoParts(NOW - 3 * 86_400_000, NOW)).toEqual({ unit: "d", n: 3 });
	});

	it("5-hour first, then weekly, then the per-model windows in their order", () => {
		const order = orderedWindows([
			{ key: "7d:opus", label: "Weekly · Opus" },
			{ key: "7d", label: "Weekly" },
			{ key: "7d:sonnet", label: "Weekly · Sonnet" },
			{ key: "5h", label: "5-hour" },
		]).map((w) => w.key);
		expect(order).toEqual(["5h", "7d", "7d:opus", "7d:sonnet"]);
	});

	it("limited by its own mark or a window at its cap; who = label, else email", () => {
		expect(accountLimited(account("a"))).toBe(false);
		expect(accountLimited(account("a", { limited: true }))).toBe(true);
		expect(accountLimited(account("a", { windows: [{ key: "7d", label: "Weekly", limited: true }] }))).toBe(true);
		expect(accountWho(account("a", { label: "work", email: "x@y" }))).toBe("work");
		expect(accountWho(account("a", { email: "x@y" }))).toBe("x@y");
		expect(accountWho(account("a"))).toBeUndefined();
	});
});

describe("client: the store", () => {
	let out: unknown[];
	beforeEach(() => {
		out = [];
		resetSubsLimitsForTest();
		setAppSend((msg) => {
			out.push(msg);
			return true;
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		setAppSend(null);
	});

	it("asks for the readings, and starts as not loaded and not checked", () => {
		requestSubsLimits();
		expect(out).toEqual([{ type: "subs_limits_get" }]);
		expect(getSubsLimits()).toMatchObject({ loaded: false, accounts: [], checking: false, pressed: false });
	});

	it("a press spins at once; numbers from a reply don't stop it; the check's start and end do", () => {
		receiveSubsLimits({ type: "subs_limits", accounts: [], checking: false });
		refreshSubsLimits();
		expect(out.at(-1)).toEqual({ type: "subs_limits_refresh" });
		expect(getSubsLimits().pressed).toBe(true);
		receiveSubsLimits({ type: "subs_limits", accounts: [account("anthropic")], checking: false });
		expect(getSubsLimits().pressed).toBe(true);
		receiveSubsLimits({ type: "subs_limits", accounts: [account("anthropic")], checking: true });
		expect(getSubsLimits()).toMatchObject({ pressed: false, checking: true });
		receiveSubsLimits({ type: "subs_limits", accounts: [account("anthropic")], checkedAt: NOW, checking: false });
		expect(getSubsLimits()).toMatchObject({ pressed: false, checking: false, checkedAt: NOW });
	});

	it("a press while a check runs keeps spinning until it ends", () => {
		receiveSubsLimits({ type: "subs_limits", accounts: [], checking: true });
		refreshSubsLimits();
		receiveSubsLimits({ type: "subs_limits", accounts: [account("anthropic")], checking: false });
		expect(getSubsLimits()).toMatchObject({ pressed: false, checking: false });
	});

	it("a refresh that couldn't run stops spinning and says why", () => {
		receiveSubsLimits({ type: "subs_limits", accounts: [], checking: false });
		refreshSubsLimits();
		receiveSubsLimits({ type: "subs_limits", accounts: [], checking: false, error: NO_CHECKER });
		expect(getSubsLimits()).toMatchObject({ pressed: false, error: NO_CHECKER });
		refreshSubsLimits();
		expect(getSubsLimits().error).toBeUndefined();
	});

	it("a press nobody answers stops spinning after a while", () => {
		vi.useFakeTimers();
		receiveSubsLimits({ type: "subs_limits", accounts: [], checking: false });
		refreshSubsLimits();
		vi.advanceTimersByTime(PRESS_TIMEOUT_MS + 1);
		expect(getSubsLimits().pressed).toBe(false);
	});

	it("offline: the press isn't sent and nothing spins", () => {
		setAppSend(() => false);
		refreshSubsLimits();
		expect(getSubsLimits().pressed).toBe(false);
	});
});
