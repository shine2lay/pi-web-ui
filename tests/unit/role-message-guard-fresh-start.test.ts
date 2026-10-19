// Ops #241 (docs/role-message-fresh-start.md): the operator's one-shot fresh start of an unreadable approval record,
// and the off switch. Real host, store and native record; only the chats and the clock are fake
// (role-message-guard-host-harness.ts). The record is made unreadable the way the live one was on 2026-10-14:
// accepted.json no longer matches the journal's copy ("legacy writer divergence").
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GUARD_APPROVALS_SWITCH,
	GUARD_FRESH_START_FILE,
	RoleMessageGuardHost,
} from "../../server/role-message-guard-host.js";
import {
	A,
	clock,
	data,
	send,
	setNow,
	tc,
	useGuardWorld,
	type World,
	who,
	world,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

const HOUR = 3600000;
const SCRIPT = fileURLToPath(new URL("../../scripts/role-guard-fresh-start.mjs", import.meta.url));
const guard = () => join(data, "role-message-guard");
const gen1 = (name: string) => join(guard(), "gen-1", name);
const requestPath = () => join(guard(), GUARD_FRESH_START_FILE);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const current = () => (JSON.parse(readFileSync(join(guard(), "current.json"), "utf8")) as { gen: number }).gen;
const doneFiles = () => readdirSync(guard()).filter((n) => /^fresh-start\.done-\d+\.json$/.test(n));
const journal = (gen: number) =>
	JSON.parse(readFileSync(join(guard(), `gen-${gen}`, "journal.json"), "utf8")) as {
		stage: string;
		state: { usage: Array<{ transactionId: string }> };
	};
const freshLines = (logs: string[]) => logs.filter((l) => l.includes("fresh start"));

/** Hosts started outside world() (it insists on a ready one); stopped after each test. */
const extra: RoleMessageGuardHost[] = [];
afterEach(() => {
	for (const h of extra.splice(0)) h.stop();
	delete process.env[GUARD_APPROVALS_SWITCH];
});
async function startHost(w: World, dir = guard()): Promise<{ host: RoleMessageGuardHost; logs: string[] }> {
	const logs: string[] = [];
	const host = new RoleMessageGuardHost({
		dir,
		roleMessages: () => w.rm,
		identities: () => w.roles,
		log: (l) => logs.push(l),
		now: clock,
	});
	extra.push(host);
	await host.start();
	return { host, logs };
}

/** Both of gen-1's files last changed `ago` before the fake clock. */
function ageGen1(ago: number): void {
	const t = (clock() - ago) / 1000;
	for (const name of ["journal.json", "accepted.json"]) utimesSync(gen1(name), t, t);
}
/** A normal record with three sends, the server stopped, then accepted.json changed behind the journal's back. */
async function diverged(): Promise<World> {
	const w = await world();
	for (const to of ["beta", "gamma", "beta"]) expect(await send(w, "alpha", A, to, {}, "")).toMatchObject({ ok: true });
	w.host.stop();
	w.rm.stop();
	const legacy = JSON.parse(readFileSync(gen1("accepted.json"), "utf8")) as { paused: boolean };
	legacy.paused = !legacy.paused;
	writeFileSync(gen1("accepted.json"), JSON.stringify(legacy));
	ageGen1(3 * HOUR);
	return w;
}
/** A request bound to gen-1's files as they are now, made a minute ago; `over` changes any field. */
function writeRequest(over: Record<string, unknown> = {}, mode = 0o600): void {
	const at = clock() - 60_000;
	const body = {
		v: 1,
		gen: 1,
		journalSha256: sha(gen1("journal.json")),
		acceptedSha256: sha(gen1("accepted.json")),
		at,
		expiresAt: at + 24 * HOUR,
		reason: "test",
		...over,
	};
	writeFileSync(requestPath(), JSON.stringify(body), { mode });
	chmodSync(requestPath(), mode);
}
/** Every file under the guard dir: its sha256, and for the generation folders its mtime too (a rewrite shows). A
 *  pipe is noted, not read. */
function snapshot(withLock = false): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string, rel: string) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			const r = rel ? `${rel}/${name}` : name;
			const st = statSync(path);
			if (st.isDirectory()) walk(path, r);
			else if (!st.isFile()) out[r] = "not a plain file";
			else if (withLock || r !== "lock") out[r] = rel ? `${sha(path)}@${st.mtimeMs}` : sha(path);
		}
	};
	walk(guard(), "");
	return out;
}
/** A record whose journal holds a prepared send: the server stopped between a send's prepare and its commit, as a
 *  crash would (the store's failure hook, reached the way role-message-guard-lease.test.ts does). Files aged 3 h. */
