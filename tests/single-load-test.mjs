/* single-load E2E（零 token）：新开的标签页只加载一次；页面落后于服务端的构建时，照样自刷新一次。
 *
 * 上游 1f31bde「self-reload page when server rebuilds underneath it」比的是两个永远对不上的 id：
 * 页面用 Vite 编进 bundle 的 __BUILD_ID__（构建时间戳），服务端 ready 帧发的是 index.html 里入口
 * chunk 的 hash。于是每个新标签页一收到 ready 就刷新一次（sessionStorage 标记挡住第二次）：整页加载
 * 两遍、多开一条 WS。服务端还把 id 缓存到进程退出，重建了前端、还没重启服务端的那段时间里，新标签页
 * 拿到的是新 index.html，服务端报的却是启动时那份的 hash，一样要多刷一次。
 *  1. 新上下文（sessionStorage 为空，等于新标签页）打开：主框架只导航 1 次、只开 1 条 WS，没有刷新标记，
 *     ready 里的 id 就是磁盘上 index.html 的入口 hash；
 *  2. 把页面自己的入口 <script> 改成别的 hash（等于这页是旧构建留下的），重启服务端：WS 重连收到 ready
 *     后恰好刷新一次，刷新后就是服务端那份构建，不再刷 —— 自刷新功能没被修坏；
 *  3. （SINGLELOAD_MUTATE_DIST=1 才跑）服务端在跑时 index.html 变了：之后的连接拿到的是新 id。做法是在
 *     index.html 开头插一行注释 `<!-- /assets/index-Rebuilt1.js -->`（服务端取第一个匹配；真正的
 *     <script> 不动，页面照常加载），跑完还原。它改的是 web/dist，别在正被线上服务用的克隆里开。
 * 用法: npm run build && node tests/single-load-test.mjs
 *      SINGLELOAD_DEBUG=1 打印每个标签页的时间线。 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const ROOT_URL = `http://localhost:${PORT}/`;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const INDEX_HTML = join(REPO, "web", "dist", "index.html");
const ENTRY_RE = /\/assets\/index-([A-Za-z0-9_-]+)\.js/;
const MUTATE_DIST = process.env.SINGLELOAD_MUTATE_DIST === "1";
const DEBUG = process.env.SINGLELOAD_DEBUG === "1";
const base = mkdtempSync(join(tmpdir(), "piweb-singleload-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	if (!ok) failures++;
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? `  (${extra})` : ""}`);
};
async function waitFor(pred, timeoutMs, what) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await pred()) return true;
		await sleep(100);
	}
	if (what) console.log(`  … gave up waiting for ${what} after ${timeoutMs}ms`);
	return false;
}

// ---- server（第 2 步要杀掉重开，同一个端口、同一个数据目录）---------------------------
let server = null;
let serverLog = "";
function startServer() {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: workdir,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_TOKEN: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => (serverLog += d));
	server.stderr.on("data", (d) => (serverLog += d));
}
function stopServer() {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}
process.on("exit", stopServer);
const serverUp = async () => {
	try {
		return (await fetch(ROOT_URL)).ok;
	} catch {
		return false;
	}
};

/** 一个浏览器上下文 = 一个新标签页（sessionStorage 为空）。记下主框架导航、WS 打开、每个 ready 的 buildId。 */
async function openTab(browser, label) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const tab = { label, ctx, page, navs: 0, sockets: 0, readyIds: [], log: [] };
	const t0 = Date.now();
	const at = () => `+${Date.now() - t0}ms`;
	page.on("framenavigated", (f) => {
		if (f !== page.mainFrame()) return;
		tab.navs++;
		tab.log.push(`${at()} navigate`);
	});
	page.on("websocket", (ws) => {
		tab.sockets++;
		tab.log.push(`${at()} ws open`);
		ws.on("close", () => tab.log.push(`${at()} ws close`));
		ws.on("framereceived", (fr) => {
			let m;
			try {
				m = JSON.parse(fr.payload);
			} catch {
				return;
			}
			if (m?.type !== "ready") return;
			tab.readyIds.push(m.buildId);
			tab.log.push(`${at()} ready buildId=${m.buildId}`);
		});
	});
	return tab;
}
const reloadStamps = (page) =>
	page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("pi-web-ui-reloaded-")));
const domEntry = (page) =>
	page.evaluate(() => document.querySelector('script[src*="/assets/index-"]')?.getAttribute("src") ?? "");
