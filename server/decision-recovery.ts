// Explicit local-slot recovery. Never a provider cancellation, usage settlement or model call.
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { localDay } from "./decision-records.js";
import { safeCount, validLocalCall, type LocalCall, type Reservation } from "./decision-batch-budget.js";

export const H7 = Object.freeze({
	operation: "H7-R2",
	task: 121,
	chunk: 37,
	at: 1791777858474,
	ids: ["dr-6dcede1b4f3c", "dr-38dd28101190"] as readonly string[],
	day: "2026-10-11",
	tokens: 170198,
	inputUpper: 42198,
	outputUpper: 128000,
	beforeHash: "7afaeb56eb6cebcc9ec1a02343e6bbf21283b474d8448cc313a820a01c30a544",
	planHash: "fc79339c4944d845754933a40e606e0ba6e4e9f87d82e33c6ea40251bf4a343e",
	nativePlanHash: "27c024f845660947812cefd4aa8953307c58b1cdc45cd189de67ecf9f6e94c1a",
	evidenceHash: "892b47c1f6cb8d402462a2284d0d0938ccdb82920d2ebe7607ef3e685209443d",
	approvalId: "dr-10074c065ec3",
	approvalHash: "c9557f5886deed8c0d63ab450190953768ff8e67972a3440c5961c26debe11c1",
	approvalRef: "ask:call_e8681b344ff64de08c9ba6e509f4de31|fc_0ad9c4870243e982016acd1e0d3fb087d2bf5dff2e1d394ec3",
	question: "h7_recovery_121_explicit_consent_r2",
	legacyHead: "9fe5b68cd451cdb3123475408b9898c9efc3ff90",
	legacyInvocation: "d5f3c4d1cfd64aeca32bbb025dbac108",
	legacyPid: 1807981,
	legacyCursor:
		"s=e2ee25b096694b7885dfface12521863;i=838b61;b=aacd6a9988284bc59b382613ba089dfa;m=115d66befa3;t=65d9ccac553bf;x=54de86919dc73a60",
	stoppedUsec: "1791777924421872",
	replacementStartedUsec: "1791777924458674",
});
export const H7_NONCE = `${H7.operation}:${H7.task}:${H7.chunk}:${H7.at}`;
const PLAN_DIR = "/home/shinelay/company-lab/shared/decisions-page-replay-2026-10-10";
const REPO = "/home/shinelay/projects/pi-web-ui";
const loadedScript =
	process.argv[1] && /\/dist\/server\/index\.js$/.test(process.argv[1]) ? resolve(process.argv[1]) : undefined;
