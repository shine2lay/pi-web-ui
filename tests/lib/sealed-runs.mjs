/**
 * sealed-runs.mjs (queue-side-by-side): what tests/run-sealed.mjs needs so a long suite started from a
 * chat survives a pi-web-ui restart, and so the queue's side-by-side chats don't all run suites at once.
 *
 *  - inService(): whether this process runs inside pi-web-ui's service. A chat's bash does, and a
 *    restart stops everything in the service, so the runner starts itself again outside it
 *    (systemd-run --user) and follows its output from there.
 *  - takeSlot(): at most 2 suites run at once (PI_SEALED_MAX_SUITES); the next one waits its turn.
 *  - findRun() / follow(): a run's output and result, read from its folder, also after the command
 *    that started it was cut off (`node tests/run-sealed.mjs --result`).
 *
 * A run's folder (<out>) holds run.json ({ repo, args, unit, at }), pid (the runner's), run.log (its
 * output), exit (its exit code, written when it ends), summary.json and one log per script.
 */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** The service whose restart would stop a run started inside it. */
export const SERVICE = process.env.PI_SEALED_SERVICE || "pi-web-ui.service";

/** Where runs keep their folders (and the slots): <tmp>/pi-sealed-runs. */
export const runsBase = () => join(tmpdir(), "pi-sealed-runs");

/** How many suites may run at once. */
export const maxSuites = () => Math.max(1, Math.floor(Number(process.env.PI_SEALED_MAX_SUITES)) || 2);

/** Where the slots are. */
export const slotsDir = () => process.env.PI_SEALED_SLOTS_DIR || join(runsBase(), "slots");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether a /proc/<pid>/cgroup text puts the process inside `service` (or a cgroup below it). */
export function inServiceCgroup(text, service = SERVICE) {
	return String(text)
		.split("\n")
		.some((line) => line.split(":").slice(2).join(":").split("/").includes(service));
}

/** Whether this process runs inside pi-web-ui's service (a chat's bash does). */
export function inService(service = SERVICE) {
	try {
		return inServiceCgroup(readFileSync("/proc/self/cgroup", "utf8"), service);
	} catch {
		return false;
	}
}

/** Whether a process is still there. */
export function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM";
	}
}

/** Whether a systemd user unit is still starting or running. */
export function unitIsActive(unit) {
	if (!unit) return false;
	const r = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" });
	return /^(active|activating|reloading|deactivating)\b/.test((r.stdout ?? "").trim());
}

const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** A slot's file whose holder is gone: its runner died (or it was never finished writing, long ago). */
function staleSlot(file, alive, now) {
	const owner = readJson(file);
	if (owner && typeof owner === "object") return !alive(owner.pid);
	try {
		return now() - statSync(file).mtimeMs > 30_000;
	} catch {
		return true;
	}
}

/** Who holds the slots, for the waiting line: "<repo> since <time>". */
export function slotHolders(dir, max) {
	const out = [];
	for (let i = 0; i < max; i++) {
		const o = readJson(join(dir, `slot-${i}`));
		if (o) out.push(`${o.repo ?? "?"} since ${String(o.at ?? "?").slice(11, 16)} UTC`);
	}
	return out;
}

/**
 * Take one of `max` slots (files slot-0 … slot-<max-1> in `dir`, each created exclusively): at most
 * `max` suites run at once. A slot whose runner is gone is freed. While every slot is taken, it says so
 * once and tries again every `everyMs`. Returns a function that frees the slot (only its own).
 */
export async function takeSlot({
	dir = slotsDir(),
	max = maxSuites(),
	owner,
	log = console.log,
	sleep = defaultSleep,
	everyMs = 5000,
	alive = isAlive,
	now = Date.now,
}) {
	mkdirSync(dir, { recursive: true });
	let said = false;
	for (;;) {
		for (let i = 0; i < max; i++) {
			const file = join(dir, `slot-${i}`);
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					writeFileSync(file, JSON.stringify(owner), { flag: "wx" });
				} catch (e) {
					if (e?.code !== "EEXIST") throw e;
					if (attempt === 0 && staleSlot(file, alive, now)) {
						try {
							unlinkSync(file);
						} catch {
							/* someone else freed it */
						}
						continue;
					}
					break;
				}
				let freed = false;
				return () => {
					if (freed) return;
					freed = true;
					if (readJson(file)?.pid === owner.pid) {
						try {
							unlinkSync(file);
						} catch {
							/* gone already */
						}
					}
				};
			}
		}
		if (!said) {
			said = true;
			log(
				`waiting for a free slot: ${max} sealed suites are running (${slotHolders(dir, max).join("; ") || "starting"}); ` +
					"this one starts when one of them ends",
			);
		}
		await sleep(everyMs);
	}
}

/** A run's run.json, or undefined. */
export const runOf = (dir) => readJson(join(dir, "run.json"));

/** A run's exit code once it has ended, else undefined. */
export function exitOf(dir) {
	try {
		const text = readFileSync(join(dir, "exit"), "utf8").trim();
		return text === "" || !Number.isFinite(Number(text)) ? undefined : Number(text);
	} catch {
		return undefined;
	}
}

/** A run's runner (its pid), once it has started. */
export function pidOf(dir) {
	try {
		const n = Number(readFileSync(join(dir, "pid"), "utf8").trim());
		return Number.isInteger(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

/** The newest run of `repo` (by when it started) in `base`: { dir, run }, or undefined. */
export function findRun(base, repo) {
	let best;
	let names = [];
	try {
		names = readdirSync(base);
	} catch {
		return undefined;
	}
	for (const name of names) {
		const dir = join(base, name);
		const run = runOf(dir);
		if (!run || run.repo !== repo || typeof run.at !== "string") continue;
		if (!best || run.at > best.run.at) best = { dir, run };
	}
	return best;
}

/**
 * Show a run's output (run.log, from byte `from` on) as it grows, until it ends; then give its exit
 * code. A run that stopped without ending (its runner gone and no exit file; or, before its runner
 * started, its unit gone) gives 1 and says so, after `graceLooks` more looks (it may have just ended
 * between two looks, or not quite started).
 */
export async function follow(
	dir,
	{
		write = (s) => {
			process.stdout.write(s);
		},
		sleep = defaultSleep,
		everyMs = 1000,
		alive = isAlive,
		unitActive = unitIsActive,
		from = 0,
		graceLooks = 2,
	} = {},
) {
	const logFile = join(dir, "run.log");
	let offset = from;
	// A read can end inside a character the runner is still writing: keep its first bytes for the next one.
	const text = new StringDecoder("utf8");
	const drain = () => {
		let size = 0;
		try {
			size = statSync(logFile).size;
		} catch {
			return;
		}
		if (size <= offset) return;
		const fd = openSync(logFile, "r");
		try {
			const buf = Buffer.alloc(size - offset);
			const n = readSync(fd, buf, 0, buf.length, offset);
			offset += n;
			const s = text.write(buf.subarray(0, n));
			if (s) write(s);
		} finally {
			closeSync(fd);
		}
	};
	let quiet = 0;
	for (;;) {
		drain();
		const code = exitOf(dir);
		if (code !== undefined) {
			drain();
			return code;
		}
		const pid = pidOf(dir);
		const going = pid !== undefined ? alive(pid) : unitActive(runOf(dir)?.unit);
		if (going) quiet = 0;
		else if (++quiet > graceLooks) {
			write(
				`\n✗ the run stopped without finishing (it was stopped or killed before it could write its result); ` +
					`what it wrote is above, its logs are in ${dir}\n`,
			);
			return 1;
		}
		await sleep(everyMs);
	}
}
