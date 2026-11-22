// proof-check on QA's messages (Ops #1073, docs/proof-check-qa-messages.md): a QA message_role or telegram_send
// that claims a pass goes out only when `proof-check --message` allows it. The tool here is an external stand-in
// on a temp PATH (its mode file picks the answer; it records each call), plus the real tool on QA's fixtures
// when `proof-check --message` works (skipped, with the reason, until Ops #1072 is installed).
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pluginToolToDefinition } from "../../server/plugin-tool-definition.js";
import type { PluginAgentTool, PluginToolCallerContext } from "../../server/plugins.js";
import { ProofCheckGate } from "../../server/proof-check-messages.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import type { RoleMessages, RoleMessageSender } from "../../server/role-messages.js";

const STAMP =
	"proof-check: PASS allowed | /tmp/qa/PROOF-TABLE.md | sha256 759af49f7e9f | items 2, without live evidence 0, not exercised 0";

/** The stand-in tool: answers as its mode file says and appends each call to calls.jsonl. */
const STANDIN = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const args = process.argv.slice(2);
const file = args[1];
let st = null;
try { st = fs.statSync(file); } catch {}
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, file, fileMode: st ? st.mode & 0o777 : null, text: st ? fs.readFileSync(file, "utf8") : null }) + "\\n");
const base = { tool: "proof-check", version: 1, mode: "message", target: file, pass_claim_lines: 0, proof_lines: 0, proofs_allowed: 0, proofs_refused: 0, claimed_verdict: null, send_allowed: true, stamp: null, proofs: [], checks: [] };
const out = (o, code) => { process.stdout.write(JSON.stringify(o, null, 2) + "\\n"); process.exit(code); };
if (mode === "stamp") out({ ...base, exit_code: 0, status: "allowed", pass_claim_lines: 1, proof_lines: 1, proofs_allowed: 1, claimed_verdict: "PASS", stamp: ${JSON.stringify(STAMP)}, proofs: [{ line: 3, path: "/tmp/qa/PROOF-TABLE.md", allowed: true }] }, 0);
if (mode === "noclaim") out({ ...base, exit_code: 0, status: "allowed" }, 0);
if (mode === "refuse") out({ ...base, exit_code: 1, status: "refused", pass_claim_lines: 1, claimed_verdict: "PASS", send_allowed: false, checks: [
  { id: "MSG-PASS-CLAIM", count: 1, blocks: false, findings: [{ file, line: 2, message: "pass claim: PASS", next: "Name the proof on its own line." }] },
  { id: "MSG-PROOF-LINE", count: 0, blocks: true, findings: [{ file, line: null, message: "a pass claim needs a line proof: <absolute path>", next: "Add proof: <absolute path of the proof table>." }] },
] }, 1);
if (mode === "cannot") out({ ...base, exit_code: 2, status: "cannot_judge", pass_claim_lines: 1, proof_lines: 1, proofs_refused: 1, claimed_verdict: "PASS", send_allowed: false, error: "proof missing", checks: [
  { id: "MSG-PROOF-ALLOWED", count: 1, blocks: true, findings: [{ file, line: 3, message: "the proof /tmp/qa/none.md does not exist", next: "Point the proof line at the proof file." }] },
] }, 2);
if (mode === "garbage") { process.stdout.write("this is not json\\n"); process.exit(0); }
if (mode === "oldtool") out({ tool: "proof-check", version: 1, exit_code: 2, status: "cannot_judge", error: "Unknown flag --message" }, 2);
if (mode === "exit3") process.exit(3);
if (mode === "slow") setTimeout(() => out({ ...base, exit_code: 0, status: "allowed" }, 0), 60000);
`;

let root = "";
let bin = "";
let home = "";
let empty = "";
let logFile = "";
let notices: string[] = [];
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };

function setMode(mode: string): void {
	writeFileSync(join(bin, "mode"), mode);
}
function calls(): { args: string[]; file: string; fileMode: number | null; text: string | null }[] {
	const f = join(bin, "calls.jsonl");
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}
function numbers(): Record<string, unknown>[] {
	if (!existsSync(logFile)) return [];
	return readFileSync(logFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}
function gate(timeoutMs?: number): ProofCheckGate {
	return new ProofCheckGate({
		logFile,
		tellOps: (text) => notices.push(text),
		log: () => {},
		...(timeoutMs ? { timeoutMs } : {}),
	});
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pc-qa-msg-"));
	bin = join(root, "bin");
	home = join(root, "home");
	empty = join(root, "empty");
	for (const d of [bin, home, empty]) mkdirSync(d);
	writeFileSync(join(bin, "proof-check"), STANDIN);
	chmodSync(join(bin, "proof-check"), 0o755);
	process.env.HOME = home;
});
afterAll(() => {
	process.env.PATH = saved.PATH;
	process.env.HOME = saved.HOME;
	rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
	rmSync(join(bin, "calls.jsonl"), { force: true });
	logFile = join(root, `numbers-${Math.random().toString(36).slice(2)}.jsonl`);
	notices = [];
	setMode("noclaim");
});

// --- message_role -------------------------------------------------------------------------------------------

function qaSender(over: Partial<RoleMessageSender> = {}): RoleMessageSender {
	return { role: "qa", title: "QA", file: "/sessions/qa-home-chat.jsonl", chat: "home chat", handling: 0, ...over };
}
function fakeService() {
	const sent: { sender: RoleMessageSender; input: Record<string, unknown> }[] = [];
	const refused: string[] = [];
	const service = {
		send: (sender: RoleMessageSender, input: Record<string, unknown>) => {
			sent.push({ sender, input });
			return {
				ok: true,
				record: { id: "rm-0000test", kind: input.kind, to: { role: input.to }, text: input.text, chain: 1 },
				targetChat: "its home chat",
				paused: false,
			};
		},
		noteRefused: (_s: unknown, _t: unknown, _k: unknown, why: string) => refused.push(why),
		sameTextRecipients: () => [],
	};
	return { service: service as unknown as RoleMessages, sent, refused };
}
async function messageRole(
	params: Record<string, unknown>,
	opts: { sender?: RoleMessageSender; gate?: ProofCheckGate } = {},
): Promise<{ ok: boolean; text: string; sent: { input: Record<string, unknown> }[] }> {
	const svc = fakeService();
	const g = opts.gate ?? gate();
	const tool = makeMessageRoleTool({
		service: () => svc.service,
		sender: () => opts.sender ?? qaSender(),
		proofCheck: () => g,
	});
	const run = tool.execute as unknown as (
		id: string,
		p: Record<string, unknown>,
	) => Promise<{ content: { text: string }[] }>;
	try {
		const r = await run("call-1", params);
		return { ok: true, text: r.content[0].text, sent: svc.sent };
	} catch (err) {
		return { ok: false, text: (err as Error).message, sent: svc.sent };
	}
}
const PASS_TEXT = "qa #219 Follow mid rows\nSIGNED OFF: Rule 33: PASS";

describe("message_role from a QA chat (Ops #1073)", () => {
	it("(a) exit 1: not sent, the tool's findings and next steps shown, no Ops notice", async () => {
		setMode("refuse");
		const r = await messageRole({ to: "backend", kind: "fyi", text: PASS_TEXT });
		expect(r.ok).toBe(false);
		expect(r.sent).toHaveLength(0);
		expect(r.text).toContain("Not sent");
		expect(r.text).toContain("MSG-PROOF-LINE");
		expect(r.text).toContain("Add proof: <absolute path of the proof table>.");
		expect(r.text).toContain("line 2");
		// QA rm-848cfb08: a refusal says refused, never that the tool could not run
		expect(r.text).toContain("refused");
		expect(r.text).not.toContain("could not run");
		expect(notices).toHaveLength(0);
		expect(calls()).toHaveLength(1);
	});

	it("(a) exit 2: not sent, with the finding", async () => {
		setMode("cannot");
		const r = await messageRole({ to: "backend", kind: "reply", replyTo: "rm-11112222", text: PASS_TEXT });
		expect(r.ok).toBe(false);
		expect(r.sent).toHaveLength(0);
		expect(r.text).toContain("Not sent");
		expect(r.text).toContain("does not exist");
		expect(notices).toHaveLength(0);
	});

	it("(a) tool missing: held, Ops told once; a second failure within 30 minutes tells nobody", async () => {
		process.env.PATH = empty; // no proof-check on PATH, none at ~/.local/bin in the temp HOME
		const g = gate();
		const one = await messageRole({ to: "backend", kind: "fyi", text: PASS_TEXT }, { gate: g });
		const two = await messageRole({ to: "rollcall", kind: "fyi", text: "no claim at all" }, { gate: g });
		for (const r of [one, two]) {
			expect(r.ok).toBe(false);
			expect(r.sent).toHaveLength(0);
			expect(r.text).toContain("Ops");
			// QA rm-848cfb08: "the tool could not run", never "refused"
			expect(r.text).toContain("the tool could not run");
			expect(r.text).not.toMatch(/refused/i);
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("proof-check");
		expect(notices[0]).not.toContain(PASS_TEXT);
		expect(notices[0]).not.toContain("SIGNED OFF");
	});

	it("(a) tool found at ~/.local/bin when not on PATH", async () => {
		process.env.PATH = empty;
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(
			join(home, ".local", "bin", "proof-check"),
			STANDIN.replace("const dir = __dirname;", `const dir = ${JSON.stringify(bin)};`),
		);
		chmodSync(join(home, ".local", "bin", "proof-check"), 0o755);
		try {
			setMode("stamp");
			const r = await messageRole({ to: "backend", kind: "fyi", text: PASS_TEXT });
			expect(r.ok).toBe(true);
			expect(calls()).toHaveLength(1);
		} finally {
			rmSync(join(home, ".local"), { recursive: true, force: true });
		}
	});

	it("(a) timeout, garbage, an old tool without --message, another exit code: each held with Ops told", async () => {
		for (const mode of ["slow", "garbage", "oldtool", "exit3"]) {
			setMode(mode);
			notices = [];
			const r = await messageRole({ to: "backend", kind: "fyi", text: PASS_TEXT }, { gate: gate(3000) });
			expect(r.ok, mode).toBe(false);
			expect(r.sent, mode).toHaveLength(0);
			expect(r.text, mode).toContain("Ops");
			expect(r.text, mode).toContain("the tool could not run");
			expect(r.text, mode).not.toMatch(/refused/i);
			expect(notices, mode).toHaveLength(1);
		}
	}, 30_000);

	it("(b) exit 0 with a stamp: sent, the stamp is the last line", async () => {
		setMode("stamp");
		const r = await messageRole({ to: "backend", kind: "fyi", text: PASS_TEXT });
		expect(r.ok).toBe(true);
		expect(r.sent).toHaveLength(1);
		const text = String(r.sent[0].input.text);
		expect(text).toBe(`${PASS_TEXT}\n${STAMP}`);
		expect(text.split("\n").at(-1)).toBe(STAMP);
		expect(calls()[0].text).toBe(PASS_TEXT); // the tool judged the text as typed
	});

	it("(b) exit 0 without a claim: sent unchanged", async () => {
		setMode("noclaim");
		const r = await messageRole({ to: "backend", kind: "question", text: "Which port does staging use?" });
		expect(r.ok).toBe(true);
		expect(r.sent[0].input.text).toBe("Which port does staging use?");
	});

	it("(c) text + stamp over 4,000 characters: refused with the number to cut", async () => {
		setMode("stamp");
		const text = `${PASS_TEXT}\n${"x".repeat(4000 - PASS_TEXT.length - 1)}`; // exactly 4,000
		expect(text.length).toBe(4000);
		const r = await messageRole({ to: "backend", kind: "fyi", text });
		expect(r.ok).toBe(false);
		expect(r.sent).toHaveLength(0);
		expect(r.text).toContain(`shorten it by ${STAMP.length + 1} characters`);
		const fits = text.slice(0, 4000 - STAMP.length - 1);
		const ok = await messageRole({ to: "backend", kind: "fyi", text: fits });
		expect(ok.ok).toBe(true);
		expect(String(ok.sent[0].input.text).length).toBe(4000);
	});

	it("(d) another role with the same text: sent as typed, the tool never runs", async () => {
		setMode("refuse");
		for (const role of ["ops", "backend", "coo", "rollcall"]) {
			const r = await messageRole({ to: "qa", kind: "fyi", text: PASS_TEXT }, { sender: qaSender({ role }) });
			expect(r.ok, role).toBe(true);
			expect(r.sent[0].input.text, role).toBe(PASS_TEXT);
		}
		expect(calls()).toHaveLength(0);
		expect(numbers()).toHaveLength(0);
	});

	it("(f) every kind, from a QA task chat too, is judged; an approval call is not", async () => {
		setMode("refuse");
		const task = qaSender({
			file: "/sessions/qa-task-222.jsonl",
			chat: "Queue #222",
			guard: {
				bindingId: "/sessions/qa-task-222.jsonl",
				isHome: false,
				task: { queueId: "q", taskId: 222 },
				lastUserText: "",
			},
		});
		for (const kind of ["question", "request", "fyi", "reply"]) {
			const r = await messageRole(
				{
					to: "backend",
					kind,
					text: PASS_TEXT,
					tags: ["any-tag"],
					...(kind === "reply" ? { replyTo: "rm-11112222" } : {}),
				},
				{ sender: task },
			);
			expect(r.ok, kind).toBe(false);
			expect(r.sent, kind).toHaveLength(0);
		}
		expect(calls()).toHaveLength(4);
		const before = calls().length;
		const approval = await messageRole({ approval: { action: "status", requestId: "cr-1" } }, { sender: task });
		expect(approval.text).not.toContain("proof-check");
		expect(calls()).toHaveLength(before);
	});

	it("(g) one numbers line per judged send, no message text, file 0600; the temp file is gone and was 0600", async () => {
		const secret = "SIGNED OFF zebra-quartz-41: Rule 33: PASS";
		for (const mode of ["stamp", "noclaim", "refuse"]) {
			setMode(mode);
			await messageRole({ to: "backend", kind: "fyi", text: secret });
		}
		process.env.PATH = empty;
		await messageRole({ to: "backend", kind: "fyi", text: secret });
		const rows = numbers();
		expect(rows).toHaveLength(4);
		expect(rows.map((r) => r.outcome)).toEqual(["sent", "sent", "refused", "held"]);
		expect(rows.map((r) => r.exit)).toEqual([0, 0, 1, null]);
		expect(rows[0]).toMatchObject({
			surface: "message_role",
			chat: "qa-home-chat",
			status: "allowed",
			claimed_verdict: "PASS",
			proofs_named: 1,
			pass_claim_lines: 1,
			proofs_allowed: 1,
		});
		const raw = readFileSync(logFile, "utf8");
		expect(raw).not.toContain("zebra-quartz");
		expect(raw).not.toContain("/sessions/");
		expect(statSync(logFile).mode & 0o777).toBe(0o600);
		for (const c of calls()) {
			expect(c.fileMode).toBe(0o600);
			expect(existsSync(c.file)).toBe(false);
			expect(existsSync(dirname(c.file))).toBe(false);
		}
	});

	it("(h) shell characters in the text never reach a shell", async () => {
		setMode("noclaim");
		const marker = join(root, "pwned");
		const text = `$(touch ${marker}) \`touch ${marker}\`; touch ${marker} && echo "x" | cat > ${marker}`;
		const r = await messageRole({ to: "backend", kind: "fyi", text });
		expect(r.ok).toBe(true);
		expect(existsSync(marker)).toBe(false);
		const c = calls()[0];
		expect(c.args[0]).toBe("--message");
		expect(c.args[2]).toBe("--json");
		expect(c.args).toHaveLength(3);
		expect(c.text).toBe(text);
	});
});

