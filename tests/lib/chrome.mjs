/**
 * 浏览器 E2E 测试用的 Chrome 可执行文件探测。
 * 路径不再写死本机（旧常量是 macOS 专属的 playwright 缓存路径）：
 * 1. 环境变量 PI_WEB_CHROME 最优先；
 * 2. playwright 缓存里已装的 headless shell（任意版本，新的优先）：PLAYWRIGHT_BROWSERS_PATH，
 *    再是账户主目录（userInfo，不是 HOME：密封测试把 HOME 换成了临时目录）下的 .cache/ms-playwright；
 * 3. 常见平台默认位置逐个探测，取第一个存在的。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

function playwrightShells() {
	let accountHome = "";
	try {
		accountHome = userInfo().homedir;
	} catch {
		/* no passwd entry */
	}
	const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, accountHome && join(accountHome, ".cache", "ms-playwright")];
	const found = [];
	for (const root of roots) {
		if (!root || !existsSync(root)) continue;
		const dirs = readdirSync(root)
			.filter((d) => /^chrom(e|ium)_headless_shell-\d+$/.test(d))
			.sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
		for (const d of dirs) {
			let subs = [];
			try {
				subs = readdirSync(join(root, d), { withFileTypes: true }).filter((s) => s.isDirectory());
			} catch {
				continue;
			}
			for (const sub of subs) {
				for (const exe of ["chrome-headless-shell", "headless_shell"]) found.push(join(root, d, sub.name, exe));
			}
		}
	}
	return found;
}

const CANDIDATES = [
	...playwrightShells(),
	// Windows playwright 缓存
	join(
		homedir(),
		"AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
	),
	// playwright 缓存（各平台）
	join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
	join(homedir(), "Library/Caches/ms-playwright/chrome-headless-shell-1228/chrome-headless-shell"),
	join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"),
	// Windows / macOS / Linux 本机 Chrome
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
	"/usr/bin/chromium",
];

export const CHROME_PATH =
	process.env.PI_WEB_CHROME ?? CANDIDATES.find((p) => existsSync(p)) ?? "";

// The browser tests run a Chinese browser. The UI is English only (PATCHES.md, english-only), so
// this proves a Chinese browser language still gets the English UI; it used to switch the UI to
// Chinese. Chromium takes its language from LANGUAGE, and Playwright passes this process's
// environment to the browser, so pin it here for every test that uses this file.
// PI_TEST_BROWSER_LANGUAGE overrides it (e.g. "en_US").
process.env.LANGUAGE = process.env.PI_TEST_BROWSER_LANGUAGE || "zh_CN";
