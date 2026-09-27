/**
 * ws-session-test.mjs — 纯 WebSocket 层冒烟测试（不走浏览器）。
 *
 * 验证 ws 协议的关键握手和行为：
 *   hello → ready → list_files(根)→ files → 媒体 /api/file → 结束
 *
 * 用法:
 *   node tests/ws-session-test.mjs
 *
 * The test starts its own server (temp folders, no real model) with a picture in its work folder.
 * It never attaches to a server someone has running: that one holds real chats.
 *
 * 与仓库其它 test.mjs 一致：clientId 随机生成，不依赖特定项目文件。
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "ws-session-test" });
const BASE = srv.http;
const WS_URL = srv.ws;

// 1x1 PNG in the server's work folder: the root listing must show it and /api/file must serve it.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MEDIA_PATH = "pic.png";
writeFileSync(join(srv.workdir, MEDIA_PATH), Buffer.from(TINY_PNG, "base64"));

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[ws-session ${step}]`, ...a);
}

function fail(msg) {
	console.error("FAIL:", msg);
	process.exit(1);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		// 用根列表暴露当前会话 cwd（path undefined → 根）
		ws.send(JSON.stringify({ type: "list_files", path: undefined }));
	} else if (m.type === "files") {
		log("files root:", m.path, "entries:", m.entries.length);
		if (!m.entries.some((e) => e.name === MEDIA_PATH)) fail(`the root listing does not show ${MEDIA_PATH}`);
		const r = await fetch(
			`${BASE}/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`,
		);
		log("media fetch:", r.status, r.headers.get("content-type"));
		if (r.status !== 200) fail(`media fetch returned ${r.status}`);
		log("PASS");
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	} else if (m.type === "notice") {
		log("notice:", m.text);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(1);
}, 8000);
