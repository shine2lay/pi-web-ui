/**
 * reconnect-trace (Ops #157): the server's connection log and the owner notices (server/conn-events.ts).
 * Fake clock, fake event-loop histogram, fake notice transport, a temp data folder: no network, no
 * Telegram. Checks placement against the loop record, the socket records, the strict record check,
 * the 10-minute limit and its sum, replay after a restart, the off switch, rotation, and that nothing
 * but metadata is written.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_FILE,
	ConnEvents,
	KEEP_DAYS,
	LOG_FILE,
	MAX_RECORDS_PER_MESSAGE,
	NOTICE_GAP_MS,
	type ConnNotice,
	createConnNoticeHub,
	hashClient,
	sanitizeRecord,
} from "../../server/conn-events";
import type { ConnTraceRecord } from "../../server/protocol";

const DAY = 86_400_000;
/** One hour into the current UTC day: real file times and the fake clock share a day. */
const T0 = Math.floor(Date.now() / DAY) * DAY + 3_600_000;

let dir = "";
/** Every instance a test made: stopped afterwards (no flush timers left behind). */
let made: ConnEvents[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "conn-events-"));
});
afterEach(() => {
	for (const c of made) c.stop();
	made = [];
	rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: log lines are plain JSON
type Line = Record<string, any>;

/** Every log line, rotated files first. */
function lines(): Line[] {
	const files = readdirSync(dir)
		.filter((f) => f.startsWith("conn-events"))
		.sort((a, b) => (a === LOG_FILE ? 1 : b === LOG_FILE ? -1 : a.localeCompare(b)));
	return files.flatMap((f) =>
		readFileSync(join(dir, f), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Line),
	);
}

function fakeHist() {
	const h = {
		maxNs: 0,
		p99Ns: 0,
		n: 0,
		enable: () => true,
		disable: () => true,
		reset: () => {
			h.maxNs = 0;
			h.p99Ns = 0;
			h.n = 0;
		},
		percentile: (_p: number) => h.p99Ns,
		get max() {
			return h.maxNs;
		},
		get count() {
			return h.n;
		},
	};
	return h;
}

function setup(opts: { startedAt?: number; deliver?: (n: ConnNotice) => Promise<boolean> } = {}) {
	const clock = { now: T0 };
	const hist = fakeHist();
	const sent: ConnNotice[] = [];
	const deliver =
		opts.deliver ??
		(async (n: ConnNotice) => {
			sent.push(n);
			return true;
		});
	const ce = new ConnEvents({
		dataDir: dir,
		now: () => clock.now,
		deliver,
		gc: false,
		histogram: () => hist,
		startedAt: opts.startedAt ?? T0 - 3_600_000,
	});
	made.push(ce);
	return { ce, clock, hist, sent };
}

/** A page's record of an episode that ended `endAgoMs` ago. */
function rec(over: Partial<ConnTraceRecord> = {}): ConnTraceRecord {
	return {
		ep: "0123456789abcdef",
		reason: "silence",
		quietMs: 5_100,
		allowedMs: 5_000,
		durMs: 8_000,
		endAgoMs: 1_000,
		sockAgeMs: 600_000,
		sinceFrameMs: 5_100,
		visible: true,
		online: true,
		endVisible: true,
		patience: 1,
		sockets: 1,
		drops: 0,
		catchUpMs: 900,
		conn: "a1b2c3d4e5f6",
		...over,
	};
}

const tick = () => new Promise((r) => setImmediate(r));

describe("conn-events: event-loop samples", () => {
	it("each window writes p99/max delay, CPU and GC totals, and starts the next one empty", () => {
		const { ce, clock, hist } = setup();
		ce.sample(); // starts measuring
		clock.now += 10_000;
		hist.n = 500;
		hist.maxNs = 6_200e6;
		hist.p99Ns = 6_100e6;
		ce.noteGc(clock.now - 4_000, 130);
		ce.noteGc(clock.now - 3_000, 4);
		ce.sample();
		clock.now += 10_000;
		ce.sample();
		const loop = lines().filter((l) => l.kind === "loop");
		expect(loop).toHaveLength(2);
		expect(loop[0]).toMatchObject({ windowMs: 10_000, p99Ms: 6_100, maxMs: 6_200, gcN: 2, gcMs: 134, gcMaxMs: 130 });
		expect(typeof loop[0].cpuMs).toBe("number");
		expect(loop[1]).toMatchObject({ p99Ms: 0, maxMs: 0, gcN: 0, gcMs: 0 });
	});
});

describe("conn-events: a page's episode placed on the server's clock", () => {
	it("gets the worst loop delay and the long GC pauses from the time frames stopped to its end", () => {
		const { ce, clock, hist, sent } = setup();
		ce.sample();
		// Window 1 (T0..T0+10s): calm. Window 2 (..+20s): a 6.2 s stall. Window 3 (..+30s): calm.
		for (const [maxMs, gcMs] of [
			[12, 0],
			[6_200, 900],
			[15, 0],
		]) {
			clock.now += 10_000;
			hist.n = 100;
			hist.maxNs = maxMs * 1e6;
			hist.p99Ns = maxMs * 1e6;
			if (gcMs) ce.noteGc(clock.now - 6_000, gcMs);
			ce.sample();
		}
		// The note came up at T0+19s (frames stopped 5.1 s before) and went at T0+27s; sent at T0+28s.
		clock.now = T0 + 28_000;
		expect(ce.banner([rec()], { conn: "0f0f0f0f0f0f", clientId: "browser-1" })).toBe(1);
		const b = lines().find((l) => l.kind === "banner") as Line;
		expect(b).toMatchObject({
			reason: "silence",
			srvStart: T0 + 19_000,
			srvEnd: T0 + 27_000,
			srvRestart: false,
			loopMaxMs: 6_200,
			longGcN: 1,
			longGcMs: 900,
			via: "0f0f0f0f0f0f",
			client: hashClient("browser-1"),
		});
		expect(b.loopSamples).toBeGreaterThanOrEqual(2);
		return tick().then(() => {
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				kind: "event",
				at: T0 + 19_000,
				durMs: 8_000,
				reason: "silence",
				closeCode: null,
				maxLoopMs: 6_200,
				hidden: false,
				more: null,
				restart: false,
			});
			expect(sent[0].id).toMatch(/^cn-[a-f0-9]{16}$/);
		});
	});

	it("an episode that began before this server process started says so; one never seen is hidden", async () => {
		const { ce, clock, sent } = setup({ startedAt: T0 + 20_000 });
		clock.now = T0 + 28_000;
		ce.banner([rec({ visible: false, endVisible: false })], { conn: "0f0f0f0f0f0f", clientId: null });
		await tick();
		const b = lines().find((l) => l.kind === "banner") as Line;
		expect(b.srvRestart).toBe(true);
		expect(b.loopMaxMs).toBeNull();
		expect(sent[0]).toMatchObject({ restart: true, hidden: true, maxLoopMs: null });
	});

	it("takes each episode once (across a restart too), and at most 20 per message", async () => {
		const a = setup();
		a.clock.now = T0 + 28_000;
		expect(a.ce.banner([rec(), rec()], { conn: "0f0f0f0f0f0f", clientId: null })).toBe(1);
		await tick();
		const b = setup();
		b.clock.now = T0 + 29_000;
		expect(b.ce.banner([rec()], { conn: "0f0f0f0f0f0f", clientId: null })).toBe(0);
		const many = Array.from({ length: MAX_RECORDS_PER_MESSAGE + 5 }, (_, i) =>
			rec({ ep: `ffff${i.toString(16).padStart(8, "0")}` }),
		);
		expect(b.ce.banner(many, { conn: "0f0f0f0f0f0f", clientId: null })).toBe(MAX_RECORDS_PER_MESSAGE);
		expect(b.ce.banner("not a list", { conn: "0f0f0f0f0f0f", clientId: null })).toBe(0);
	});
});