const loadedSourceHash = loadedScript ? sha256(readFileSync(loadedScript)) : undefined;
export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
/** Versioned JSON canonical form; reject non-JSON, undefined, non-finite and unsafe numbers. */
export function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	throw new Error("non-canonical recovery metadata");
}
export function localProcess(): Omit<LocalCall, "ref" | "day"> {
	const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
	const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	return {
		invocation: process.env.INVOCATION_ID ?? "foreground",
		pid: process.pid,
		start,
		boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
	};
}
export function newLocalCall(at: number): LocalCall {
	const c = { ...localProcess(), ref: randomUUID(), day: localDay(at) };
	if (!validLocalCall(c)) throw new Error("local process identity unavailable");
	return c;
}
function syncDir(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** No time-based stale lock deletion. A partial, foreign or dead lock fails closed. */
export function withLedgerExclusion<T>(file: string, run: () => T): T {
	const lock = `${file}.lock`;
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		throw new Error("ledger writer exclusion unavailable");
	}
	const owner = `${canonical({ ...localProcess(), nonce: randomUUID() })}\n`;
	const ownerFile = join(lock, "owner.json");
	// If owner persistence fails, retain the incomplete lock rather than guessing ownership.
	const fd = openSync(ownerFile, "wx", 0o600);
	try {
		writeFileSync(fd, owner);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	syncDir(lock);
	syncDir(dirname(file));
	try {
		return run();
	} finally {
		if (readFileSync(ownerFile, "utf8") !== owner) throw new Error("ledger lock ownership changed");
		unlinkSync(ownerFile);
		rmdirSync(lock);
		syncDir(dirname(file));
	}
}
export type PersistStage = "before-file-sync" | "before-rename" | "after-rename" | "after-directory-sync";
/** One atomic image contains accounting AND receipt. No after-hash inside the image. */
export function persistLedger(
	file: string,
	expectedHash: string | undefined,
	value: unknown,
	fault?: (stage: PersistStage) => void,
): string {
	const before = existsSync(file) ? sha256(readFileSync(file)) : undefined;
	if (before !== expectedHash) throw new Error("stale ledger hash");
	const body = `${JSON.stringify(value, null, "\t")}\n`;
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeFileSync(fd, body);
		fault?.("before-file-sync");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fault?.("before-rename");
	if ((existsSync(file) ? sha256(readFileSync(file)) : undefined) !== expectedHash)
		throw new Error("stale ledger hash");
	renameSync(tmp, file);
	fault?.("after-rename");
	syncDir(dirname(file));
	fault?.("after-directory-sync");
	return sha256(body);
}
export interface NativeApproval {
	recordId: string;
	rawHash: string;
	ref: string;
	at: number;
	question: string;
	planHash: string;
	nativePlanHash: string;
	evidenceHash: string;
}
export function validateNativeApproval(
	raw: string,
	scope: Omit<typeof H7, "approvalHash"> & { readonly approvalHash: string } = H7,
): NativeApproval {
	if (sha256(raw) !== scope.approvalHash) throw new Error("native approval hash mismatch");
	const r = JSON.parse(raw);
	const q = r.questions?.[0];
	if (
		r.v !== 1 ||
		r.id !== scope.approvalId ||
		r.source !== "answer" ||
		r.from !== "owner" ||
		r.to !== "ops" ||
		r.how !== "live" ||
		r.ref !== scope.approvalRef ||
		r.answeredIn !== "telegram" ||
		!safeCount(r.at) ||
		r.at <= scope.at ||
		r.questions?.length !== 1 ||
		q?.id !== scope.question ||
		canonical(q.picked) !== canonical(["Approve exact H7 repair"]) ||
		typeof q.detail !== "string" ||
		![scope.planHash, scope.nativePlanHash, scope.evidenceHash, scope.beforeHash, String(scope.at), ...scope.ids].every(
			(pin) => q.detail.includes(pin),
		) ||
		!q.detail.includes("Ops #121") ||
		!q.detail.includes("H7-R2") ||
		!q.detail.includes("unmodified installer health check")
	)
		throw new Error("native operation approval unavailable or mismatched");
	return {
		recordId: r.id,
		rawHash: scope.approvalHash,
		ref: r.ref,
		at: r.at,
		question: q.id,
		planHash: scope.planHash,
		nativePlanHash: scope.nativePlanHash,
		evidenceHash: scope.evidenceHash,
	};
}
function trustedFile(file: string): Buffer {
	const s = lstatSync(file);
	if (!s.isFile() || s.isSymbolicLink() || (process.getuid && s.uid !== process.getuid()))
		throw new Error("trusted native file unavailable");
	return readFileSync(file);
}
/** Caller cannot supply an approval payload, approval policy, plan path or evidence. */
export function nativeH7Approval(dir: string): NativeApproval {
	for (const [file, expected] of [
		["H7-RECOVERY-PLAN.md", H7.planHash],
		["H7-NATIVE-PLAN.json", H7.nativePlanHash],
		["H7-RECOVERY-EVIDENCE.json", H7.evidenceHash],
	])
		if (sha256(trustedFile(join(PLAN_DIR, file))) !== expected) throw new Error("approved version changed");
	const rows = trustedFile(join(dir, "records.jsonl"))
		.toString("utf8")
		.split("\n")
		.filter((row) => row.includes(`"id":"${H7.approvalId}"`));
	if (rows.length !== 1) throw new Error("native approval missing or duplicated");
	return validateNativeApproval(rows[0]);
}
export interface JournalStart {
	at: number;
	pid: number;
	invocation: string;
	cursor: string;
	boot: string;
	monotonic: string;
}
export interface LegacyProof {
	at: number;
	current: Omit<LocalCall, "ref" | "day">;
	oldInvocation: string;
	oldPid: number;
	oldStart: JournalStart;
	oldPidAbsent: boolean;
	duplicates: number[];
	quiescent: boolean;
	complete: boolean;
	gapped: boolean;
	suppressed: boolean;
	starts: JournalStart[];
	terminals: number;
	stoppedUsec: string;
	sequenceHash: string;
	sequenceGaps: number;
	journalHash: string;
	runtimeHash: string;
	legacySourceVerified: boolean;
}
export function verifyLegacyProof(p: LegacyProof, now: number): void {
	const start = p.starts[0];
	if (
		!safeCount(p.at) ||
		p.at > now ||
		now - p.at > 30_000 ||
		!p.complete ||
		p.gapped ||
		p.suppressed ||
		p.sequenceGaps !== 0 ||
		!/^[a-f0-9]{64}$/.test(p.sequenceHash) ||
		!p.quiescent ||
		!p.oldPidAbsent ||
		p.duplicates.length !== 0 ||
		p.oldInvocation !== H7.legacyInvocation ||
		p.oldPid !== H7.legacyPid ||
		p.terminals !== 0 ||
		p.stoppedUsec !== H7.stoppedUsec ||
		!p.legacySourceVerified ||
		p.starts.length !== 1 ||
		start?.at !== H7.at ||
		start.pid !== H7.legacyPid ||
		start.invocation !== H7.legacyInvocation ||
		start.cursor !== H7.legacyCursor ||
		p.oldStart.pid !== H7.legacyPid ||
		p.oldStart.invocation !== H7.legacyInvocation ||
		p.oldStart.at >= H7.at ||
		!/^\d+$/.test(p.oldStart.monotonic) ||
		!/^[a-f0-9-]{36}$/.test(p.oldStart.boot) ||
		p.oldStart.boot !== start.boot ||
		BigInt(p.oldStart.monotonic) >= BigInt(start.monotonic) ||
		p.current.invocation === H7.legacyInvocation ||
		p.current.pid === H7.legacyPid ||
		p.current.boot !== start.boot ||
		!/^[a-f0-9]{32}$/.test(p.current.invocation) ||
		!safeCount(p.current.pid) ||
		p.current.pid < 1 ||
		!/^\d+$/.test(p.current.start) ||
		!/^[a-f0-9]{64}$/.test(p.journalHash) ||
		!/^[a-f0-9]{64}$/.test(p.runtimeHash)
	)
		throw new Error("legacy local-death proof unavailable, stale or ambiguous");
}
export interface RecoveryPayload {
	v: 1;
	operation: "H7-R2";
	nonce: string;
	approval: NativeApproval;
	beforeHash: string;
	beforeGeneration: number;
	chunk: number;
	ids: string[];
	reservationHash: string;
	reservation: Reservation;
	originDay: string;
	unknownTokens: number;
	proof: LegacyProof;
	meaning: "LOCAL_DEATH_ONLY_COST_UNKNOWN";
}
export interface RecoveryReceipt {
	payload: RecoveryPayload;
	hash: string;
}
export function recoveryReceipt(
	approval: NativeApproval,
	proof: LegacyProof,
	reservation: Reservation,
	generation: number,
): RecoveryReceipt {
	const payload: RecoveryPayload = {
		v: 1,
		operation: "H7-R2",
		nonce: H7_NONCE,
		approval,
		beforeHash: H7.beforeHash,
		beforeGeneration: generation,
		chunk: H7.chunk,
		ids: [...H7.ids],
		reservationHash: sha256(canonical(reservation)),
		reservation: structuredClone(reservation),
		originDay: H7.day,
		unknownTokens: H7.tokens,
		proof,
		meaning: "LOCAL_DEATH_ONLY_COST_UNKNOWN",
	};
	return { payload, hash: sha256(canonical(payload)) };
}
export interface RecoveryCommand {
	operation: "H7-R2";
	nonce: string;
	beforeHash: string;
	dryRun: boolean;
}
export function parseRecoveryCommand(value: unknown): RecoveryCommand | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (
		Object.keys(r).sort().join(",") !== "beforeHash,dryRun,nonce,operation" ||
		r.operation !== H7.operation ||
		r.nonce !== H7_NONCE ||
		r.beforeHash !== H7.beforeHash ||
		typeof r.dryRun !== "boolean"
	)
		return undefined;
	return r as unknown as RecoveryCommand;
}
export function isDecisionServiceProcess(args: string[]): boolean {
	return args.some((arg) => /(?:^|\/)(?:dist\/server\/index\.js|server\/index\.(?:ts|js))$/.test(arg));
}

