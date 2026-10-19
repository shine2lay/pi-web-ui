// Ops #253: the guard folder's own files: current.json's switch reaches the disk (Architecture A2), and one server
// holds the lock (A4). Real host, store and native record (role-message-guard-host-harness.ts); node:fs passes
// through, noting the renames and flushes a test looks at, and running a test's hook where another server could step in.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import { A, clock, data, send, useGuardWorld, type World, world } from "./role-message-guard-host-harness.js";

type Hook = (when: "before" | "after", op: "rename" | "link", from: string, to: string) => void;
/** What node:fs was asked to do while `on`: "rename <to>" and "fsync <the path the fd was opened on>". */
const fsx = vi.hoisted(() => ({
	on: false,
	calls: [] as string[],
	fds: new Map<number, string>(),
	hook: null as Hook | null,
}));
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const wrapped = {
		openSync: (...args: Parameters<typeof real.openSync>) => {
			const fd = real.openSync(...args);
			fsx.fds.set(fd, String(args[0]));
			return fd;
		},
		fsyncSync: (fd: number) => {
			real.fsyncSync(fd);
			if (fsx.on) fsx.calls.push(`fsync ${fsx.fds.get(fd)}`);
		},
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			fsx.hook?.("before", "rename", String(args[0]), String(args[1]));
			real.renameSync(...args);
			if (fsx.on) fsx.calls.push(`rename ${String(args[1])}`);
			fsx.hook?.("after", "rename", String(args[0]), String(args[1]));
		},
		linkSync: (...args: Parameters<typeof real.linkSync>) => {
			fsx.hook?.("before", "link", String(args[0]), String(args[1]));
			real.linkSync(...args);
			fsx.hook?.("after", "link", String(args[0]), String(args[1]));
		},
	};
	return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

useGuardWorld();

const guard = () => join(data, "role-message-guard");
/** Hosts started outside world() (it insists on a ready one); stopped after each test. */
const hosts: RoleMessageGuardHost[] = [];
afterEach(() => {
	fsx.hook = null;
	for (const h of hosts.splice(0)) h.stop();
});
function newHost(w: World, dir: string): RoleMessageGuardHost {
	const host = new RoleMessageGuardHost({
		dir,
		roleMessages: () => w.rm,
		identities: () => w.roles,
		log: () => {},
		now: clock,
	});
	hosts.push(host);
	return host;
}
/** Run `fn` as a server whose pid is `pid` (a second server, in this one test process). */
function asPid<T>(pid: number, fn: () => T): T {
	const real = Object.getOwnPropertyDescriptor(process, "pid")!;
	Object.defineProperty(process, "pid", { ...real, value: pid });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "pid", real);
	}
}
/** A folder whose lock a server that is gone left behind (no process has a pid above Linux's largest pid_max). */
function staleLock(name: string, text = `${2 ** 22 + 1}\n`): string {
	const dir = join(data, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "lock"), text);
	return dir;
}
const lockFiles = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("lock"));
/** Another live server: a live process that isn't this one (the test runner that started it). */
const OTHER = process.ppid;

describe("current.json's switch reaches the disk (Ops #253, Architecture A2)", () => {
	it("each rename of current.json is followed at once by a flush of the guard folder", async () => {
		fsx.calls.length = 0;
		fsx.on = true;
		try {
			// A first start (it names gen-1 before and after making it), a rotation at start, one after a send.
			const w = await world(undefined, { rotateBytes: 1 });
			expect(await send(w, "alpha", A, "beta", { kind: "fyi" }, "")).toMatchObject({ ok: true });
		} finally {
			fsx.on = false;
		}
		expect(JSON.parse(readFileSync(join(guard(), "current.json"), "utf8"))).toEqual({ gen: 3 });
		const switched = `rename ${join(guard(), "current.json")}`;
		const at = fsx.calls.flatMap((c, i) => (c === switched ? [i] : []));
		expect(at).toHaveLength(4);
		expect(at.map((i) => fsx.calls[i + 1])).toEqual(at.map(() => `fsync ${guard()}`));
	});
});