describe("conn-events: sockets", () => {
	it("open and close keep the close code, the socket's life and a hashed client id only", () => {
		const { ce } = setup();
		const conn = ce.newConnId();
		expect(conn).toMatch(/^[a-f0-9]{12}$/);
		ce.opened(conn, "browser-secret-id", true, 40);
		ce.closed(conn, "browser-secret-id", true, 1006, 61_000);
		ce.closed(conn, null, false, "going away", 5);
		const [open, close, odd] = lines();
		expect(open).toEqual({
			t: T0,
			kind: "open",
			conn,
			client: hashClient("browser-secret-id"),
			browser: true,
			helloMs: 40,
		});
		expect(close).toEqual({
			t: T0,
			kind: "close",
			conn,
			client: hashClient("browser-secret-id"),
			browser: true,
			code: 1006,
			livedMs: 61_000,
		});
		expect(odd.code).toBeNull();
		expect(JSON.stringify(lines())).not.toContain("browser-secret-id");
	});
});

describe("conn-events: a page's record is checked field by field", () => {
	it("accepts a well-formed record unchanged", () => {
		const r = rec({ closeCode: 1006, then: "close", pageStallMs: 2_400, cut: true });
		expect(sanitizeRecord(r)).toEqual(r);
	});

	it("refuses hostile or malformed ones whole", () => {
		const bad: unknown[] = [
			null,
			[],
			"x",
			{ ...rec(), text: "hello" },
			{ ...rec(), html: "<b>x</b>" },
			rec({ reason: "<b>owned</b>" as never }),
			rec({ ep: "<script>alert(1)</script>" }),
			rec({ ep: "ABCDEF0123456789" }),
			rec({ closeCode: 999 }),
			rec({ closeCode: 5_000 }),
			rec({ closeCode: 1006.5 }),
			rec({ durMs: -1 }),
			rec({ durMs: Number.NaN }),
			rec({ durMs: "5000" as never }),
			rec({ visible: "yes" as never }),
			rec({ conn: "zz-not-hex" }),
			rec({ then: "everything" as never }),
			rec({ cut: "yes" as never }),
			rec({ patience: 1_000 }),
			rec({ sockets: 1.5 }),
		];
		for (const r of bad) expect(sanitizeRecord(r)).toBeNull();
	});

	it("clamps a huge duration to a day", () => {
		expect(sanitizeRecord(rec({ durMs: 1e15 }))?.durMs).toBe(DAY);
	});
});

