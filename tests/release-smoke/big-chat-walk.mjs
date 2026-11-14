/**
 * Walking an open big chat for F3, ported from Ops's pi-web-check (gatherPictures, scrollToPictures):
 * newest first, open folded exchanges and quiet turns, visit lazily drawn messages and load older pages
 * until the expected pictures are found, then scroll to each one: it must load once it is on screen.
 */
import { setTimeout as sleep } from "node:timers/promises";

// A picture's key (its address without the retry counter) is computed inside the page by each evaluate.

/** Pictures in the page now: { key, messageId, top }. */
const inPage = (page) =>
	page.evaluate(() => {
		const key = (a) => {
			const u = new URL(a, location.href);
			return u.pathname + u.search.replace(/[&?]retry=\d+/, "");
		};
		const box = document.querySelector(".messages");
		if (!box) return [];
		const view = box.getBoundingClientRect();
		const out = new Map();
		for (const img of box.querySelectorAll("img")) {
			const a = img.getAttribute("data-src") ?? img.getAttribute("src") ?? "";
			if (!a.includes("/api/chat-image/")) continue;
			const k = key(a);
			if (out.has(k)) continue;
			const r = img.getBoundingClientRect();
			const holder = img.closest("[data-lazy-id]") ?? img.closest("[data-msg-id]");
			out.set(k, {
				key: k,
				messageId: holder?.getAttribute("data-lazy-id") ?? holder?.getAttribute("data-msg-id") ?? null,
				top: Math.round(r.top - view.top + box.scrollTop),
			});
		}
		return [...out.values()];
	});

/** Find up to `expect` pictures, newest first, within ms. */
export async function gatherPictures(page, { expect, ms, maxOlderPages = 12 }) {
	const pictures = new Map();
	const visited = new Set();
	const end = Date.now() + ms;
	const checkTime = () => {
		if (Date.now() >= end)
			throw new Error(
				`looking for the pictures timed out after ${Math.round(ms / 1000)} s (found ${pictures.size} of ${expect})`,
			);
	};
	const look = () =>
		page.evaluate(() => {
			const paging = window.__smoke.paging;
			const count = (sel) => document.querySelectorAll(sel).length;
			const older = document.querySelector(".load-older button");
			const shape = [
				paging.answers,
				count(".messages [data-lazy-id]"),
				count(".messages .msg"),
				count('.messages [aria-expanded="false"]'),
				older ? `${older.disabled}:${older.textContent}` : "-",
			];
			return { outstanding: paging.outstanding, shape: JSON.stringify(shape) };
		});
	// A step is settled once the page's requests for older messages are answered and the list stayed the same twice.
	const settle = async () => {
		let last = await look();
		for (let calm = 0, still = 0, i = 0; calm < 2 && i < 240; i++) {
			checkTime();
			await sleep(250);
			const now = await look();
			still = now.shape === last.shape ? still + 1 : 0;
			if (now.outstanding > 0 && still >= 80) {
				await page.evaluate(() => {
					window.__smoke.paging.outstanding = 0;
				});
				now.outstanding = 0;
			}
			calm = now.outstanding === 0 && now.shape === last.shape ? calm + 1 : 0;
			last = now;
		}
	};
	const visit = async () => {
		for (;;) {
			checkTime();
			for (const p of await inPage(page)) pictures.set(p.key, p);
			if (pictures.size >= expect) return;
			const next = await page.evaluate(
				(done) => {
					const nodes = [...document.querySelectorAll(".messages [data-lazy-id]")];
					const mounted = nodes.filter(
						(n) => !n.classList.contains("msg-lazy-ph") && !n.querySelector(".msg-collapsed"),
					);
					const ids = mounted.map((n) => n.getAttribute("data-lazy-id"));
					const seen = new Set([...done, ...ids]);
					const target = nodes.findLast((n) => !seen.has(n.getAttribute("data-lazy-id")));
					target?.scrollIntoView({ block: "center" });
					return { ids, more: !!target };
				},
				[...visited],
			);
			for (const id of next.ids) visited.add(id);
			if (!next.more) return;
			await sleep(400);
		}
	};
	let pages = 0;
	const clickedQuiet = new Set();
	for (let guard = 0; guard < 300; guard++) {
		checkTime();
		const rows = await page.evaluate(() => {
			const r = [...document.querySelectorAll(".messages .msg-collapsed")];
			for (const x of r) x.click();
			return r.length;
		});
		if (rows) await sleep(400);
		await visit();
		if (pictures.size >= expect) break;
		const unfolded = await page.evaluate(
			(tried) => {
				const quietId = (h) => h.closest(".quiet-turn-row")?.getAttribute("data-quiet-turn") ?? "";
				const h = [
					...document.querySelectorAll(
						'.messages .xfold-head[aria-expanded="false"], .messages .quiet-turn-row .rolemsg-row-btn[aria-expanded="false"]',
					),
				]
					.filter((x) => !tried.includes(quietId(x)))
					.at(-1);
				if (!h) return null;
				h.click();
				return quietId(h);
			},
			[...clickedQuiet],
		);
		if (unfolded !== null) {
			if (unfolded) clickedQuiet.add(unfolded);
			await settle();
			continue;
		}
		if (pages >= maxOlderPages) break;
		const btn = page.locator(".load-older button").first();
		if (!(await btn.count())) break;
		await btn.click();
		pages++;
		await settle();
	}
	return [...pictures.values()];
}

/** Scroll to each picture; it must load within 15 s once on screen. Returns [{ key, loaded }]. */
export async function scrollToPictures(page, pictures) {
	const out = [];
	for (const { key, messageId, top } of pictures) {
		if (messageId) {
			await page.evaluate((id) => {
				const node = [...document.querySelectorAll(".messages [data-lazy-id], .messages [data-msg-id]")].find(
					(n) => (n.getAttribute("data-lazy-id") ?? n.getAttribute("data-msg-id")) === id,
				);
				node?.scrollIntoView({ block: "center" });
			}, messageId);
			await sleep(400);
		}
		let found = false;
		for (const shift of [null, 0, -600, 600, -1200, 1200]) {
			if (shift !== null) {
				await page.evaluate((y) => {
					const box = document.querySelector(".messages");
					if (box) box.scrollTop = Math.max(0, y - box.clientHeight / 2);
				}, top + shift);
				await sleep(400);
			}
			found = await page.evaluate((k) => {
				const key = (a) => {
					const u = new URL(a, location.href);
					return u.pathname + u.search.replace(/[&?]retry=\d+/, "");
				};
				const img = [...document.querySelectorAll(".messages img")].find((i) => {
					const a = i.getAttribute("data-src") ?? i.getAttribute("src") ?? "";
					return a.includes("/api/chat-image/") && key(a) === k;
				});
				img?.scrollIntoView({ block: "center" });
				return !!img;
			}, key);
			if (found) break;
		}
		let loaded = false;
		for (let i = 0; found && i < 60 && !loaded; i++) {
			await sleep(250);
			loaded = await page.evaluate((k) => {
				const key = (a) => {
					const u = new URL(a, location.href);
					return u.pathname + u.search.replace(/[&?]retry=\d+/, "");
				};
				const img = [...document.querySelectorAll(".messages img")].find((i) => {
					const a = i.getAttribute("src") ?? "";
					return a.includes("/api/chat-image/") && key(a) === k;
				});
				return !!img && !img.classList.contains("chat-image-pending") && img.complete && img.naturalWidth > 0;
			}, key);
		}
		out.push({ key, loaded });
	}
	return out;
}
