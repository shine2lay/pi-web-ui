import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { follow } from "../lib/sealed-runs.mjs";
import {
	recordDetachedIdentity,
	startSealedRun,
	testCpuTransport,
	workerResultToken,
	TEST_CPU,
	TEST_CPU_POLICY,
} from "../lib/sealed-test-launch.mjs";
import { HANG_GUARD_MS } from "./load-independent.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const token = "ab".repeat(16);
const unit = `testcpu-job-${token}.service`;
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sealed-cpu-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
const reply = (value: unknown, status = 0) => ({ status, stdout: JSON.stringify(value), stderr: "", signal: null });
const fixtureCpu = (value: unknown, status = 0) => {
	const invoke = vi.fn((..._args: unknown[]) => reply(value, status));
	return { cpu: testCpuTransport({ invoke, has: () => true }), invoke };
};

function launchOptions() {
	return {
		repo: root,
		out: root,
		args: ["--no-build", "fixture-test", "--jobs=2", "--out=old path"],
		unit: "pi-sealed-fixture",
		runner: join(root, "runner with spaces.mjs"),
		env: { PATH: process.env.PATH, SYNTHETIC: "spaces\n=λ" },
	};
}

describe("canonical CPU entry", () => {
	it("permits only confirmed absence when the installed launcher is absent", () => {
		const invoke = vi.fn();
		expect(testCpuTransport({ invoke, has: () => false }).entry()).toBe(0);
		expect(invoke).not.toHaveBeenCalled();
		expect(() => testCpuTransport({ invoke, has: (p: string) => p === TEST_CPU_POLICY }).entry()).toThrow(
			"restore its install",
		);
		expect(() =>
			testCpuTransport({
				invoke,
				has: () => {
					throw new Error("EACCES");
				},
			}).entry(),
		).toThrow("EACCES");
	});
	it.each([
		[{ mode: "absent" }, 0],
		[{ mode: "inactive" }, 0],
		[{ mode: "enabled", decision: "inside" }, 0],
		[{ mode: "enabled", decision: "placed" }, 3],
	])("delegates %j without a copied placement algorithm", (state, code) => {
		const { cpu, invoke } = fixtureCpu(state);
		expect(cpu.entry()).toBe(code);
		expect(invoke).toHaveBeenCalledWith(TEST_CPU, ["status", "--json"], { encoding: "utf8" });
	});
	it.each([{}, null, { mode: "enabled" }, { mode: "invalid" }, { mode: "enabled", decision: "failed" }])(
		"refuses an unconfirmed reply %j",
		(state) => {
			expect(() => fixtureCpu(state).cpu.entry()).toThrow();
		},
	);
	it("does not mistake command failure or malformed stdout for inactivity", () => {
		expect(() => fixtureCpu({ mode: "inactive" }, 1).cpu.entry()).toThrow("status failed");
		const cpu = testCpuTransport({ has: () => true, invoke: () => ({ status: 0, stdout: "not json" }) });
		expect(() => cpu.entry()).toThrow("unreadable receipt");
	});
});

