/** Test-only transport for the shared launcher. No policy parser, quota or admission pool here. */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TEST_CPU = "/usr/local/libexec/test-cpu/bin/test-cpu";
export const TEST_CPU_POLICY = "/etc/agent-tools/test-cpu.json";
const tokenPattern = /^[0-9a-f]{32}$/;

function present(path) {
	try {
		lstatSync(path);
		return true;
	} catch (e) {
		if (e.code === "ENOENT") return false;
		throw e;
	}
}

function jsonReply(r) {
	try {
		return JSON.parse(r.stdout);
	} catch {
		throw new Error("test-cpu returned an unreadable receipt");
	}
}
const problem = (r) => (r.stderr || r.error?.message || `exit ${r.status}, signal ${r.signal ?? "none"}`).trim();

/**
 * @typedef {Pick<import('node:child_process').SpawnSyncReturns<string>, 'status'> & Partial<Pick<import('node:child_process').SpawnSyncReturns<string>, 'stdout' | 'stderr' | 'signal' | 'error'>>} CommandReply
 * @typedef {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => CommandReply} InvokeCommand
 */

/**
 * Injection is module-local for fixed test transports, never selected by argv/environment.
 * @param {{invoke?: InvokeCommand, has?: (path: string) => boolean}} [options]
 */
export function testCpuTransport({ invoke = spawnSync, has = present } = {}) {
	const installed = () => {
		if (has(TEST_CPU)) return true;
		if (has(TEST_CPU_POLICY)) throw new Error(`host policy exists but ${TEST_CPU} is missing; restore its install`);
		return false;
	};
	const call = (args, options = {}) => invoke(TEST_CPU, args, { ...options, encoding: "utf8" });
	return {
		/** 0 = inactive/already inside; 3 = re-exec needed. No marker can produce either verdict. */
		entry() {
			if (!installed()) return 0;
			const r = call(["status", "--json"]);
			if (r.status !== 0) throw new Error(`test-cpu status failed: ${problem(r)}`);
			const s = jsonReply(r);
			if (s.mode === "absent" || s.mode === "inactive") return 0;
			if (s.mode === "enabled" && s.decision === "inside") return 0;
			if (s.mode === "enabled" && s.decision === "placed") return 3;
			throw new Error("test-cpu status did not confirm inactive or valid placement");
		},
		start(argv, { cwd, env, log, result }) {
			if (!installed()) return { code: 3 };
			const r = call(["start", "--log", log, "--result", result, "--", ...argv], { cwd, env });
			if (r.status === 3) return { code: 3 };
			if (r.status === 125) return { code: 125, error: problem(r), fallback: true };
			if (r.status !== 0)
				throw new Error(`test-cpu start is ambiguous (${problem(r)}); inspect the saved run before retrying`);
			// A malformed success could have started a job. Never run a duplicate as a fallback.
			const receipt = jsonReply(r);
			if (!tokenPattern.test(receipt.token) || receipt.unit !== `testcpu-job-${receipt.token}.service`)
				throw new Error("test-cpu start returned an invalid owned-token receipt; inspect the launcher before retrying");
			return { code: 0, ...receipt };
		},
		/** Correlate this detached worker, not a new placement decision. Works after policy undo too. */
		identity() {
			try {
				const r = call(["membership", "--json"]);
				const m = jsonReply(r);
				const match = typeof m.cgroup === "string" && /\/(testcpu-job-([0-9a-f]{32})\.service)$/.exec(m.cgroup);
				// Correlation only: an inactive rollback may have removed quota readiness. entry()
				// still independently decides placement; a token never grants permission to run.
				if (![0, 1].includes(r.status) || m.error || !match) return null;
				return { unit: match[1], token: match[2] };
			} catch {
				return null;
			}
		},
		result(token) {
			if (!tokenPattern.test(token)) return { state: "unknown", error: "invalid job token" };
			try {
				const r = call(["result", token]);
				const result = jsonReply(r);
				if (r.status === 1 && result.state === "running") return result;
				if (
					r.status === 0 &&
					result.state === "finished" &&
					Number.isInteger(result.code) &&
					result.code >= 0 &&
					result.code <= 255 &&
					!(result.error && result.code === 0)
				)
					return result;
				return { state: "unknown", error: result.error || `job ${result.state ?? "unreadable"}: ${problem(r)}` };
			} catch (e) {
				return { state: "unknown", error: e.message };
			}
		},
		stop(token, { force = false } = {}) {
			if (!tokenPattern.test(token)) throw new Error("invalid job token");
			const r = call(["stop", token, ...(force ? ["--force"] : [])]);
			if (r.status !== 0) throw new Error(`test-cpu stop failed: ${problem(r)}`);
			return jsonReply(r);
		},
	};
}
export const testCpu = testCpuTransport();