/** 不开浏览器：连一条 WS、发 hello，拿 ready 里的 buildId。 */
function readyBuildId() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("no ready within 20s"));
		}, 20000);
		ws.onopen = () => ws.send(JSON.stringify({ type: "hello", clientId: `singleload-${Date.now()}` }));
		ws.onmessage = (ev) => {
			let m;
			try {
				m = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (m?.type !== "ready") return;
			clearTimeout(timer);
			ws.close();
			resolve(m.buildId);
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
	});
}

let browser = null;
const tabs = [];
const originalIndex = readFileSync(INDEX_HTML, "utf8");
const onDisk = originalIndex.match(ENTRY_RE)?.[1] ?? "";
try {
	if (!onDisk) throw new Error(`no /assets/index-*.js in ${INDEX_HTML} — run npm run build first`);
	startServer();
	if (!(await waitFor(serverUp, 30000, "the server"))) throw new Error("server did not start");
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("1. a new tab loads the page once");
	const A = await openTab(browser, "A");
	tabs.push(A);
	await A.page.goto(ROOT_URL);
	await waitFor(() => A.readyIds.length >= 1, 20000, "tab A's first ready");
	await sleep(4000);
	check(
		"the ready frame carries the entry-chunk hash of index.html on disk",
		A.readyIds.at(-1) === onDisk,
		`ready=${A.readyIds.at(-1)} disk=${onDisk}`,
	);
	check("the page navigated once (no self-reload)", A.navs === 1, `navigations=${A.navs}`);
	check("one WebSocket", A.sockets === 1, `sockets=${A.sockets}`);
	const stamps1 = await reloadStamps(A.page);
	check("no reload stamp in sessionStorage", stamps1.length === 0, JSON.stringify(stamps1));

	console.log("2. a page left over from an older build still reloads itself, once");
	await A.page.evaluate(() => {
		const s = document.querySelector('script[src*="/assets/index-"]');
		s?.setAttribute("src", (s.getAttribute("src") ?? "").replace(/index-[A-Za-z0-9_-]+\.js/, "index-OldBuild.js"));
	});
	const navsBefore = A.navs;
	stopServer();
	await waitFor(async () => !(await serverUp()), 10000, "the server to go down");
	startServer();
	if (!(await waitFor(serverUp, 30000, "the server to come back"))) throw new Error("server did not restart");
	await waitFor(() => A.navs > navsBefore, 30000, "tab A to reload");
	const readyAfterReload = A.readyIds.length + 1;
	await waitFor(() => A.readyIds.length >= readyAfterReload, 20000, "tab A's ready after the reload");
	await sleep(4000);
	check("the stale page reloaded exactly once", A.navs === navsBefore + 1, `navigations ${navsBefore}→${A.navs}`);
	const entryAfter = await domEntry(A.page);
	check("after the reload it runs the server's build", entryAfter.includes(`index-${onDisk}.js`), entryAfter);
	const stamps2 = await reloadStamps(A.page);
	check(
		"the reload was stamped for the server's build",
		stamps2.includes(`pi-web-ui-reloaded-${onDisk}`),
		JSON.stringify(stamps2),
	);

	if (MUTATE_DIST) {
		console.log("3. index.html changes under a running server: later connections get the new id");
		const before = await readyBuildId();
		writeFileSync(INDEX_HTML, `<!-- /assets/index-Rebuilt1.js -->\n${originalIndex}`);
		let after = "";
		try {
			after = await readyBuildId();
		} finally {
			writeFileSync(INDEX_HTML, originalIndex);
		}
		const restored = await readyBuildId();
		check("before the change the server announces the on-disk hash", before === onDisk, `ready=${before}`);
		check("after the change it announces the new one", after === "Rebuilt1", `ready=${after}`);
		check("after restoring index.html it is back to the original", restored === onDisk, `ready=${restored}`);
	} else {
		console.log("3. skipped (set SINGLELOAD_MUTATE_DIST=1 in a throwaway checkout: it edits web/dist/index.html)");
	}
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	if (readFileSync(INDEX_HTML, "utf8") !== originalIndex) writeFileSync(INDEX_HTML, originalIndex);
	if (DEBUG)
		for (const t of tabs) {
			console.log(`  tab ${t.label}:`);
			for (const l of t.log) console.log(`    ${l}`);
		}
	await browser?.close();
	stopServer();
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall single-load checks passed");
