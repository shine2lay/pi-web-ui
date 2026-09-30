/**
 * phone-chat.mjs: what the phone tests and measurements share: a test server of its own with a
 * stand-in model, seeded chats, the slow link in front of it, and page helpers.
 *
 *   const kit = await startPhoneServer({ name: "phone-x" });
 *   kit.srv, kit.link (slow-link.mjs), kit.seeded (the seeded chat's file), kit.mock
 *   await hookSocket(page)                 // before goto: window.__ws / window.__frames / __sockets
 *   await openChatOnPage(page, file)       // switch the page to a chat and wait for its snapshot
 *   await chatReady(page)                  // the chat shows and the message box can be used
 *
 * The stand-in model answers "STREAM-<n>-<ms>[-<tag>]" with n numbered lines, one every ms
 * milliseconds ("Line 0001 <tag>: ...", then "STREAM-DONE <tag>"), so a test can tell how far that
 * reply has got on the page; anything else gets a short answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownServer } from "./own-server.mjs";
import { startSlowLink } from "./slow-link.mjs";

/** One line of a streamed reply. `tag` (4 characters) names the reply, so a test can tell it from an
 *  earlier one (a long chat shows only its latest messages, so counting them proves nothing). */
export const STREAM_LINE = (i, tag = "r000") =>
	`Line ${String(i).padStart(4, "0")} ${tag}: the stand-in model keeps typing so the phone has something to follow.\n\n`;

let replyCount = 0;
/** A new reply's tag. */
export function newReplyTag() {
	replyCount += 1;
	return `r${String(replyCount % 1000).padStart(3, "0")}`;
}

/** How many lines of STREAM-<n>-<ms> the model has sent so far (the test keeps the clock). */
export const streamState = { startedAt: 0, lines: 0, total: 0 };

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const WORDS = (
	"the a to of and in is it that for on with as this by be are from at or an was not but can all we will " +
	"your more one which about if do has its our so what up out when there file line code test page chat " +
	"phone server model reply message button screen layout width height slow fast link network socket " +
	"frame state change value build check run step part list table path folder window menu note tap " +
	"type text word letter cursor keyboard bottom top bar send stop open close load time number size"
).split(" ");

/** Made-up prose of about `chars` characters: as varied as ordinary writing, so it compresses like it. */
export function prose(seed, chars) {
	let x = seed * 2654435761;
	const out = [];
	let len = 0;
	while (len < chars) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		const w = WORDS[x % WORDS.length] + ((x >>> 12) % 13 === 0 ? `${(x >>> 4) % 1000}. ` : " ");
		out.push(w);
		len += w.length;
	}
	return out.join("");
}

/**
 * A made-up chat that renders like a real one: headings, lists, code, a table. No real text.
 * bulky: each answer also gets that many characters of made-up prose (a chat whose messages are big).
 */
