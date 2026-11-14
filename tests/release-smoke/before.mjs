/**
 * The before-run: `node tests/release-smoke/before.mjs`, in the repo or a built worktree of it, no
 * arguments. It starts its own copy of the app from the built dist/ and web/dist/ of the folder it runs
 * in (what pi-web-deploy has just built), on a free port with temp data and the repo's zero-token
 * stand-in model, and runs F1-F4 on it. No real add-on, chat, model or token is used.
 * Exit 0 all passed, 1 any failed (a missing build or a copy that doesn't start fails every check),
 * 3 none failed but some could not be checked (Chrome or QA's big-chat fixture missing).
 * PI_WEB_SMOKE_APP_DIR names another built folder to check (default: the current folder).
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ownServer } from "../lib/own-server.mjs";
import { run } from "./harness.mjs";
import "./f1-open-app-test.mjs";
import "./f2-reply-test.mjs";
import "./f3-big-chat-test.mjs";
import { CARRY_ON_NOTE, F4_BUSY, F4_CARRIED } from "./f4-restart-test.mjs";

export const F2_PROMPT = "SMOKE-F2 please run a command";
const F2_TOOL = { name: "bash", output: "smoke-tool-ran" };

/** The stand-in model's answers for the before-run's checks. */
export function standInReply({ lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Smoke title";
	if (lastUser.startsWith(CARRY_ON_NOTE)) return `${F4_CARRIED}: picked the cut-off turn back up.`;
	if (toolResult)
		return {
			text: `SMOKE-DONE: the command ran and printed its line. ${"More words arrive one piece at a time. ".repeat(3)}`,
			stream: { everyMs: 80, pieceChars: 6 },
		};
	if (lastUser.includes(F2_PROMPT)) return { tool: F2_TOOL.name, args: { command: `echo ${F2_TOOL.output}` } };
	if (lastUser.includes(F4_BUSY)) return { text: "still writing ".repeat(40), stream: { everyMs: 500, pieceChars: 7 } };
	return "hi";
}

const LIMITS = {
	readyMs: 30_000,
	replyStartMs: 20_000,
	replyMs: 30_000,
	bigchatMs: 90_000,
	memoryWatchMs: 0,
	carryOnMs: 60_000,
};

/** Run F1-F4 on a copy started from appDir with the stand-in model `respond`; returns the exit code. */
export async function beforeRun({
	appDir = resolve(process.env.PI_WEB_SMOKE_APP_DIR ?? process.cwd()),
	respond = standInReply,
} = {}) {
	const label = `before-run on ${appDir}`;
	const missing = ["dist/server/index.js", "web/dist/index.html"].filter((f) => !existsSync(join(appDir, f)));
	if (missing.length)
		return run(
			{ notes: [] },
			{ label, blocked: `no built app here (missing ${missing.join(", ")}); build it first (npm run build)` },
		);
	let srv;
	try {
		srv = await ownServer({ name: "release-smoke-before", appDir, mock: respond });
	} catch (err) {
		return run(
			{ notes: [] },
			{
				label,
				blocked: `the copy didn't start: ${String(err.message).split("\n").slice(0, 3).join(" ").slice(0, 400)}`,
			},
		);
	}
	try {
		const ctx = {
			http: `http://127.0.0.1:${srv.port}`,
			ws: `ws://127.0.0.1:${srv.port}/ws`,
			pages: [{ name: "own copy", url: `http://127.0.0.1:${srv.port}/` }],
			agentDir: srv.agentDir,
			dataDir: srv.dataDir,
			memoryDir: join(srv.agentDir, "memory", "daily"),
			copyCwd: join(srv.root, "copy-cwd"),
			clientId: (name) => `carry-on:release-smoke-${name}`,
			reply: { prompt: F2_PROMPT, expectText: /SMOKE-DONE/, streams: true, tool: F2_TOOL },
			limits: LIMITS,
			restart: () => srv.restart(),
			notes: [],
		};
		return await run(ctx, { label });
	} finally {
		await srv.stop().catch(() => {});
		srv.mock?.close().catch(() => {}); // not awaited: a planted model that never answers keeps its request open
		rmSync(srv.root, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await beforeRun());