describe("one server holds the guard (Ops #253, Architecture A4)", () => {
	it("two servers starting at once on one folder: exactly one holds it, the other turns off and leaves nothing", async () => {
		const w = await world(); // the native record and the chats; the two servers share another folder
		const dir = join(data, "guard-two");
		const first = newHost(w, dir);
		const second = newHost(w, dir);
		let secondStarted: Promise<void> | null = null;
		// The second server starts while the first is between its look at the lock and taking it.
		const proto = RoleMessageGuardHost.prototype as unknown as { currentGeneration(): number | string };
		const look = proto.currentGeneration;
		const spy = vi.spyOn(proto, "currentGeneration").mockImplementation(function (this: unknown) {
			if (this === first && !secondStarted) secondStarted = asPid(OTHER, () => second.start());
			return look.call(this);
		});
		try {
			await first.start();
			await secondStarted;
		} finally {
			spy.mockRestore();
		}
		expect(second.state).toEqual({ status: "ready", reason: "" });
		expect(first.state).toEqual({ status: "degraded", reason: `another server (pid ${OTHER}) holds the guard` });
		expect(readFileSync(join(dir, "lock"), "utf8")).toBe(`${OTHER}\n`);
		expect(lockFiles(dir)).toEqual(["lock"]);
	});

	it("a gone server's lock, an unreadable or empty one and this process's own are taken over", async () => {
		const w = await world();
		for (const [i, text] of [`${2 ** 22 + 1}\n`, "not a pid\n", "", `${process.pid}\n`].entries()) {
			const dir = staleLock(`guard-stale-${i}`, text);
			const host = newHost(w, dir);
			await host.start();
			expect(host.state).toEqual({ status: "ready", reason: "" });
			expect(readFileSync(join(dir, "lock"), "utf8")).toBe(`${process.pid}\n`);
			expect(lockFiles(dir)).toEqual(["lock"]);
			host.stop();
			expect(existsSync(join(dir, "lock"))).toBe(false);
		}
	});

	it("a live server that took the lock just before the gone one's was moved aside gets it back; this one turns off", async () => {
		const w = await world();
		const dir = staleLock("guard-put-back");
		fsx.hook = (when, op, from) => {
			// The other server removed the gone server's lock and took its own between this one's look and its move.
			if (when === "before" && op === "rename" && from === join(dir, "lock")) {
				fsx.hook = null;
				rmSync(from);
				writeFileSync(from, `${OTHER}\n`);
			}
		};
		const host = newHost(w, dir);
		await host.start();
		expect(host.state).toEqual({ status: "degraded", reason: `another server (pid ${OTHER}) holds the guard` });
		expect(readFileSync(join(dir, "lock"), "utf8")).toBe(`${OTHER}\n`);
		expect(readdirSync(dir)).toEqual(["lock"]); // nothing else written
	});

	it("three servers over a gone server's lock: the one whose lock was moved aside turns off; one holds the guard (Ops #257, B1)", async () => {
		// Architecture's repro (review of Ops #253): a guard folder with a record (gen-1) whose server is gone.
		const w = await world();
		const dir = join(data, "guard-three");
		const lock = join(dir, "lock");
		const first = newHost(w, dir);
		await first.start();
		first.stop();
		writeFileSync(lock, `${2 ** 22 + 1}\n`);
		const [a, b, c] = [newHost(w, dir), newHost(w, dir), newHost(w, dir)];
		const THIRD = 1; // init: alive to pidAlive() (kill(1, 0) gives EPERM)
		const aAside = `${lock}.stale-${process.pid}`;
		let bStarted: Promise<void> | null = null;
		let cStarted: Promise<void> | null = null;
		fsx.hook = (when, op, from, to) => {
			if (op !== "rename" || from !== lock || to !== aAside) return;
			// B does the whole take-over between A's look and A's move; C starts while A holds B's live lock aside.
			if (when === "before" && !bStarted) bStarted = asPid(OTHER, () => b.start());
			else if (when === "after" && !cStarted) cStarted = asPid(THIRD, () => c.start());
		};
		await a.start();
		await bStarted;
		await cStarted;
		fsx.hook = null;
		expect(a.state).toEqual({ status: "degraded", reason: `another server (pid ${OTHER}) holds the guard` });
		expect(b.state).toEqual({ status: "degraded", reason: `another server (pid ${THIRD}) took the guard's lock` });
		expect(c.state).toEqual({ status: "ready", reason: "" });
		expect(readFileSync(lock, "utf8")).toBe(`${THIRD}\n`);
		expect(lockFiles(dir)).toEqual(["lock"]);
		b.stop(); // B no longer holds the lock: its stop leaves C's
		expect(readFileSync(lock, "utf8")).toBe(`${THIRD}\n`);
		c.stop();
		expect(existsSync(lock)).toBe(false);
	});

	it("a running server whose lock another server took turns off before its next guard write (Ops #257, B1)", async () => {
		const w = await world();
		const lock = join(guard(), "lock");
		const journal = join(guard(), "gen-1", "journal.json");
		const before = readFileSync(journal, "utf8");
		rmSync(lock);
		writeFileSync(lock, `${OTHER}\n`); // another server's lock: a new file
		expect(await send(w, "alpha", A, "beta", { kind: "fyi" }, "")).toMatchObject({ ok: false });
		expect(w.host.state).toEqual({ status: "degraded", reason: `another server (pid ${OTHER}) took the guard's lock` });
		expect(readFileSync(journal, "utf8")).toBe(before);
		w.host.stop();
		expect(readFileSync(lock, "utf8")).toBe(`${OTHER}\n`); // its stop leaves the other server's lock
	});

	// Ops #257 (B3): `lock` is looked at with lstat first; anything but a plain file turns the start off, left as it is.
	const odd = (kind: string) => `the guard's lock is ${kind}, not a plain file; it was left in place`;
	it("a folder or a link at lock turns the start off and is left as it is (Ops #257, B3)", async () => {
		const w = await world();
		const cases: Array<[string, (lock: string) => void, (lock: string) => boolean]> = [
			[
				"a folder",
				(l) => {
					mkdirSync(l);
					writeFileSync(join(l, "keep"), "x");
				},
				(l) => lstatSync(l).isDirectory() && existsSync(join(l, "keep")),
			],
			[
				"a link", // to a gone server's lock: never followed, never moved
				(l) => {
					writeFileSync(`${l}-target`, `${2 ** 22 + 1}\n`);
					symlinkSync(`${l}-target`, l);
				},
				(l) => lstatSync(l).isSymbolicLink() && readFileSync(`${l}-target`, "utf8") === `${2 ** 22 + 1}\n`,
			],
		];
		for (const [kind, make, still] of cases) {
			const dir = join(data, `guard-${kind.replace(" ", "-")}`);
			mkdirSync(dir, { recursive: true });
			const lock = join(dir, "lock");
			make(lock);
			const host = newHost(w, dir);
			await host.start();
			expect(host.state, kind).toEqual({ status: "degraded", reason: odd(kind) });
			expect(still(lock), kind).toBe(true);
			expect(lockFiles(dir).sort(), kind).toEqual(kind === "a link" ? ["lock", "lock-target"] : ["lock"]);
			host.stop();
			expect(still(lock), kind).toBe(true);
		}
	});

	it("a pipe at lock turns the start off at once, never opened (Ops #257, B3)", async () => {
		const w = await world();
		const dir = join(data, "guard-pipe");
		mkdirSync(dir, { recursive: true });
		const lock = join(dir, "lock");
		execFileSync("mkfifo", [lock]);
		const host = newHost(w, dir);
		await host.start(); // before: opening the pipe to read it waited for a writer, so the start never finished
		expect(host.state).toEqual({ status: "degraded", reason: odd("a pipe") });
		expect(lstatSync(lock).isFIFO()).toBe(true);
		expect(lockFiles(dir)).toEqual(["lock"]);
	});

	it("lock.tmp- and lock.stale- files a gone server left are removed once the lock is held; a live server's stay (Ops #257, B5)", async () => {
		const w = await world();
		const dir = staleLock("guard-leftovers");
		const GONE = 2 ** 22 + 1;
		// A server that crashed inside its take left its own files; a live one is taking the lock right now.
		for (const name of [`lock.tmp-${GONE}`, `lock.stale-${GONE}`, `lock.tmp-${OTHER}`, `lock.stale-${OTHER}`])
			writeFileSync(join(dir, name), `${GONE}\n`);
		mkdirSync(join(dir, `lock.stale-${GONE + 1}`)); // not a plain file: left as it is
		const host = newHost(w, dir);
		await host.start();
		expect(host.state).toEqual({ status: "ready", reason: "" });
		expect(readFileSync(join(dir, "lock"), "utf8")).toBe(`${process.pid}\n`);
		expect(lockFiles(dir).sort()).toEqual(
			["lock", `lock.stale-${GONE + 1}`, `lock.stale-${OTHER}`, `lock.tmp-${OTHER}`].sort(),
		);
	});

	it("a server that takes the lock between the move and the second try wins it; this one turns off", async () => {
		const w = await world();
		const dir = staleLock("guard-second-try");
		fsx.hook = (when, op, from, to) => {
			if (when === "after" && op === "rename" && from === join(dir, "lock") && basename(to).startsWith("lock.")) {
				fsx.hook = null;
				writeFileSync(from, `${OTHER}\n`);
			}
		};
		const host = newHost(w, dir);
		await host.start();
		expect(host.state).toEqual({
			status: "degraded",
			reason: `another server (pid ${OTHER}) took the guard as this one started`,
		});
		expect(readFileSync(join(dir, "lock"), "utf8")).toBe(`${OTHER}\n`);
		expect(readdirSync(dir)).toEqual(["lock"]); // nothing else written
	});
});
