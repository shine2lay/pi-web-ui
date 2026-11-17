/* Design #326 M2: external browser assertions, using the existing Roles feed/page harness. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rectangles must survive every clipping ancestor, not just document.scrollWidth. */
function miniBounds(button) {
	const tile = button.closest(".rbp-tile") ?? button;
	const nodes = [...button.querySelectorAll(".rbp-draw .sq")];
	const labels = [...button.querySelectorAll(".rbp-draw .rbp-cut")];
	const clipped = [];
	const overlap = [];
	const clips = (v) => /^(hidden|clip|auto|scroll)$/.test(v);
	const elements = [...nodes, ...labels];
	const rects = elements.map((e) => e.getBoundingClientRect());
	for (const [i, el] of elements.entries()) {
		const r = rects[i];
		const name = el.textContent || el.dataset.miniRef || `square ${i}`;
		if (r.width < 1 || r.height < 1) clipped.push(`${name}: empty`);
		for (let a = el.parentElement; a; a = a.parentElement) {
			const ar = a.getBoundingClientRect();
			const s = getComputedStyle(a);
			if (
				((a === tile || clips(s.overflowX)) && (r.left < ar.left - 0.5 || r.right > ar.right + 0.5)) ||
				((a === tile || clips(s.overflowY)) && (r.top < ar.top - 0.5 || r.bottom > ar.bottom + 0.5))
			)
				clipped.push(`${name}: outside ${a.className || a.tagName}`);
		}
		for (let j = i + 1; j < rects.length; j++) {
			const b = rects[j];
			if (
				Math.min(r.right, b.right) - Math.max(r.left, b.left) > 1 &&
				Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 1
			)
				overlap.push(`${i}/${j}`);
		}
	}
	return {
		count: nodes.length,
		refs: nodes.map((n) => n.dataset.miniRef),
		clipped,
		overlap,
		labels: labels.map((l) => l.textContent.trim()),
		readable: labels.every((l) => parseFloat(getComputedStyle(l).fontSize) >= 12),
		green: nodes.every((n) => n.classList.contains("k-ok")),
	};
}

export async function miniMaps(browser, name, { data, graph, openPage, tile, check, overlapScan }) {
	const tasks = data.denseMiniTasks();
	const rows = tasks.filter((t) => t.groupKey === "tag:dense-mini");
	const mini = graph.miniMapOf(graph.taskMapOf(rows), rows);
	const selected = [...mini.columns.flatMap((c) => c.refs), ...mini.squares.refs];
	check(
		`M2 ${name} fixture: 13 layers, +4 earlier/+4 later/+3 layer, seven loose`,
		graph.taskMapOf(rows).layers.length === 13 &&
			mini.earlier === 4 &&
			mini.later === 4 &&
			mini.columns[0].more === 3 &&
			mini.squares.refs.length === 7 &&
			selected.length === 16,
	);
	const out = process.env.PI_ROLES_MINI_SHOTS;
	if (out) mkdirSync(out, { recursive: true });
	for (const width of [320, 390, 1440])
		for (const theme of ["light", "dark"]) {
			const { context, page, errors } = await openPage(browser, { width, theme, tasks });
			const tag = `M2 ${name} ${width}px ${theme}`;
			try {
				const target = tile(page, "dense-mini");
				await target.scrollIntoViewIfNeeded();
				const r = await target.evaluate(miniBounds);
				check(`${tag}: all 16 selected nodes drawn`, r.count === selected.length);
				check(
					`${tag}: every selected node and label inside tile/clipping ancestors`,
					!r.clipped.length,
					r.clipped.join(" | "),
				);
				check(
					`${tag}: +4 earlier layers, +4 later, per-layer +3 visible`,
					["+4 earlier layers", "+4 later", "+3"].every((s) => r.labels.includes(s)),
					r.labels.join(" | "),
				);
				check(
					`${tag}: counts readable and no node/label overlap`,
					r.readable && !r.overlap.length,
					r.overlap.join(" | "),
				);
				check(`${tag}: refs match canonical miniMapOf selection`, JSON.stringify(r.refs) === JSON.stringify(selected));
				if (out && name === "Chromium") {
					await target.screenshot({ path: join(out, `mini-${width}-${theme}@2x.png`) });
					// Isolated rendered feature snapshot for the standard ui-check (no shell or production fixture path).
					if (width === 1440) {
						const html = await page.evaluate(() => {
							const css = [...document.styleSheets]
								.flatMap((s) => {
									try {
										return [...s.cssRules].map((r) => r.cssText);
									} catch {
										return [];
									}
								})
								.join("\n");
							return `<!doctype html><html ${[...document.documentElement.attributes].map((a) => `${a.name}="${a.value}"`).join(" ")}><head><meta charset="utf-8"><style>${css}</style></head><body>${document.querySelector(".rbp").outerHTML}<script>new MutationObserver(() => { document.querySelector('.rbp').dataset.tasksRolesV8Theme = document.documentElement.dataset.theme; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });</script></body></html>`;
						});
						writeFileSync(join(out, "rendered.html"), html);
					}
				}
				const cap = tile(page, "capped-mini");
				await cap.scrollIntoViewIfNeeded();
				const c = await cap.evaluate(miniBounds);
				check(
					`${tag}: forty loose cap +3, all forty squares visible`,
					c.count === 40 && c.labels.includes("+3") && !c.clipped.length && !c.overlap.length,
					c.clipped.join(" | "),
				);
				await page.locator(".rbp-donefold > summary").filter({ hasText: "Done lately" }).click();
				const done = page.locator("button.rbp-mini").filter({ hasText: "done-mini" });
				await done.scrollIntoViewIfNeeded();
				await done.evaluate(async (el) => {
					el.scrollIntoView({ block: "center", behavior: "instant" });
					await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				});
				const d = await done.evaluate(miniBounds);
				check(
					`${tag}: idle compact scale, seven green done squares visible`,
					d.count === 7 && d.green && !d.clipped.length && !d.overlap.length,
					d.clipped.join(" | "),
				);
				await target.click();
				await page.locator(".rbp-tile.is-open .rbp-task").first().waitFor();
				check(
					`${tag}: opened map still has all twenty linked cards`,
					(await page.locator(".rbp-tile.is-open .rbp-dag .rbp-task").count()) === 20,
				);
				if (out && name === "Chromium")
					await page.locator(".rbp-tile.is-open").screenshot({ path: join(out, `opened-${width}-${theme}@2x.png`) });
				const physical = await page.evaluate(overlapScan);
				check(
					`${tag}: no horizontal overflow or text overlap`,
					physical.overflow <= 0 && !physical.hits.length,
					physical.hits.slice(0, 3).join(" | "),
				);
				// WebKit reports this existing shell meta-viewport parsing warning as an error (also on the base).
				// Architecture rm-b04e515c scopes this feature to .rbp; no other error is excluded.
				const featureErrors = errors.filter(
					(e) => e !== 'console Viewport argument key "interactive-widget" not recognized and ignored.',
				);
				check(`${tag}: no feature console/page errors`, !featureErrors.length, featureErrors.join(" | "));
			} finally {
				await context.close();
			}
		}
}
