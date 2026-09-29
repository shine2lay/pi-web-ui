/**
 * overflow-finder.mjs: what makes the whole window scroll sideways?
 *
 *   import { findOverflow, describeOverflow } from "./lib/overflow-finder.mjs";
 *   const r = await findOverflow(page);
 *   r.ok        // nothing reaches past the window's right edge, and the page can't be scrolled sideways
 *   r.page      // { window, doc, body, scrolledTo }: the window's width, the page's scroll widths, and
 *               //   how far window.scrollTo(far right) really got (0 = the page doesn't scroll sideways)
 *   r.starts    // the outermost elements past the edge: where the overflow starts (fix these)
 *   r.wide      // the innermost ones: the things that are wide (a long line, a picture, a table)
 *   r.shifted   // boxes that hide their overflow but were scrolled sideways anyway, so part of their
 *               //   content moved out of reach with no scroll bar to bring it back
 *   r.fixed     // fixed boxes (menus, pop-ups, notices, closed drawers) past the edge: cut off or
 *               //   parked off screen, but they never widen the page
 *   r.folded    // the page is wider but no element is past the edge (a ::before/::after box has no
 *               //   element of its own): the element that holds it, found by clipping one at a time
 *   describeOverflow(r)  // the same as lines of text, for a test's output
 *
 * Layout facts only: tags, classes, ids, positions and sizes. Never any text from the page, so it is
 * safe to run on copies of real chats (a code block's language class and ids inside chat messages are
 * shortened to "…", as a chat's own words could be in them).
 *
 * "Past the edge" means an element's right side, or the right side of text directly in it, lies more
 * than 1 px right of the window's right edge (document.documentElement.clientWidth, which leaves out a
 * vertical scroll bar) and no box between it and the page root holds it in: a box with overflow-x
 * hidden, clip, auto or scroll whose own right side is inside the window (for an absolutely placed
 * box, only the boxes from its containing block up). The page's own guard doesn't count: its
 * overflow-x on html and body is lifted while measuring, and html, body, #root and .app never count
 * as holding boxes, so the guard that keeps the window from scrolling can't hide a new culprit from
 * a test. findOverflow(page, { liftGuard: false }) measures the page as it is, to check the guard.
 */

