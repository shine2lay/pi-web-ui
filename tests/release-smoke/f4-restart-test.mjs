/**
 * F4 a chat survives a restart (before-run only: it restarts its own copy, as carry-on-restart-test.mjs
 * does). A normal chat is made busy with a long streamed reply, the copy restarts the way pi-web-deploy
 * restarts it (SIGTERM, with a restart reason), and the cut-off turn must carry on by itself: the
 * server adds its carry-on note to the chat and the chat answers it, with no window open.
 * The live run has no F4 check: it would need a turn planted before the real restart.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { clip, test, waitFor } from "./harness.mjs";

export const CARRY_ON_NOTE = "pi-web-ui restarted at";
export const F4_HELLO = "SMOKE-F4 hello";
export const F4_BUSY = "SMOKE-F4-BUSY keep writing";
export const F4_CARRIED = "SMOKE-CARRIED-ON";

const textOf = (m) =>
	typeof m?.content === "string"
		? m.content
		: (m?.content
				?.filter?.((p) => p?.type === "text")
				.map((p) => p.text)
				.join(" ") ?? "");

/** The chat's messages from its transcript on disk: [{ role, text }]. */
function transcript(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "message" && e.message)
			.map((e) => ({ role: e.message.role, text: textOf(e.message) }));
	} catch {
		return [];
	}
}

/** A protocol window (Node's WebSocket) on the copy, keeping its current chat's snapshot. */
async function connect(wsUrl, clientId, ms) {
	const ws = new WebSocket(wsUrl);
	const w = { ws, state: null, ready: false, send: (m) => ws.send(JSON.stringify(m)) };
	ws.addEventListener("message", (ev) => {
		let m;
		try {
			m = JSON.parse(String(ev.data));
		} catch {
			return;
		}
		if (m.type === "ready") w.ready = true;
		else if (m.type === "snapshot") w.state = m.state ?? null;
		else if (m.type === "snapshot_delta") {
			const st = w.state;
			if (st && st.rev === m.baseRev && m.conversationId === st.conversationId)
				w.state = { ...st, ...m.state, messages: [...(st.messages ?? []), ...(m.appended ?? [])] };
			else w.send({ type: "get_state" });
		}
	});
	await waitFor(() => ws.readyState === 1, ms, "socket to the copy");
	w.send({ type: "hello", clientId, locale: "en" });
	await waitFor(() => w.ready && w.state?.conversationId, ms, "ready and a first snapshot from the copy");
	return w;
}

test("@flow:F4 a chat survives a restart: a turn cut off by the restart carries on by itself", async (ctx) => {
	const w = await connect(ctx.ws, ctx.clientId("restart"), ctx.limits.readyMs);
	let file;
	try {
		// The window starts on a blank chat of its own (a normal one, not a throwaway: those don't carry on).
		if (w.state.messages?.length || w.state.isEphemeral) {
			const first = w.state.conversationId;
			w.send({ type: "new_chat" });
			await waitFor(
				() => w.state.conversationId !== first && (w.state.messages?.length ?? 0) === 0,
				ctx.limits.readyMs,
				"new chat",
			);
		}
		// The first exchange puts the chat's transcript on disk (pi writes it once there is an answer).
		w.send({ type: "prompt", text: F4_HELLO });
		file = await waitFor(
			() =>
				w.state.isStreaming === false &&
				w.state.sessionFile &&
				transcript(w.state.sessionFile).some((m) => m.role === "assistant")
					? w.state.sessionFile
					: null,
			ctx.limits.replyMs,
			"answer to the chat's first message",
		);
		w.send({ type: "prompt", text: F4_BUSY });
		await waitFor(
			() => w.state.isStreaming === true && transcript(file).filter((m) => m.role === "user").length >= 2,
			ctx.limits.replyStartMs,
			"busy turn",
		);
		// Let the reply stream for a moment, so the restart cuts it off mid-reply.
		await sleep(2000);
	} finally {
		w.ws.close();
	}
	writeFileSync(
		join(ctx.dataDir, "restart-reason.json"),
		JSON.stringify({ reason: "release smoke restart", at: new Date().toISOString() }),
	);
	const t0 = Date.now();
	await ctx.restart();
	const carried = await waitFor(
		() => {
			const msgs = transcript(file);
			const i = msgs.findLastIndex((m) => m.role === "user" && m.text.startsWith(CARRY_ON_NOTE));
			return i >= 0 && msgs.slice(i + 1).some((m) => m.role === "assistant" && m.text.includes(F4_CARRIED))
				? msgs[i].text
				: null;
		},
		ctx.limits.carryOnMs,
		`carry-on note and answer in the cut-off chat after the restart${existsSync(file) ? "" : " (its transcript is gone)"}`,
	);
	return `restarted; the cut-off chat got "${clip(carried, 70)}" and answered it ${((Date.now() - t0) / 1000).toFixed(1)} s after the restart began`;
});