describe("detached launch transport", () => {
	it("passes exact argv/env/cwd and stores the owned token before following", () => {
		const { cpu, invoke } = fixtureCpu({ token, unit });
		const legacy = vi.fn();
		const options = launchOptions();
		const r = startSealedRun(options, { cpu, invoke: legacy });
		expect(r).toEqual({ code: 0, unit, stop: `${TEST_CPU} stop ${token}` });
		expect(invoke).toHaveBeenCalledWith(
			TEST_CPU,
			[
				"start",
				"--log",
				join(root, "run.log"),
				"--result",
				join(root, "cpu-result.json"),
				"--",
				process.execPath,
				options.runner,
				"--no-build",
				"fixture-test",
				"--jobs=2",
				"--here",
				`--out=${root}`,
			],
			{ cwd: root, env: options.env, encoding: "utf8" },
		);
		expect(JSON.parse(readFileSync(join(root, "run.json"), "utf8"))).toMatchObject({
			token,
			unit,
			transport: "test-cpu",
			repo: root,
			args: options.args,
		});
		expect(existsSync(join(root, "env.json"))).toBe(false);
		expect(legacy).not.toHaveBeenCalled();
	});
	it("uses the legacy manager only on inactive, preserving private environment handoff", () => {
		const { cpu } = fixtureCpu({}, 3);
		const invoke = vi.fn((..._args: unknown[]) => reply({}));
		const options = launchOptions();
		const r = startSealedRun(options, { cpu, invoke });
		expect(r.stop).toBe("systemctl --user stop pi-sealed-fixture");
		expect(invoke.mock.calls[0]?.[0]).toBe("systemd-run");
		expect(JSON.parse(readFileSync(join(root, "env.json"), "utf8"))).toEqual(options.env);
		expect(statSync(join(root, "env.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(root, "run.json"), "utf8")).transport).toBeUndefined();
	});
	it.each([3, 125])("failed detach %i has no stale handoff and never substitutes an uncapped user unit", (status) => {
		const { cpu } = fixtureCpu({}, status);
		const invoke = vi.fn(() => ({ status: 1, stderr: "fake manager failed" }));
		expect(startSealedRun(launchOptions(), { cpu, invoke })).toMatchObject({ code: 125, fallback: true });
		expect(invoke).toHaveBeenCalledTimes(status === 3 ? 1 : 0);
		expect(existsSync(join(root, "env.json"))).toBe(false);
		expect(existsSync(join(root, "run.json"))).toBe(false);
	});
	it.each([
		{ token: "bad", unit },
		{ token, unit: "somebody-else.service" },
	])("does not duplicate an ambiguous successful start %j", (receipt) => {
		const { cpu } = fixtureCpu(receipt);
		const invoke = vi.fn();
		expect(() => startSealedRun(launchOptions(), { cpu, invoke })).toThrow("invalid owned-token");
		expect(invoke).not.toHaveBeenCalled();
	});
	it("stop and forced stop name only the validated token, not an arbitrary unit", () => {
		const { cpu, invoke } = fixtureCpu({ ok: true, outcome: "stopped" });
		expect(cpu.stop(token)).toMatchObject({ ok: true });
		expect(cpu.stop(token, { force: true })).toMatchObject({ ok: true });
		expect(invoke.mock.calls.map((c) => c[1])).toEqual([
			["stop", token],
			["stop", token, "--force"],
		]);
		expect(() => cpu.stop("pi-web-ui.service")).toThrow("invalid job token");
		expect(() => fixtureCpu({ ok: false }, 1).cpu.stop(token)).toThrow("stop failed");
	});
});

describe("dispatch interruption controls", () => {
	it("never-published identity remains unconfirmed, with one notice and no terminal verdict", async () => {
		writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu" }));
		let looks = 0;
		const shown: string[] = [];
		const jobResult = vi.fn();
		await expect(
			follow(root, {
				graceLooks: 2,
				jobResult,
				write: (s) => shown.push(s),
				sleep: async () => {
					if (++looks === 10) throw new Error("leave follower fixture");
				},
			}),
		).rejects.toThrow("leave follower fixture");
		expect(jobResult).not.toHaveBeenCalled();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("Ctrl-C leaves this follower only");
		expect(shown[0]).not.toContain("stopped");
	});
	it("correlation never overrides a failed canonical entry", () => {
		const invoke = vi.fn((_path, args) =>
			args[0] === "membership"
				? reply({ inside: false, cgroup: `/testcpu.slice/${unit}` }, 1)
				: reply({ mode: "enabled", decision: "failed" }, 1),
		);
		const cpu = testCpuTransport({ has: () => true, invoke });
		expect(() => recordDetachedIdentity(root, { transport: "test-cpu" }, cpu)).not.toThrow();
		expect(() => cpu.entry()).toThrow("status failed");
	});
	it("malformed recovery is an explicit failure rather than indefinite pending", async () => {
		writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu" }));
		writeFileSync(join(root, "cpu-result.json"), "bad json", { mode: 0o600 });
		const shown: string[] = [];
		expect(await follow(root, { write: (s) => shown.push(s), sleep: async () => {} })).toBe(1);
		expect(shown.join("")).toContain("worker result recovery failed");
		expect(shown.join("")).not.toContain("dispatch unconfirmed");
	});
	it("keeps following unconfirmed dispatch past graceLooks until the delayed worker publishes its token", async () => {
		writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu", dispatchPid: 1 }));
		const shown: string[] = [];
		let looks = 0;
		const code = await follow(root, {
			alive: () => false,
			graceLooks: 2,
			write: (s) => shown.push(s),
			jobResult: (t) => ({ state: t === token ? "finished" : "unknown", code: 37 }),
			sleep: async () => {
				if (++looks === 4) writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu", token }));
			},
		});
		expect(code).toBe(37);
		expect(looks).toBe(4);
		expect(shown.join("")).toContain("dispatch unconfirmed");
		expect(shown.join("")).not.toContain("stopped without finishing");
	});
	it("inactive quota-removed identity bookkeeping cannot veto the canonical inactive entry", () => {
		const invoke = vi.fn((_path, args) =>
			args[0] === "membership"
				? reply({ mode: "inactive", inside: false, cgroup: `/testcpu.slice/${unit}` }, 1)
				: reply({ mode: "inactive" }),
		);
		const cpu = testCpuTransport({ has: () => true, invoke });
		expect(() => recordDetachedIdentity(root, { transport: "test-cpu" }, cpu)).not.toThrow();
		expect(cpu.entry()).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "run.json"), "utf8"))).toMatchObject({ token, unit });
	});
	it("the detached worker durably records its canonical identity even if its starter disappeared", () => {
		const { cpu, invoke } = fixtureCpu({ inside: true, cgroup: `/testcpu.slice/${unit}` });
		const record = { transport: "test-cpu", externalLog: true };
		recordDetachedIdentity(root, record, cpu);
		expect(invoke).toHaveBeenCalledWith(TEST_CPU, ["membership", "--json"], { encoding: "utf8" });
		expect(JSON.parse(readFileSync(join(root, "run.json"), "utf8"))).toEqual({ ...record, token, unit });
		expect(fixtureCpu({ inside: false, cgroup: `/testcpu.slice/${unit}` }).cpu.identity()).toEqual({ token, unit });
		expect(fixtureCpu({ error: "unreadable cgroup" }).cpu.identity()).toBe(null);
	});
	it.each(["symlink", "fifo", "directory", "too large", "bad bytes", "invalid token", "public"])(
		"rejects %s worker receipts without blocking or trusting their result",
		(kind) => {
			const path = join(root, "cpu-result.json");
			const good = JSON.stringify({ v: 1, token, code: 0 });
			if (kind === "symlink") {
				writeFileSync(join(root, "target"), good, { mode: 0o600 });
				symlinkSync(join(root, "target"), path);
			} else if (kind === "fifo") expect(spawnSync("mkfifo", [path]).status).toBe(0);
			else if (kind === "directory") mkdirSync(path);
			else
				writeFileSync(
					path,
					kind === "too large"
						? " ".repeat(65537)
						: kind === "bad bytes"
							? Buffer.from([255])
							: kind === "invalid token"
								? '{"v":1,"token":"wrong"}'
								: good,
					{ mode: kind === "public" ? 0o644 : 0o600 },
				);
			expect(workerResultToken(root)).toMatchObject({
				error: expect.stringContaining("worker result recovery failed"),
			});
		},
	);
	it.each([null, 1, 2, 137])("ambiguous start status %s preserves its record without any fallback", (status) => {
		const cpu = testCpuTransport({
			has: () => true,
			invoke: () => ({ status, signal: status === null ? "SIGTERM" : null, stderr: "interrupted" }),
		});
		const legacy = vi.fn();
		expect(() => startSealedRun(launchOptions(), { cpu, invoke: legacy })).toThrow("ambiguous");
		expect(legacy).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(join(root, "run.json"), "utf8"))).toMatchObject({ transport: "test-cpu" });
	});
	it("recovers the token from the worker's result when dispatch died before publishing it", async () => {
		writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu" }));
		writeFileSync(join(root, "cpu-result.json"), JSON.stringify({ v: 1, token, code: 37 }), { mode: 0o600 });
		writeFileSync(join(root, "run.log"), "last output\n");
		const shown: string[] = [];
		const jobResult = vi.fn((seen) =>
			seen === token ? { state: "finished", code: 37 } : { state: "unknown", error: "lost token" },
		);
		expect(await follow(root, { write: (s) => shown.push(s), jobResult, sleep: async () => {} })).toBe(37);
		expect(jobResult).toHaveBeenCalledWith(token);
		expect(shown.join("")).toBe("last output\n");
	});
});