// --- telegram_send ------------------------------------------------------------------------------------------

function telegramTool(name = "telegram_send") {
	const got: Record<string, unknown>[] = [];
	const tool: PluginAgentTool = {
		name,
		description: "Send the owner a message on Telegram.",
		execute: async (_id, params) => {
			got.push(params);
			return {
				content: [{ type: "text", text: "Sent to the owner on Telegram (message 7)." }],
				details: { ok: true, messageIds: [7] },
			};
		},
	};
	return { tool, got };
}
async function telegram(
	text: string,
	ctx: PluginToolCallerContext,
	opts: { name?: string; gate?: ProofCheckGate } = {},
): Promise<{ ok: boolean; text: string; got: Record<string, unknown>[] }> {
	const t = telegramTool(opts.name);
	const g = opts.gate ?? gate();
	const def = pluginToolToDefinition(
		t.tool,
		() => ctx,
		() => g,
	);
	const run = def.execute as unknown as (
		id: string,
		p: Record<string, unknown>,
	) => Promise<{ content: { text: string }[] }>;
	try {
		const r = await run("tg-1", { text, from: "QA lead" });
		return { ok: true, text: r.content[0].text, got: t.got };
	} catch (err) {
		return { ok: false, text: (err as Error).message, got: t.got };
	}
}
const QA_CTX: PluginToolCallerContext = {
	role: "qa",
	sessionFile: "/sessions/qa-home-chat.jsonl",
	conversationId: "c-qa",
};

