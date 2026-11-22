// ---------------------------------------------------------------------------
// proof-check-messages.ts — a QA message claiming a pass goes out only with a proof proof-check allows (Ops #1073)
// ---------------------------------------------------------------------------
// The one host-side check for both send paths a QA chat has: message_role (role-message-tool.ts) and
// telegram_send (plugin-tool-definition.ts pluginToolToDefinition). The judge is agent-tools' `proof-check --message`
// (contract: agent-tools docs/proof-check-messages.md, QA #222); this file never reads a claim itself. Only the
// sender role QA_ROLE, as the server knows the chat, is judged; every other role's text passes untouched and the
// tool never runs for it. No flag, tag, setting or environment switch skips it. docs/proof-check-qa-messages.md.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

/** The role whose messages are judged (owner Shine, "Top 4", Board bp-52e3bfe7 item 2). */
export const QA_ROLE = "qa";
export const PROOF_CHECK_TIMEOUT_MS = 30_000;
/** At most one "the tool can't run" notice to Ops per this long. */
export const PROOF_CHECK_NOTICE_GAP_MS = 30 * 60_000;
export const PROOF_CHECK_NUMBERS_FILE = "proof-check-messages.jsonl";
const TOOL = "proof-check";
const FINDINGS_SHOWN = 12;

export type ProofCheckSurface = "message_role" | "telegram_send";
/** ok: send this text (maybe with the stamp appended); else not sent, and why with the next step. */
export type ProofCheckResult = { ok: true; text: string } | { ok: false; error: string };

export interface ProofCheckGateOptions {
	/** The numbers file (one JSON line per judged send, 0600). */
	logFile: string;
	/** One notice to Ops's home chat (never holds the message text). */
	tellOps(text: string): void;
	log?(line: string): void;
	timeoutMs?: number;
	now?(): number;
}

export interface ProofCheckSend {
	text: string;
	surface: ProofCheckSurface;
	/** The sending chat's id (its session id; never a path). */
	chat: string;
	/** The surface's text limit, the stamp counted inside it (message_role: 4,000). */
	maxChars?: number;
}

interface Finding {
	line: number | null;
	message: string;
	next: string;
}
interface Answer {
	exit: 0 | 1 | 2;
	status: string;
	stamp: string | null;
	claimedVerdict: string | null;
	counts: Record<(typeof COUNT_KEYS)[number], number>;
	sendAllowed: boolean;
	findings: (Finding & { rule: string })[];
}
const COUNT_KEYS = ["pass_claim_lines", "proof_lines", "proofs_allowed", "proofs_refused"] as const;
type Run = { ok: true; answer: Answer; bin: string } | { ok: false; why: string; bin?: string };

/** The sending chat's id for the numbers: a session file's base name without .jsonl, else the given id. */
export function proofCheckChatId(file: string | undefined, fallback = ""): string {
	return file ? basename(file).replace(/\.jsonl$/u, "") : fallback;
}

/** The tool: the first executable proof-check on the server's PATH, else ~/.local/bin/proof-check. */
export function proofCheckBinary(): string | undefined {
	const candidates = [
		...(process.env.PATH ?? "")
			.split(delimiter)
			.filter((d) => d.startsWith("/"))
			.map((d) => join(d, TOOL)),
		join(homedir(), ".local", "bin", TOOL),
	];
	for (const c of candidates) {
		try {
			accessSync(c, constants.X_OK);
			return c;
		} catch {
			// not here
		}
	}
	return undefined;
}

export class ProofCheckGate {
	private lastNoticeAt: number | undefined;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(private readonly opts: ProofCheckGateOptions) {
		this.timeoutMs = opts.timeoutMs ?? PROOF_CHECK_TIMEOUT_MS;
		this.now = opts.now ?? Date.now;
	}

