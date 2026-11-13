/* tool-time-limit E2E (no tokens): google_search and queue_reply get a 2-minute limit (ops #863).
 *
 * What went wrong live (2026-11-12): google_search (three lead chats, 16:08-16:10 PST) and queue_reply
 * (Ops lead 16:18, Design lead 18:06) never returned, for 21 min to 2h17m, and the chat's turn stayed
 * busy. The owner chose a 2-minute limit for exactly these two tools (COO rm-625df2d1): "A frozen
 * search or reply errors out after 2 minutes and the chat carries on".
 *
 * One sealed server with a scripted model and a test add-on whose google_search and queue_reply never
 * settle (and ignore the abort). The limit is shortened to 3 s (PI_WEB_TOOL_TIME_LIMIT_MS); the 20-minute
 * hang guard is moved out of the way (10 min). For each tool:
 *   1. the turn hangs in the tool;
 *   2. at the limit the chat is free again (not after the hang guard), and not before the limit;
 *   3. the tool's result is an error with the owner-approved words;
 *   4. the tool's own abort signal fired;
 *   5. the turn went on to the next model step (the model's answer after the tool is in the chat).
 * Without the limit, step 2 fails: the chat stays busy.
 * Never prints what goes to the model (rule 8): only yes/no and timings.
 * Usage: npm run build && node tests/run-sealed.mjs tool-time-limit   (TOOLLIMIT_DEBUG=1: server output)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const LIMIT_MS = 3_000;
const MARGIN_MS = 10_000;
const WORDS = {
	google_search: "Search gave no answer within 2 minutes; try again or use another search tool.",
	queue_reply:
		"No answer within 2 minutes. It may still have gone through: check the task (queue list / roles_overview) before replying again.",
};

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}

/** The add-on: both tools never settle and ignore the abort, but note that it came. */
const tools = (agentDir) => `/** tool-time-limit test: google_search and queue_reply that never return. */
import { writeFileSync } from "node:fs";
export default function (pi: any) {
	for (const name of ["google_search", "queue_reply"]) {
		pi.registerTool({
			name,
			label: name,
			description: "Test tool: never returns.",
			parameters: { type: "object", properties: {}, additionalProperties: true },
			execute: (_id: string, _params: unknown, signal?: AbortSignal) => {
				signal?.addEventListener("abort", () => writeFileSync(${JSON.stringify(agentDir)} + "/aborted-" + name, "1"));
				return new Promise(() => {});
			},
		});
	}
}
`;
const reply = ({ lastUser, toolResult, sideRequest }) => {
	if (sideRequest) return "Chat";
	if (toolResult) return "carried on after the tool";
	if (/^search now/.test(lastUser)) return { tool: "google_search", args: { query: "pi" } };
	if (/^reply now/.test(lastUser)) return { tool: "queue_reply", args: { id: 1, answer: "yes" } };
	return "ok";
};

function sessionEntries(agentDir) {
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".jsonl")) files.push(p);
		}
	};
	walk(join(agentDir, "sessions"));
	return files.flatMap((f) =>
		readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l)];
				} catch {
					return [];
				}
			}),
	);
}
/** The tool's result, and whether the model answered after it (the next model step ran). */
function afterTool(agentDir, name) {
	const msgs = sessionEntries(agentDir)
		.filter((e) => e.type === "message")
		.map((e) => e.message);
	const at = msgs.findIndex((m) => m.role === "toolResult" && m.toolName === name);
	if (at < 0) return { result: null, carriedOn: false };
	const m = msgs[at];
	const text = (m.content ?? []).map((c) => c.text ?? "").join("");
	const carriedOn = msgs
		.slice(at + 1)
		.some((x) => x.role === "assistant" && (x.content ?? []).some((c) => c.text === "carried on after the tool"));
	return { result: { isError: m.isError === true, text }, carriedOn };
}

const srv = await ownServer({
	name: "tool-time-limit",
	verbose: !!process.env.TOOLLIMIT_DEBUG,
	mock: reply,
	prepare: ({ agentDir }) => {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "never-tools.ts"), tools(agentDir));
	},
	env: { PI_WEB_TOOL_TIME_LIMIT_MS: String(LIMIT_MS), PI_WEB_TOOL_TIMEOUT_MS: "600000" },
});
const ws = new WebSocket(srv.ws);
let streaming = false;
const seen = new Set();
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if ((m.type === "snapshot" || m.type === "snapshot_delta") && m.state) {
		streaming = !!m.state.isStreaming;
		const s = JSON.stringify(m.state.messages ?? m.appended ?? []);
		for (const name of Object.keys(WORDS)) if (s.includes(`"${name}"`)) seen.add(name);
	}
});

async function scenario(name, prompt) {
	ws.send(JSON.stringify({ type: "prompt", text: prompt }));
	const t0 = Date.now();
	check(`${name}: the turn hangs in the tool`, !!(await waitFor(() => seen.has(name) && streaming, 30000)));
	const freed = await waitFor(() => !streaming, LIMIT_MS + MARGIN_MS);
	const took = Date.now() - t0;
	console.log(`  ${name}: chat free after ${(took / 1000).toFixed(1)}s (limit ${LIMIT_MS / 1000}s)`);
	check(`${name}: the chat is free again at the limit`, !!freed, `still working after ${(took / 1000).toFixed(1)}s`);
	check(`${name}: not before the limit`, took >= LIMIT_MS, `${took} ms`);
	const got =
		(await waitFor(() => afterTool(srv.agentDir, name).carriedOn && afterTool(srv.agentDir, name), 10000)) ??
		afterTool(srv.agentDir, name);
	check(`${name}: its result is an error`, got.result?.isError === true);
	check(`${name}: with the owner-approved words`, got.result?.text === WORDS[name]);
	check(`${name}: the tool's own abort signal fired`, existsSync(join(srv.agentDir, `aborted-${name}`)));
	check(`${name}: the turn went on to the next model step`, got.carriedOn);
}

try {
	await new Promise((res, rej) => {
		ws.once("open", res);
		ws.once("error", rej);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "tool-time-limit" }));
	await sleep(1500);
	await scenario("google_search", "search now");
	await scenario("queue_reply", "reply now");
} catch (err) {
	check("scenario ran", false, err?.stack ?? String(err));
} finally {
	ws.close();
	await srv.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