describe("conn-events: owner notices, at most one per 10 minutes", () => {
	it("the first goes at once; later ones are held and summed into one line once the gap is over", async () => {
		const { ce, clock, sent } = setup();
		const send = (ep: string, endAgoMs: number, over: Partial<ConnTraceRecord> = {}) => {
			ce.banner([rec({ ep, endAgoMs, ...over })], { conn: "0f0f0f0f0f0f", clientId: null });
		};
		clock.now = T0 + 30_000;
		send("aaaaaaaa00000001", 0);
		await tick();
		expect(sent).toHaveLength(1);

		clock.now = T0 + 90_000;
		send("aaaaaaaa00000002", 0, { durMs: 3_000, reason: "close", closeCode: 1006 });
		clock.now = T0 + 150_000;
		send("aaaaaaaa00000003", 0, { durMs: 4_000, reason: "close", closeCode: 1006 });
		await tick();
		expect(sent).toHaveLength(1);
		const held = lines().filter((l) => l.kind === "notice");
		expect(held).toHaveLength(1);

		// Not yet: the gap isn't over.
		clock.now = T0 + 30_000 + NOTICE_GAP_MS - 1;
		await ce.flush();
		expect(sent).toHaveLength(1);

		clock.now = T0 + 30_000 + NOTICE_GAP_MS;
		await ce.flush();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({
			kind: "summary",
			reason: "close",
			durMs: 7_000,
			restart: false,
			more: { count: 2, totalMs: 7_000, since: T0 + 90_000 - 3_000 },
		});

		// The next one waits a full gap after the summary; then it carries what was held meanwhile.
		clock.now += 60_000;
		send("aaaaaaaa00000004", 0, { durMs: 1_000 });
		await tick();
		expect(sent).toHaveLength(2);
		clock.now += NOTICE_GAP_MS;
		send("aaaaaaaa00000005", 0, { durMs: 2_000 });
		await tick();
		expect(sent).toHaveLength(3);
		expect(sent[2]).toMatchObject({ kind: "event", durMs: 2_000, more: { count: 1, totalMs: 1_000 } });
		expect(new Set(sent.map((n) => n.id)).size).toBe(3);
	});

	it("a notice that doesn't go (no transport, refused or failed) is summed into the next try, a gap later", async () => {
		let ok = false;
		let calls = 0;
		const got: ConnNotice[] = [];
		const { ce, clock } = setup({
			deliver: async (n) => {
				calls++;
				if (calls === 2) throw new Error("network down");
				if (ok) got.push(n);
				return ok;
			},
		});
		clock.now = T0 + 30_000;
		ce.banner([rec({ ep: "bbbbbbbb00000001", endAgoMs: 0 })], { conn: "0f0f0f0f0f0f", clientId: null });
		await tick();
		expect(calls).toBe(1);
		// Right after a failed try: held, not hammered.
		clock.now += 1_000;
		ce.banner([rec({ ep: "bbbbbbbb00000002", endAgoMs: 0 })], { conn: "0f0f0f0f0f0f", clientId: null });
		await tick();
		expect(calls).toBe(1);
		clock.now += NOTICE_GAP_MS;
		await ce.flush(); // throws inside: counts as not sent
		expect(calls).toBe(2);
		ok = true;
		clock.now += NOTICE_GAP_MS;
		await ce.flush();
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ kind: "summary", more: { count: 2, totalMs: 16_000 } });
		const notices = lines().filter((l) => l.kind === "notice");
		expect(notices.map((n) => n.sent)).toEqual([false, false, true]);
	});

	it("a notice cut off by a restart is tried again with the same id; held ones still get their line", async () => {
		const a = setup({ deliver: () => new Promise<boolean>(() => {}) }); // never answers: the process ends
		a.clock.now = T0 + 30_000;
		a.ce.banner([rec({ ep: "cccccccc00000001", endAgoMs: 0 })], { conn: "0f0f0f0f0f0f", clientId: null });
		await tick();
		const first = JSON.parse(readFileSync(join(dir, "conn-notify-state.json"), "utf8")).inflight as ConnNotice;
		expect(first.id).toMatch(/^cn-/);

		const b = setup();
		b.clock.now = T0 + 60_000;
		b.ce.resume();
		await tick();
		expect(b.sent).toHaveLength(1);
		expect(b.sent[0].id).toBe(first.id);
		b.ce.stop();
	});
});