/** Runs inside the page (page.evaluate): self-contained, no outside names. */
export function overflowProbe({
	limit = 20,
	slack = 1,
	roots = ["#root", ".app"],
	liftGuard = true,
	within = "",
} = {}) {
	const de = document.documentElement;
	const se = document.scrollingElement || de;

	const lifted = [];
	if (liftGuard) {
		for (const el of [de, document.body]) {
			if (getComputedStyle(el).overflowX === "visible") continue;
			lifted.push([el, el.style.getPropertyValue("overflow-x"), el.style.getPropertyPriority("overflow-x")]);
			el.style.setProperty("overflow-x", "visible", "important");
		}
	}
	try {
		return measure();
	} finally {
		for (const [el, value, prio] of lifted) {
			if (value) el.style.setProperty("overflow-x", value, prio);
			else el.style.removeProperty("overflow-x");
		}
	}

	function measure() {
		// `within`: a box that should never scroll sideways either (the chat list): its content box's
		// right side is the edge, and it is the root.
		const box = within ? document.querySelector(within) : null;
		if (within && !box)
			return { ok: true, missing: true, page: {}, starts: [], wide: [], shifted: [], fixed: [], folded: [] };
		const top = box ?? document.body;
		const vw = box ? box.clientWidth : de.clientWidth;
		const edge = (box ? box.getBoundingClientRect().left + box.clientLeft : 0) + vw + slack;
		const scrollWidth = () => (box ? box.scrollWidth : se.scrollWidth);

		// Can it be scrolled sideways? Try, then put it back (before the guard returns).
		let scrolledTo;
		if (box) {
			const x0 = box.scrollLeft;
			box.scrollLeft = 1e6;
			scrolledTo = Math.round(box.scrollLeft);
			box.scrollLeft = x0;
		} else {
			const x0 = window.scrollX;
			const y0 = window.scrollY;
			window.scrollTo(1e6, y0);
			scrolledTo = Math.round(window.scrollX);
			window.scrollTo(x0, y0);
		}

		const rootEls = new Set([de, document.body]);
		for (const sel of roots) for (const el of document.querySelectorAll(sel)) rootEls.add(el);
		for (let a = box; a; a = a.parentElement) rootEls.add(a);

		const styles = new Map();
		const style = (el) => {
			let s = styles.get(el);
			if (!s) {
				s = getComputedStyle(el);
				styles.set(el, s);
			}
			return s;
		};
		const rects = new Map();
		const rect = (el) => {
			let r = rects.get(el);
			if (!r) {
				r = el.getBoundingClientRect();
				rects.set(el, r);
			}
			return r;
		};
		// Names only, and none that a chat's own words could be in: a code block's language class and
		// ids inside chat messages (a footnote's id carries its label) are shortened.
		const desc = (el) => {
			const raw = typeof el.className === "string" ? el.className : (el.getAttribute("class") ?? "");
			const inChat = !!el.closest?.(".messages");
			const classes = raw
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 4)
				.map((c) =>
					/^language-/.test(c) ? ".language-…" : inChat && !/^[A-Za-z][\w-]{0,40}$/.test(c) ? ".…" : `.${c}`,
				)
				.join("");
			const id = !el.id ? "" : !inChat || /^(_r_|:r)/.test(el.id) ? `#${el.id}` : "#…";
			return `${el.tagName.toLowerCase()}${id}${classes}`;
		};
		const pathOf = (el) => {
			const out = [];
			for (let a = el.parentElement; a && !rootEls.has(a) && out.length < 6; a = a.parentElement) out.unshift(desc(a));
			return out.join(" > ");
		};
		/** Can `a` be the containing block of an absolutely placed box inside it? */
		const holdsAbsolute = (a) => {
			const s = style(a);
			return (
				s.position !== "static" ||
				s.transform !== "none" ||
				s.filter !== "none" ||
				s.perspective !== "none" ||
				/paint|layout|strict|content/.test(s.contain) ||
				/transform|filter|perspective/.test(s.willChange)
			);
		};
		/** "fixed": it, or a box around it, is position: fixed (never widens the page);
		 *  "held": a box from `from` up clips it inside the window; "free": it pushes the page wider.
		 *  `absolute`: the thing is absolutely placed, so boxes between it and its containing block
		 *  don't clip it (an absolutely placed menu escapes a plain overflow: hidden parent). */
		const kindFrom = (from, absolute = false) => {
			let skipping = absolute;
			for (let a = from; a && !rootEls.has(a); a = a.parentElement) {
				const s = style(a);
				if (skipping) {
					if (!holdsAbsolute(a)) continue;
					skipping = false;
				}
				if (s.position === "fixed") return "fixed";
				if (s.overflowX !== "visible" && rect(a).right <= edge) return "held";
				if (s.position === "absolute") skipping = true;
			}
			return "free";
		};

		/** Elements past the edge, each with "box" (its own box is) and/or "text" (text right in it is). */
		const past = new Map();
		const fixed = [];
		for (const el of top.querySelectorAll("*")) {
			const r = rect(el);
			if (r.width === 0 && r.height === 0) continue;
			if (r.right <= edge) continue;
			if (style(el).position === "fixed") {
				fixed.push(el);
				continue;
			}
			const kind = kindFrom(el.parentElement, style(el).position === "absolute");
			if (kind === "free") past.set(el, { box: true, text: false });
		}
		// Text that runs out of its own element (an unbroken word in a narrow box): the element's box
		// can sit inside the window while its text doesn't. Text in a fixed box (a notice) that runs
		// past the edge is cut off: listed with the fixed boxes.
		const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const parent = n.parentElement;
			if (!parent || !n.nodeValue || !n.nodeValue.trim()) continue;
			range.selectNodeContents(n);
			const r = range.getBoundingClientRect();
			if (r.width === 0 || r.right <= edge) continue;
			const kind = kindFrom(parent);
			if (kind === "fixed") {
				if (!fixed.includes(parent)) fixed.push(parent);
				continue;
			}
			if (kind !== "free") continue;
			const seen = past.get(parent);
			if (seen) seen.text = true;
			else past.set(parent, { box: false, text: true });
		}
		range.detach?.();

		const facts = (el, extra = {}) => {
			const r = rect(el);
			const s = style(el);
			const how = past.get(el);
			return {
				el: desc(el),
				path: pathOf(el),
				left: Math.round(r.left),
				right: Math.round(r.right),
				width: Math.round(r.width),
				scrollWidth: el.scrollWidth,
				display: s.display,
				position: s.position,
				minWidth: s.minWidth,
				whiteSpace: s.whiteSpace,
				overflowWrap: s.overflowWrap,
				what: how ? (how.box ? (how.text ? "box+text" : "box") : "text") : "",
				...extra,
			};
		};
		// Group repeats (every message row, every tab) under one line with a count.
		const grouped = (els, extra) => {
			const byKey = new Map();
			for (const el of els) {
				const f = facts(el, extra?.(el));
				const key = `${f.path} > ${f.el}`;
				const g = byKey.get(key);
				if (g) {
					g.count += 1;
					if (f.right > g.right) Object.assign(g, { ...f, count: g.count });
				} else byKey.set(key, { ...f, count: 1 });
			}
			return [...byKey.values()].sort((a, b) => b.right - a.right).slice(0, limit);
		};
		const free = [...past.keys()];
		const inFree = (el) => {
			for (let a = el.parentElement; a && !rootEls.has(a); a = a.parentElement) if (past.has(a)) return true;
			return false;
		};
		const startEls = free.filter((el) => !inFree(el));
		const wideEls = free.filter((el) => !free.some((o) => o !== el && el.contains(o)));
		const inside = (el) => ({ freeInside: free.filter((f) => f !== el && el.contains(f)).length });

		// Boxes that hide overflow but got scrolled sideways (scrollIntoView, focus): shifted content.
		const shifted = [];
		for (const el of top.querySelectorAll("*")) {
			if (el.scrollLeft > 0 && style(el).overflowX === "hidden") shifted.push(facts(el, { scrollLeft: el.scrollLeft }));
			if (shifted.length >= limit) break;
		}

		const page = {
			within,
			window: vw,
			innerWidth: window.innerWidth,
			doc: scrollWidth(),
			body: box ? box.scrollWidth : document.body.scrollWidth,
			scrolledTo,
		};
		const starts = grouped(startEls, inside);

		// The page is wider but nothing above explains it (a ::before/::after box has no element of
		// its own): clip one element at a time (overflow-x: clip keeps its own size and place) and go
		// down into the one whose clipping fixes the width. The deepest one holds the culprit. Each is
		// put back at once, before the page draws again.
		const folded = [];
		if (scrollWidth() > vw + slack && starts.length === 0) {
			const widthClipped = (el) => {
				const old = el.style.getPropertyValue("overflow-x");
				const prio = el.style.getPropertyPriority("overflow-x");
				el.style.setProperty("overflow-x", "clip", "important");
				const w = scrollWidth();
				if (old) el.style.setProperty("overflow-x", old, prio);
				else el.style.removeProperty("overflow-x");
				return w;
			};
			let at = top;
			for (let depth = 0; depth < 60; depth++) {
				const next = [...at.children].find((c) => widthClipped(c) <= vw + slack);
				if (!next) break;
				at = next;
			}
			if (at !== top) {
				const pseudo = ["::before", "::after"]
					.map((p) => {
						const s = getComputedStyle(at, p);
						return s.content && s.content !== "none" && s.display !== "none"
							? `${p} (${s.position}, width ${s.width}, left ${s.left}, right ${s.right})`
							: "";
					})
					.filter(Boolean)
					.join("; ");
				folded.push(facts(at, { pseudo }));
			}
		}
		return {
			ok: starts.length === 0 && shifted.length === 0 && scrolledTo === 0 && scrollWidth() <= vw + slack,
			page,
			starts,
			wide: grouped(wideEls),
			shifted,
			fixed: grouped(fixed),
			folded,
		};
	}
}

