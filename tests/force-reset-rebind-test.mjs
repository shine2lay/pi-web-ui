/* force-reset-rebind E2E (no tokens): a background chat that the hang guard force-resets comes back whole.
 *
 * What went wrong live (2026-10-05): a role message opened Architecture's home chat through the
 * role-messages pseudo client; a tool in that turn hung, the tool watchdog stopped it, and the abort
 * didn't end the run, so the chat was force-reset. By then the pseudo client had moved on to another
 * chat, and the force-reset bound THAT chat again instead of the rebuilt one: the rebuilt chat had no
 * events (its turns never reached the working list) and no extension session start (pi-identity: "no
 * role"), and the stuck turn stayed on the working list, so every later role message waited for good.
 *
 * A sealed server (TZ America/Los_Angeles, tool watchdog 4 s) with a scripted model, the real
 * pi-identity and a test add-on tool that never ends and ignores the abort. Roles alpha (home chat A)
 * and beta (home chat B), both closed at the start. Checks:
 *  1. alpha's report request (day 2) wakes A and its turn hangs in the tool;
 *  2. beta's request (day 1) is delivered meanwhile (the delivery client moves on to B);
 *  3. the hang guard force-resets A (the hung call gets its filled-in result);
 *  4. A leaves the working list;
 *  5. a new request for alpha (day 3) is delivered;
 *  6. A's next turn is on the working list while it runs, and off it after (its events are bound);
 *  7. A still has its role: its message_role call goes through, and no "no role" for A;
 *  8. A's answer has the four headings.
 * Never prints what goes to the model (rule 11).
 * Usage: npm run build && node tests/force-reset-rebind-test.mjs   (REBIND_DEBUG=1: server output)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}
const TZ = "America/Los_Angeles";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 30000, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}

/** YYYY-MM-DD in Pacific time, `back` days before today. */
function pacificDay(back) {
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	const [y, m, d] = today.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
const D1 = pacificDay(1); // beta's request: answered at once
const D2 = pacificDay(2); // alpha's first request: the turn hangs
const D3 = pacificDay(3); // alpha's request after the force-reset

// ---- the scripted model ------------------------------------------------------------------------------
const REPORT_HEAD = /^\[Role message (rm-[0-9a-f]{8}) from the app · 6 am report · (\d{4}-\d{2}-\d{2})\]/;
const reportText = (date) =>
	[
		"## Goal or hypothesis",
		`Check the morning report for ${date}. ${"Plain words about the day. ".repeat(4)}`,
		"## Done yesterday",
		"Built and tested it.",
		"## Learned",
		"Metadata was enough.",
		"## Next",
		"Watch the first real morning.",
	].join("\n");
function decide({ payload, lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Chat";
	const users = (Array.isArray(payload.messages) ? payload.messages : []).filter(
		(m) => m.role === "user" && !/^\(System reminder/.test(textOf(m)),
	);
	const last = users.length > 0 ? textOf(users.at(-1)) : lastUser;
	const rep = REPORT_HEAD.exec(last);
	if (toolResult) return { text: reportText(rep?.[2] ?? D3), stream: { everyMs: 80, pieceChars: 6 } };
	if (rep?.[2] === D2) return { tool: "hang_forever", args: {} };
	if (rep?.[2] === D3)
		return { tool: "message_role", args: { to: "beta", kind: "fyi", text: "Alpha is back after the reset." } };
	if (rep) return reportText(rep[2]);
	return "ok";
}
function reply(ctx) {
	const out = decide(ctx);
	if (process.env.REBIND_DEBUG) {
		const what = typeof out === "string" ? "text" : out?.tool ? `tool ${out.tool}` : "stream";
		console.log(`[mock] side=${ctx.sideRequest} result=${!!ctx.toolResult} -> ${what}`);
	}
	return out;
}

// ---- the add-on tool that never ends ----------------------------------------------------------------
const HANG_TOOL = `/** force-reset-rebind test: a tool that never ends and ignores the abort (like a hand-off that waits on another chat's whole turn). */
export default function (pi: any) {
	pi.registerTool({
		name: "hang_forever",
		label: "Hang",
		description: "Test tool: never returns.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: () => new Promise(() => {}),
	});
}
`;

// ---- the saved chats and the roles -------------------------------------------------------------------
const files = {};
const ids = {};
let idDir = "";
function seed({ root, agentDir, workdir }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
	settings.packages = [PI_IDENTITY];
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "hang-tool.ts"), HANG_TOOL);
	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (n) => join(dir, `2026-10-01T10-0${n}-00-000Z_01a0f000-0000-7000-8000-0000000000c${n}.jsonl`);
	files.A = file(1);
	files.B = file(2);
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const write = (path, roleId) => {
		const ts = Date.parse("2026-10-01T10:00:00.000Z");
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		ids[roleId] = id;
		const at = (n) => new Date(ts + n * 1000).toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: at(0), cwd: workdir },
			{ type: "model_change", id: "mc", parentId: null, timestamp: at(0), provider: "mock", modelId: "mock-model" },
			{
				type: "custom",
				customType: "identity",
				id: "e2",
				parentId: "mc",
				timestamp: at(1),
				data: { v: 1, id: roleId, via: "command" },
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: at(2),
				message: { role: "user", content: [{ type: "text", text: `${roleId} home starts` }], timestamp: ts + 2000 },
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: at(3),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "mock",
					model: "mock-model",
					usage,
					stopReason: "stop",
					timestamp: ts + 3000,
				},
			},
		];
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, "alpha");
	write(files.B, "beta");
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${id} things.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("alpha", { title: "Alpha desk", homeChat: files.A });
	role("beta", { title: "Beta desk", homeChat: files.B });
}