/** Replace the wrapper, so the shared launcher alone owns foreground signal/stdio/exit semantics. */
export function execTestCpu(argv) {
	process.execve(TEST_CPU, [TEST_CPU, "exec", "--", ...argv], process.env);
}

/** Called before heavy work, including after a detach failure. --here never disables placement. */
export function enterTestCpu(argv) {
	if (testCpu.entry() === 3) execTestCpu(argv);
}

function recordRun(out, record) {
	const temp = join(out, `run.${process.pid}.tmp`);
	writeFileSync(temp, JSON.stringify(record));
	renameSync(temp, join(out, "run.json"));
}

/** The worker publishes its identity too: its starter may have died before saving start's reply. */
export function recordDetachedIdentity(out, record, cpu = testCpu) {
	if (record?.transport !== "test-cpu" || record.token) return;
	const identity = cpu.identity();
	if (identity) recordRun(out, { ...record, ...identity });
	else console.error("[sealed] detached token not yet available; the worker's final receipt can recover it");
}

/** Recover only a token, then ask the canonical result API; the copy is never a success verdict. */
export function workerResultToken(out) {
	let fd;
	try {
		fd = openSync(join(out, "cpu-result.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		const max = 64 * 1024;
		if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > max)
			throw new Error("invalid worker result file");
		const bytes = Buffer.alloc(max + 1);
		const n = readSync(fd, bytes, 0, bytes.length, 0);
		if (n > max) throw new Error("oversize worker result file");
		const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)));
		if (record?.v !== 1 || !tokenPattern.test(record.token)) throw new Error("invalid worker result token");
		return { token: record.token };
	} catch (e) {
		return e.code === "ENOENT" ? {} : { error: `worker result recovery failed: ${e.message}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Select only the detached transport. Runner test selection/builds/admission stay in run-sealed.
 * @param {{repo: string, args: string[], out: string, unit: string, runner: string, node?: string, env?: NodeJS.ProcessEnv}} request
 * @param {{cpu?: ReturnType<typeof testCpuTransport>, invoke?: InvokeCommand}} [transport]
 */
export function startSealedRun(
	{ repo, args, out, unit, runner, node = process.execPath, env = process.env },
	{ cpu = testCpu, invoke = spawnSync } = {},
) {
	const log = join(out, "run.log");
	const passOn = join(out, "env.json");
	const record = { repo, args, unit, externalLog: true, at: new Date().toISOString() };
	const argv = [node, runner, ...args.filter((a) => !a.startsWith("--out=")), "--here", `--out=${out}`];
	// Never recover an earlier use of this output folder as this dispatch's terminal receipt.
	for (const name of ["cpu-result.json", "pid", "exit"]) rmSync(join(out, name), { force: true });
	// The worker can start before start() returns: mark externally logged output before dispatch.
	recordRun(out, { ...record, transport: "test-cpu" });
	const started = cpu.start(argv, { cwd: repo, env, log, result: join(out, "cpu-result.json") });
	if (started.code === 0) {
		recordRun(out, { ...record, transport: "test-cpu", unit: started.unit, token: started.token });
		return { code: 0, unit: started.unit, stop: `${TEST_CPU} stop ${started.token}` };
	}
	let failure = started.error;
	if (started.code === 3) {
		// Inactive only: retain the old restart-independent user-manager launch and exact environment.
		recordRun(out, record);
		writeFileSync(passOn, JSON.stringify(env), { mode: 0o600 });
		const r = invoke(
			"systemd-run",
			[
				"--user",
				"--quiet",
				"--collect",
				`--unit=${unit}`,
				`--description=sealed tests of ${repo}`,
				`--working-directory=${repo}`,
				`--property=StandardOutput=append:${log}`,
				`--property=StandardError=append:${log}`,
				`--setenv=PI_SEALED_ENV_FILE=${passOn}`,
				...argv,
			],
			{ encoding: "utf8" },
		);
		if (r.status === 0) return { code: 0, unit, stop: `systemctl --user stop ${unit}` };
		// A killed/failed client might have started the service. Leave its handoff for that child.
		// ENOENT is a confirmed no-dispatch outcome; an ordinary nonzero exit is a manager refusal.
		if (r.signal || (r.status === null && r.error?.code !== "ENOENT"))
			throw new Error(`legacy start is ambiguous (${problem(r)}); inspect the saved run before retrying`);
		failure = problem(r);
	}
	rmSync(passOn, { force: true });
	rmSync(join(out, "run.json"), { force: true });
	return { code: 125, error: failure, fallback: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [command, separator, ...argv] = process.argv.slice(2);
		if (command === "entry") process.exitCode = testCpu.entry();
		else if (command === "exec" && separator === "--" && argv.length) execTestCpu(argv);
		else throw new Error("use entry, or exec -- <command…>");
	} catch (e) {
		console.error(`[sealed] CPU entry failed: ${e.message}; no test started`);
		process.exitCode = 125;
	}
}
