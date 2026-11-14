/**
 * F1 open the app: at every address the run checks, the page loads, its socket says ready, the chat
 * list shows and no "page version differs" banner shows. Read-only: the window starts on a blank chat
 * of its own (carry-on: client id) and opens nothing.
 */
import { launchBrowser, openApp } from "./app-page.mjs";
import { messageOf, test, unsure } from "./harness.mjs";

async function openOne(browser, ctx, url) {
	const opened = await openApp(browser, url, ctx.clientId("page"), { readyMs: ctx.limits.readyMs });
	try {
		const { page } = opened;
		// The running list comes a moment after ready; the list draws at least the window's own chat.
		await page
			.waitForFunction(
				() => window.__smoke.lists > 0 && document.querySelectorAll(".lp-panel .lp-row").length > 0,
				null,
				{
					timeout: ctx.limits.readyMs,
				},
			)
			.catch(() => {
				throw new Error("the chat list never showed (no running list, or no row in the left panel)");
			});
		await page.waitForTimeout(1500);
		if (await page.locator(".protocol-banner").count())
			throw new Error("shows the version banner (the page and the server differ)");
		if (opened.errors.length)
			ctx.notes.push(`${new URL(url).host}: page errors: ${opened.errors.slice(0, 2).join(" | ")}`);
		return `${await page.locator(".lp-panel .lp-row").count()} rows in the chat list`;
	} finally {
		await opened.ctx.close().catch(() => {});
	}
}

test("@flow:F1 open the app: page loads, socket ready, chat list shows, no version banner", async (ctx) => {
	const browser = await launchBrowser();
	const seen = [];
	try {
		for (const { name, url } of ctx.pages) {
			try {
				seen.push({ name, url, ok: true, why: await openOne(browser, ctx, url) });
			} catch (err) {
				seen.push({ name, url, ok: false, why: messageOf(err) });
			}
		}
	} finally {
		await browser.close().catch(() => {});
	}
	const bad = seen.filter((s) => !s.ok);
	if (!bad.length) return seen.map((s) => `${s.name}: ${s.why}`).join("; ");
	// Another address fails while the server's own works: is it the route (tunnel, DNS), not pi-web-ui?
	const own = seen.find((s) => s.url.startsWith(ctx.http));
	if (own?.ok) {
		const routeDown = [];
		for (const s of bad) {
			try {
				const res = await fetch(new URL("/api/health", s.url), { signal: AbortSignal.timeout(15_000) });
				if (!res.ok) routeDown.push(`${s.name} answers ${res.status}`);
			} catch (err) {
				routeDown.push(`${s.name} doesn't answer (${messageOf(err)})`);
			}
		}
		if (routeDown.length === bad.length)
			throw unsure(`loads at ${own.name}, but the route is down, not pi-web-ui: ${routeDown.join("; ")}`);
	}
	throw new Error(bad.map((s) => `${s.name}: ${s.why}`).join("; "));
});
