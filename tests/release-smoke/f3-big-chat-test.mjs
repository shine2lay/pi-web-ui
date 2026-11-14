/**
 * F3 open an existing big chat with pictures: a copy of QA's fixed 100 MB chat opens (a snapshot under
 * 1 MB, pictures as placeholders, never inline), scrolls back, and every one of its pictures loads when
 * scrolled to. The copy is closed (its window parks on a blank chat first, so no chat is marked read),
 * its file and folder are deleted and pi-memory's summary of it is taken out again.
 */
import { rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { copyChat, sessionsFolder, takeOutMemorySummary, verifiedFixture } from "./big-chat-copy.mjs";
import { gatherPictures, scrollToPictures } from "./big-chat-walk.mjs";
import { launchBrowser, openApp, pageSend, parkOnBlankChat, removeParkedFolder, smokeState } from "./app-page.mjs";
import { holds, test, waitFor } from "./harness.mjs";

/** Copy ids the running list holds (or the page has shown) for this file. */
const copyIds = (page, file) =>
	smokeState(
		page,
		(p) => {
			const s = window.__smoke;
			const ids = s.conversations.filter((c) => c.sessionPath === p && c.live).map((c) => c.id);
			if (s.state?.sessionFile === p && s.state.conversationId) ids.push(s.state.conversationId);
			return { ids: [...new Set(ids)], onCopy: s.state?.sessionFile === p, current: s.state?.conversationId ?? null };
		},
		file,
	);

/** Close every open chat of the copy without closing the chat the window is on. Returns a note or null. */
async function closeCopy(page, file, waitMs, parked) {
	let seen = await copyIds(page, file);
	if (seen.onCopy) {
		const park = await parkOnBlankChat(page, {
			stillOn: async () => (await copyIds(page, file)).onCopy,
			waitMs,
			parked,
		});
		if (!park.moved) return `left the copy open: couldn't move to a blank chat first (${park.why})`;
		await holds(async () => !(await copyIds(page, file)).ids.length, 10_000);
		seen = await copyIds(page, file);
	}
	for (const id of seen.ids) {
		if (id === seen.current) continue;
		await pageSend(page, { type: "dismiss_conversation", id });
	}
	const gone = await holds(async () => !(await copyIds(page, file)).ids.length, 10_000);
	return gone ? null : "the copy still shows as open after closing it";
}

test("@flow:F3 open an existing big chat with pictures: it opens, scrolls and its pictures load", async (ctx) => {
	const fixture = await verifiedFixture();
	const folder = sessionsFolder(ctx.agentDir, ctx.copyCwd);
	const copy = join(folder, "release-smoke-copy.jsonl");
	const browser = await launchBrowser();
	let opened = null;
	let copyId = null;
	let leftOpen = null;
	const parked = [];
	try {
		// Attached: a switch sent before the attach finishes can be refused.
		opened = await openApp(browser, `${ctx.http}/`, ctx.clientId("bigchat"), {
			readyMs: ctx.limits.readyMs,
			attached: true,
		});
		const { page } = opened;
		// A copy an earlier run left open: close it before its file is replaced.
		const stale = await closeCopy(page, copy, ctx.limits.readyMs, parked);
		if (stale) {
			leftOpen = stale;
			throw new Error(`a copy an earlier run left open couldn't be closed: ${stale}`);
		}
		copyId = await copyChat(fixture.path, copy, ctx.copyCwd);
		const t0 = Date.now();
		await page.evaluate((p) => {
			window.__smoke.want = p;
		}, copy);
		await pageSend(page, { type: "switch_session", path: copy });
		await waitFor(
			() =>
				page.evaluate(
					() =>
						!!window.__smoke.wantSnap &&
						document.querySelectorAll(".messages .msg, .messages .quiet-turn-row").length > 0,
				),
			ctx.limits.bigchatMs,
			"drawn copy of the big chat",
		);
		const snap = await page.evaluate(() => window.__smoke.wantSnap);
		const what = `a ${Math.round(statSync(copy).size / 1e6)} MB copy opened in ${((Date.now() - t0) / 1000).toFixed(1)} s (snapshot ${Math.round(snap.len / 1024)} KB)`;
		if (snap.inline > 0) throw new Error(`${what}, but it sent ${snap.inline} pictures inline instead of placeholders`);
		if (snap.len >= 1 << 20) throw new Error(`${what}: the snapshot is over 1 MB`);
		const want = fixture.pictures.length;
		const pictures = await gatherPictures(page, { expect: want, ms: ctx.limits.bigchatMs });
		if (pictures.length < want)
			throw new Error(`${what}, but only ${pictures.length} of its ${want} pictures showed up when scrolling back`);
		const loaded = await scrollToPictures(page, pictures.slice(0, want));
		const fine = loaded.filter((p) => p.loaded).length;
		const bad = [...new Set(opened.pictureStatuses.filter((s) => s !== 200 && s !== 304))];
		if (fine < want || bad.length)
			throw new Error(
				`${what}; ${fine} of ${want} pictures loaded when scrolled to${bad.length ? `; picture requests answered ${bad.join(", ")}` : ""}`,
			);
		return `${what}; ${fine} of ${want} pictures loaded when scrolled to`;
	} finally {
		if (opened && copyId)
			leftOpen = await closeCopy(opened.page, copy, ctx.limits.readyMs, parked).catch(
				(e) => `couldn't close the copy: ${e.message}`,
			);
		await opened?.ctx.close().catch(() => {});
		await browser.close().catch(() => {});
		for (const p of parked) await removeParkedFolder(ctx.agentDir, p, ctx.notes);
		// Never delete a file a chat still has open.
		if (leftOpen) ctx.notes.push(leftOpen);
		else {
			rmSync(copy, { force: true });
			try {
				rmdirSync(folder);
			} catch {
				/* not empty or gone */
			}
		}
		if (copyId && !leftOpen) {
			const removed = await takeOutMemorySummary(ctx.memoryDir, copyId.slice(0, 8), ctx.limits.memoryWatchMs);
			if (removed) ctx.notes.push(`pi-memory wrote a summary of the copy into ${removed}; took it out again`);
		}
	}
});