async function preparedSend(): Promise<{ w: World; operationId: string }> {
	const w = await world();
	expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
	const options = Reflect.get(Reflect.get(w.host, "store") as object, "options") as {
		boundary: ((at: string) => void) | null;
	};
	options.boundary = (at) => {
		if (at === "commit:write") throw new Error("stopped between the prepare and the commit");
	};
	await send(w, "alpha", A, "gamma", {}, "");
	w.host.stop();
	w.rm.stop();
	const j = JSON.parse(readFileSync(gen1("journal.json"), "utf8")) as {
		stage: string;
		identity: { operationId: string };
	};
	expect(j.stage).toBe("prepared");
	ageGen1(3 * HOUR);
	return { w, operationId: j.identity.operationId };
}
/** rotate() is private; reached the way role-message-guard-lease.test.ts does. */
const rotate = (h: RoleMessageGuardHost, force: boolean) =>
	(h as unknown as { rotate(force: boolean): Promise<void> }).rotate(force);
/** A record that rotated to gen-2 with a send in each generation (as live since the fresh start), server stopped. */
async function onGen2(): Promise<World> {
	const w = await world();
	expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
	await rotate(w.host, true);
	expect(current()).toBe(2);
	expect(await send(w, "alpha", A, "gamma", {}, "")).toMatchObject({ ok: true });
	w.host.stop();
	w.rm.stop();
	return w;
}
/** The script on the test's data dir. Ops #248 (Security N2): PI_WEB_DATA_DIR is the temp `data` too, so a call
 *  without --data-dir can never reach the live ~/.pi-web-ui. */
