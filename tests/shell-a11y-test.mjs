/* shell-a11y: the app shell (top bar + status bar) passes axe and the 24 px target size on every page (frontend #295).
 * Real server and page; the only stand-in is the roles count the server pushes (5 asks), so the Roles tab shows
 * its badge and its "waiting on you" name. For the Roles view and the chat view, 1440 and 390 px, light and dark:
 *   S1 axe aria-required-parent: a view button in the top bar's toolbar is never a tab without a tablist;
 *   S2 axe label-content-name-mismatch (experimental, so run by rule name): a named control's name holds its
 *      visible text (the Roles tab with its count);
 *   S3 axe color-contrast: top bar and status bar text reads at WCAG AA in both themes;
 *   S4 every visible control in the top bar and status bar (the folder chip included) is at least 24x24 px,
 *      read in one page.evaluate (a redraw between reads can't detach the node).
 * Any other serious or critical axe finding on the shell fails too. Scoped to .topbar and .statusbar: the
 * pages' own bodies have their own tests (e.g. roles-by-project-test.mjs).
 * Run after build: scripts/sealed.sh node tests/shell-a11y-test.mjs
 */
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH) throw new Error("Chrome is required");

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
if (!existsSync(AXE)) throw new Error(`axe-core not found at ${AXE}`);
const ASKS = 5;
const SHELL = [".topbar", ".statusbar"];

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
	if (!ok) failures++;
};

const srv = await ownServer({ name: "shell-a11y", env: { PI_WEB_TOKEN: "", PI_IDENTITY_REINDEX: "0" } });
const hardStop = setTimeout(() => {
	console.error("FAIL bounded fixture timeout");
	process.exitCode = 1;
	void srv.stop();
}, 240000);
hardStop.unref();

/** One page at `view`, with the server's roles count replaced by ASKS. */
async function openPage(browser, { view, width, theme }) {
	const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", timezoneId: "UTC" });
	await context.addInitScript((t) => {
		if (t === "light") localStorage.setItem("pi-web-ui:theme", "flow-light");
	}, theme);
	await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			if (typeof message === "string" && message.startsWith('{"type":"roles"')) {
				ws.send(JSON.stringify({ type: "roles", asks: ASKS, checkedAt: Date.now() }));
				return;
			}
			ws.send(message);
		});
	});
	const page = await context.newPage();
	await page.goto(`${srv.http}/?view=${view}`);
	await page.locator(".topbar .roles-badge").first().waitFor({ timeout: 20000 });
	await page.locator(".statusbar .status-cwd").first().waitFor({ timeout: 10000 });
	await page.addScriptTag({ path: AXE });
	return { context, page };
}

async function shellCase(browser, view, width, theme) {
	const tag = `${view} ${width}px ${theme}`;
	const { context, page } = await openPage(browser, { view, width, theme });
	try {
		const r = await page.evaluate(async (shell) => {
			const context = { include: shell.map((s) => [s]) };
			const tags = await window.axe.run(context, {
				runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
				resultTypes: ["violations"],
			});
			const byName = await window.axe.run(context, {
				runOnly: { type: "rule", values: ["label-content-name-mismatch"] },
				resultTypes: ["violations"],
			});
			const findings = [...tags.violations, ...byName.violations]
				.filter((v) => v.impact === "serious" || v.impact === "critical")
				.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
			const controls = "button, a[href], input, select, summary, [role=button], [role=tab], [role=radio]";
			const small = [];
			for (const root of shell.map((s) => document.querySelector(s)))
				for (const el of root?.querySelectorAll(controls) ?? []) {
					if (!el.getClientRects().length || el.closest("[hidden]")) continue;
					if (el.parentElement?.closest(controls)) continue;
					const b = el.getBoundingClientRect();
					const name = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.className;
					if (b.width < 24 || b.height < 24) small.push(`${name} ${b.width.toFixed(1)}x${b.height.toFixed(1)}`);
				}
			const cwd = document.querySelector(".statusbar .status-cwd")?.getBoundingClientRect();
			const roles = document.querySelector(".topbar .roles-tab");
			return {
				findings,
				small,
				cwd: cwd ? [cwd.width, cwd.height] : null,
				rolesName: roles?.getAttribute("aria-label") ?? roles?.textContent ?? null,
			};
		}, SHELL);
		const of = (id) => r.findings.filter((f) => f.id === id);
		const say = (list) => list.map((f) => `${f.id}: ${f.nodes.join(", ")}`).join(" | ");
		check(
			`S1 ${tag}: no aria-required-parent`,
			of("aria-required-parent").length === 0,
			say(of("aria-required-parent")),
		);
		check(
			`S2 ${tag}: no label-content-name-mismatch (Roles tab name ${JSON.stringify(r.rolesName)})`,
			of("label-content-name-mismatch").length === 0,
			say(of("label-content-name-mismatch")),
		);
		check(`S3 ${tag}: no color-contrast finding`, of("color-contrast").length === 0, say(of("color-contrast")));
		const other = r.findings.filter(
			(f) => !["aria-required-parent", "label-content-name-mismatch", "color-contrast"].includes(f.id),
		);
		check(`S ${tag}: no other serious or critical axe finding`, other.length === 0, say(other));
		check(
			`S4 ${tag}: the folder chip is at least 24 px tall`,
			r.cwd !== null && r.cwd[1] >= 24,
			r.cwd ? `${r.cwd[0].toFixed(1)}x${r.cwd[1].toFixed(1)}` : "no folder chip",
		);
		check(`S4 ${tag}: every shell control at least 24x24 px`, r.small.length === 0, r.small.slice(0, 5).join(" | "));
	} finally {
		await context.close();
	}
}

let chrome;
try {
	chrome = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	for (const view of ["roles", "chat"])
		for (const width of [1440, 390]) for (const theme of ["light", "dark"]) await shellCase(chrome, view, width, theme);
} catch (error) {
	console.error(`FAIL ${error instanceof Error ? error.message : "fixture error"}`);
	failures++;
} finally {
	clearTimeout(hardStop);
	await chrome?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `shell-a11y: ${failures} failed` : "shell-a11y: all passed");
process.exitCode = failures ? 1 : 0;