	/** Judge one QA send: the text to send, or why not. Never throws. */
	async judge(send: ProofCheckSend): Promise<ProofCheckResult> {
		const started = this.now();
		const run = await this.run(send.text);
		const ms = this.now() - started;
		if (!run.ok) {
			const told = this.tellOps(run.why, run.bin);
			this.keep(send, ms, { exit: null, status: "tool_failed", outcome: "held", why: run.why });
			return {
				ok: false,
				error: `Not sent: the tool could not run (proof-check: ${run.why}), and a QA message is held until it can. ${told} Nothing went out; send it again once the tool works, and meanwhile use the Board or the owner's chat.`,
			};
		}
		const a = run.answer;
		if (a.exit !== 0) {
			this.keep(send, ms, { answer: a, outcome: "refused" });
			return { ok: false, error: refusalText(a) };
		}
		if (!a.stamp) {
			this.keep(send, ms, { answer: a, outcome: "sent" });
			return { ok: true, text: send.text };
		}
		const text = `${send.text}${send.text.endsWith("\n") ? "" : "\n"}${a.stamp}`;
		if (send.maxChars !== undefined && text.length > send.maxChars) {
			this.keep(send, ms, { answer: a, outcome: "too_long" });
			const cut = text.length - send.maxChars;
			return {
				ok: false,
				error: `Not sent: proof-check allowed it, but with its stamp line added the message is ${text.length} characters; the most is ${send.maxChars}, so shorten it by ${cut} characters and send it again.`,
			};
		}
		this.keep(send, ms, { answer: a, outcome: "sent" });
		return { ok: true, text };
	}

	/** The start-up line: whether `proof-check --message` works here. */
	async probe(): Promise<string> {
		const run = await this.run("start-up check\n");
		const line = run.ok
			? `[proof-check] proof-check --message works (${run.bin}): a QA message that claims a pass is sent only with a proof it allows`
			: `[proof-check] proof-check --message does NOT work (${run.why}): QA's messages are held until it does, and Ops is told with the first one`;
		this.opts.log?.(line);
		return line;
	}