describe("token result following", () => {
	it.each([false, true])("the owned-token stop (force=%s) reaches only its fake-manager fixture", async (force) => {
		const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close");
		try {
			await once(child.stdout, "data");
			const cpu = testCpuTransport({
				invoke: (_path: string, args: string[]) => {
					expect(args).toEqual(["stop", token, ...(force ? ["--force"] : [])]);
					child.kill(force ? "SIGKILL" : "SIGTERM");
					return reply({ ok: true, outcome: force ? "killed" : "stopped" });
				},
			});
			expect(() => cpu.stop("someone-else")).toThrow("invalid job token");
			expect(child.killed).toBe(false);
			expect(cpu.stop(token, { force }).ok).toBe(true);
			const [code, signal] = await closed;
			expect(code).toBe(null);
			expect(signal).toBe(force ? "SIGKILL" : "SIGTERM");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	});
	it.each([0, 37, 130, 143])(
		"waits past the runner exit for final stdout, returning %i after a follower restart",
		async (code) => {
			writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu", token, unit }));
			writeFileSync(join(root, "exit"), "0"); // deliberately too early and not authoritative
			writeFileSync(join(root, "run.log"), "first\n");
			let ended = false;
			const invoke = vi.fn(() => reply(ended ? { state: "finished", code } : { state: "running" }, ended ? 0 : 1));
			const cpu = testCpuTransport({ invoke });
			const shown: string[] = [];
			const unitActive = vi.fn();
			expect(
				await follow(root, {
					write: (s: string) => shown.push(s),
					unitActive,
					jobResult: cpu.result,
					sleep: async () => {
						appendFileSync(join(root, "run.log"), "final λ\n");
						ended = true;
					},
				}),
			).toBe(code);
			expect(shown.join("")).toBe("first\nfinal λ\n");
			expect(unitActive).not.toHaveBeenCalled();
			const resumed: string[] = [];
			expect(
				await follow(root, {
					write: (s: string) => resumed.push(s),
					jobResult: cpu.result,
					sleep: async () => {
						throw new Error("finished already");
					},
				}),
			).toBe(code);
			expect(resumed.join("")).toBe(shown.join(""));
		},
	);
	it.each([
		[{ state: "lost" }, 2],
		[{ state: "unknown", error: "bus unavailable" }, 2],
		[{ state: "finished", code: 0 }, 1],
		[{ state: "finished", code: null }, 0],
		[{ state: "finished", code: 0, error: "lost result" }, 0],
	])("never calls unavailable or malformed result %j a pass", async (value, status) => {
		writeFileSync(join(root, "run.json"), JSON.stringify({ transport: "test-cpu", token }));
		writeFileSync(join(root, "exit"), "0");
		const { cpu } = fixtureCpu(value, Number(status));
		const shown: string[] = [];
		expect(
			await follow(root, { write: (s: string) => shown.push(s), jobResult: cpu.result, sleep: async () => {} }),
		).toBe(1);
		expect(shown.join("")).toContain("test-cpu result unavailable");
	});
});

/** A private copy points at a fake CLI; production has no env/path override. No live manager is used. */
function shellFixture() {
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "tests/lib"), { recursive: true });
	const cli = join(root, "fake-test-cpu");
	const state = join(root, "state.json");
	const calls = join(root, "calls.jsonl");
	writeFileSync(state, JSON.stringify({ mode: "enabled", decision: "placed" }));
	writeFileSync(
		join(root, "tests/lib/sealed-test-launch.mjs"),
		readFileSync(join(repo, "tests/lib/sealed-test-launch.mjs"), "utf8")
			.replace(TEST_CPU, cli)
			.replace(TEST_CPU_POLICY, join(root, "policy.json")),
	);
	for (const path of ["scripts/sealed.sh", "scripts/sealed-summary.mjs", "tests/lib/sealed-fence.cjs"])
		copyFileSync(join(repo, path), join(root, path));
	writeFileSync(
		cli,
		`#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)}, calls = ${JSON.stringify(calls)};
appendFileSync(calls, JSON.stringify({args, sealed: process.env.PI_SEALED ?? null}) + '\\n');
const s = JSON.parse(readFileSync(state));
if (args[0] === 'status') { console.log(JSON.stringify(s)); process.exit(s.fail ? 1 : 0); }
if (args[0] === 'exec') {
 writeFileSync(state, JSON.stringify({mode:'enabled',decision:'inside'}));
 const argv = args.slice(args.indexOf('--') + 1);
 const r = spawnSync(argv[0], argv.slice(1), {stdio:'inherit', env:process.env});
 process.exit(r.status ?? 125);
}
process.exit(125);
`,
		{ mode: 0o700 },
	);
	return { state, calls, sealed: join(root, "scripts/sealed.sh") };
}
function runShell(script: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	// No inherited model/server state; this shell will allocate its own fenced HOME.
	return spawnSync("bash", [script, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: HANG_GUARD_MS,
		env: {
			PATH: process.env.PATH,
			HOME: root,
			PI_SEALED: "",
			PI_SEALED_MODEL: "none",
			PI_SEALED_TMP_PARENT: root,
			...extra,
		},
	});
}
function runnerFixture() {
	const f = shellFixture();
	copyFileSync(join(repo, "tests/run-sealed.mjs"), join(root, "tests/run-sealed.mjs"));
	writeFileSync(
		join(root, "tests/lib/sealed-runs.mjs"),
		readFileSync(join(repo, "tests/lib/sealed-runs.mjs"), "utf8").replace(
			/export function inService\(service = SERVICE\) \{[\s\S]*?\/\*\* Whether a process/,
			"export function inService() { return true; }\n\n/** Whether a process",
		),
	);
	writeFileSync(
		join(root, "tests/fixture-test.mjs"),
		"console.log('fixture stdout'); console.error('fixture stderr'); process.exit(37);",
	);
	return f;
}
const readCalls = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((s) => JSON.parse(s));

describe("normal sealed commands with fake placement only", () => {
	it("the placement observation rejects an entry-removed negative control (the old shell behavior)", () => {
		const f = shellFixture();
		const current = readFileSync(f.sealed, "utf8");
		const mutant = current.replace(/cpu_launch=\"[^\n]+[\s\S]*?\nesac\n/, "");
		expect(mutant).not.toBe(current);
		writeFileSync(f.sealed, mutant);
		const r = runShell(f.sealed, [
			process.execPath,
			"-e",
			`console.log(JSON.parse(require('node:fs').readFileSync(${JSON.stringify(f.state)})).decision)`,
		]);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("placed\n"); // outside, not the required inside verdict
		expect(existsSync(f.calls)).toBe(false);
	});
	it("enters before scrubbing, rechecks nested entry, preserves argv/stdout/exit and deletes the temp home", () => {
		const f = shellFixture();
		const report = join(root, "report.json");
		const output = join(root, "observed.json");
		const command = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({home:process.env.HOME,root:process.env.PI_SEALED_ROOT,secret:process.env.SYNTHETIC_SECRET,marker:process.env.WT_SLOT,args:process.argv.slice(1)})); console.log('stdout λ'); console.error('stderr value'); process.exit(37);`;
		const r = runShell(f.sealed, ["bash", f.sealed, process.execPath, "-e", command, "space value", "quote'\""], {
			PI_SEALED_REPORT_FILE: report,
			SYNTHETIC_SECRET: "not inherited",
			WT_SLOT: "not membership",
			CI: "1",
		});
		expect(r.status, r.stderr).toBe(37);
		expect(r.stdout).toBe("stdout λ\n");
		expect(r.stderr).toContain("stderr value");
		const observed = JSON.parse(readFileSync(output, "utf8"));
		expect(observed.args).toEqual(["space value", "quote'\""]);
		expect(observed.secret).toBeUndefined();
		expect(observed.marker).toBeUndefined();
		expect(observed.home).not.toBe(root);
		expect(existsSync(observed.root)).toBe(false);
		expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ hits: [], leaked: [] });
		const calls = readCalls(f.calls);
		expect(calls.map((c) => c.args[0])).toEqual(["status", "exec", "status", "status"]);
		expect(calls.at(-1).sealed).toBe("1");
	});
	it("pre-seal caller hooks cannot break active entry and are still scrubbed for the command", () => {
		const f = shellFixture();
		const r = runShell(f.sealed, [process.execPath, "-e", "console.log('fixture')"], {
			NODE_OPTIONS: "--require /nonexistent/caller-hook.cjs",
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toBe("fixture\n");
		expect(readCalls(f.calls).map((c) => c.args[0])).toEqual(["status", "exec", "status"]);
	});
	it("legacy external logging stays owned across env handoff and active placement re-exec", () => {
		const f = runnerFixture();
		const out = join(root, "out");
		mkdirSync(out);
		writeFileSync(join(out, "run.json"), JSON.stringify({ externalLog: true, unit: "legacy", repo: root }));
		const handoff = join(root, "env.json");
		writeFileSync(
			handoff,
			JSON.stringify({
				PATH: process.env.PATH,
				HOME: root,
				PI_SEALED: "",
				PI_SEALED_MODEL: "none",
				PI_SEALED_RUNS_DIR: join(root, "slots"),
			}),
			{ mode: 0o600 },
		);
		const r = spawnSync(
			process.execPath,
			[join(root, "tests/run-sealed.mjs"), "fixture-test", "--no-build", "--here", `--out=${out}`],
			{
				cwd: root,
				encoding: "utf8",
				timeout: HANG_GUARD_MS,
				env: { PATH: process.env.PATH, PI_SEALED_ENV_FILE: handoff },
			},
		);
		expect(r.status, r.stderr).toBe(1);
		expect(existsSync(handoff)).toBe(false);
		expect(existsSync(join(out, "run.log"))).toBe(false); // stdout is the external logger's only copy
		expect(readCalls(f.calls).map((c) => c.args[0])).toContain("exec");
		expect(readFileSync(join(out, "fixture-test.log"), "utf8")).toContain("fixture stdout");
	});
	it("a forged PI_SEALED/WT_SLOT marker cannot skip the CPU entry", () => {
		const f = shellFixture();
		const r = runShell(f.sealed, [process.execPath, "-e", "console.log('fixture')"], { PI_SEALED: "1", WT_SLOT: "1" });
		expect(r.status, r.stderr).toBe(0);
		expect(readCalls(f.calls).map((c) => c.args[0])).toEqual(["status", "exec", "status"]);
	});
	it("refuses a broken policy before even the already-sealed command executes", () => {
		const f = shellFixture();
		writeFileSync(f.state, JSON.stringify({ mode: "enabled", decision: "failed", fail: true }));
		const r = runShell(f.sealed, [process.execPath, "-e", "console.log('MUST NOT RUN')"], { PI_SEALED: "1" });
		expect(r.status).toBe(125);
		expect(r.stdout).not.toContain("MUST NOT RUN");
		expect(readCalls(f.calls).map((c) => c.args[0])).toEqual(["status"]);
	});
	it("retains the no-live-data fence on a synthetic forbidden file", () => {
		const f = shellFixture();
		const forbidden = join(root, "synthetic-private");
		writeFileSync(forbidden, "fixture only");
		const report = join(root, "report.json");
		const r = runShell(
			f.sealed,
			[
				"env",
				`PI_SEALED_FORBID=${forbidden}`,
				process.execPath,
				"-e",
				`try { require('node:fs').readFileSync(${JSON.stringify(forbidden)}); process.exit(9); } catch(e) { console.log(e.code); }`,
			],
			{ PI_SEALED_REPORT_FILE: report },
		);
		expect(r.status, r.stderr).toBe(97);
		expect(r.stdout).toBe("EACCES\n");
		expect(JSON.parse(readFileSync(report, "utf8")).hits[0].path).toBe(forbidden);
		expect(readFileSync(forbidden, "utf8")).toBe("fixture only");
	});
	it("a refused detach runs its fixture through foreground entry, with exact logs/results and slot cleanup", () => {
		const f = runnerFixture();
		const out = join(root, "out");
		const r = spawnSync(
			process.execPath,
			[join(root, "tests/run-sealed.mjs"), "fixture-test", "--no-build", `--out=${out}`],
			{
				cwd: root,
				encoding: "utf8",
				timeout: HANG_GUARD_MS,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TMPDIR: root,
					PI_SEALED_SLOTS_DIR: join(root, "slots"),
					PI_SEALED_MODEL: "none",
					PI_SEALED_TMP_PARENT: root,
				},
			},
		);
		expect(r.status, r.stderr).toBe(1);
		const commands = readCalls(f.calls).map((c) => c.args[0]);
		expect(commands).toEqual(["start", "status", "exec", "status", "status"]);
		expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toMatchObject([
			{ name: "fixture-test", code: 37, hits: 0, leaked: 0 },
		]);
		expect(readFileSync(join(out, "fixture-test.log"), "utf8").trim().split("\n").sort()).toEqual([
			"fixture stderr",
			"fixture stdout",
		]);
		expect(readFileSync(join(out, "exit"), "utf8")).toBe("1");
		expect(existsSync(join(root, "slots/slot-0"))).toBe(false);
		expect(existsSync(join(out, "env.json"))).toBe(false);
	});
	it("keeps gate entry before the sealing shortcut and runner fallback before admission/builds", () => {
		const check = readFileSync(join(repo, "scripts/check.sh"), "utf8");
		expect(check.indexOf('node "$cpu_launch" entry')).toBeGreaterThan(0);
		expect(check.indexOf('node "$cpu_launch" entry')).toBeLessThan(check.indexOf('if [ -z "${PI_SEALED:-}" ]'));
		const runner = readFileSync(join(repo, "tests/run-sealed.mjs"), "utf8");
		expect(runner.indexOf("startSealedRun({")).toBeGreaterThan(runner.indexOf('args.includes("--result")'));
		expect(runner.indexOf("enterTestCpu([")).toBeGreaterThan(runner.indexOf("startSealedRun({"));
		expect(runner.indexOf("enterTestCpu([")).toBeLessThan(runner.indexOf("await takeSlot("));
		expect(runner).toContain('runOf(out)?.transport !== "test-cpu"');
	});
});