function script(...args: string[]): { code: number | null; out: string } {
	return run("--data-dir", data, ...args);
}
function run(...args: string[]): { code: number | null; out: string } {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_WEB_DATA_DIR: data },
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("fresh start: a matching request", () => {
	it("starts generation 2 once: gen-1 kept byte for byte, request done, the last hour's sends still count", async () => {
		setNow(Date.now()); // the script dates its request by the real clock
		const w = await diverged();
		const old = { journal: sha(gen1("journal.json")), accepted: sha(gen1("accepted.json")) };

		const dry = script("--dry-run");
		expect(dry.code, dry.out).toBe(0);
		expect(dry.out).toContain("the record is unreadable");
		expect(dry.out).toContain("outbox entries by state:");
		expect(dry.out).toContain("dry run: nothing written");
		expect(dry.out).not.toContain("hello from"); // counts and ids only, never a message's words
		expect(existsSync(requestPath())).toBe(false);
		const made = script();
		expect(made.code, made.out).toBe(0);
		expect(statSync(requestPath()).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(requestPath(), "utf8"))).toMatchObject({
			v: 1,
			gen: 1,
			journalSha256: old.journal,
			acceptedSha256: old.accepted,
		});

		setNow(Date.now());
		const w2 = await world(w);
		expect(freshLines(w2.logs)).toEqual([
			"approval ladder: fresh start from generation 1 (old record kept in archive-gen-1)",
		]);
		expect(w2.logs).toContain("approval ladder: on (hops 1-6 free; 7-11 COO grant; 12+ owner grant)");
		expect(current()).toBe(2);
		for (const [name, digest] of [
			["journal.json", old.journal],
			["accepted.json", old.accepted],
		]) {
			expect(sha(join(guard(), "archive-gen-1", name))).toBe(digest);
			expect(sha(gen1(name))).toBe(digest); // gen-1 itself stays as it was
		}
		expect(existsSync(requestPath())).toBe(false);
		expect(doneFiles()).toHaveLength(1);
		expect(readFileSync(join(guard(), "history.jsonl"), "utf8")).toContain('"revoked_all"');
		// The three sends of the last hour still count toward the 20 an hour (from the native record).
		const native = w2.rm
			.recent(clock() - HOUR)
			.filter((m) => m.kind !== "report")
			.map((m) => `native-${m.id}`);
		expect(native).toHaveLength(3);
		expect(
			journal(2)
				.state.usage.map((u) => u.transactionId)
				.sort(),
		).toEqual(native.sort());

		// A real send is committed through generation 2.
		expect(await send(w2, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		const after = journal(2);
		expect(after.stage).toBe("committed");
		expect(after.state.usage.filter((u) => !u.transactionId.startsWith("native-"))).toHaveLength(1);

		// A later start stays on generation 2.
		w2.host.stop();
		w2.rm.stop();
		await world(w2);
		expect(current()).toBe(2);
		expect(existsSync(join(guard(), "gen-3"))).toBe(false);
		expect(freshLines(w2.logs)).toHaveLength(1);
		expect(sha(join(guard(), "archive-gen-1", "journal.json"))).toBe(old.journal);
	});

	it("a crash after the archive copy, before current.json switched: the next start finishes it, once", async () => {
		const w = await diverged();
		writeRequest();
		const old = sha(gen1("journal.json"));
		// What the crash leaves: the archive copied, a half-made gen-2, current.json still on 1.
		mkdirSync(join(guard(), "archive-gen-1"));
		for (const name of ["journal.json", "accepted.json"])
			copyFileSync(gen1(name), join(guard(), "archive-gen-1", name));
		mkdirSync(join(guard(), "gen-2"));
		writeFileSync(join(guard(), "gen-2", "journal.json"), '{"format":');
		const w2 = await world(w);
		expect(current()).toBe(2);
		expect(sha(join(guard(), "archive-gen-1", "journal.json"))).toBe(old);
		expect(journal(2).stage).toBe("committed");
		expect(doneFiles()).toHaveLength(1);
		w2.host.stop();
		w2.rm.stop();
		await world(w2);
		expect(current()).toBe(2);
		expect(freshLines(w2.logs)).toHaveLength(1);
	});
});

describe("fresh start: no request, or one that doesn't match, changes nothing", () => {
	const cases: Array<[string, () => void, string | null]> = [
		["no request", () => {}, null],
		[
			"another journal",
			() => writeRequest({ journalSha256: "0".repeat(64) }),
			"journal.json is not the file the request was made for (sha256 differs)",
		],
		[
			"another accepted.json",
			() => writeRequest({ acceptedSha256: "f".repeat(64) }),
			"accepted.json is not the file the request was made for (sha256 differs)",
		],
		[
			"a file touched less than 2 h ago",
			() => {
				writeRequest();
				const t = (clock() - HOUR) / 1000;
				utimesSync(gen1("accepted.json"), t, t);
			},
			"accepted.json changed less than 2 h ago",
		],
		[
			"an expired request",
			() => writeRequest({ at: clock() - 25 * HOUR, expiresAt: clock() - HOUR }),
			`the request expired at ${new Date(Date.parse("2026-10-12T11:00:00Z")).toISOString()}`,
		],
		[
			"a request good for over 24 h",
			() => writeRequest({ expiresAt: clock() + 48 * HOUR }),
			"the request is good for over 24 h",
		],
		[
			"a request dated in the future",
			() => writeRequest({ at: clock() + 60_000 }),
			"the request is dated in the future",
		],
		[
			"a request for another generation",
			() => writeRequest({ gen: 5 }),
			"the request is for generation 5, the current one is 1",
		],
		["a request others can write", () => writeRequest({}, 0o620), "other users can write the request"],
		[
			"a request in another format",
			() => writeFileSync(requestPath(), "{not json", { mode: 0o600 }),
			"the request's format is not understood",
		],
		// Ops #248 (Security N1): one open that follows no link and waits on no pipe; mode 0600; at most 4 KiB.
		["a request others can read", () => writeRequest({}, 0o644), "the request's mode is 0644, not 0600"],
		["a request over 4 KiB", () => writeRequest({ reason: "x".repeat(5000) }), "the request is over 4 KiB"],
		[
			"a request that is a link",
			() => {
				writeRequest();
				renameSync(requestPath(), join(data, "elsewhere.json"));
				symlinkSync(join(data, "elsewhere.json"), requestPath());
			},
			"the request is not a plain file",
		],
		["a request that is a pipe", () => mkfifo(requestPath()), "the request is not a plain file"],
	];
	// Ops #252 (docs/gate-near-limit.md): its own limit, 3x the slowest land-gate time of its rows ("another journal",
	// 3733 ms) rounded up to whole 5 s. Sequential scenarios and Security's review evidence, so they aren't split;
	// the guard store's work is CPU-bound and 2-4x slower under gate load.
	it.each(cases)(
		"%s",
		async (_name, make, why) => {
			const w = await diverged();
			make();
			const before = snapshot();
			const { host, logs } = await startHost(w);
			expect(host.state.status).toBe("degraded");
			expect(host.state.reason).toContain("legacy writer divergence");
			expect(freshLines(logs)).toEqual(why ? [`approval ladder: fresh start refused (${why})`] : []);
			expect(snapshot()).toEqual(before); // gen folders, current.json and the request as they were; no archive
		},
		15_000,
	);
});

function mkfifo(path: string): void {
	const r = spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });
	expect(r.status, r.stderr).toBe(0);
}

