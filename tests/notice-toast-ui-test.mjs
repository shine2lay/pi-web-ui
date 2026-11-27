// QA248 N1: mount the real React toast and production CSS; no application/model server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(process.env.NOTICE_PROOF_DIR || join(repo, "tests/scratch/notice-toast"));
mkdirSync(out, { recursive: true });
const longText = `Restart complete. ${"Synthetic restart detail keeps every word available while you read. ".repeat(180)}End of restart details.`;
const bundle = await build({
	stdin: {
		contents: `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LanguageProvider} from './web/src/i18n';
import {NoticeToast} from './web/src/components/NoticeToast';
import './web/src/styles.css';
const p = new URLSearchParams(location.search);
const text = p.get('short') ? 'Restart complete.' : ${JSON.stringify(longText)};
function Preview() {
 const [open,setOpen] = useState(true);
 return <LanguageProvider><main aria-label="Notice test"><button id="before">Before notice</button>
 <div className="notices">{open && <NoticeToast notice={{id:1, level:p.get('level')||'info',text:'Fallback text',textEn:text}} onDismiss={()=>setOpen(false)}/>}</div>
 <button id="after">After notice</button></main></LanguageProvider>;
}
createRoot(document.getElementById('root')).render(<Preview/>);`,
		resolveDir: repo,
		loader: "tsx",
	},
	bundle: true,
	write: false,
	outdir: "out",
	jsx: "automatic",
	// Optional external red/control capture reads the exact old source, never edits production.
	plugins: process.env.NOTICE_SOURCE_REF
		? [
				{
					name: "old-notice-control",
					setup(bundler) {
						bundler.onLoad({ filter: /(?:styles\.css|NoticeToast\.tsx)$/ }, ({ path }) => ({
							contents: execFileSync(
								"git",
								["-C", repo, "show", `${process.env.NOTICE_SOURCE_REF}:${path.slice(repo.length)}`],
								{ encoding: "utf8" },
							),
							loader: path.endsWith("tsx") ? "tsx" : "css",
							resolveDir: resolve(path, ".."),
						}));
					},
				},
			]
		: [],
	loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
});
const js = bundle.outputFiles.find((f) => f.path.endsWith(".js")).contents;
const css = bundle.outputFiles.find((f) => f.path.endsWith(".css")).contents;
const server = createServer((req, res) => {
	if (req.url === "/app.js" || req.url === "/app.css") {
		res.setHeader("Content-Type", req.url.endsWith("js") ? "text/javascript" : "text/css");
		return res.end(req.url.endsWith("js") ? js : css);
	}
	if (req.url === "/light.css") {
		res.setHeader("Content-Type", "text/css");
		return res.end(readFileSync(join(repo, "themes/flow-light.css")));
	}
	res.setHeader("Content-Type", "text/html");
	res.end(
		`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notice regression</title><link rel="stylesheet" href="/app.css"><script>if(matchMedia('(prefers-color-scheme: light)').matches)document.write('<link rel="stylesheet" href="/light.css">')</script></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
	);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
	console.log(url);
} else {
	assert(CHROME_PATH, "Chrome is required, not a skipped proof");
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const results = [];
	const failures = [];
	const axePath =
		process.env.PI_AXE_JS || join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
	async function checkAxe(page, name) {
		assert(existsSync(axePath), "Set PI_AXE_JS to the installed axe-core script");
		// axe schedules its own work; release the external clock for that audit only.
		await page.clock.resume();
		await page.addScriptTag({ path: axePath });
		const violations = await page.evaluate(async () =>
			(await window.axe.run(".notice")).violations
				.filter((v) => ["serious", "critical"].includes(v.impact))
				.map((v) => ({
					id: v.id,
					impact: v.impact,
					nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
				})),
		);
		await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 50));
		writeFileSync(join(out, `${name}-axe.json`), JSON.stringify(violations, null, 2));
		const baseline = process.env.NOTICE_BASELINE_DIR && join(process.env.NOTICE_BASELINE_DIR, `${name}-axe.json`);
		if (!process.env.NOTICE_SOURCE_REF) {
			assert.deepEqual(
				violations,
				baseline && existsSync(baseline) ? JSON.parse(readFileSync(baseline, "utf8")) : [],
				"No NEW serious/critical axe violations versus exact old-source control",
			);
		}
	}
	async function test(name, fn) {
		try {
			await fn();
			results.push({ name, pass: true });
		} catch (e) {
			failures.push(name);
			results.push({ name, pass: false, error: e.message });
		}
	}
	async function pageFor(width, height, theme, query = "") {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme });
		page.on("pageerror", (e) => failures.push(e.message));
		await page.clock.install();
		await page.clock.pauseAt(new Date());
		await page.goto(`${url}/${query}`);
		await page.locator(".notice").waitFor();
		await page.clock.runFor(200);
		await page.locator(".notice").evaluate((el) => el.getAnimations().forEach((animation) => animation.finish()));
		return page;
	}
	try {
		for (const theme of ["light", "dark"]) {
			for (const level of ["info", "warning", "error"]) {
				await test(`short desktop ${theme} ${level}: words, native click, parity`, async () => {
					const page = await pageFor(1440, 960, theme, `?short=1&level=${level}`);
					assert.equal(await page.locator(".notice-text").textContent(), "Restart complete.");
					assert.equal(await page.locator(`[role=status].notice-${level}`).count(), 1);
					await checkAxe(page, `short-${theme}-${level}`);
					const geometry = await page.locator(".notice").evaluate((el) =>
						[el, ...el.children].map((node) => {
							const r = node.getBoundingClientRect(),
								s = getComputedStyle(node);
							return {
								box: [r.x, r.y, r.width, r.height],
								color: s.color,
								background: s.backgroundColor,
								font: s.font,
								border: s.border,
								shadow: s.boxShadow,
							};
						}),
					);
					const baseline =
						process.env.NOTICE_BASELINE_DIR && join(process.env.NOTICE_BASELINE_DIR, `${theme}-${level}.json`);
					if (baseline && existsSync(baseline)) assert.deepEqual(geometry, JSON.parse(readFileSync(baseline, "utf8")));
					writeFileSync(join(out, `${theme}-${level}.json`), JSON.stringify(geometry, null, 2));
					await page.screenshot({ path: join(out, `short-1440-${theme}-${level}@2x.png`) });
					const close = await page.getByRole("button", { name: "Close", exact: true }).boundingBox();
					// The 24px native pointer target extends two pixels beyond the unchanged 20px painted box.
					await page.mouse.click(close.x - 1, close.y + close.height / 2);
					assert.equal(await page.locator(".notice").count(), 0);
					await page.close();
				});
			}
			for (const [width, height] of [
				[320, 568],
				[390, 844],
			]) {
				await test(`long ${width}x${height} ${theme}: viewport, full text, scroll, native pointer and keyboard`, async () => {
					const page = await pageFor(width, height, theme);
					assert.equal(await page.locator(".notice-text").textContent(), longText);
					await checkAxe(page, `long-${width}-${theme}`);
					const boxes = await page.locator(".notice").evaluate((el) => {
						const r = el.getBoundingClientRect(),
							c = el.querySelector("button").getBoundingClientRect(),
							t = el.querySelector(".notice-text");
						return {
							notice: [r.x, r.y, r.right, r.bottom],
							close: [c.x, c.y, c.right, c.bottom],
							scroll: t.scrollHeight > t.clientHeight,
							overflow: document.documentElement.scrollWidth > innerWidth,
						};
					});
					writeFileSync(join(out, `boxes-${width}-${theme}.json`), JSON.stringify(boxes, null, 2));
					await page.screenshot({ path: join(out, `long-${width}-${theme}@2x.png`) });
					assert(
						boxes.close[0] >= 0 && boxes.close[1] >= 0 && boxes.close[2] <= width && boxes.close[3] <= height,
						`native Close outside viewport: ${JSON.stringify(boxes)}`,
					);
					assert(boxes.notice[0] >= 0 && boxes.notice[2] <= width && boxes.notice[3] <= height);
					assert(boxes.scroll, "long text must scroll internally");
					assert.equal(boxes.overflow, false);
					await page.getByRole("button", { name: "Close", exact: true }).click();
					assert.equal(await page.locator(".notice").count(), 0);
					await page.close();
					const keyboard = await pageFor(width, height, theme);
					await keyboard.keyboard.press("Tab");
					assert.equal(await keyboard.locator("#before").evaluate((el) => el === document.activeElement), true);
					await keyboard.keyboard.press("Tab");
					assert.equal(await keyboard.locator(".notice-text").evaluate((el) => el === document.activeElement), true);
					await keyboard.clock.runFor(13000);
					assert.equal(await keyboard.locator(".notice").count(), 1, "focused reading must not auto-dismiss");
					await keyboard.keyboard.press("End");
					await keyboard.clock.runFor(300);
					await keyboard.waitForFunction(() => document.querySelector(".notice-text").scrollTop > 0);
					await keyboard.keyboard.press("Tab");
					assert.equal(
						await keyboard
							.getByRole("button", { name: "Close", exact: true })
							.evaluate((el) => el === document.activeElement),
						true,
					);
					assert.equal(
						await keyboard.locator(".notice-close").evaluate((el) => getComputedStyle(el).outlineStyle !== "none"),
						true,
						"Native focus ring remains visible",
					);
					await keyboard.screenshot({ path: join(out, `keyboard-${width}-${theme}@2x.png`) });
					await keyboard.keyboard.press("Enter");
					assert.equal(await keyboard.locator(".notice").count(), 0);
					await keyboard.close();
				});
			}
		}
		for (const level of ["info", "warning", "error"]) {
			await test(`${level}: original auto-dismiss delay and hover pause`, async () => {
				const page = await pageFor(1440, 960, "dark", `?short=1&level=${level}`);
				const delay = level === "error" ? 12000 : 7000;
				await page.locator(".notice").hover();
				await page.clock.runFor(delay + 100);
				assert.equal(await page.locator(".notice").count(), 1);
				await page.mouse.move(0, 0);
				await page.clock.runFor(delay - 1);
				assert.equal(await page.locator(".notice").count(), 1);
				await page.clock.runFor(1);
				assert.equal(await page.locator(".notice").count(), 0);
				await page.close();
			});
		}
	} finally {
		await browser.close();
		await new Promise((r) => server.close(r));
	}
	writeFileSync(join(out, "results.json"), JSON.stringify({ results, failures }, null, 2));
	console.log(JSON.stringify({ results, failures }, null, 2));
	if (failures.length) process.exitCode = 1;
}