describe("conn-events: the hub hands notices to the transport", () => {
	it("true from one transport = told; none, false, a throw or a malformed answer = not told", async () => {
		const hub = createConnNoticeHub();
		const n: ConnNotice = {
			id: "cn-0123456789abcdef",
			kind: "event",
			at: T0,
			durMs: 1,
			reason: "silence",
			closeCode: null,
			maxLoopMs: null,
			hidden: false,
			more: null,
			restart: false,
		};
		expect(await hub.deliver(n)).toBe(false);
		const offA = hub.on(() => {
			throw new Error("boom");
		});
		const offB = hub.on(() => "yes");
		expect(await hub.deliver(n)).toBe(false);
		const offC = hub.on(async (got) => {
			(got as { durMs: number }).durMs = 999; // a transport can't change what others get
			return true;
		});
		expect(await hub.deliver(n)).toBe(true);
		expect(n.durMs).toBe(1);
		for (const off of [offA, offB, offC]) off();
		expect(hub.size).toBe(0);
	});
});

describe("conn-events: one switch turns it all off", () => {
	it('{"enabled": false} stops the log, the samples, the pages\' records and the notices; removing it turns it back on', async () => {
		const { ce, clock, hist, sent } = setup();
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ enabled: false }));
		expect(ce.enabled()).toBe(false);
		ce.sample();
		clock.now += 10_000;
		hist.n = 1;
		hist.maxNs = 9_000e6;
		ce.sample();
		ce.opened("0f0f0f0f0f0f", "x", true, 1);
		ce.closed("0f0f0f0f0f0f", "x", true, 1006, 1);
		expect(ce.banner([rec()], { conn: "0f0f0f0f0f0f", clientId: null })).toBe(0);
		await ce.flush();
		await tick();
		expect(sent).toHaveLength(0);
		expect(readdirSync(dir).filter((f) => f.startsWith("conn-events"))).toHaveLength(0);

		rmSync(join(dir, CONFIG_FILE));
		clock.now += 3_001;
		expect(ce.enabled()).toBe(true);
		ce.opened("0f0f0f0f0f0f", "x", true, 1);
		expect(lines()).toHaveLength(1);
	});

	it("an unreadable switch file counts as off", () => {
		const { ce } = setup();
		writeFileSync(join(dir, CONFIG_FILE), "{ enabled: nope");
		expect(ce.enabled()).toBe(false);
	});
});