describe("fresh start: a readable record", () => {
	it("a pipe where the request goes doesn't hold up the start (Ops #248, N1)", async () => {
		const w = await world();
		w.host.stop();
		w.rm.stop();
		mkfifo(requestPath());
		const w2 = await world(w);
		expect(freshLines(w2.logs)).toEqual([
			"approval ladder: fresh start request ignored (the request is not a plain file; generation 1 opened as usual)",
		]);
		expect(statSync(requestPath()).isFIFO()).toBe(true);
	});

	it("ignores a request for its own generation; one for an older generation is marked done", async () => {
		const w = await world();
		expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		w.host.stop();
		w.rm.stop();
		ageGen1(3 * HOUR);
		writeRequest();
		const w2 = await world(w);
		expect(current()).toBe(1);
		expect(freshLines(w2.logs)).toEqual([
			"approval ladder: fresh start request ignored (generation 1 opened as usual)",
		]);
		expect(existsSync(requestPath())).toBe(true);
		expect(existsSync(join(guard(), "archive-gen-1"))).toBe(false);

		// After a fresh start whose request wasn't marked done before a crash: the next start marks it done.
		const fresh = await diverged();
		writeRequest();
		const started = await world(fresh);
		expect(current()).toBe(2);
		renameSync(join(guard(), doneFiles()[0] as string), requestPath());
		started.host.stop();
		started.rm.stop();
		const again = await world(started);
		expect(current()).toBe(2);
		expect(again.logs).toContain(
			"approval ladder: fresh start request for generation 1 marked done (already on generation 2)",
		);
		expect(existsSync(requestPath())).toBe(false);
	});
});

describe(`the off switch (${GUARD_APPROVALS_SWITCH}=off)`, () => {
	it("turns approvals off at once: no guard file read or written; sends take the native rule", async () => {
		const w = await world();
		expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		w.host.stop();
		const before = snapshot(true);
		process.env[GUARD_APPROVALS_SWITCH] = "off";
		const { host, logs } = await startHost(w);
		const reason = `turned off (${GUARD_APPROVALS_SWITCH}=off)`;
		expect(host.state).toEqual({ status: "degraded", reason });
		expect(logs).toEqual([`approval ladder UNAVAILABLE (${reason}): sends use the native depth-6 rule; no approvals`]);
		const never = join(data, "guard-never");
		expect((await startHost(w, never)).host.state.status).toBe("degraded");
		expect(existsSync(never)).toBe(false);
		const r = await host.send(who(w, "alpha", A, ""), { to: "beta", kind: "fyi", text: "native" }, tc());
		expect(r).toMatchObject({ ok: true });
		expect((await host.approval(who(w, "alpha", A), { action: "request" }, tc())).ok).toBe(false);
		host.stop();
		expect(snapshot(true)).toEqual(before);
	});

	it("any other value leaves approvals on, and the log says so", async () => {
		process.env[GUARD_APPROVALS_SWITCH] = "no";
		const w = await world();
		expect(w.logs.some((l) => l.includes(`${GUARD_APPROVALS_SWITCH}="no" is not understood`))).toBe(true);
	});
});

