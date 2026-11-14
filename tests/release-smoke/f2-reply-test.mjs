/**
 * F2 send a message and get a reply: in a new throwaway chat, the message typed into the composer gets
 * a reply that streams in, (before-run) a tool call runs and shows, and the turn ends. The throwaway
 * chat is closed and its folder removed afterwards; no other chat is opened, written or marked read.
 * A reply that fails with the model provider's own error (429, 5xx, overloaded) is unsure, not red.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, openApp, pageSend, parkOnBlankChat, removeParkedFolder, smokeState } from "./app-page.mjs";
import { clip, holds, test, unsure, waitFor } from "./harness.mjs";

const PROVIDER_TROUBLE =
	/\b(429|500|502|503|504|529)\b|overload|rate.?limit|too many requests|temporarily unavailable|service unavailable|internal server error/i;

/** The newest assistant message after the last user message, from the page's snapshot. */
const lastAnswer = (page) =>
	smokeState(page, () => {
		const msgs = window.__smoke.state?.messages ?? [];
		const i = msgs.map((m) => m.role).lastIndexOf("user");
		const a = i < 0 ? null : msgs.slice(i + 1).findLast((m) => m.role === "assistant");
		if (!a) return null;
		const parts = Array.isArray(a.content) ? a.content : [{ type: "text", text: String(a.content ?? "") }];
		const text = parts
			.filter((p) => p?.type === "text")
			.map((p) => p.text)
			.join("")
			.trim();
		return { text, stopReason: a.stopReason ?? null, errorMessage: a.errorMessage ?? null };
	});
const streaming = (page) => smokeState(page, () => window.__smoke.state?.isStreaming === true);
// How much text the chat shows; it grows piece by piece while a reply streams in.
const shownText = (page) => page.evaluate(() => document.querySelector(".messages")?.textContent ?? "");

async function makeThrowawayChat(page, ctx) {
	const before = await smokeState(page, () => window.__smoke.state?.conversationId ?? null);
	await pageSend(page, { type: "new_chat", ephemeral: true });
	await waitFor(
		() =>
			smokeState(
				page,
				(b) => window.__smoke.state?.conversationId !== b && window.__smoke.state?.isEphemeral === true,
				before,
			),
		ctx.limits.readyMs,
		"throwaway chat",
	);
	return smokeState(page, () => window.__smoke.state.conversationId);
}

/** Watch the turn: pieces of the reply on screen while it streams, then its end. */
async function watchTurn(page, ctx) {
	const lengths = new Set();
	await waitFor(
		async () => (await streaming(page)) || (await lastAnswer(page)),
		ctx.limits.replyStartMs,
		"start of the reply",
	);
	const end = Date.now() + ctx.limits.replyMs;
	for (;;) {
		if (await page.locator(".btn.stop").count()) {
			const n = (await shownText(page)).length;
			if (n) lengths.add(n);
		}
		const a = await lastAnswer(page);
		if (!(await streaming(page)) && a && (a.text || a.errorMessage || a.stopReason === "error"))
			return { answer: a, pieces: lengths.size };
		if (Date.now() >= end) {
			const seen = await smokeState(page, () => {
				const s = window.__smoke.state;
				return `streaming ${s?.isStreaming}, messages ${(s?.messages ?? []).map((m) => `${m.role}${m.stopReason ? `:${m.stopReason}` : ""}`).join(" ")}`;
			});
			throw new Error(
				`the chat started replying but the turn never ended within ${Math.round(ctx.limits.replyMs / 1000)} s (${seen})`,
			);
		}
		await sleep(100);
	}
}

async function checkTool(page, expect) {
	const head = page.locator('.messages .xfold-head[aria-expanded="false"]').last();
	if (await head.count()) await head.click();
	const ok = await holds(
		() =>
			page.evaluate(
				({ name, output }) =>
					[...document.querySelectorAll(".messages .toolcall")].some(
						(t) =>
							t.querySelector(".toolcall-name")?.textContent?.includes(name) &&
							t.querySelector(".toolcall-output")?.textContent?.includes(output),
					),
				expect,
			),
		10_000,
	);
	if (!ok)
		throw new Error(`the reply ended, but its ${expect.name} tool call with output "${expect.output}" never showed`);
}