describe("conn-events: rotation", () => {
	it(`rolls over each UTC day and keeps ${KEEP_DAYS} days`, () => {
		const day = (t: number) => new Date(t).toISOString().slice(0, 10);
		const old = join(dir, `conn-events-${day(T0 - (KEEP_DAYS + 1) * DAY)}.jsonl`);
		const kept = join(dir, `conn-events-${day(T0 - (KEEP_DAYS - 1) * DAY)}.jsonl`);
		writeFileSync(old, "{}\n");
		writeFileSync(kept, "{}\n");
		writeFileSync(join(dir, LOG_FILE), '{"kind":"open"}\n');
		const yesterday = (T0 - DAY) / 1000;
		utimesSync(join(dir, LOG_FILE), yesterday, yesterday);
		const { ce } = setup();
		ce.opened("0f0f0f0f0f0f", null, true, 1);
		const files = readdirSync(dir).sort();
		expect(files).toContain(`conn-events-${day(T0 - DAY)}.jsonl`);
		expect(files).toContain(`conn-events-${day(T0 - (KEEP_DAYS - 1) * DAY)}.jsonl`);
		expect(files).not.toContain(`conn-events-${day(T0 - (KEEP_DAYS + 1) * DAY)}.jsonl`);
		expect(readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe("conn-events: metadata only", () => {
	it("no line holds free text: only fixed kinds, ids, hashes, causes and numbers", async () => {
		const { ce, clock, hist } = setup();
		ce.sample();
		clock.now += 10_000;
		hist.n = 1;
		hist.maxNs = 7_000e6;
		ce.sample();
		ce.opened("0f0f0f0f0f0f", "client-with-a-name", true, 3);
		clock.now += 5_000;
		ce.banner([rec({ endAgoMs: 0, closeCode: 1006, reason: "close", then: "connect_timeout" })], {
			conn: "0f0f0f0f0f0f",
			clientId: "client-with-a-name",
		});
		ce.closed("0f0f0f0f0f0f", "client-with-a-name", true, 1006, 5_000);
		await tick();
		const allowed: Record<string, RegExp> = {
			kind: /^(loop|open|close|banner|notice)$/,
			conn: /^[a-f0-9]{12}$/,
			via: /^[a-f0-9]{12}$/,
			client: /^[a-f0-9]{12}$/,
			ep: /^[a-z0-9]{8,32}$/,
			reason: /^[a-z_]+$/,
			then: /^[a-z_]+$/,
			id: /^cn-[a-f0-9]{16}$/,
			notice: /^(event|summary)$/,
		};
		const all = lines();
		expect(all.map((l) => l.kind).sort()).toEqual(["banner", "close", "loop", "notice", "open"]);
		for (const l of all)
			for (const [k, v] of Object.entries(l)) {
				if (typeof v !== "string") {
					expect(v === null || typeof v === "number" || typeof v === "boolean").toBe(true);
					continue;
				}
				expect(allowed[k], `string field ${k}`).toBeDefined();
				expect(v).toMatch(allowed[k]);
			}
	});
});