export function seedChat(sessionsDir, cwd, { id, exchanges = 120, name, bulky = 0 } = {}) {
	const t0 = Date.parse("2026-09-01T00:00:00.000Z");
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd })];
	let parentId = null;
	let n = 0;
	const push = (message) => {
		const eid = `p${String(n).padStart(5, "0")}`;
		const ts = t0 + n * 1000;
		lines.push(
			JSON.stringify({
				type: "message",
				id: eid,
				parentId,
				timestamp: new Date(ts).toISOString(),
				message: { ...message, timestamp: ts },
			}),
		);
		parentId = eid;
		n += 1;
	};
	const code = (k) =>
		Array.from(
			{ length: 18 },
			(_, i) => `  const value${i} = compute(${k}, ${i}); // step ${i} of the seeded example`,
		).join("\n");
	for (let k = 0; k < exchanges; k++) {
		push({
			role: "user",
			content: [{ type: "text", text: `Seeded question ${k}: how does part ${k} of the example work?` }],
		});
		const text = [
			`## Part ${k}`,
			``,
			`Seeded answer ${k}. This paragraph is here so the chat has ordinary text to lay out, wrap and scroll, the way a real answer does on a phone screen.`,
			``,
			`- first point about part ${k}`,
			`- second point, a little longer so it wraps on a narrow phone screen`,
			`- third point`,
			``,
			"```js",
			`function part${k}() {`,
			code(k),
			`}`,
			"```",
			``,
			`| column | value |`,
			`| --- | --- |`,
			`| part | ${k} |`,
			`| state | seeded |`,
			``,
			...(bulky ? [prose(k + 1, bulky), ``] : []),
			`SEEDED-END-${k}`,
		].join("\n");
		// The last answer also thinks and runs a tool first, so the phone checks see those rows too.
		if (k === exchanges - 1) {
			const callId = `call_seed_${k}`;
			push({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Seeded thinking about part ${k}: look at the files first.` },
					{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls -la" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock-model",
				usage,
				stopReason: "toolUse",
			});
			push({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: "total 2\nseeded-file-a.txt\nseeded-file-b.txt" }],
				isError: false,
			});
		}
		push({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock-model",
			usage,
			stopReason: "stop",
		});
	}
	const file = join(sessionsDir, `2026-09-01T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	return { file, id, name, lastMarker: `SEEDED-END-${exchanges - 1}` };
}

export async function startPhoneServer({ name = "phone", exchanges = 120, link = {}, env = {}, verbose = false } = {}) {
	// The chats live in a folder of their own, named to the server when it starts.
	const sessionsDir = mkdtempSync(join(tmpdir(), `${name}-sessions-`));
	process.on("exit", () => rmSync(sessionsDir, { recursive: true, force: true }));
	let workCwd = "";
	let seeded = null;
	const srv = await ownServer({
		name,
		verbose,
		env: { PI_CODING_AGENT_SESSION_DIR: sessionsDir, ...env },
		mock: async ({ lastUser, sideRequest }) => {
			if (sideRequest) return "Phone test chat";
			const m = lastUser.match(/STREAM-(\d+)-(\d+)(?:-(r\d{3}))?/);
			if (m) {
				const total = Number(m[1]);
				const every = Number(m[2]);
				const tag = m[3] ?? "r000";
				const text = Array.from({ length: total }, (_, i) => STREAM_LINE(i + 1, tag)).join("") + `STREAM-DONE ${tag}`;
				streamState.startedAt = Date.now();
				streamState.total = total;
				streamState.every = every;
				// One line per piece: the test can tell from the clock how many lines have been sent.
				return { text, stream: { everyMs: every, pieceChars: STREAM_LINE(1).length } };
			}
			await new Promise((r) => setTimeout(r, 300));
			return `Short answer to ${lastUser.slice(0, 20).replace(/[^\w -]/g, "")}.`;
		},
		prepare: async ({ workdir }) => {
			workCwd = workdir;
			seeded = seedChat(sessionsDir, workdir, {
				id: "01a0f000-0000-7000-8000-00000000a001",
				exchanges,
				name: "seeded",
			});
		},
	});
	return { srv, sessionsDir, workCwd, seeded, link: await startSlowLink({ target: srv.port, ...link }) };
}

/** Lines of the streamed reply the model has sent by now. */
export function linesSentNow() {
	if (!streamState.startedAt) return 0;
	return Math.min(streamState.total, Math.floor((Date.now() - streamState.startedAt) / streamState.every) + 1);
}

/** Before goto: keep the page's socket(s) reachable from the test and count them. */
export async function hookSocket(page) {
	await page.addInitScript(() => {
		window.__frames = [];
		window.__frameBytes = {}; // bytes received per message type (only the type names: no content)
		window.__frameAt = {}; // when (ms since the page started loading) each type first arrived
		window.__sockets = 0;
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...a) {
				super(...a);
				window.__ws = this;
				window.__sockets += 1;
				this.addEventListener("message", (ev) => {
					window.__lastFrameAt = Date.now();
					if (typeof ev.data === "string") {
						const type = /^\{"type":"([\w-]+)"/.exec(ev.data)?.[1] ?? "other";
						window.__frameBytes[type] = (window.__frameBytes[type] ?? 0) + ev.data.length;
						window.__frameAt[type] ??= Math.round(performance.now());
						// When the end marker of the test reply being watched (window.__streamTag) first arrived
						// (the test's own marker, no chat text).
						if (!window.__streamDoneAt && window.__streamTag && ev.data.includes(`STREAM-DONE ${window.__streamTag}`))
							window.__streamDoneAt = Date.now();
						window.__frames.push(ev.data.length > 200 ? ev.data.slice(0, 200) : ev.data);
						if (window.__frames.length > 4000) window.__frames.splice(0, 2000);
					}
				});
			}
		};
	});
}

/** Switch the page to a chat (by file) and wait for its snapshot. */
export async function openChatOnPage(page, file, timeoutMs = 120_000) {
	await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1, null, { timeout: 60_000 });
	return page.evaluate(
		async ({ path, timeoutMs }) => {
			const from = window.__frames.length;
			window.__ws.send(JSON.stringify({ type: "switch_session", path }));
			const t0 = Date.now();
			while (Date.now() - t0 < timeoutMs) {
				const after = window.__frames.slice(from);
				const failed = after.find((f) => f.startsWith('{"type":"switch_failed"'));
				if (failed) throw new Error(`the chat didn't open: ${failed.slice(0, 200)}`);
				if (after.some((f) => f.startsWith('{"type":"switch_done"'))) return Date.now() - t0;
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error("the chat didn't open in time");
		},
		{ path: file, timeoutMs },
	);
}
