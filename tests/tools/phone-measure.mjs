/* phone-measure: the before/after numbers and screenshots for the phone fixes (mobile-fixes).
 *
 *   npm run build && scripts/sealed.sh node tests/tools/phone-measure.mjs <out dir> [--real] [--only=load,stream,...]
 *
 * An emulated Android phone (412×915 and 360×800, touch, CPU 4× slower) on a slow mobile-data link
 * (tests/lib/slow-link.mjs) in front of a sealed test server with a seeded 120-exchange chat.
 * --real also times opening a temporary copy of the biggest real chat (sealed; timing only, no
 * screenshots, the copy is deleted right after).
 * Writes <out>/measure.json and screenshots; prints a short summary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, openPhone, PHONE_360, PHONE_412 } from "../lib/phone.mjs";
import { hookSocket, startPhoneServer } from "../lib/phone-chat.mjs";
import {
	installTimers,
	measureCatchup,
	measureKeyboard,
	measureLoad,
	measureStream,
	measureTargets,
	measureTyping,
	stopReply,
} from "../lib/phone-checks.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: phone-measure.mjs <out dir> [--real] [--only=a,b]");
const real = process.argv.includes("--real");
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (k) => only.length === 0 || only.includes(k);
mkdirSync(out, { recursive: true });

const log = (...a) => console.error(`[phone-measure ${new Date().toISOString().slice(11, 19)}]`, ...a);
// Re-running only some checks (--only=) keeps the other results already in the folder.
const saved = join(out, "measure.json");
const result = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {};
result.when = new Date().toISOString();
try {
	result.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
	/* not a checkout */
}
const save = () => writeFileSync(join(out, "measure.json"), JSON.stringify(result, null, 1));

const kit = await startPhoneServer({ name: "phone-measure", exchanges: 120 });
const chatUrl = (file) => `${kit.link.http}/?chat=${encodeURIComponent(file)}`;
const browser = await launchBrowser();

/** A phone on the slow link, showing the seeded chat. */
async function phoneOnChat(size, { cpu = 4, slow = true } = {}) {
	kit.link.setSpeed(slow ? {} : null);
	const phone = await openPhone(browser, { size, cpu });
	await hookSocket(phone.page);
	await installTimers(phone.page);
	await phone.page.goto(kit.link.http);
	// Any finished last message will do (earlier checks may have added replies to the chat).
	await phone.page.evaluate(() => sessionStorage.setItem("__phoneMarker", ""));
	await phone.page.goto(chatUrl(kit.seeded.file));
	await phone.page.waitForFunction(() => window.__phoneT?.chat != null && window.__phoneT?.ws != null, null, {
		timeout: 180_000,
	});
	await phone.page.waitForTimeout(1000);
	return phone;
}

async function reconnected(phone) {
	const ok = await phone.page
		.waitForFunction(() => window.__ws?.readyState === 1 && window.__lastFrameAt > Date.now() - 4000, null, {
			timeout: 30_000,
		})
		.then(() => true)
		.catch(() => false);
	if (!ok) {
		log("the page did not reconnect by itself; reloading it for the next check");
		await phone.page.goto(chatUrl(kit.seeded.file));
		await phone.page.waitForFunction(() => window.__phoneT?.chat != null && window.__phoneT?.ws != null, null, {
			timeout: 180_000,
		});
	}
}

