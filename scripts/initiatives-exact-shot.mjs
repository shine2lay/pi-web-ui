// initiatives-exact (docs/initiatives-exact.md): one sealed browser look at the test fixture (the design's 4
// sample initiatives, converted) through the real InitiativesExactView mount: script-free frame, pinned fonts,
// every callback given so every control shows. Screenshots at 1440x1900 and 390x844 (plus the phone page in
// full), for a by-eye comparison with the design; no pixel gate. It touches no chat and no server.
// Chrome logs "Blocked script execution" once per event attribute (onClick="{{"name"}}") when the binder parses
// the template inside the script-free frame: nothing runs, the binder adds the host's listeners instead (Roles
// logs the same, once per its own 29). The look checks that exact count; any other console error fails it.
// --page (initiatives-page-exact, docs/initiatives-page-exact.md): the live page's core model on its fixed registry
// fixture instead, with the callbacks the Initiatives tab gives.
// Both looks fail when the page scrolls sideways.
// Run: scripts/sealed.sh node --import tsx scripts/initiatives-exact-shot.mjs [--page] [output-directory]
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../tests/lib/chrome.mjs";
import { readInitiativeFonts } from "../web/initiatives-design-assets.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pageLook = process.argv.includes("--page");
const output = resolve(
	process.argv.slice(2).find((a) => !a.startsWith("--")) ??
		join(root, pageLook ? ".test-results/initiatives-page" : ".test-results/initiatives-exact"),
);
if (!process.env.PI_SEALED || !CHROME_PATH) throw new Error("Run sealed (scripts/sealed.sh) with the installed Chrome");
mkdirSync(output, { recursive: true });
const fonts = readInitiativeFonts();
const eventAttributes = (
	readFileSync(join(root, "web/src/initiatives-u0/surface.html"), "utf8").match(/\son[a-z]+="/gi) ?? []
).length;
const BLOCKED =
	/^Blocked script execution in '[^']*' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/;
const plugin = {
	name: "initiatives-font-input",
	setup(b) {
		b.onResolve({ filter: /^virtual:initiatives-design-fonts$/ }, () => ({ path: "fonts", namespace: "exact" }));
		b.onLoad({ filter: /.*/, namespace: "exact" }, () => ({
			contents: `export const fonts = Object.freeze(${JSON.stringify(fonts)});`,
		}));
	},
};
const view = pageLook
	? `
import { buildInitiativesPage } from "./web/src/initiatives-page/model";
import { pageArgs } from "./tests/unit/initiatives-page-fixture";
const model = buildInitiativesPage(pageArgs());
const element = (
	<InitiativesExactView input={model.input} onOpen={noop} onRetry={noop} onSelect={noop} onMessageLead={noop}
		onChangeLead={noop} />
);
`
	: `
import { DESIGN_FIXTURE } from "./tests/unit/initiatives-exact-fixture";
const element = (
	<InitiativesExactView input={DESIGN_FIXTURE} onOpen={noop} onRetry={noop} onChangeLead={noop} onMessageLead={noop}
		onNewInitiative={noop} onResume={noop} onMarkRead={noop} onAskDesign={noop} onAnswer={noop} />
);
`;
const entry = `
import { createRoot } from "react-dom/client";
import { InitiativesExactView } from "./web/src/components/InitiativesExactView";
const noop = () => {};
${view}
document.body.style.margin = "0";
const host = document.createElement("div");
host.style.cssText = "width:100vw;height:100vh";
document.body.appendChild(host);
createRoot(host).render(element);
`;
const app = (
	await build({
		stdin: { contents: entry, resolveDir: root, loader: "tsx", sourcefile: "initiatives-exact-shot-entry.tsx" },
		absWorkingDir: root,
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
const server = createServer((req, res) => {
	const js = req.url === "/app.js";
	res.setHeader("Content-Type", js ? "text/javascript" : "text/html");
	res.end(
		js
			? app
			: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Initiatives exact look</title></head><body><script src="/app.js"></script></body></html>',
	);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
	executablePath: CHROME_PATH,
	headless: true,
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const errors = [];
const facts = {};
try {
	for (const [name, width, height] of [
		["desktop", 1440, 1900],
		["phone", 390, 844],
	]) {
		const context = await browser.newContext({
			viewport: { width, height },
			deviceScaleFactor: 1,
			reducedMotion: "reduce",
		});
		await context.route("**/*", (route) =>
			route.request().url().startsWith(origin) ? route.continue() : route.abort(),
		);
		const page = await context.newPage();
		let blocked = 0;
		page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
		page.on("console", (m) => {
			if (m.type() !== "error") return;
			if (BLOCKED.test(m.text())) blocked++;
			else errors.push(`${name}: ${m.text()} (${m.location().url}:${m.location().lineNumber})`);
		});
		await page.goto(origin);
		await page
			.frameLocator('iframe[title="Initiatives"]')
			.locator(pageLook ? "text=Alpha launch" : "text=Team in Temper")
			.first()
			.waitFor({ timeout: 20_000 });
		// The frame is same-origin and script-free: read it from the host page.
		facts[name] = await page.evaluate(() => {
			const frame = document.querySelector('iframe[title="Initiatives"]');
			const doc = frame.contentDocument;
			return {
				sandbox: frame.getAttribute("sandbox"),
				scripts: doc.querySelectorAll("script").length,
				faces: doc.fonts.size,
				geist: doc.fonts.check("600 16px Geist"),
				mono: doc.fonts.check("500 12px 'Geist Mono'"),
				rootFont: getComputedStyle(doc.querySelector("#dc-root > div")).fontFamily,
				height: doc.documentElement.scrollHeight,
				frameWidth: frame.clientWidth,
				frameScrollWidth: doc.documentElement.scrollWidth,
				pageScrollWidth: document.documentElement.scrollWidth,
			};
		});
		facts[name].blockedHandlerAttributes = blocked;
		if (facts[name].frameScrollWidth > facts[name].frameWidth || facts[name].pageScrollWidth > width)
			errors.push(`${name}: scrolls sideways (${JSON.stringify(facts[name])})`);
		if (blocked !== eventAttributes)
			errors.push(
				`${name}: ${blocked} blocked script lines, expected one per template event attribute (${eventAttributes})`,
			);
		await page.screenshot({ path: join(output, `${name}.png`) });
		if (facts[name].height > height) {
			await page.setViewportSize({ width, height: facts[name].height });
			await page.screenshot({ path: join(output, `${name}-full.png`) });
		}
		await context.close();
	}
} finally {
	await browser.close();
	server.close();
}
console.log(JSON.stringify(facts, null, 1));
if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(`Wrote the screenshots to ${output}`);
