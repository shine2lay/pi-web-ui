/**
 * image-paste-test.mjs — 纯 WebSocket 冒烟测试：验证「粘贴图片」协议路径。
 *
 * 发送带 imageData（raw base64）附件的 prompt，验证：
 *   1. 服务端把它变成 image content 的 custom message（details.mode === "image"）
 *   2. 快照里该消息的 content 含 { type: "image", dataUrl: "data:image/..." }
 *   3. 超限图片（>2MB）被拒并回 notice
 *
 * 用法:
 *   node tests/image-paste-test.mjs
 *
 * The test starts its own server (temp folders, a model that can't be reached, so the prompt only
 * saves the message). It never attaches to a server someone has running: that one holds real chats.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({ name: "image-paste-test" });
const WS_URL = srv.ws;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);

// 1x1 透明 PNG (base64)
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let step = 0;
let sawImageMsg = false;
let sawOversizeNotice = false;
const timer = setTimeout(() => {
	console.error("TIMEOUT — image message not observed");
	process.exit(1);
}, 15000);

function log(...a) {
	console.log(`[image-paste ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

let checking = false;

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, sending prompt with tiny pasted image");
		step = 1;
		ws.send(
			JSON.stringify({
				type: "prompt",
				text: "描述这张图片",
				attachments: [
					{
						path: "",
						imageData: TINY_PNG,
						mimeType: "image/png",
						name: "粘贴测试.png",
						size: 0,
					},
					{
						// 超限：1.5MB 的假 base64（>2MB 解码后）→ 应回 warning notice
						path: "",
						imageData: "A".repeat(3 * 1024 * 1024),
						mimeType: "image/png",
						name: "超大.png",
						size: 0,
					},
				],
			}),
		);
		// Snapshot protocol v2: the regular checkpoints are snapshot_delta messages, and this script only
		// reads full snapshots, so ask for one (get_state forces a full snapshot) until the image shows.
		const poll = setInterval(() => {
			try {
				ws.send(JSON.stringify({ type: "get_state" }));
			} catch {
				/* closing */
			}
		}, 700);
		ws.on("close", () => clearInterval(poll));
	} else if (m.type === "snapshot") {
		for (const msg of m.state?.messages ?? []) {
			if (msg.customType !== "file") continue;
			if (msg.details?.mode !== "image") continue;
			const img = (msg.content ?? []).find((b) => b.type === "image");
			if (!img) continue;
			if (sawImageMsg || checking) continue;
			const url = String(img.dataUrl ?? "");
			if (url.startsWith("data:image/png;base64,")) {
				sawImageMsg = true;
			} else if (/^\/api\/attachment\/[0-9a-f]+$/.test(url)) {
				// Pasted pictures are kept in the content-addressed attachment store and the message
				// points at it: fetch it and check it is the picture that was pasted.
				checking = true;
				const r = await fetch(`${srv.http}${url}`);
				const buf = Buffer.from(await r.arrayBuffer());
				if (r.status !== 200 || r.headers.get("content-type") !== "image/png") {
					console.error("FAIL: attachment fetch:", r.status, r.headers.get("content-type"));
					process.exit(1);
				}
				if (!buf.equals(Buffer.from(TINY_PNG, "base64"))) {
					console.error("FAIL: the stored picture is not the pasted one");
					process.exit(1);
				}
				sawImageMsg = true;
			} else {
				console.error("FAIL: image dataUrl prefix wrong:", url.slice(0, 40));
				process.exit(1);
			}
			log("OK: image custom message in snapshot:", JSON.stringify(msg.details), url.slice(0, 40));
		}
	} else if (m.type === "notice") {
		if (m.level === "warning" && m.text.includes("超大.png")) {
			sawOversizeNotice = true;
			log("OK: oversize notice:", m.text);
		} else {
			log("notice:", m.level, m.text);
		}
	} else if (m.type === "heartbeat") {
		// ignore
	}

	if (sawImageMsg && sawOversizeNotice) {
		clearTimeout(timer);
		log("PASS");
		ws.send(JSON.stringify({ type: "abort" }));
		ws.close();
		process.exit(0);
	}
});

ws.on("error", (e) => {
	console.error("ws error:", e.message);
	process.exit(1);
});
