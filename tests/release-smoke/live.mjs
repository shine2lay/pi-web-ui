/**
 * The live run: `node tests/release-smoke/live.mjs`, right after an install, no arguments. It checks
 * the live app at both addresses (the public site and 127.0.0.1) for F1-F3, keeping Ops's rules:
 * every window's socket uses a "carry-on:" client id; no real chat is opened, written or moved; F2
 * sends one tiny real prompt in a throwaway chat it closes again (its files gone); F3 opens a copy of
 * QA's fixed big chat and deletes it after; checks wait on conditions with generous limits (busy is
 * not broken right after a restart). F4 has no live check (it needs a turn planted before the restart).
 * Exit 0 all passed, 1 any failed, 3 none failed but some could not be checked (model provider down,
 * public route down, Chrome or QA's fixture missing).
 * Plain configuration (defaults are the live app): PI_WEB_SMOKE_PUBLIC_URL, PI_WEB_SMOKE_LOCAL_URL,
 * PI_WEB_SMOKE_AGENT_DIR (the app's pi agent folder), PI_WEB_SMOKE_FIXTURE_DIR (QA's big chat).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./harness.mjs";
import "./f1-open-app-test.mjs";
import "./f2-reply-test.mjs";
import "./f3-big-chat-test.mjs";

const env = process.env;
const local = new URL(env.PI_WEB_SMOKE_LOCAL_URL || "http://127.0.0.1:8787/");
const publicSite = new URL(env.PI_WEB_SMOKE_PUBLIC_URL || "https://pi.wai2shine.com/");
const agentDir = env.PI_WEB_SMOKE_AGENT_DIR || join(homedir(), ".pi", "agent");

const ctx = {
	http: local.origin,
	ws: `${local.protocol === "https:" ? "wss" : "ws"}://${local.host}/ws`,
	pages: [
		{ name: "public site", url: publicSite.href },
		{ name: local.host, url: local.href },
	],
	agentDir,
	memoryDir: join(agentDir, "memory", "daily"),
	copyCwd: join(homedir(), ".cache", "pi-web-ui-smoke", "copy-cwd"),
	clientId: (name) => `carry-on:release-smoke-${name}`,
	reply: { prompt: "Reply with just OK", expectText: /\bok\b/i, streams: false, tool: null },
	limits: { readyMs: 120_000, replyStartMs: 120_000, replyMs: 180_000, bigchatMs: 180_000, memoryWatchMs: 15_000 },
	notes: [],
};

process.exit(await run(ctx, { label: `live run on ${publicSite.host} and ${local.host}` }));