const srv = await ownServer({
	name: "force-reset-rebind",
	verbose: !!process.env.REBIND_DEBUG,
	stdout: true,
	mock: reply,
	prepare: seed,
	env: {
		TZ,
		PI_WEB_TOOL_TIMEOUT_MS: "4000",
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

// ---- the control socket ------------------------------------------------------------------------------
function control(req) {
	return new Promise((resolve) => {
		const c = createConnection(join(srv.dataDir, "pi-web-ui.sock"));
		let buf = "";
		const timer = setTimeout(() => {
			c.destroy();
			resolve(null);
		}, 5000);
		c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
		c.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				c.destroy();
				try {
					resolve(JSON.parse(buf.slice(0, nl)));
				} catch {
					resolve(null);
				}
			}
		});
		c.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}
const token = () => readFileSync(join(srv.dataDir, "app-token"), "utf8").trim();
const ask = (role, date) => control({ cmd: "role_report", token: token(), role, date });
const receiptOf = async (role, date) =>
	((await control({ cmd: "role_reports", date }))?.receipts ?? []).find((r) => r.role === role);

// ---- what the files say ------------------------------------------------------------------------------
function entries(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
const calledHang = () =>
	entries(files.A).some(
		(e) =>
			e.type === "message" &&
			e.message?.role === "assistant" &&
			(e.message.content ?? []).some((c) => c.type === "toolCall" && c.name === "hang_forever"),
	);
const hangAnswered = () =>
	entries(files.A).some(
		(e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "hang_forever",
	);
const workingList = () => {
	try {
		return readFileSync(join(srv.dataDir, "running-chats.json"), "utf8");
	} catch {
		return "";
	}
};
const listsA = () => workingList().includes(JSON.stringify(files.A).slice(1, -1));
const serverLog = () => `${srv.stdout()}\n${srv.stderr()}`;

try {
	// 1. alpha's request wakes A, and its turn hangs in the tool.
	const first = await ask("alpha", D2);
	check("alpha's first request is taken", first?.ok === true, JSON.stringify(first));
	check("A's turn hangs in the tool", !!(await waitFor(calledHang, 30000)));
	check("A is on the working list while it hangs", listsA());

	// 2. beta's request goes out meanwhile: the delivery client moves on to B.
	const second = await ask("beta", D1);
	check("beta's request is taken", second?.ok === true, JSON.stringify(second));
	const betaDone = await waitFor(async () => (await receiptOf("beta", D1))?.state === "replied", 30000);
	check("beta's request is delivered and answered while A hangs", !!betaDone && !hangAnswered());

	// 3. the hang guard stops the tool; the abort can't end the run, so A is force-reset.
	check(
		"the hang guard force-resets A (the hung call gets its filled-in result)",
		!!(await waitFor(hangAnswered, 60000)),
	);

	// 4. the stuck turn is over: A leaves the working list.
	check("A leaves the working list after the force-reset", !!(await waitFor(() => !listsA(), 5000)), workingList());

	// 5. a new request reaches alpha.
	const third = await ask("alpha", D3);
	check("alpha's next request is taken", third?.ok === true, JSON.stringify(third));
	let seenWorking = false;
	const delivered = await waitFor(
		async () => {
			if (listsA()) seenWorking = true;
			const r = await receiptOf("alpha", D3);
			return r && r.state !== "waiting" ? r : null;
		},
		30000,
		50,
	);
	check("alpha's next request is delivered", !!delivered, JSON.stringify(await receiptOf("alpha", D3)));

	// 6-8. A's next turn: bound (on the working list while it runs), with its role, and answered.
	const answered = await waitFor(
		async () => {
			if (listsA()) seenWorking = true;
			const r = await receiptOf("alpha", D3);
			return r?.state === "replied" ? r : null;
		},
		30000,
		50,
	);
	check("A's next turn is on the working list while it runs (its events are bound)", seenWorking);
	check(
		"A still has its role: its message_role call goes through",
		/rm-[0-9a-f]{8} alpha \(home chat\) -> beta · fyi/.test(serverLog()),
	);
	check('no "no role" for A', !new RegExp(`no role: hid [^\\n]*\\(session ${ids.alpha}\\)`).test(serverLog()));
	check("A's answer has the four headings", answered?.reply?.headings === true, JSON.stringify(answered));
	check("A is off the working list after that turn", !!(await waitFor(() => !listsA(), 5000)), workingList());
} catch (err) {
	check("test ran", false, err?.stack ?? String(err));
} finally {
	await srv.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