describe("current.json not understood: off, and nothing cleaned (Ops #248, Security N3)", () => {
	const cases: Array<[string, () => void, string]> = [
		["missing", () => rmSync(join(guard(), "current.json")), "current.json is missing"],
		["garbled", () => writeFileSync(join(guard(), "current.json"), '{"gen":'), "current.json is not understood"],
		[
			"naming a generation that isn't there",
			() => writeFileSync(join(guard(), "current.json"), '{"gen":3}\n'),
			"current.json points at gen-3, which doesn't exist",
		],
	];
	it.each(cases)("%s", async (_name, make, why) => {
		const w = await onGen2();
		make();
		const before = snapshot(true);
		const { host, logs } = await startHost(w);
		expect(host.state).toEqual({ status: "degraded", reason: why });
		expect(logs).toEqual([`approval ladder UNAVAILABLE (${why}): sends use the native depth-6 rule; no approvals`]);
		expect(snapshot(true)).toEqual(before); // gen-1 and gen-2 byte for byte, no lock taken, nothing cleaned
	});

	it("a rotation refuses too, and removes nothing", async () => {
		const w = await world();
		expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		await rotate(w.host, true);
		expect(current()).toBe(2);
		writeFileSync(join(guard(), "current.json"), "garbled");
		const before = snapshot(true);
		await expect(rotate(w.host, true)).rejects.toThrow("rotation: current.json is not understood");
		expect(snapshot(true)).toEqual(before); // the live gen-2 is still there
	});
});