describe("telegram_send from a QA chat (Ops #1073)", () => {
	it("(e) exit 1 / exit 2: nothing reaches Telegram, findings shown", async () => {
		for (const mode of ["refuse", "cannot"]) {
			setMode(mode);
			const r = await telegram(PASS_TEXT, QA_CTX);
			expect(r.ok, mode).toBe(false);
			expect(r.got, mode).toHaveLength(0);
			expect(r.text, mode).toContain("Not sent");
			expect(r.text, mode).not.toContain("could not run");
		}
	});

	it("(e) tool missing: held, Ops told once", async () => {
		process.env.PATH = empty;
		const g = gate();
		const one = await telegram(PASS_TEXT, QA_CTX, { gate: g });
		const two = await telegram(PASS_TEXT, QA_CTX, { gate: g });
		expect(one.got).toHaveLength(0);
		expect(two.got).toHaveLength(0);
		expect(one.text).toContain("Ops");
		expect(one.text).toContain("the tool could not run");
		expect(one.text).not.toMatch(/refused/i);
		expect(notices).toHaveLength(1);
	});

	it("(e) exit 0 with a stamp: sent with the stamp as the last line; without a claim: unchanged", async () => {
		setMode("stamp");
		const a = await telegram(PASS_TEXT, QA_CTX);
		expect(a.ok).toBe(true);
		expect(a.got[0]).toEqual({ text: `${PASS_TEXT}\n${STAMP}`, from: "QA lead" });
		setMode("noclaim");
		const b = await telegram("Morning: nothing new.", QA_CTX);
		expect(b.got[0]).toEqual({ text: "Morning: nothing new.", from: "QA lead" });
		const rows = numbers();
		expect(rows.map((r) => r.surface)).toEqual(["telegram_send", "telegram_send"]);
		expect(rows[0].chat).toBe("qa-home-chat");
	});

	it("(e) from another role's chat, or another plugin tool from a QA chat: untouched, the tool never runs", async () => {
		setMode("refuse");
		const other = await telegram(PASS_TEXT, { ...QA_CTX, role: "ops" });
		expect(other.ok).toBe(true);
		expect(other.got[0].text).toBe(PASS_TEXT);
		const noRole = await telegram(PASS_TEXT, { conversationId: "c-x" });
		expect(noRole.got[0].text).toBe(PASS_TEXT);
		const mail = await telegram(PASS_TEXT, QA_CTX, { name: "mail_send" });
		expect(mail.got[0].text).toBe(PASS_TEXT);
		expect(calls()).toHaveLength(0);
	});
});

