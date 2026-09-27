/**
 * live-test.mjs — 纯 WebSocket 层端到端冒烟测试（不走浏览器）。
 *
 * 验证：hello → ready → set_cwd → read_file（文本预览）→ 媒体 /api/file → 结束
 *
 * 用法:
 *   node tests/live-test.mjs
 *
 * The test starts its own server (temp folders, no real model) and makes its own work folder with
 * a text file and a picture. It never attaches to a server someone has running: that one holds
 * real chats.
 *
 * clientId 随机生成，不依赖特定项目，便于反复跑。
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "live-test" });
const BASE = srv.http;
const WS_URL = srv.ws;

// 1x1 PNG
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
writeFileSync(join(srv.workdir, "note.txt"), "first line\nsecond line\n");
writeFileSync(join(srv.workdir, "pic.png"), Buffer.from(TINY_PNG, "base64"));

const clientId = randomUUID();
const CWD = srv.workdir;
const READ_PATH = "note.txt";
const MEDIA_PATH = "pic.png";

function fail(msg) {
	console.error("FAIL:", msg);
	process.exit(1);
}

const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[live ${step}]`, ...a);
}

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		ws.send(JSON.stringify({ type: "set_cwd", path: CWD }));
	} else if (m.type === "notice" && step === 0) {
		log("set_cwd notice:", m.text);
		step = 1;
		ws.send(JSON.stringify({ type: "read_file", path: READ_PATH ?? "" }));
	} else if (m.type === "file_content" && step === 1) {
		log("file_content:", JSON.stringify({ name: m.name, truncated: m.truncated, binary: m.binary, lines: m.lines }));
		if (!String(m.text ?? "").includes("second line")) fail("read_file did not return the file's text");
		step = 2;
		const url = `/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`;
		const r = await fetch(`${BASE}${url}`);
		log("media url:", url);
		log("media fetch:", r.status, r.headers.get("content-type"));
		const buf = Buffer.from(await r.arrayBuffer());
		log("bytes:", buf.length, "magic:", buf.subarray(0, 4).toString("hex"));
		if (r.status !== 200) fail(`media fetch returned ${r.status}`);
		if (buf.subarray(0, 4).toString("hex") !== "89504e47") fail("media fetch did not return the PNG");
		log("PASS");
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(2);
}, 10000);