describe("a journal holding a prepared send, or one that can't be parsed, is never started over (Ops #248, S1)", () => {
	it("a prepared send: refused, off with the reason, every guard file as it was", async () => {
		const { w, operationId } = await preparedSend();
		writeRequest();
		const before = snapshot();
		const { host, logs } = await startHost(w);
		expect(host.state).toEqual({
			status: "degraded",
			reason: "recover: prepared reservation held; no speculative commit/refund/retry",
		});
		expect(freshLines(logs)).toEqual([
			`approval ladder: fresh start refused (the journal holds a prepared send (operation ${operationId}))`,
		]);
		expect(snapshot()).toEqual(before); // the prepared journal, accepted.json and the request, byte for byte
	});

	it("a journal that can't be parsed: refused, off with the reason, every guard file as it was", async () => {
		const w = await diverged();
		writeFileSync(gen1("journal.json"), '{"format":"role-message-guard-journal/v1","stage":');
		ageGen1(3 * HOUR);
		writeRequest();
		const before = snapshot();
		const { host, logs } = await startHost(w);
		expect(host.state.status).toBe("degraded");
		expect(host.state.reason).toMatch(/^recover: /);
		expect(freshLines(logs)).toEqual([
			expect.stringMatching(/^approval ladder: fresh start refused \(the journal can't be parsed \(.+\)\)$/),
		]);
		expect(snapshot()).toEqual(before);
	});
});

describe("one way to begin a generation (Ops #248, Architecture S2)", () => {
	it("the fresh start and a rotation both begin theirs with beginGeneration, leaving the same files", async () => {
		const begin = vi.spyOn(
			RoleMessageGuardHost.prototype as unknown as Record<"beginGeneration", (...a: unknown[]) => Promise<unknown>>,
			"beginGeneration",
		);
		try {
			const files = (gen: number) =>
				readdirSync(join(guard(), `gen-${gen}`))
					.sort()
					.map((n) => `${n} 0${(statSync(join(guard(), `gen-${gen}`, n)).mode & 0o777).toString(8)}`);
			const w = await diverged();
			writeRequest();
			const { host } = await startHost(w);
			expect(host.state.status).toBe("ready");
			const fresh = files(2);
			await rotate(host, true);
			expect(current()).toBe(3);
			expect(begin.mock.calls.map((c) => c.slice(0, 2))).toEqual([
				[2, "fresh start"],
				[3, "rotation"],
			]);
			expect(files(3)).toEqual(fresh);
		} finally {
			begin.mockRestore();
		}
	});
});

describe("the script stays in the test's folder (Ops #248, Security N2)", () => {
	it("without --data-dir it reads PI_WEB_DATA_DIR, the test's own folder", async () => {
		expect(data.startsWith(join(tmpdir(), "rmguard-host-"))).toBe(true); // the temp folder, never ~/.pi-web-ui
		setNow(Date.now());
		await diverged();
		const r = run("--dry-run");
		expect(r.code, r.out).toBe(0);
		expect(r.out).toContain(`guard dir: ${guard()}\n`);
		expect(r.out).toContain("the record is unreadable");
		expect(existsSync(requestPath())).toBe(false);
	});
});

describe("the script refuses when the next start would", () => {
	it("a readable record, or files touched less than 2 h ago: nothing written", async () => {
		setNow(Date.now());
		const w = await world();
		expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		w.host.stop();
		w.rm.stop();
		ageGen1(3 * HOUR);
		const readable = script();
		expect(readable.code, readable.out).toBe(1);
		expect(readable.out).toContain("the record is readable");
		const legacy = JSON.parse(readFileSync(gen1("accepted.json"), "utf8")) as { paused: boolean };
		legacy.paused = !legacy.paused;
		writeFileSync(gen1("accepted.json"), JSON.stringify(legacy)); // unreadable now, but changed just now
		const recent = script();
		expect(recent.code, recent.out).toBe(1);
		expect(recent.out).toContain("accepted.json changed less than 2 h ago");
		expect(existsSync(requestPath())).toBe(false);
	});

	it("a request over 4 KiB: nothing written (N1)", async () => {
		setNow(Date.now());
		await diverged();
		const r = script("--reason", "x".repeat(5000));
		expect(r.code, r.out).toBe(1);
		expect(r.out).toContain("over the 4 KiB the server reads");
		expect(existsSync(requestPath())).toBe(false);
	});

	it("a journal holding a prepared send, or one that can't be parsed: nothing written (S1)", async () => {
		setNow(Date.now());
		const { operationId } = await preparedSend();
		const prepared = script();
		expect(prepared.code, prepared.out).toBe(1);
		expect(prepared.out).toContain(
			`the journal holds a prepared send (operation ${operationId}), so the next start would refuse a fresh start`,
		);
		const bundle = JSON.parse(readFileSync(gen1("journal.json"), "utf8")) as { stage: string };
		bundle.stage = "committed"; // its checksum no longer matches
		writeFileSync(gen1("journal.json"), JSON.stringify(bundle));
		const corrupt = script();
		expect(corrupt.code, corrupt.out).toBe(1);
		expect(corrupt.out).toContain("the journal can't be parsed (corrupt guard journal or unsupported schema), so");
		writeFileSync(gen1("journal.json"), "{not json");
		const garbled = script();
		expect(garbled.code, garbled.out).toBe(1);
		expect(garbled.out).toContain("the journal can't be parsed, so the next start would refuse a fresh start");
		expect(existsSync(requestPath())).toBe(false);
	});

	it("current.json missing while a generation exists: the next start stays off, so nothing written (N3)", async () => {
		await onGen2();
		rmSync(join(guard(), "current.json"));
		const r = script();
		expect(r.code, r.out).toBe(1);
		expect(r.out).toContain("current.json is missing");
		expect(existsSync(requestPath())).toBe(false);
	});
});