try {
	if (want("load")) {
		log("load: cold ×2, warm ×1 (412, CPU 4×, slow link)");
		kit.link.setSpeed({});
		const phone = await openPhone(browser, { size: PHONE_412, cpu: 4 });
		await hookSocket(phone.page);
		await installTimers(phone.page);
		await phone.page.goto(kit.link.http);
		await phone.page.waitForTimeout(3000);
		const url = chatUrl(kit.seeded.file);
		const marker = kit.seeded.lastMarker;
		result.load = {
			cold1: await measureLoad(kit, phone, { url, marker, cold: true }),
			cold2: await measureLoad(kit, phone, { url, marker, cold: true }),
			warm: await measureLoad(kit, phone, { url, marker, cold: false }),
		};
		await phone.page.screenshot({ path: join(out, "412-loaded.png") });
		await phone.close();
		save();
	}

	if (real && want("real")) {
		log("real: opening a copy of the biggest real chat (timing only)");
		const { cloneRealChat } = await import("../lib/real-chat-clone.mjs");
		const copy = cloneRealChat({ into: kit.sessionsDir });
		// Point the copy at the test server's folder, so opening it doesn't look into the real home.
		const raw = readFileSync(copy.file);
		const nl = raw.indexOf(10);
		const head = JSON.parse(raw.subarray(0, nl).toString("utf8"));
		head.cwd = kit.srv.workdir;
		writeFileSync(copy.file, Buffer.concat([Buffer.from(JSON.stringify(head)), raw.subarray(nl)]));
		try {
			kit.link.setSpeed({});
			const phone = await openPhone(browser, { size: PHONE_412, cpu: 4 });
			await hookSocket(phone.page);
			await installTimers(phone.page);
			await phone.page.goto(kit.link.http);
			await phone.page.waitForTimeout(3000);
			const r = await measureLoad(kit, phone, {
				url: chatUrl(copy.file),
				marker: "",
				cold: false,
				settleMs: 500,
				fullWaitMs: 240_000,
			});
			delete r.files;
			r.socketsAfter = await phone.page.evaluate(() => window.__sockets);
			result.realChat = { megabytes: Math.round(copy.bytes / 1e6), ...r };
			await phone.close();
		} finally {
			rmSync(copy.file, { force: true });
			rmSync(`${copy.file}.acp.json`, { force: true });
		}
		save();
	}

	if (want("stream")) {
		log("stream: a long reply on the slow link");
		const phone = await phoneOnChat(PHONE_412);
		result.stream = await measureStream(kit, phone, { lines: 1500, everyMs: 20 });
		log("stream:", JSON.stringify(result.stream));
		await phone.close();
		save();
	}

	if (want("catchup")) {
		result.catchup ??= {};
		const phone = await phoneOnChat(PHONE_412);
		for (const scenario of ["hidden", "sleep", "offline", "silent"]) {
			log(`catch-up: ${scenario}`);
			result.catchup[scenario] = await measureCatchup(kit, phone, scenario, { awayMs: 15_000, limitMs: 90_000 });
			log(`catch-up: ${scenario}:`, JSON.stringify(result.catchup[scenario]));
			save();
			await reconnected(phone);
			await stopReply(phone.page);
		}
		await phone.close();
	}

	for (const size of [PHONE_412, PHONE_360]) {
		if (!want("layout")) break;
		log(`layout ${size.name}: tap targets, keyboard, typing`);
		const phone = await phoneOnChat(size, { cpu: 1, slow: false });
		const shots = join(out, size.name);
		result[`targets${size.name}`] = (await measureTargets(phone, { shots })).summary;
		result[`keyboard${size.name}`] = await measureKeyboard(phone, { shots });
		if (size === PHONE_412) result.typing = await measureTyping(phone);
		await phone.close();
		save();
	}
} finally {
	save();
	await browser.close().catch(() => {});
	await kit.link.close().catch(() => {});
	await kit.srv.stop().catch(() => {});
}

const brief = {
	load: result.load && {
		cold: [result.load.cold1.usableMs, result.load.cold2.usableMs],
		coldKB: Math.round(result.load.cold1.bytesDownToUsable / 1024),
		warm: result.load.warm.usableMs,
		warmKB: Math.round(result.load.warm.bytesDownToUsable / 1024),
		terminalAtStart: result.load.cold1.terminalLoaded,
	},
	realChat: result.realChat && {
		mb: result.realChat.megabytes,
		usable: result.realChat.usableMs,
		full: result.realChat.fullChatMs,
	},
	stream: result.stream && {
		maxGap: result.stream.maxGapMs,
		endLag: result.stream.endLagMs,
		complete: result.stream.complete,
		sockets: result.stream.newSockets,
	},
	catchup:
		result.catchup &&
		Object.fromEntries(
			Object.entries(result.catchup).map(([k, v]) => [k, `${v.catchupMs ?? "none"} ms note=${v.reconnectingNote}`]),
		),
	targets412: result.targets412,
	targets360: result.targets360,
	keyboard412: result.keyboard412?.keyboardUp,
	keyboard360: result.keyboard360?.keyboardUp,
	typing: result.typing && {
		plain: result.typing.plainOk,
		middle: result.typing.middleOk,
		slash: result.typing.slashOk,
		mention: result.typing.mentionOk,
	},
};
console.log(JSON.stringify(brief, null, 1));
