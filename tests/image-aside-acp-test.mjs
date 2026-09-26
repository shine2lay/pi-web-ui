/* image-aside-acp E2E (no tokens): a pasted picture reaches the model with billion-context-pi loaded.
 *
 * billion-context-pi rebuilds the model's message list on every turn and keeps a custom message
 * only if it has text. An image aside used to hold just the image, so the model never got the
 * picture ("no image came through"). image-aside-label gives each image aside one line of text,
 * `<image name="…" />` or `<image path="…" />`; the page doesn't show it.
 *
 * The real extension is loaded through settings.json `packages` (BCP_PKG, default
 * ~/.pi/agent/npm/node_modules/billion-context-pi). A mock OpenAI-compatible model that takes
 * images records every request. Checks:
 *  - the extension is really on: its <acp …> ref tags are in the model's request;
 *  - turn 1, a pasted image: the request carries the picture and the line naming it;
 *  - the page's card for it shows the picture and no text;
 *  - turn 2, a workspace image by path: the request carries both pictures (turn 1's is kept)
 *    and the line with the path.
 * Usage: npm run build && node tests/image-aside-acp-test.mjs    (IMAGE_ACP_DEBUG=1 prints the requests)
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const BCP = process.env.BCP_PKG ?? join(homedir(), ".pi", "agent", "npm", "node_modules", "billion-context-pi");
if (!existsSync(join(BCP, "package.json"))) {
	console.log(`✗ FAIL: billion-context-pi not found at ${BCP} (set BCP_PKG)`);
	process.exit(1);
}
const base = mkdtempSync(join(tmpdir(), "piweb-image-acp-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
// billion-context-pi appends to ~/.pi/acp.log: the server gets its own home so the real log stays clean.
const homeDir = join(base, "home");
for (const d of [workdir, dataDir, agentDir, homeDir, join(workdir, "pics")]) mkdirSync(d, { recursive: true });

// 1x1 PNG (base64, no data: prefix).
const IMG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
writeFileSync(join(workdir, "pics", "red.png"), Buffer.from(IMG_B64, "base64"));

const MODEL_ID = "image-acp-mock";
const DEBUG = !!process.env.IMAGE_ACP_DEBUG;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	const shown = String(extra)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, ok ? 80 : 400);
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${shown ? " — " + shown : ""}`);
	if (!ok) failures++;
};

// ---- mock model --------------------------------------------------------------
/** Every request the model got: its text, how many pictures it carried, how many tools it offered. */
const requests = [];
/** The parts of one chat message (its content is a string or a list of parts). */
function partsOf(msg) {
	if (typeof msg?.content === "string") return [{ type: "text", text: msg.content }];
	return Array.isArray(msg?.content) ? msg.content : [];
}
const chunk = (model, delta, finish = null, usage = undefined) => ({
	id: "mock-1",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
	...(usage ? { usage } : {}),
});
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const parts = (payload.messages ?? []).flatMap(partsOf);
	const text = parts
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
	const images = parts.filter((p) => p.type === "image_url" || p.type === "image").length;
	// Which turn this is: the highest IMAGE-ACP-<n> in the conversation so far.
	const turn = Math.max(0, ...[...text.matchAll(/IMAGE-ACP-(\d+)/g)].map((m) => Number(m[1])));
	const entry = { turn, images, tools: payload.tools?.length ?? 0, text };
	requests.push(entry);
	if (DEBUG) console.log(`[mock] turn ${turn}, ${images} picture(s), ${entry.tools} tools:\n${text.slice(-1500)}\n`);
	const reply = turn ? `REPLY-${turn} I can see it.` : "ok";
	const model = payload.model ?? MODEL_ID;
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if (payload.stream === false) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				id: "mock-1",
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
				usage,
			}),
		);
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(`data: ${JSON.stringify(chunk(model, { role: "assistant", content: reply }))}\n\n`);
	res.write(`data: ${JSON.stringify(chunk(model, {}, "stop", usage))}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [
					{
						id: MODEL_ID,
						name: "Image ACP Mock",
						input: ["text", "image"],
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID, packages: [BCP] }),
);

// ---- server ----------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		HOME: homeDir,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

// ---- a bare protocol client (snapshots + deltas, as the page merges them) ----
class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		this.messages = [];
		ws.on("message", (d) => {
			const m = JSON.parse(d.toString());
			this.received.push(m);
			if (m.type === "snapshot") {
				this.state = m.state;
				this.messages = m.state.messages ?? [];
			} else if (
				m.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === m.baseRev &&
				(!m.conversationId || m.conversationId === this.state.conversationId)
			) {
				this.state = { ...this.state, ...m.state };
				this.messages = [...this.messages, ...m.appended];
			}
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async until(fn, ms, what) {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const v = fn();
			if (v) return v;
			await sleep(100);
		}
		throw new Error(`timeout waiting for ${what}`);
	}
}
async function connect() {
	for (let i = 0; i < 150; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(200);
		}
	}
	throw new Error("server not ready");
}
const textOf = (m) =>
	(m?.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
/** The agent's own request for a turn (a title request offers no tools). */
const agentRequest = (turn) => requests.filter((r) => r.turn === turn && r.tools > 0).at(-1);

let ws;
try {
	const c = await connect();
	ws = c.ws;
	c.send({ type: "hello", clientId: "image-aside-acp-test" });
	await c.until(() => c.received.some((m) => m.type === "ready"), 20000, "ready");
	c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await c.until(() => c.state?.model?.id === MODEL_ID, 20000, "the mock model");

	console.log("turn 1: a pasted picture");
	c.send({
		type: "prompt",
		text: "IMAGE-ACP-1 what is in this picture?",
		attachments: [{ path: "", key: "t1", name: "shot.png", mode: "inline", imageData: IMG_B64, mimeType: "image/png" }],
	});
	await c.until(
		() => c.messages.some((m) => m.role === "assistant" && textOf(m).includes("REPLY-1")),
		45000,
		"turn 1's reply",
	);
	const r1 = agentRequest(1);
	check("the model got turn 1", !!r1, `${requests.length} request(s)`);
	check(
		"billion-context-pi is on: its ref tags are in the request",
		/<acp [^>]*>m\d+<\/acp>/.test(r1?.text ?? ""),
		(r1?.text ?? "").slice(-300),
	);
	check("the pasted picture reaches the model", r1?.images === 1, `pictures in the request: ${r1?.images}`);
	check(
		"with the line naming it",
		(r1?.text ?? "").includes('<image name="shot.png" />'),
		(r1?.text ?? "").slice(-300),
	);
	const card = c.messages.find(
		(m) => m.customType === "file" && m.details?.mode === "image" && m.details?.name === "shot.png",
	);
	const cardParts = JSON.stringify((card?.content ?? []).map((b) => b.type));
	check("the page's card shows the picture and no text", cardParts === '["image"]', cardParts);

	console.log("turn 2: a workspace picture by path");
	c.send({
		type: "prompt",
		text: "IMAGE-ACP-2 and this one?",
		attachments: [{ path: "pics/red.png", mode: "reference", name: "red.png" }],
	});
	await c.until(
		() => c.messages.some((m) => m.role === "assistant" && textOf(m).includes("REPLY-2")),
		45000,
		"turn 2's reply",
	);
	const r2 = agentRequest(2);
	check("the model got turn 2", !!r2, `${requests.length} request(s)`);
	check("both pictures reach the model (turn 1's is kept)", r2?.images === 2, `pictures in the request: ${r2?.images}`);
	check(
		"with the line giving the path",
		(r2?.text ?? "").includes('<image path="pics/red.png" />'),
		(r2?.text ?? "").slice(-300),
	);
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	ws?.close();
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Files kept in ${base}. Server log tail:`);
	console.log(serverLog.split("\n").slice(-30).join("\n"));
	process.exit(1);
}
rmSync(base, { recursive: true, force: true });
console.log("\nall image-aside-acp checks passed");