/** Run the finder in `page` (a Playwright page). */
export async function findOverflow(page, opts = {}) {
	return page.evaluate(overflowProbe, opts);
}

/** The finder's result as short lines of text (layout facts only). */
export function describeOverflow(r, { fixed = false } = {}) {
	const px = (f) => `left ${f.left} right ${f.right} width ${f.width}${f.count > 1 ? ` ×${f.count}` : ""}`;
	const lines = [
		r.page.within
			? `${r.page.within} ${r.page.window}px wide, its content ${r.page.doc}px, scrolls sideways by ${r.page.scrolledTo}px`
			: `window ${r.page.window}px, page ${r.page.doc}px (body ${r.page.body}px), scrolls sideways by ${r.page.scrolledTo}px`,
	];
	for (const f of r.starts)
		lines.push(
			`  starts: ${f.el} [${f.what}] (${px(f)}; ${f.display}, min-width ${f.minWidth}, ${f.freeInside} more inside)\n          in ${f.path || "(root)"}`,
		);
	for (const f of r.wide)
		lines.push(
			`  wide:   ${f.el} [${f.what}] (${px(f)}; white-space ${f.whiteSpace}, wrap ${f.overflowWrap}, scrollWidth ${f.scrollWidth})\n          in ${f.path || "(root)"}`,
		);
	for (const f of r.shifted)
		lines.push(`  shifted: ${f.el} scrolled ${f.scrollLeft}px (${px(f)})\n          in ${f.path || "(root)"}`);
	for (const f of r.folded ?? [])
		lines.push(
			`  found by clipping: ${f.el} (${px(f)}; ${f.display}, ${f.position}${f.pseudo ? `; ${f.pseudo}` : ""})\n          in ${f.path || "(root)"}`,
		);
	if (fixed)
		for (const f of r.fixed)
			lines.push(`  fixed (cut off, no page scroll): ${f.el} (${px(f)})\n          in ${f.path || "(root)"}`);
	return lines.join("\n");
}
