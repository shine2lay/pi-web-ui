/**
 * switch-loading：连上就切换时，打开的那条对话的快照不能被背压丢掉（零 token）。
 *
 * 背景（同步 v0.96.1 时发现）：
 *  - 服务端的发送背压规则：socket 缓冲超过下限（SNAPSHOT_BACKPRESSURE_MIN_BYTES = 256 KB）时，
 *    snapshot / snapshot_delta 直接丢，250ms 后补发一份（补的是 delta，客户端得靠 rev 缺口 get_state）。
 *  - v0.96 起 ready 先于 attach 的那批消息发出；那批里的 settings_state 在真实环境 ~350 KB
 *    （toolsSchema、系统提示词预览……）。客户端一连上就切换（ready 之前就发了 switch_session），
 *    切换在 attach 之后立刻执行，缓冲正满，打开的那份快照被丢，switch_done 跑到了内容前面：
 *    「正在打开…」遮罩撤掉时对话还没到。
 *  - 修法：打开另一条对话的那份全量快照不丢（server/index.ts 的 send）。
 *
 * 这里用一份 ~400 KB 的 AGENTS.md（进系统提示词，也就进了 settings_state）把那批消息撑大，
 * 再连上就切到一份预先写好的会话，检查：先收到这条会话的全量快照，再收到 switch_done。
 * 跑在独立端口 8948 上的编译产物（dist/server/index.js）；agent 目录、会话目录都是临时的。
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8948;
const WS_URL = `ws://localhost:${PORT}/ws`;
/** server/index.ts 里的背压下限。 */
const BACKPRESSURE_FLOOR = 262_144;
const MESSAGES = 6;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-burst-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-burst-agent-"));
const sessionsDir = mkdtempSync(join(tmpdir(), "pi-web-burst-sessions-"));
const workCwd = mkdtempSync(join(tmpdir(), "pi-web-burst-cwd-"));
let server = null;

// ~400 KB 的项目说明：进系统提示词，settings_state 的提示词预览会带上它。
const paragraph = "This line only makes the project instructions big for the switch-open-burst test.\n";
writeFileSync(
	join(workCwd, "AGENTS.md"),
	`# Big instructions\n\n${paragraph.repeat(Math.ceil(400_000 / paragraph.length))}`,
);

/** 按 SDK 的 jsonl 布局写一份会话（同 chat-pagination-test）。 */
function seedSession() {
	const sessionId = "01a0c000-0000-7000-8000-0000000b0057";
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: workCwd }),
	];
	let parentId = null;
	for (let i = 0; i < MESSAGES; i++) {
		const id = `msg${String(i).padStart(4, "0")}`;
		const text = i % 2 === 0 ? `question ${i}` : `reply ${i}`;
		const message =
			i % 2 === 0
				? { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
				: {
						role: "assistant",
						content: [{ type: "text", text }],
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
			PI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_SESSION_DIR: sessionsDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
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

	/** 按到达顺序记下每条消息（类型、字节数、快照属于哪份会话）。 */
	const all = [];
	ws.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		all.push({
			type: msg.type,
			bytes: data.length,
			sessionFile: msg.type === "snapshot" ? msg.state?.sessionFile : undefined,
			messages: msg.type === "snapshot" ? (msg.state?.messages?.length ?? 0) : undefined,
			target: msg.type === "switch_done" || msg.type === "switch_failed" ? msg.target : undefined,
		});
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	// 连上就切：不等 ready，切换排在 attach 后面立刻执行。
	ws.send(JSON.stringify({ type: "hello", clientId: "switch-open-burst" }));
	ws.send(JSON.stringify({ type: "switch_session", path: sessionFile }));

	const isOurs = (m) => m.target?.kind === "session" && m.target.path === sessionFile;
	const answered = () => all.some((m) => (m.type === "switch_done" || m.type === "switch_failed") && isOurs(m));
	for (let i = 0; i < 300 && !answered(); i++) await sleep(50);
	const doneIdx = all.findIndex((m) => m.type === "switch_done" && isOurs(m));
	const failed = all.find((m) => m.type === "switch_failed");
	check("the switch finished (switch_done)", doneIdx >= 0, failed ? "got switch_failed" : "");

	const biggestSettings = Math.max(0, ...all.filter((m) => m.type === "settings_state").map((m) => m.bytes));
	check(
		"the settings sent on connect are bigger than the backpressure floor (the test really fills the buffer)",
		biggestSettings > BACKPRESSURE_FLOOR,
		`${Math.round(biggestSettings / 1024)} KB`,
	);

	const snapIdx = all.findIndex((m) => m.type === "snapshot" && m.sessionFile === sessionFile);
	check("the opened chat's full snapshot arrived", snapIdx >= 0);
	check(
		"…before switch_done (the loading overlay lifts only when the content is there)",
		snapIdx >= 0 && doneIdx >= 0 && snapIdx < doneIdx,
		`snapshot #${snapIdx}, switch_done #${doneIdx}`,
	);
	check(
		"…with the chat's messages",
		snapIdx >= 0 && all[snapIdx].messages === MESSAGES,
		`${snapIdx >= 0 ? all[snapIdx].messages : "no"} messages`,
	);

	ws.close();
} catch (err) {
	console.log(`✗ FAIL: ${err?.stack ?? err}`);
	failures++;
} finally {
	server?.kill("SIGTERM");
	await sleep(300);
	for (const dir of [dataDir, agentDir, sessionsDir, workCwd]) rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`FAIL (${failures})`);
	process.exit(1);
}
console.log("all switch-open-burst checks passed");