/** Close the throwaway chat (window parks on a blank chat first), then make sure its folder is gone. */
async function closeThrowaway(page, ctx, conv, parked) {
	const onIt = () => smokeState(page, (c) => window.__smoke.state?.conversationId === c, conv);
	if (await onIt()) {
		const park = await parkOnBlankChat(page, { stillOn: onIt, waitMs: ctx.limits.readyMs, parked });
		if (!park.moved) return `left the throwaway chat open: couldn't move to a blank chat first (${park.why})`;
	}
	const listed = await holds(
		async () => !(await smokeState(page, (c) => window.__smoke.conversations.some((x) => x.id === c), conv)),
		10_000,
	);
	if (!listed) await pageSend(page, { type: "dismiss_conversation", id: conv });
	const dir = join(ctx.agentDir, "ephemeral-sessions", conv);
	await holds(() => !existsSync(dir), 10_000, 250);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		ctx.notes.push(`the server left the throwaway chat's folder; removed it`);
	}
	return null;
}

test("@flow:F2 send a message and get a reply: text streams, a tool call runs and shows, the turn ends", async (ctx) => {
	const browser = await launchBrowser();
	let opened = null;
	let conv = null;
	let finished = false;
	const parked = [];
	try {
		opened = await openApp(browser, `${ctx.http}/`, ctx.clientId("reply"), {
			readyMs: ctx.limits.readyMs,
			attached: true,
		});
		const { page } = opened;
		conv = await makeThrowawayChat(page, ctx);
		const box = page.locator(".inputbox textarea");
		await box.waitFor({ timeout: ctx.limits.readyMs });
		await box.fill(ctx.reply.prompt);
		await box.press("Enter");
		const { answer, pieces } = await watchTurn(page, ctx);
		finished = true;
		const problem =
			answer.errorMessage ||
			(answer.stopReason === "error" || answer.stopReason === "aborted"
				? `the reply ended with "${answer.stopReason}"`
				: "");
		if (problem) {
			if (PROVIDER_TROUBLE.test(problem)) throw unsure(`the model provider had trouble: ${clip(problem, 200)}`);
			throw new Error(`the reply failed: ${clip(problem, 200)}`);
		}
		if (!answer.text) throw new Error("the reply came back empty");
		if (ctx.reply.expectText && !ctx.reply.expectText.test(answer.text))
			throw new Error(`the reply is not the expected one: "${clip(answer.text, 60)}"`);
		if (!(await page.locator(".btn.send").count()))
			throw new Error("the turn ended, but the composer still shows no send button");
		if (ctx.reply.streams && pieces < 2)
			throw new Error(`the reply never streamed in: ${pieces} piece(s) seen while it ran`);
		if (ctx.reply.tool) await checkTool(page, ctx.reply.tool);
		return `replied "${clip(answer.text, 40)}"${ctx.reply.streams ? ` in ${pieces} pieces` : ""}${ctx.reply.tool ? `, ${ctx.reply.tool.name} tool call shown` : ""}`;
	} finally {
		if (opened && conv) {
			const { page } = opened;
			// A running chat can't be closed (moving off it lists it in every window): stop its turn first.
			if (!finished && (await streaming(page).catch(() => false))) {
				await pageSend(page, { type: "abort" }).catch(() => {});
				finished = Boolean(await holds(async () => !(await streaming(page)), 15_000));
			} else finished = true;
			const left = finished
				? await closeThrowaway(page, ctx, conv, parked).catch((e) => `couldn't close the throwaway chat: ${e.message}`)
				: "left the throwaway chat open: its turn wouldn't stop";
			if (left) ctx.notes.push(left);
		}
		await opened?.ctx.close().catch(() => {});
		await browser.close().catch(() => {});
		for (const p of parked) await removeParkedFolder(ctx.agentDir, p, ctx.notes);
	}
});