	private run(text: string): Promise<Run> {
		const bin = proofCheckBinary();
		if (!bin) return Promise.resolve({ ok: false, why: "proof-check isn't on the server's PATH or at ~/.local/bin" });
		let dir: string;
		try {
			dir = mkdtempSync(join(tmpdir(), "proof-check-msg-"));
			writeFileSync(join(dir, "message.txt"), text, { mode: 0o600 });
		} catch (err) {
			return Promise.resolve({ ok: false, why: `couldn't write the temp file: ${(err as Error).message}`, bin });
		}
		const file = join(dir, "message.txt");
		return new Promise<Run>((resolve) => {
			execFile(
				bin,
				["--message", file, "--json"],
				{ timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", shell: false },
				(err, stdout) => {
					rmSync(dir, { recursive: true, force: true });
					const code = err ? (err as { code?: unknown }).code : 0;
					if (err && (err as { killed?: boolean }).killed)
						return resolve({ ok: false, why: `no answer in ${Math.round(this.timeoutMs / 1000)} s`, bin });
					if (typeof code !== "number") return resolve({ ok: false, why: `it didn't run (${String(code)})`, bin });
					if (code !== 0 && code !== 1 && code !== 2) return resolve({ ok: false, why: `exit ${code}`, bin });
					const answer = readAnswer(stdout, code);
					resolve(
						answer ? { ok: true, answer, bin } : { ok: false, why: `an answer it can't read (exit ${code})`, bin },
					);
				},
			);
		});
	}

	/** The Ops notice, at most once per PROOF_CHECK_NOTICE_GAP_MS; the sentence for the refusal. */
	private tellOps(why: string, bin: string | undefined): string {
		const now = this.now();
		if (this.lastNoticeAt !== undefined && now - this.lastNoticeAt < PROOF_CHECK_NOTICE_GAP_MS)
			return "Ops was already told.";
		this.lastNoticeAt = now;
		try {
			this.opts.tellOps(
				`proof-check gate: a QA message was held because \`proof-check --message\` can't run (${why}; tool: ${bin ?? "not found"}). Every QA message is held until it works (pi-web-ui docs/proof-check-qa-messages.md). Check: \`proof-check --message <file> --json\` from the server's PATH, then \`pi-web-deploy restart\` if the PATH changed. At most one such notice per 30 minutes.`,
			);
		} catch (err) {
			this.opts.log?.(`[proof-check] couldn't tell Ops: ${(err as Error).message}`);
		}
		return "Ops has been told.";
	}

	private keep(
		send: ProofCheckSend,
		ms: number,
		r: { answer?: Answer; exit?: null; status?: string; outcome: string; why?: string },
	): void {
		const a = r.answer;
		const row = {
			at: new Date(this.now()).toISOString(),
			surface: send.surface,
			chat: send.chat,
			exit: a ? a.exit : null,
			status: a ? a.status : r.status,
			outcome: r.outcome,
			claimed_verdict: a ? a.claimedVerdict : null,
			proofs_named: a ? a.counts.proof_lines : null,
			...(a ? a.counts : {}),
			send_allowed: a ? a.sendAllowed : false,
			ms,
			...(r.why ? { why: r.why } : {}),
		};
		try {
			mkdirSync(dirname(this.opts.logFile), { recursive: true });
			appendFileSync(this.opts.logFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		} catch (err) {
			this.opts.log?.(`[proof-check] couldn't keep the numbers line: ${(err as Error).message}`);
		}
	}
}

/** The tool's --json answer in message mode, or undefined when it isn't one (an old tool, garbage, a mismatch). */
function readAnswer(stdout: string, code: 0 | 1 | 2): Answer | undefined {
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (!o || o.tool !== TOOL || o.mode !== "message" || o.exit_code !== code || typeof o.status !== "string")
		return undefined;
	const stamp = o.stamp;
	if (stamp !== null && stamp !== undefined && (typeof stamp !== "string" || /[\r\n]/u.test(stamp))) return undefined;
	if (code === 0 && o.send_allowed !== true) return undefined;
	const counts = {} as Answer["counts"];
	for (const k of COUNT_KEYS) counts[k] = typeof o[k] === "number" ? (o[k] as number) : 0;
	const findings: Answer["findings"] = [];
	for (const check of Array.isArray(o.checks) ? (o.checks as Record<string, unknown>[]) : []) {
		for (const f of Array.isArray(check?.findings) ? (check.findings as Record<string, unknown>[]) : []) {
			findings.push({
				rule: String(check.id ?? "?"),
				line: typeof f?.line === "number" ? f.line : null,
				message: String(f?.message ?? ""),
				next: String(f?.next ?? ""),
			});
		}
	}
	return {
		exit: code,
		status: o.status,
		stamp: typeof stamp === "string" && stamp ? stamp : null,
		claimedVerdict: typeof o.claimed_verdict === "string" ? o.claimed_verdict : null,
		counts,
		sendAllowed: o.send_allowed === true,
		findings,
	};
}

function refusalText(a: Answer): string {
	const head = `Not sent: proof-check ${a.exit === 1 ? "refused" : "couldn't judge"} this QA message (exit ${a.exit}${a.claimedVerdict ? `, claimed ${a.claimedVerdict}` : ""}, proofs named ${a.counts.proof_lines}).`;
	const lines = a.findings
		.slice(0, FINDINGS_SHOWN)
		.map(
			(f) =>
				`- ${f.rule} ${f.line === null ? "message" : `line ${f.line}`}: ${f.message}${f.next ? ` Next: ${f.next}` : ""}`,
		);
	if (a.findings.length > FINDINGS_SHOWN) lines.push(`- and ${a.findings.length - FINDINGS_SHOWN} more`);
	return [
		head,
		...lines,
		"A QA pass goes out only with its own line `proof: <absolute path>` naming a proof that proof-check allows (agent-tools docs/proof-check-messages.md). Fix the proof or the claim, or reword a line that isn't your verdict, then send it again. Don't type a `proof-check:` line: the app adds the stamp.",
	].join("\n");
}

/** Both send paths call this: a QA sender's text is judged (no gate wired: held), any other role's passes as is. */
export async function proofCheckOutgoing(
	gate: ProofCheckGate | undefined,
	role: string | undefined,
	send: ProofCheckSend,
): Promise<ProofCheckResult> {
	if (role !== QA_ROLE) return { ok: true, text: send.text };
	if (!gate)
		return {
			ok: false,
			error:
				"Not sent: the proof-check gate for QA's messages isn't running in this app, so QA's messages are held. Tell Ops.",
		};
	return gate.judge(send);
}
