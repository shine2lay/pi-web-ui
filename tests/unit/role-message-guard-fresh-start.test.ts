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
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
/** Every file under the guard dir: its sha256, and for the generation folders its mtime too (a rewrite shows). */
function snapshot(withLock = false): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string, rel: string) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			const r = rel ? `${rel}/${name}` : name;
			if (statSync(path).isDirectory()) walk(path, r);
			else if (withLock || r !== "lock") out[r] = rel ? `${sha(path)}@${statSync(path).mtimeMs}` : sha(path);
		}
	};
	walk(guard(), "");
	return out;
}
function script(...args: string[]): { code: number | null; out: string } {
	const r = spawnSync(process.execPath, [SCRIPT, "--data-dir", data, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_WEB_DATA_DIR: "" },
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
	];
	it.each(cases)("%s", async (_name, make, why) => {
		const w = await diverged();
		make();
		const before = snapshot();
		const { host, logs } = await startHost(w);
		expect(host.state.status).toBe("degraded");
		expect(host.state.reason).toContain("legacy writer divergence");
		expect(freshLines(logs)).toEqual(why ? [`approval ladder: fresh start refused (${why})`] : []);
		expect(snapshot()).toEqual(before); // gen folders, current.json and the request as they were; no archive
	});
});

describe("fresh start: a readable record", () => {
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
});
