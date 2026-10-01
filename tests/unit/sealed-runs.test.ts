/**
 * queue-side-by-side: tests/lib/sealed-runs.mjs, what tests/run-sealed.mjs needs so a long suite started
 * from a chat survives a pi-web-ui restart (it starts itself again outside the service, `--result` reads
 * it after the restart) and so at most 2 suites run at once.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exitOf,
	findRun,
	follow,
	inServiceCgroup,
	isAlive,
	pidOf,
	slotHolders,
	takeSlot,
} from "../lib/sealed-runs.mjs";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sealed-runs-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("inServiceCgroup", () => {
	it("a chat's bash is inside pi-web-ui's service; a run started outside it is not", () => {
		const chat = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-web-ui.service\n";
		expect(inServiceCgroup(chat)).toBe(true);
		expect(inServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-web-ui.service/sub\n")).toBe(
			true,
		);
		const outside =
			"0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-sealed-2026-09-30T20-31-12-345Z.service\n";
		expect(inServiceCgroup(outside)).toBe(false);
		expect(inServiceCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBe(false);
		expect(inServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-web-ui.service.old\n")).toBe(
			false,
		);
		// cgroup v1 lines (several controllers) and another service name.
		expect(inServiceCgroup("12:pids:/system.slice/x.service\n1:name=systemd:/user.slice/pi-web-ui.service\n")).toBe(
			true,
		);
		expect(inServiceCgroup(chat, "other.service")).toBe(false);
		expect(inServiceCgroup("")).toBe(false);
	});
});

describe("takeSlot", () => {
	const owner = (pid: number, repo = `/r/${pid}`) => ({ pid, repo, out: `/o/${pid}`, at: "2026-09-30T20:31:12.345Z" });

	it("two suites take the two slots; the third waits, says so once, and starts when one ends", async () => {
		const dir = join(root, "slots");
		const said: string[] = [];
		const alive = (pid: number) => pid < 100;
		const free1 = await takeSlot({ dir, max: 2, owner: owner(1), log: (s: string) => said.push(s), alive });
		await takeSlot({ dir, max: 2, owner: owner(2), log: (s: string) => said.push(s), alive });
		expect(said).toEqual([]);
		expect(slotHolders(dir, 2)).toEqual(["/r/1 since 20:31 UTC", "/r/2 since 20:31 UTC"]);
		let looks = 0;
		const third = await takeSlot({
			dir,
			max: 2,
			owner: owner(3),
			log: (s: string) => said.push(s),
			alive,
			sleep: async () => {
				looks++;
				if (looks === 3) free1();
			},
		});
		expect(looks).toBe(3);
		expect(said).toHaveLength(1);
		expect(said[0]).toMatch(
			/^waiting for a free slot: 2 sealed suites are running \(\/r\/1 since 20:31 UTC; \/r\/2 since/,
		);
		expect(JSON.parse(readFileSync(join(dir, "slot-0"), "utf8")).pid).toBe(3);
		third();
		expect(existsSync(join(dir, "slot-0"))).toBe(false);
		third();
	});

	it("a slot whose runner is gone is freed; a slot still being written is not, unless it is old", async () => {
		const dir = join(root, "slots");
		mkdirSync(dir);
		writeFileSync(join(dir, "slot-0"), JSON.stringify(owner(500)));
		writeFileSync(join(dir, "slot-1"), "");
		let now = Date.now();
		const alive = (pid: number) => pid !== 500;
		const mine = await takeSlot({ dir, max: 2, owner: owner(7), alive, now: () => now });
		expect(JSON.parse(readFileSync(join(dir, "slot-0"), "utf8")).pid).toBe(7);
		// The empty slot-1 is just being written: the next one waits until it is old.
		let looks = 0;
		await takeSlot({
			dir,
			max: 2,
			owner: owner(8),
			alive,
			now: () => now,
			log: () => {},
			sleep: async () => {
				looks++;
				now += 31_000;
			},
		});
		expect(looks).toBe(1);
		expect(JSON.parse(readFileSync(join(dir, "slot-1"), "utf8")).pid).toBe(8);
		mine();
	});

	it("frees only its own slot", async () => {
		const dir = join(root, "slots");
		const free = await takeSlot({ dir, max: 1, owner: owner(1), alive: () => true });
		// Taken over meanwhile (say its runner was thought gone): the old holder leaves it alone.
		writeFileSync(join(dir, "slot-0"), JSON.stringify(owner(2)));
		free();
		expect(JSON.parse(readFileSync(join(dir, "slot-0"), "utf8")).pid).toBe(2);
	});

	it("isAlive: this process is, a pid that can't be is not", () => {
		expect(isAlive(process.pid)).toBe(true);
		expect(isAlive(0)).toBe(false);
		expect(isAlive(-1)).toBe(false);
		expect(isAlive(2 ** 30)).toBe(false);
	});
});

describe("findRun", () => {
	it("the newest run of this folder; other folders' runs and folders without a record don't count", () => {
		const base = join(root, "runs");
		const run = (name: string, repo: string, at: string) => {
			mkdirSync(join(base, name), { recursive: true });
			writeFileSync(join(base, name, "run.json"), JSON.stringify({ repo, args: [], unit: null, at }));
		};
		run("a", "/p/pi-web-ui-x", "2026-09-30T20:00:00.000Z");
		run("b", "/p/pi-web-ui-x", "2026-09-30T21:00:00.000Z");
		run("c", "/p/pi-web-ui-y", "2026-09-30T22:00:00.000Z");
		mkdirSync(join(base, "slots"));
		mkdirSync(join(base, "old-run"));
		expect(findRun(base, "/p/pi-web-ui-x")?.dir).toBe(join(base, "b"));
		expect(findRun(base, "/p/pi-web-ui-y")?.run.at).toBe("2026-09-30T22:00:00.000Z");
		expect(findRun(base, "/p/other")).toBeUndefined();
		expect(findRun(join(root, "none"), "/p/pi-web-ui-x")).toBeUndefined();
	});
});

describe("follow", () => {
	const runDir = (unit: string | null = "pi-sealed-x") => {
		const dir = join(root, "run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "run.json"),
			JSON.stringify({ repo: "/p", args: [], unit, at: "2026-09-30T20:00:00.000Z" }),
		);
		return dir;
	};

	it("shows the output as it grows and gives the exit code once the run ends", async () => {
		const dir = runDir();
		const shown: string[] = [];
		let looks = 0;
		const code = await follow(dir, {
			write: (s: string) => shown.push(s),
			alive: () => true,
			unitActive: () => true,
			sleep: async () => {
				looks++;
				if (looks === 1) writeFileSync(join(dir, "pid"), "4242");
				if (looks === 2)
					appendFileSync(join(dir, "run.log"), "building (npm run build)\n[1/2] PASS a-test (3s, exit 0)\n");
				// A character cut in two by a read: shown whole, once its second half is there.
				if (looks === 3) appendFileSync(join(dir, "run.log"), Buffer.from("[2/2] FAIL b-test \u2717"));
				if (looks === 4) appendFileSync(join(dir, "run.log"), Buffer.from(" \u2026\n").subarray(0, 2));
				if (looks === 5) {
					appendFileSync(join(dir, "run.log"), Buffer.from(" \u2026\n").subarray(2));
					appendFileSync(join(dir, "run.log"), "\n1/2 passed\n");
					writeFileSync(join(dir, "exit"), "1");
				}
			},
		});
		expect(code).toBe(1);
		expect(shown.join("")).toBe(
			"building (npm run build)\n[1/2] PASS a-test (3s, exit 0)\n[2/2] FAIL b-test \u2717 \u2026\n\n1/2 passed\n",
		);
		expect(shown.every((s) => !s.includes("\ufffd"))).toBe(true);
		expect(pidOf(dir)).toBe(4242);
		expect(exitOf(dir)).toBe(1);
	});

	it("a run that has already ended: its whole output and its code at once (--result after a restart)", async () => {
		const dir = runDir();
		writeFileSync(join(dir, "pid"), "4242");
		writeFileSync(join(dir, "run.log"), "a\nb\n\n181/181 passed\n");
		writeFileSync(join(dir, "exit"), "0\n");
		const shown: string[] = [];
		const code = await follow(dir, {
			write: (s: string) => shown.push(s),
			alive: () => false,
			sleep: async () => {
				throw new Error("no waiting");
			},
		});
		expect(code).toBe(0);
		expect(shown.join("")).toBe("a\nb\n\n181/181 passed\n");
	});

	it("a runner that is gone without its result: 1, after a couple more looks, and it says so", async () => {
		const dir = runDir();
		writeFileSync(join(dir, "pid"), "4242");
		writeFileSync(join(dir, "run.log"), "[1/9] PASS a-test (3s, exit 0)\n");
		const shown: string[] = [];
		let looks = 0;
		const code = await follow(dir, {
			write: (s: string) => shown.push(s),
			alive: () => false,
			sleep: async () => {
				looks++;
			},
		});
		expect(code).toBe(1);
		expect(looks).toBe(2);
		expect(shown.join("")).toMatch(
			/^\[1\/9\] PASS a-test .*\n\n\u2717 the run stopped without finishing .*its logs are in /s,
		);
	});

	it("one that ends between two looks still gives its own code", async () => {
		const dir = runDir();
		writeFileSync(join(dir, "pid"), "4242");
		const code = await follow(dir, {
			write: () => {},
			alive: () => false,
			sleep: async () => {
				writeFileSync(join(dir, "exit"), "0");
			},
		});
		expect(code).toBe(0);
	});

	it("before the runner writes its pid, the unit counts; a unit that never started gives 1", async () => {
		const dir = runDir();
		let looks = 0;
		const code = await follow(dir, {
			write: () => {},
			alive: (pid: number) => pid === 4242,
			unitActive: (unit: string) => unit === "pi-sealed-x" && looks < 3,
			sleep: async () => {
				looks++;
				if (looks === 5) writeFileSync(join(dir, "pid"), "4242");
				if (looks === 6) writeFileSync(join(dir, "exit"), "0");
			},
		});
		expect(code).toBe(0);
		const never = join(root, "never");
		mkdirSync(never);
		writeFileSync(join(never, "run.json"), JSON.stringify({ repo: "/p", args: [], unit: "pi-sealed-y", at: "x" }));
		expect(await follow(never, { write: () => {}, unitActive: () => false, sleep: async () => {} })).toBe(1);
	});
});
