// Actual component + same-input supplied-reference checks. All inputs are fictional.
// Run: scripts/sealed.sh node --import tsx tests/roles-exact-test.mjs [output-directory] [all|component|reference]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { readRoleFont } from "../web/roles-design-assets.ts";
import { installInitialSendHold } from "./roles-u0/initial-clock.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, ".test-results/roles-exact"));
const phase = process.argv[3] ?? "all";
assert.ok(["all", "component", "reference"].includes(phase), "phase must be all, component or reference");
mkdirSync(output, { recursive: true });
const assets =
	process.env.PI_ROLES_DESIGN_ASSETS ??
	join(userInfo().homedir, "company-lab/shared/roles-renderer-u0-2026-10-13/extract");
const fonts = { geist: readRoleFont(assets, "geist"), mono: readRoleFont(assets, "mono") };
if (!process.env.PI_SEALED || !CHROME_PATH) throw new Error("Run sealed with the installed Chrome");
const axe = readFileSync(
	process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js"),
	"utf8",
);
const plugin = {
	name: "exact-font-input",
	setup(b) {
		b.onResolve({ filter: /^virtual:roles-design-fonts$/ }, () => ({ path: "fonts", namespace: "exact" }));
		b.onLoad({ filter: /.*/, namespace: "exact" }, () => ({
			contents: `export const geist=${JSON.stringify(fonts.geist)}; export const mono=${JSON.stringify(fonts.mono)};`,
		}));
	},
};
const compile = async (entry) =>
	(
		await build({
			absWorkingDir: root,
			entryPoints: [entry],
			bundle: true,
			write: false,
			format: "iife",
			platform: "browser",
			jsx: "automatic",
			loader: { ".html": "text" },
			plugins: [plugin],
			define: { "process.env.NODE_ENV": '"production"' },
			logLevel: "silent",
		})
	).outputFiles[0].text;