describe("start-up line (Ops #1073)", () => {
	it("says whether proof-check --message works", async () => {
		setMode("noclaim");
		expect(await gate().probe()).toMatch(/^\[proof-check\] proof-check --message works \(/);
		setMode("oldtool");
		expect(await gate().probe()).toMatch(/^\[proof-check\] proof-check --message does NOT work/);
		process.env.PATH = empty;
		expect(await gate().probe()).toMatch(/^\[proof-check\] proof-check --message does NOT work/);
		expect(notices).toHaveLength(0);
	});
});

// --- the real tool on QA's fixtures (agent-tools test/fixtures/proof-check, QA #222) --------------------------

/** The real tool: PROOF_CHECK_REAL (a binary path, e.g. an agent-tools worktree's bin/proof-check), else the one
 *  on the PATH; the fixtures sit beside it in its kit. Undefined (with why) when its --message mode doesn't work. */
function realTool(): { bin: string; fixtures: string } | string {
	const pick = process.env.PROOF_CHECK_REAL ?? findOnPath("proof-check", saved.PATH ?? "");
	if (!pick) return "no proof-check on the PATH";
	const real = realpathSync(pick);
	const fixtures = join(dirname(dirname(real)), "test", "fixtures", "proof-check");
	if (!existsSync(join(fixtures, "messages", "m12-rm-b176aa65.txt"))) return `no message fixtures beside ${real}`;
	const probe = join(mkdtempSync(join(tmpdir(), "pc-probe-")), "m.txt");
	writeFileSync(probe, "hello\n");
	try {
		execFileSync(real, ["--message", probe, "--json"], { stdio: "pipe" });
		return { bin: dirname(real), fixtures };
	} catch {
		return `${real} has no working --message mode yet (Ops #1072)`;
	} finally {
		rmSync(dirname(probe), { recursive: true, force: true });
	}
}
function findOnPath(name: string, path: string): string | undefined {
	for (const d of path.split(delimiter)) if (d && existsSync(join(d, name))) return join(d, name);
	return undefined;
}
const REAL = realTool();
if (typeof REAL === "string") console.warn(`[proof-check-qa-messages] real-tool cases skipped: ${REAL}`);

describe.skipIf(typeof REAL === "string")("the real proof-check on QA's fixtures (Ops #1073)", () => {
	const real = REAL as { bin: string; fixtures: string };
	const msg = (file: string, ...append: string[]) =>
		readFileSync(join(real.fixtures, "messages", file), "utf8") +
		(append.length ? `\n${append.map((l) => l.replaceAll("@FIXTURES@", real.fixtures)).join("\n")}` : "");
	beforeEach(() => {
		// node beside the tool: the real proof-check is a `#!/usr/bin/env node` script
		process.env.PATH = `${real.bin}${delimiter}${dirname(process.execPath)}${delimiter}${empty}`;
	});

	it("M12's two real sign-off messages are refused", async () => {
		for (const file of ["m12-rm-b176aa65.txt", "m12-rm-02b6c6ed.txt"]) {
			const r = await messageRole({ to: "backend", kind: "fyi", text: msg(file) });
			expect(r.ok, file).toBe(false);
			expect(r.sent, file).toHaveLength(0);
			expect(r.text, file).toContain("MSG-PROOF-LINE");
		}
		expect(notices).toHaveLength(0);
	});

	it("a task-close style 'PASS: ...' line without a proof is refused (seam 93a1e79, leading-pass)", async () => {
		const r = await messageRole({ to: "backend", kind: "fyi", text: msg("leading-pass.txt") });
		expect(r.ok).toBe(false);
		expect(r.sent).toHaveLength(0);
		expect(r.text).toContain("MSG-PROOF-LINE");
		const t = await telegram(msg("leading-pass.txt"), QA_CTX);
		expect(t.got).toHaveLength(0);
	});

	it("a clean pass message goes out with the tool's stamp as its last line", async () => {
		const text = msg("verdict-pass.txt", "proof: @FIXTURES@/new-pass-clean.md");
		const r = await messageRole({ to: "backend", kind: "fyi", text });
		expect(r.ok).toBe(true);
		const sent = String(r.sent[0].input.text);
		expect(sent.startsWith(text)).toBe(true);
		expect(sent.split("\n").at(-1)).toMatch(
			/^proof-check: PASS allowed \| .*new-pass-clean\.md \| sha256 [0-9a-f]{12} \|/,
		);
	});

	it("a FAIL report that mentions doc-check PASS goes out unchanged", async () => {
		const text = msg("fail-report.txt");
		const r = await messageRole({ to: "backend", kind: "fyi", text });
		expect(r.ok).toBe(true);
		expect(r.sent[0].input.text).toBe(text);
		const t = await telegram(text, QA_CTX);
		expect(t.got[0].text).toBe(text);
	});
});
