/** #157 H-RECONNECT-SILENT: fake clocks/transports only, no Telegram or model traffic. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_FILE,
	ConnEvents,
	LOG_FILE,
	NOTICE_GAP_MS,
	STATE_FILE,
	createConnNoticeHub,
	type ConnNotice,
	type ConnNoticeDeliver,
} from "../../server/conn-events";

const T0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3_600_000;
let dir: string;
let serial: number;
let made: ConnEvents[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "conn-silent-"));
	serial = 0;
	made = [];
});
afterEach(() => {
	for (const c of made) c.stop();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});
function config(value: unknown) {
	const file = join(dir, CONFIG_FILE);
	writeFileSync(file, JSON.stringify(value));
	// A deterministic file incarnation even when the fake clock hasn't advanced.
	const t = (T0 + ++serial * 100) / 1000;
	utimesSync(file, t, t);
}
function setup(deliver?: ConnNoticeDeliver, now = T0) {
	const clock = { now };
	const sent: ConnNotice[] = [];
	const ce = new ConnEvents({
		dataDir: dir,
		now: () => clock.now,
		gc: false,
		deliver:
			deliver ??
			(async (n) => {
				sent.push(n);
				return true;
			}),
	});
	made.push(ce);
	return { ce, clock, sent };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function episode(ce: ConnEvents, id = "aaaaaaaa00000001", endAgoMs = 0) {
	return ce.banner(
		[
			{
				ep: id,
				reason: "silence",
				quietMs: 5100,
				durMs: 10,
				endAgoMs,
				sockAgeMs: 60_000,
				sinceFrameMs: 5100,
				visible: true,
				online: true,
				endVisible: true,
				patience: 1,
				sockets: 1,
				drops: 0,
			},
		],
		{ conn: "012345abcdef", clientId: "browser" },
	);
}
function state() {
	return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
}
function log() {
	try {
		return readFileSync(join(dir, LOG_FILE), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
function deferred() {
	let resolve!: (value: boolean) => void;
	const promise = new Promise<boolean>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("split capture/notice permission", () => {
	for (const enabled of [false, true])
		for (const notices of [false, true])
			it(`enabled=${enabled}, notices=${notices}: capture and calls are independent`, async () => {
				config({ enabled, notices });
				const { ce, clock, sent } = setup();
				clock.now += 30_000;
				ce.sample();
				clock.now += 10_000;
				ce.sample();
				ce.opened("012345abcdef", "browser", true, 1);
				ce.closed("012345abcdef", "browser", true, 1006, 100);
				expect(episode(ce)).toBe(enabled ? 1 : 0);
				await tick();
				expect(sent).toHaveLength(enabled && notices ? 1 : 0);
				expect(
					log()
						.filter((l) => l.kind !== "notice")
						.map((l) => l.kind),
				).toEqual(enabled ? ["loop", "open", "close", "banner"] : []);
				expect(state().pending).toBeNull();
			});

	// Run this exact case against the old module as the fail-without-the-fix control.
	it("capture remains active with notices explicitly disabled", async () => {
		config({ enabled: true, notices: false });
		const { ce, clock, sent } = setup();
		clock.now += 30_000;
		expect(episode(ce)).toBe(1);
		await tick();
		expect(log().some((l) => l.kind === "banner")).toBe(true);
		expect(sent).toHaveLength(0);
	});

	for (const value of [undefined, {}, { enabled: true }, { enabled: true, notices: "true" }])
		it(`missing/invalid opt-in is SILENT: ${JSON.stringify(value)}`, async () => {
			if (value !== undefined) config(value);
			const { ce, clock, sent } = setup();
			clock.now += 30_000;
			expect(episode(ce)).toBe(1);
			await ce.flush();
			await tick();
			expect(sent).toHaveLength(0);
			expect(log().filter((l) => l.kind === "notice")).toHaveLength(0);
		});

	for (const kind of ["malformed", "directory", "invalid-object", "permissions"])
		it(`unreadable/invalid config fails closed: ${kind}`, async () => {
			if (kind === "directory") mkdirSync(join(dir, CONFIG_FILE));
			else writeFileSync(join(dir, CONFIG_FILE), kind === "malformed" ? "{bad" : "null");
			if (kind === "permissions") chmodSync(join(dir, CONFIG_FILE), 0);
			const { ce, clock, sent } = setup();
			clock.now += 30_000;
			expect(ce.enabled()).toBe(false);
			expect(ce.noticesEnabled()).toBe(false);
			expect(episode(ce)).toBe(0);
			ce.resume();
			await ce.flush();
			await tick();
			expect(sent).toHaveLength(0);
			expect(log()).toHaveLength(0);
		});

	it("revocation bypasses the capture cache; fresh explicit opt-in never replays muted episodes", async () => {
		config({ enabled: true, notices: true });
		const { ce, clock, sent } = setup();
		clock.now += 30_000;
		episode(ce);
		await tick();
		config({ enabled: true, notices: false });
		clock.now += 1;
		episode(ce, "aaaaaaaa00000002");
		await tick(); // less than the 3s cache TTL
		expect(sent).toHaveLength(1);
		expect(state().pending).toBeNull();
		clock.now += NOTICE_GAP_MS;
		config({ enabled: true, notices: true });
		expect(ce.noticesEnabled()).toBe(true);
		episode(ce, "aaaaaaaa00000003", 10_000); // delayed record from before new opt-in
		expect(episode(ce, "aaaaaaaa00000002")).toBe(0); // already captured while muted
		clock.now += 100;
		episode(ce, "aaaaaaaa00000004");
		await tick();
		expect(sent).toHaveLength(2);
		expect(sent[1].more).toBeNull();
		expect(log().filter((l) => l.kind === "banner")).toHaveLength(4);
	});

	for (const off of [{ enabled: true, notices: false }, { enabled: false, notices: true }, null])
		it(`pending-summary timer, flush and restart discard revoked backlog: ${JSON.stringify(off)}`, async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			config({ enabled: true, notices: true });
			const { ce, clock, sent } = setup();
			clock.now += 30_000;
			episode(ce);
			await tick();
			clock.now += 1_000;
			episode(ce, "aaaaaaaa00000002");
			expect(state().pending.count).toBe(1);
			config(off);
			clock.now += NOTICE_GAP_MS;
			await vi.advanceTimersByTimeAsync(NOTICE_GAP_MS);
			await ce.flush();
			ce.resume();
			await tick();
			expect(sent).toHaveLength(1);
			expect(state().pending).toBeNull();
			ce.stop();
			const b = setup(undefined, clock.now);
			b.ce.resume();
			await b.ce.flush();
			expect(b.sent).toHaveLength(0);
			config({ enabled: true, notices: true });
			b.ce.noticesEnabled();
			b.clock.now += NOTICE_GAP_MS;
			b.ce.resume();
			await b.ce.flush();
			expect(b.sent).toHaveLength(0);
		});

	for (const success of [false, true])
		it(`inflight ${success ? "success" : "failure"} after mute/re-enable never restores old backlog`, async () => {
			config({ enabled: true, notices: true });
			const d = deferred();
			const calls: ConnNotice[] = [];
			let guard: (() => boolean) | undefined;
			const { ce, clock } = setup(async (n, permitted) => {
				calls.push(n);
				guard = permitted;
				return calls.length === 1 ? d.promise : true;
			});
			clock.now += 30_000;
			episode(ce);
			expect(calls).toHaveLength(1);
			config({ enabled: true, notices: false });
			expect(ce.noticesEnabled()).toBe(false);
			expect(guard?.()).toBe(false);
			clock.now += 10_000;
			config({ enabled: true, notices: true });
			expect(ce.noticesEnabled()).toBe(true);
			clock.now += 100;
			episode(ce, "aaaaaaaa00000002"); // a fresh one while old send awaits
			expect(state().pending.count).toBe(1);
			d.resolve(success);
			await tick();
			expect(guard?.()).toBe(false);
			expect(state().pending.count).toBe(1); // neither lost nor mixed with the old item
			expect(state().inflight).toBeNull();
			expect(log().find((l) => l.kind === "notice")).toMatchObject({ sent: success, muted: true });
			clock.now += NOTICE_GAP_MS;
			await ce.flush();
			expect(calls).toHaveLength(2);
			expect(calls[1].more?.count).toBe(1);
		});

	it("inflight rejection while still muted cannot queue a retry or survive restart", async () => {
		config({ enabled: true, notices: true });
		const d = deferred();
		const { ce, clock } = setup(() => d.promise);
		clock.now += 30_000;
		episode(ce);
		config({ enabled: true, notices: false });
		d.resolve(false);
		await tick();
		expect(state().pending).toBeNull();
		expect(state().inflight).toBeNull();
		ce.stop();
		const b = setup(undefined, clock.now + NOTICE_GAP_MS);
		b.ce.resume();
		await b.ce.flush();
		expect(b.sent).toHaveLength(0);
	});

	it("a failed transport retries only within the same opt-in; mute clears its retry", async () => {
		config({ enabled: true, notices: true });
		let calls = 0;
		const { ce, clock } = setup(async () => {
			calls++;
			return false;
		});
		clock.now += 30_000;
		episode(ce);
		await tick();
		expect(calls).toBe(1);
		clock.now += NOTICE_GAP_MS;
		await ce.flush();
		expect(calls).toBe(2);
		config({ enabled: true, notices: false });
		clock.now += NOTICE_GAP_MS;
		await ce.flush();
		ce.resume();
		expect(calls).toBe(2);
		expect(state().pending).toBeNull();
		config({ enabled: true, notices: true });
		ce.noticesEnabled();
		await ce.flush();
		expect(calls).toBe(2);
	});

	it("restart retains continuous opt-in retry, but an off/on rewrite while down fences it out", async () => {
		config({ enabled: true, notices: true });
		const a = setup(() => new Promise<boolean>(() => {}));
		a.clock.now += 30_000;
		episode(a.ce);
		const id = state().inflight.id;
		a.ce.stop();
		const b = setup(undefined, a.clock.now + 1_000);
		b.ce.resume();
		await tick();
		expect(b.sent[0].id).toBe(id);
		b.ce.stop();
		// Store another inflight, then change permission while the process is down.
		const c = setup(() => new Promise<boolean>(() => {}), a.clock.now + NOTICE_GAP_MS * 2);
		episode(c.ce, "aaaaaaaa00000002");
		c.ce.stop();
		config({ enabled: true, notices: false });
		config({ enabled: true, notices: true });
		const e = setup(undefined, c.clock.now + NOTICE_GAP_MS);
		e.ce.resume();
		await e.ce.flush();
		expect(e.sent).toHaveLength(0);
		expect(state().inflight).toBeNull();
		expect(state().pending).toBeNull();
	});

	it("legacy state without a permission fence never replays, even with a new explicit opt-in", async () => {
		config({ enabled: true, notices: true });
		const a = setup(() => new Promise<boolean>(() => {}));
		a.clock.now += 30_000;
		episode(a.ce);
		a.ce.stop();
		const legacy = state();
		delete legacy.noticePolicy;
		writeFileSync(join(dir, STATE_FILE), JSON.stringify(legacy));
		const b = setup(undefined, a.clock.now + 10_000);
		b.ce.resume();
		await b.ce.flush();
		expect(b.sent).toHaveLength(0);
		expect(state().inflight).toBeNull();
	});

	it("hub fallback is gated after a delayed failure; no second submission after revocation", async () => {
		config({ enabled: true, notices: true });
		const hub = createConnNoticeHub();
		const d = deferred();
		let later = 0;
		hub.on(() => d.promise);
		hub.on(() => {
			later++;
			return true;
		});
		const { ce, clock } = setup((n, permitted) => hub.deliver(n, permitted));
		clock.now += 30_000;
		episode(ce);
		config({ enabled: true, notices: false });
		d.resolve(false);
		await tick();
		expect(later).toBe(0);
		expect(state().pending).toBeNull();
	});
});
