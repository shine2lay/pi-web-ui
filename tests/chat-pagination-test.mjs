/**
 * chat-window-pagination 线上协议冒烟（零 token）。
 *
 * 用一份**预先写好**的会话 jsonl（24 条消息 / 6 个提问）跑真服务端，验证：
 *  1. 打开会话的快照只带窗口内的消息（PI_WEB_MESSAGE_WINDOW=8），并带上
 *     messagesStart = 窗口在完整列表里的起点；
 *  2. questionIndex 覆盖**整段**对话的 6 个提问（含窗口外的），下标是全局的
 *     —— 这是导轨在分页后还能列出全部提问的前提；
 *  3. load_older 回的 older_messages 正好接在窗口前面（start + len === 原起点），
 *     内容是完整列表里对应的那一段；
 *  4. 一路往前取能到顶（start === 0），到顶后不再多发。
 *
 * 这些都是「只看单测看不出来」的部分：窗口切片、全局下标、切片边界。
 * 跑在独立端口 8944 上的编译产物（dist/server/index.js）。
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8944;
const WS_URL = `ws://localhost:${PORT}/ws`;
/** 服务端窗口（env 覆盖），刻意开小以便用 24 条消息就能测出分页。 */
const WINDOW = 8;
/** 种子会话：24 条消息，每 4 条一个提问 → 下标 0/4/8/12/16/20 共 6 个。 */
const TOTAL = 24;
const QUESTION_EVERY = 4;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-pagination-data-"));
const sessionsDir = mkdtempSync(join(tmpdir(), "pi-web-pagination-sessions-"));
const workCwd = mkdtempSync(join(tmpdir(), "pi-web-pagination-cwd-"));
let server = null;

/** 期望的第 i 条消息文本 —— 断言切片内容用同一套规则。 */
const textAt = (i) => (i % QUESTION_EVERY === 0 ? `question ${i}` : `reply ${i}`);
const roleAt = (i) => (i % QUESTION_EVERY === 0 ? "user" : "assistant");

/** 按 SDK 的 jsonl 布局写一份会话（flat 根目录，见 piSessionsRoot）。 */
function seedSession() {
	const sessionId = "01a0c000-0000-7000-8000-00000000beef";
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: workCwd }),
	];
	let parentId = null;
	for (let i = 0; i < TOTAL; i++) {
		const id = `msg${String(i).padStart(4, "0")}`;
		const role = roleAt(i);
		const message =
			role === "user"
				? { role: "user", content: [{ type: "text", text: textAt(i) }], timestamp: Date.now() }
				: {
						role: "assistant",
						content: [{ type: "text", text: textAt(i) }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-opus-4-8",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message }));
		parentId = id;
	}
	const file = join(sessionsDir, `2026-09-21T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workCwd,
			PI_CODING_AGENT_SESSION_DIR: sessionsDir,
			PI_WEB_MESSAGE_WINDOW: String(WINDOW),
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await portUp(PORT)) return;
	}
	throw new Error("server did not start");
}

try {
	const sessionFile = seedSession();
	await startServer();
	const { default: WebSocket } = await import("ws");
	const ws = new WebSocket(WS_URL);

	const snapshots = [];
	const older = [];
	let sawReady = false;
	ws.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		if (msg.type === "ready") sawReady = true;
		if (msg.type === "snapshot") snapshots.push(msg);
		if (msg.type === "older_messages") older.push(msg);
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "pagination-test" }));
	for (let i = 0; i < 100 && !sawReady; i++) await sleep(50);
	check("ready received", sawReady);

	// --- 打开种子会话 -------------------------------------------------------
	snapshots.length = 0;
	ws.send(JSON.stringify({ type: "switch_session", path: sessionFile }));
	for (let i = 0; i < 200 && !snapshots.some((s) => s.state.messages.length > 0); i++) await sleep(50);
	const snap = snapshots.filter((s) => s.state.messages.length > 0).pop();
	check("switching to the seeded session produced a snapshot", !!snap);

	// --- 1) 快照只带窗口内的消息 -------------------------------------------
	const msgs = snap?.state?.messages ?? [];
	check("snapshot carries only the window, not the whole session", msgs.length === WINDOW, `${msgs.length} messages`);
	check(
		"messagesStart marks where the window begins",
		snap?.state?.messagesStart === TOTAL - WINDOW,
		`start=${snap?.state?.messagesStart}`,
	);
	check(
		"the window really is the NEWEST slice",
		msgs[0]?.content?.[0]?.text === textAt(TOTAL - WINDOW) && msgs.at(-1)?.content?.[0]?.text === textAt(TOTAL - 1),
		`${msgs[0]?.content?.[0]?.text} … ${msgs.at(-1)?.content?.[0]?.text}`,
	);

	// --- 2) 提问索引覆盖整段对话（窗口外的也在） ----------------------------
	const qi = snap?.state?.questionIndex ?? [];
	const expectedQuestions = [];
	for (let i = 0; i < TOTAL; i += QUESTION_EVERY) expectedQuestions.push(i);
	check(
		"questionIndex covers EVERY question, not just the loaded ones",
		qi.length === expectedQuestions.length,
		`${qi.length} of ${expectedQuestions.length}`,
	);
	check(
		"questionIndex carries GLOBAL message indices",
		qi.map((q) => q.index).join(",") === expectedQuestions.join(","),
		qi.map((q) => q.index).join(","),
	);
	check("questionIndex text is the question itself", qi[0]?.text === textAt(0), qi[0]?.text);
	check(
		"questions ABOVE the window are indexed (the whole point)",
		qi.some((q) => q.index < (snap?.state?.messagesStart ?? 0)),
	);

	// --- 3) load_older 接在窗口前面 ----------------------------------------
	older.length = 0;
	ws.send(JSON.stringify({ type: "load_older", beforeIndex: TOTAL - WINDOW, count: WINDOW }));
	for (let i = 0; i < 120 && older.length === 0; i++) await sleep(50);
	const batch = older[0];
	check("load_older answered with older_messages", !!batch);
	check("older batch starts exactly one window earlier", batch?.start === TOTAL - 2 * WINDOW, `start=${batch?.start}`);
	check(
		"older batch is contiguous with the window",
		(batch?.start ?? -1) + (batch?.messages?.length ?? 0) === TOTAL - WINDOW,
	);
	check(
		"older batch carries the right slice",
		batch?.messages?.[0]?.content?.[0]?.text === textAt(TOTAL - 2 * WINDOW) &&
			batch?.messages?.at(-1)?.content?.[0]?.text === textAt(TOTAL - WINDOW - 1),
		`${batch?.messages?.[0]?.content?.[0]?.text} … ${batch?.messages?.at(-1)?.content?.[0]?.text}`,
	);

	// --- 4) 一路取到顶 ------------------------------------------------------
	older.length = 0;
	ws.send(JSON.stringify({ type: "load_older", beforeIndex: TOTAL - 2 * WINDOW }));
	for (let i = 0; i < 120 && older.length === 0; i++) await sleep(50);
	check("reaching the top yields start=0", older[0]?.start === 0, `start=${older[0]?.start}`);
	check("top batch carries the first message", older[0]?.messages?.[0]?.content?.[0]?.text === textAt(0));

	// 到顶之后再要就没有了（前端此时也已经把按钮收起来）。
	older.length = 0;
	ws.send(JSON.stringify({ type: "load_older", beforeIndex: 0 }));
	await sleep(600);
	check("asking past the top sends nothing", older.length === 0, `${older.length} batch(es)`);

	ws.close();
} catch (e) {
	check(`test crashed: ${e?.message ?? e}`, false);
} finally {
	server?.kill();
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