/** Production metadata collector: called INSIDE exclusion, never caller-supplied evidence. */
export function collectLegacyProof(quiescent: boolean): LegacyProof {
	const at = Date.now();
	const current = localProcess();
	const systemd = execFileSync(
		"systemctl",
		["--user", "show", "pi-web-ui.service", "-p", "MainPID", "-p", "InvocationID"],
		{ encoding: "utf8", timeout: 5_000 },
	);
	if (!systemd.includes(`MainPID=${process.pid}\n`) || !systemd.includes(`InvocationID=${current.invocation}\n`))
		throw new Error("current service identity mismatch");
	// Verify journal storage, then retain payload-free rows only. Any suppression is a denial.
	execFileSync("journalctl", ["--user", "--verify", "--quiet"], { timeout: 10_000, stdio: "pipe" });
	const raw = execFileSync(
		"journalctl",
		[
			"--user",
			"-u",
			"pi-web-ui.service",
			"--since",
			"2026-10-11 00:00:00 UTC",
			"--until",
			`@${Math.floor(at / 1000)}`,
			"--no-pager",
			"-o",
			"json",
		],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 * 1024 },
	);
	const rows = raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, string>);
	const old = rows.filter((r) => r._SYSTEMD_INVOCATION_ID === H7.legacyInvocation && Number(r._PID) === H7.legacyPid);
	if (!old.length) throw new Error("legacy invocation startup missing");
	const bootUUID = (hex: string) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
	const meta = (r: Record<string, string>, stamp?: number): JournalStart => ({
		at: stamp ?? Math.floor(Number(r.__REALTIME_TIMESTAMP) / 1000),
		pid: Number(r._PID),
		invocation: r._SYSTEMD_INVOCATION_ID,
		cursor: r.__CURSOR,
		boot: bootUUID(r._BOOT_ID),
		monotonic: r.__MONOTONIC_TIMESTAMP,
	});
	// Unfiltered cursor-only rows prove coverage; no messages/model bodies are requested here.
	const coverageRaw = execFileSync(
		"journalctl",
		[
			"--user",
			"--since",
			`@${Math.floor(Number(old[0].__REALTIME_TIMESTAMP) / 1_000_000) - 1}`,
			"--until",
			`@${Math.floor(at / 1000)}`,
			"--no-pager",
			"-o",
			"json",
			"--output-fields=__CURSOR,__REALTIME_TIMESTAMP,_BOOT_ID",
		],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 * 1024 },
	);
	const coverage = coverageRaw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).__CURSOR as string);
	const streams = new Map<string, bigint[]>();
	for (const cursor of coverage) {
		const match = /^s=([a-f0-9]+);i=([a-f0-9]+);/.exec(cursor);
		if (!match) throw new Error("journal cursor identity unavailable");
		const seq = BigInt(`0x${match[2]}`);
		const group = streams.get(match[1]) ?? [];
		group.push(seq);
		streams.set(match[1], group);
	}
	let sequenceGaps = 0;
	for (const group of streams.values()) {
		group.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		for (let i = 1; i < group.length; i++) if (group[i] !== group[i - 1] + 1n) sequenceGaps++;
	}
	const cursorSet = new Set(coverage);
	const relevant = rows.filter((r) => Number(r.__REALTIME_TIMESTAMP) >= Number(old[0].__REALTIME_TIMESTAMP));
	const starts: JournalStart[] = [];
	let terminals = 0,
		suppressed = false,
		stoppedUsec = "",
		started = false;
	const selected: unknown[] = [];
	for (const row of rows) {
		const time = Number(row.__REALTIME_TIMESTAMP);
		const message = typeof row.MESSAGE === "string" ? row.MESSAGE : "";
		if (time >= H7.at * 1000 && /suppressed|dropped \d+|missed \d+|corrupt|journal.*gap/i.test(message))
			suppressed = true;
		if (row.USER_UNIT === "pi-web-ui.service") {
			if (time === Number(H7.stoppedUsec) && /Stopped pi-web-ui\.service/.test(message))
				stoppedUsec = row.__REALTIME_TIMESTAMP;
			if (time === Number(H7.replacementStartedUsec) && /Started pi-web-ui\.service/.test(message)) started = true;
		}
		const prefix = "[decisions-call] ";
		const index = message.indexOf(prefix);
		if (index < 0) continue;
		const event = JSON.parse(message.slice(index + prefix.length));
		if (!safeCount(event.at) || event.at < H7.at) continue;
		selected.push({ phase: event.phase, ...meta(row, event.at) });
		if (event.phase === "prompt_started") starts.push(meta(row, event.at));
		if (
			row._SYSTEMD_INVOCATION_ID === H7.legacyInvocation &&
			["prompt_settled", "prompt_rejected", "prompt_timeout", "quota_refusal", "disposed"].includes(event.phase)
		)
			terminals++;
	}
	const duplicates: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			if (process.getuid && lstatSync(`/proc/${name}`).uid !== process.getuid()) continue;
			const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
			if (isDecisionServiceProcess(args)) duplicates.push(Number(name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH")
				throw new Error("process census incomplete");
		}
	}
	const evidence = JSON.parse(trustedFile(join(PLAN_DIR, "H7-RECOVERY-EVIDENCE.json")).toString("utf8"));
	let legacySourceVerified = true;
	for (const [path, hash] of Object.entries(evidence.sourceSha256) as [string, string][]) {
		const relative = path.slice(`${REPO}/`.length);
		if (resolve(REPO, relative) !== path || (!relative.startsWith("server/") && !relative.startsWith("tests/unit/")))
			throw new Error("legacy source path mismatch");
		const source = execFileSync("git", ["show", `${H7.legacyHead}:${relative}`], { cwd: REPO, timeout: 5_000 });
		if (sha256(source) !== hash) legacySourceVerified = false;
	}
	if (!loadedScript || !loadedSourceHash) throw new Error("installed source identity unavailable");
	const runtimeHash = sha256(trustedFile(loadedScript));
	if (runtimeHash !== loadedSourceHash) throw new Error("installed source changed after startup");
	return {
		at,
		current,
		oldInvocation: H7.legacyInvocation,
		oldPid: H7.legacyPid,
		oldStart: meta(old[0]),
		oldPidAbsent: !existsSync(`/proc/${H7.legacyPid}`),
		duplicates,
		quiescent,
		complete:
			stoppedUsec === H7.stoppedUsec &&
			started &&
			old.some((r) => Number(r.__REALTIME_TIMESTAMP) < H7.at * 1000) &&
			relevant.every((r) => cursorSet.has(r.__CURSOR)),
		gapped: coverage.length === 0 || sequenceGaps !== 0,
		suppressed,
		starts,
		terminals,
		stoppedUsec,
		sequenceHash: sha256(canonical(coverage)),
		sequenceGaps,
		journalHash: sha256(canonical(selected)),
		runtimeHash,
		legacySourceVerified,
	};
}