const app = await compile("tests/roles-exact-harness.tsx");
const fixture = await compile("tests/roles-u0/fixture-entry.js");
const server = createServer((req, res) => {
	const source = req.url === "/app.js" ? app : req.url === "/fixture.js" ? fixture : null;
	res.setHeader("Content-Type", source ? "text/javascript" : "text/html");
	res.end(
		source ??
			'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Isolated Roles check</title></head><body><script src="/app.js"></script></body></html>',
	);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
	executablePath: CHROME_PATH,
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = { component: [], reference: [], errors: [] };
const deadline = setTimeout(() => {
	results.errors.push("Isolated browser check exceeded its 180-second deadline");
	void browser.close();
}, 180_000);
const record = (name) => {
	results.component.push(name);
	console.log(`PASS ${name}`);
};
try {
	if (phase !== "reference") {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1300 }, deviceScaleFactor: 1 });
		await context.route("**/*", (route) =>
			route.request().url().startsWith(origin) ? route.continue() : route.abort(),
		);
		const page = await context.newPage();
		const pageErrors = [];
		page.on("pageerror", (e) => pageErrors.push(e.message));
		const consoleErrors = [];
		page.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 10) consoleErrors.push(message.text());
		});
		await page.goto(origin);
		await page.waitForFunction(() => !!window.rolesExactTest);
		await page.evaluate(() => window.rolesExactTest.deliver());
		const frame = page.frameLocator('iframe[title="Roles"]');
		await frame.locator('button[aria-haspopup="dialog"]').first().waitFor();
		assert.equal(await frame.locator('button[aria-haspopup="dialog"]').count(), 15);
		await page.screenshot({ path: join(output, "desktop.png") });
		record("real component renders all 15 departments with the supplied graph");
		await frame.getByRole("button", { name: /^Ops / }).click();
		const panel = frame.locator('[role="region"]');
		// A script-disabled child also blocks Playwright's child-window retry timer.
		// Observe the real CSS transition from the host; never force-click or enable scripts.
		const settled = () =>
			page.waitForFunction(
				() => {
					const region = document
						.querySelector('iframe[title="Roles"]')
						?.contentDocument?.querySelector('[role="region"]');
					return (
						region?.style.overflowY === "auto" &&
						region.getAnimations({ subtree: true }).every((a) => a.playState !== "running")
					);
				},
				undefined,
				{ timeout: 3000 },
			);
		await panel.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
		try {
			await settled();
		} catch (error) {
			console.log(
				"EXPANSION DIAGNOSTIC",
				JSON.stringify({
					consoleErrors,
					panel: await panel.evaluate((el) => ({
						css: el.getAttribute("style"),
						rect: el.getBoundingClientRect().toJSON(),
					})),
				}),
			);
			throw error;
		}
		await panel.getByRole("link", { name: /full queue/i }).click();
		let state = await page.evaluate(() => window.rolesExactTest.getState());
		assert.deepEqual(state.lastOpen, { file: "/tmp/roles-exact-fixture/ops.jsonl", focus: { kind: "task", id: "1" } });
		const text = await panel.innerText();
		for (const value of ["Contact and reply tracking are not connected yet.", "Not connected", "Spending this week"])
			assert.ok(text.toLowerCase().includes(value.toLowerCase()), value);
		assert.ok(!text.includes("/tmp/"));
		await page.screenshot({ path: join(output, "department.png") });
		record("department sections, missing-data labels and correct home-queue navigation");
		const close = panel.getByRole("button", { name: "Close and return to all departments" });
		await close.focus();
		await page.keyboard.press("Shift+Tab");
		assert.equal(await panel.evaluate((el) => el.contains(el.ownerDocument.activeElement)), true);
		await page.keyboard.press("Escape");
		await panel.waitFor({ state: "hidden" });
		record("keyboard stays within an open panel and Escape closes it");
		await frame.getByRole("button", { name: "You: open your decisions, questions and spending" }).click();
		await panel.getByText("A recorded question for ops", { exact: true }).waitFor();
		await settled();
		assert.equal(await panel.getByRole("button", { name: "Open chat", exact: true }).count(), 2);
		await panel.getByRole("button", { name: "Open chat", exact: true }).first().click();
		assert.equal(
			(await page.evaluate(() => window.rolesExactTest.getState())).lastOpen.file,
			"/tmp/roles-exact-fixture/ops.jsonl",
		);
		await page.screenshot({ path: join(output, "owner-inbox.png") });
		await panel.getByRole("button", { name: "Close and return to all departments" }).click();
		await panel.waitFor({ state: "hidden" });
		record("owner inbox has existing safe Open chat actions, no inline consent");
		for (const mode of ["error", "disconnected", "first-error", "loading", "partial"]) {
			await page.evaluate((mode) => window.rolesExactTest.deliver(mode), mode);
			await frame.getByText(/current (?:total|asks).*unknown/i).waitFor();
			assert.ok(!(await frame.locator("body").innerText()).includes("CANARY-PATH"));
			if (mode === "first-error") await page.screenshot({ path: join(output, "unavailable.png") });
			await page.evaluate(() => window.rolesExactTest.deliver());
			await frame.getByText("2 reported asks", { exact: true }).waitFor();
		}
		record("failed, disconnected, loading and partial states never claim an all-clear");
		await page.evaluate(() => window.rolesExactTest.deliver("crowded"));
		await frame.getByText("55 reported asks", { exact: true }).waitFor();
		await frame.getByRole("button", { name: "You: open your decisions, questions and spending" }).click();
		await panel.getByText("5 more reported asks are not shown here", { exact: true }).waitFor();
		await settled();
		await page.evaluate(() => window.rolesExactTest.active(false));
		await panel.waitFor({ state: "hidden" });
		await page.evaluate(() => {
			window.rolesExactTest.active(true);
			window.rolesExactTest.deliver();
		});
		record("overflow is counted and hiding the page closes its panel");
		// Axe needs script timers. Audit an unchanged DOM snapshot in a separate test
		// document, not by weakening the actual component's script-disabled sandbox.
		// This is a structural audit, not a contrast or live-interaction receipt.
		const auditMarkup = await page.evaluate(
			() => document.querySelector('iframe[title="Roles"]').contentDocument.documentElement.outerHTML,
		);
		const audit = await context.newPage();
		await audit.setContent(auditMarkup);
		await audit.addScriptTag({ content: axe });
		const accessibility = await audit.evaluate(async () =>
			(await axe.run(document, { rules: { "color-contrast": { enabled: false } } })).violations
				.filter((v) => ["serious", "critical"].includes(v.impact))
				.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })),
		);
		await audit.close();
		results.accessibility = accessibility;
		assert.deepEqual(accessibility, []);
		record("no serious or critical structural accessibility violations");
		await page.setViewportSize({ width: 390, height: 844 });
		await frame.locator("[data-boxgrid]").waitFor();
		const pan = await frame.locator("[data-boxgrid]").evaluate((el) => {
			let p = el.parentElement;
			while (p && p.scrollWidth <= p.clientWidth) p = p.parentElement;
			if (!p) return false;
			p.scrollLeft = 120;
			return p.scrollLeft > 0;
		});
		assert.equal(pan, true);
		await page.screenshot({ path: join(output, "phone.png") });
		record("the supplied wide phone canvas can be panned");
		assert.deepEqual(pageErrors, []);
		state = await page.evaluate(() => window.rolesExactTest.getState());
		assert.ok(state.sent.every((type) => ["roles_watch", "roles_unwatch"].includes(type)));
		await page.evaluate(() => window.rolesExactTest.badFonts());
		await page.getByRole("alert").waitFor();
		assert.equal(await page.locator("iframe").count(), 0);
		await page.evaluate(() => window.rolesExactTest.unmount());
		assert.equal(await page.locator("iframe").count(), 0);
		record("font failure is explicit and unmount leaves no frame or active surface");
		await context.close();
	}

	if (phase !== "component") {
		// Separate same-input comparison against the actual supplied HTML, not a golden
		// generated by this implementation. Never contacts the app or a real chat.
		const contract = await import(
			join(userInfo().homedir, "company-lab/shared/roles-reference-contract-closure-2026-10-13/closure-core.mjs")
		);
		for (const spec of contract.FRAMES) {
			const c = await browser.newContext({
				viewport: { width: spec.width, height: spec.height },
				deviceScaleFactor: 1,
				locale: "en-US",
				timezoneId: "UTC",
				reducedMotion: "reduce",
			});
			await c.setOffline(true);
			await c.route("**/*", (route) => route.abort());
			await c.addInitScript(installInitialSendHold);
			await c.route(origin + "/reference", (route) =>
				route.fulfill({ contentType: "text/html", body: contract.childBytes(spec).toString("utf8") }),
			);
			await c.route(origin + "/fixture", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>',
				}),
			);
			const ref = await c.newPage();
			await ref.goto(origin + "/reference");
			await contract.ready(ref);
			const before = join(output, `${spec.name}-source.png`);
			await ref.screenshot({ path: before, clip: { x: 0, y: 0, width: spec.width, height: spec.height } });
			const native = await c.newPage();
			await native.goto(origin + "/fixture");
			await native.addScriptTag({ content: fixture });
			const scenario =
				spec.name === "phone-disconnected"
					? "disconnected"
					: spec.name === "phone-stale"
						? "stale"
						: spec.name === "phone-loading"
							? "loading"
							: spec.name === "phone-inbox-empty"
								? "empty"
								: "live";
			await native.evaluate(async ({ spec, scenario, fonts }) => window.startU0Fixture({ ...spec, scenario }, fonts), {
				spec,
				scenario,
				fonts,
			});
			const after = join(output, `${spec.name}-implemented.png`);
			await native.screenshot({ path: after, clip: { x: 0, y: 0, width: spec.width, height: spec.height } });
			const a = contract.png(before),
				b = contract.png(after);
			assert.equal(a.width, b.width);
			assert.equal(a.height, b.height);
			let pixels = 0;
			for (let i = 0; i < a.rgba.length; i += 4)
				if (!a.rgba.subarray(i, i + 4).equals(b.rgba.subarray(i, i + 4))) pixels++;
			results.reference.push({ name: spec.name, differentPixels: pixels, totalPixels: a.width * a.height });
			console.log(`REFERENCE ${spec.name}: ${pixels} different pixels`);
			await c.close();
		}
		assert.ok(
			results.reference.every((r) => r.differentPixels === 0),
			"same-input reference mismatch; inspect the images, do not bless new goldens",
		);
	}
} catch (error) {
	results.errors.push(String(error.stack ?? error));
	process.exitCode = 1;
} finally {
	clearTimeout(deadline);
	writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
	await browser.close();
	await new Promise((r) => server.close(r));
	console.log(
		JSON.stringify({ componentChecks: results.component.length, reference: results.reference, errors: results.errors }),
	);
}
