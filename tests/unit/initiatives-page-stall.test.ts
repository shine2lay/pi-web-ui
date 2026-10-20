/// <reference types="vite/client" />
// @vitest-environment jsdom
// stall-wake (Ops #284, docs/stall-watch.md "On the Initiatives page"): the stall check's lines in the slots the
// page already has: a project's row note, an item in the "in no initiative" box, an initiative's card note, and a
// lead's recorded wait. The fixed registry page of the other Initiatives tests; no chats, server or model calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage } from "../../web/src/initiatives-page/model";
import { stallLine } from "../../web/src/initiatives-page/stall";
import type { UiWorkPage } from "../../web/src/types";
import { withStall } from "../../server/stall-wake";
import type { StallFinding } from "../../server/stall-watch";
import { AT, NOW, PAGE, pageArgs } from "./initiatives-page-fixture";

const HOUR = 3_600_000;
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	document.body.replaceChildren();
});

/** The fixture with: Login form (alpha) empty, asked twice; Alpha launch silent; Docs sweep (no initiative)
 *  waiting until tomorrow; Search box (done) carrying a stall it must not show. */
function stalledPage(): UiWorkPage {
	const at = (h: number) => NOW - h * HOUR;
	return {
		...PAGE,
		initiatives: PAGE.initiatives.map((i) =>
			i.id === "alpha" ? { ...i, stall: { rule: "silent" as const, since: at(30), asked: [] } } : i,
		),
		projects: PAGE.projects.map((p) =>
			p.id === "p-login"
				? {
						...p,
						stall: {
							rule: "empty" as const,
							since: new Date(2026, 9, 18, 6, 0).getTime(),
							asked: [
								{ role: "frontend", at: new Date(2026, 9, 18, 8, 10).getTime() },
								{ role: "owner", at: new Date(2026, 9, 18, 9, 30).getTime() },
							],
						},
					}
				: p.id === "p-docs"
					? {
							...p,
							wait: {
								until: new Date(2026, 9, 19, 9, 0).getTime(),
								why: "starts after Login form",
								at: AT,
								by: "docs",
							},
						}
					: p.id === "p-search"
						? { ...p, stall: { rule: "empty" as const, since: at(3), asked: [] } }
						: p,
		),
	};
}

for (const pass of [1, 2]) {
	describe(`stall and wait lines on the Initiatives page (pass ${pass})`, () => {
		it("words each line", () => {
			const p = stalledPage();
			const login = p.projects.find((x) => x.id === "p-login")!;
			expect(stallLine(login, NOW)).toBe(
				"No open task since 06:00 \u00b7 Frontend asked 08:10 \u00b7 Owner (through COO) asked 09:30",
			);
			expect(
				stallLine(
					p.initiatives.find((x) => x.id === "alpha")!,
					NOW,
				),
			).toBe("Nothing recorded since Sat 03:45");
			expect(
				stallLine(
					p.projects.find((x) => x.id === "p-docs")!,
					NOW,
				),
			).toBe("Waits until Oct 19 09:00: starts after Login form");
			expect(
				stallLine(
					p.projects.find((x) => x.id === "p-search")!,
					NOW,
				),
			).toBeUndefined();
			// A wait that ran out shows nothing; a stall wins over a wait.
			const docs = p.projects.find((x) => x.id === "p-docs")!;
			expect(stallLine(docs, docs.wait!.until)).toBeUndefined();
			expect(stallLine({ ...docs, stall: { rule: "empty", since: NOW - HOUR, asked: [] } }, NOW)).toBe(
				"No open task since 08:45",
			);
		});

		it("puts them in the project row, the box item and the initiative card, and nowhere else", () => {
			const work = { page: stalledPage(), status: "ready" as const };
			const m = buildInitiativesPage(pageArgs({ work, open: vi.fn() }));
			const alpha = m.input.initiatives!.find((i) => i.id === "alpha")!;
			expect(alpha.statusNote).toBe("Nothing recorded since Sat 03:45");
			expect(alpha.roles!.find((r) => r.name === "Login form")!.note).toBe(
				"No open task since 06:00 \u00b7 Frontend asked 08:10 \u00b7 Owner (through COO) asked 09:30",
			);
			const item = m.input.loose!.items!.find((i) => i.id === "p-docs")!;
			expect(item.note).toBe(
				"Lead \u00b7 Docs \u00b7 0 of 3 done \u00b7 Active \u00b7 Waits until Oct 19 09:00: starts after Login form",
			);
			// Without the fields the page is as before.
			const plain = buildInitiativesPage(pageArgs({ open: vi.fn() }));
			expect(plain.input.initiatives!.find((i) => i.id === "alpha")!.statusNote).toBeUndefined();
			expect(plain.input.loose!.items!.find((i) => i.id === "p-docs")!.note).toBe(
				"Lead \u00b7 Docs \u00b7 0 of 3 done \u00b7 Active",
			);

			// Through the supplied design's view and template: the card and the row show them.
			const actions: InitiativesExactActions = {
				open: vi.fn(),
				retry: vi.fn(),
				messageLead: vi.fn(),
				changeLead: vi.fn(),
				select: vi.fn(),
			};
			const view = createInitiativesExactView(
				() => m.input,
				() => actions,
				() => {},
			);
			const binding = bindInitiativesSurface(document, () => view.values());
			cleanups.push(() => {
				binding.dispose();
				view.dispose();
			});
			const text = norm(document.body.textContent);
			expect(text).toContain("Nothing recorded since Sat 03:45");
			expect(text).toContain(
				"No open task since 06:00 \u00b7 Frontend asked 08:10 \u00b7 Owner (through COO) asked 09:30",
			);
			expect(text).toContain("Waits until Oct 19 09:00: starts after Login form");
		});

		it("clears an old silent note when a task finishes, even if another remains open", () => {
			const p = PAGE.projects.find((p) => p.id === "p-login")!;
			const since = NOW - 30 * HOUR;
			const task = {
				queue: "/fixture/queue.jsonl",
				task: 1,
				added: since - HOUR,
				title: "Fixture task",
				parent: { project: p.id },
			};
			const f: StallFinding = {
				kind: "project",
				id: p.id,
				name: p.name,
				rule: "silent",
				since,
				stretch: `project:${p.id}:silent:${since}`,
				chain: [p.lead, "owner"],
				open: [],
			};
			const old = {
				...task,
				state: "working" as const,
				stateAt: since,
				progress: undefined,
				paused: undefined,
				needsYou: undefined,
			};
			const base = {
				...PAGE,
				tasks: [old],
				projects: PAGE.projects.map((p) => ({ ...p, updatedAt: since })),
				initiatives: PAGE.initiatives.map((i) => ({ ...i, updatedAt: since })),
			};
			const hasNote = (page: UiWorkPage) =>
				!!withStall(page, [f], () => [], NOW).projects.find((x) => x.id === p.id)?.stall;
			expect(hasNote(base)).toBe(true);
			const done = { ...old, state: "done" as const, stateAt: NOW };
			expect(hasNote({ ...base, tasks: [done] })).toBe(false);
			expect(hasNote({ ...base, tasks: [done, { ...old, task: 900 }] })).toBe(false);
			const initiative = PAGE.initiatives.find((i) => i.id === p.initiative)!;
			const fi: StallFinding = {
				...f,
				kind: "initiative",
				id: initiative.id,
				name: initiative.name,
				stretch: `initiative:${initiative.id}:silent:${since}`,
				chain: [initiative.lead, "owner"],
			};
			const direct = { ...old, parent: { initiative: initiative.id } };
			const doneDirect = { ...direct, state: "done" as const, stateAt: NOW };
			const directPage = { ...base, projects: [], tasks: [direct] };
			expect(
				withStall(directPage, [fi], () => [], NOW).initiatives.find((i) => i.id === initiative.id)?.stall,
			).toBeDefined();
			expect(
				withStall({ ...directPage, projects: [p] }, [fi], () => [], NOW).initiatives.find((i) => i.id === initiative.id)
					?.stall,
			).toBeUndefined();
			expect(
				withStall(
					{ ...directPage, tasks: [doneDirect, { ...direct, task: 900 }] },
					[fi],
					() => [],
					NOW,
				).initiatives.find((i) => i.id === initiative.id)?.stall,
			).toBeUndefined();
			// A dropped project's leftover open task does not cover an otherwise empty initiative (#283 rules).
			const droppedChild = { ...base, projects: [{ ...p, status: "dropped" as const }] };
			const empty: StallFinding = { ...fi, rule: "empty", stretch: `initiative:${initiative.id}:empty:${since}` };
			expect(
				withStall(droppedChild, [empty], () => [], NOW).initiatives.find((i) => i.id === initiative.id)?.stall,
			).toBeDefined();
		});

		it("gets the fields from the stall check's findings (server, withStall)", () => {
			const f: StallFinding = {
				kind: "project",
				id: "p-login",
				name: "Login form",
				rule: "empty",
				since: AT - HOUR,
				stretch: `project:p-login:empty:${AT - HOUR}`,
				chain: ["frontend", "architecture", "owner"],
				open: [],
			};
			const asked = vi.fn(() => [{ role: "frontend", at: AT }]);
			const empty = { ...PAGE, tasks: PAGE.tasks.filter((t) => !("project" in t.parent && t.parent.project === f.id)) };
			const out = withStall(empty, [f], asked, NOW);
			expect(asked).toHaveBeenCalledWith(f.stretch);
			expect(out.projects.find((p) => p.id === "p-login")!.stall).toEqual({
				rule: "empty",
				since: AT - HOUR,
				asked: [{ role: "frontend", at: AT }],
			});
			expect(out.projects.filter((p) => p.stall)).toHaveLength(1);
			expect(out.initiatives.filter((i) => i.stall)).toHaveLength(0);
			expect(withStall(PAGE, [], asked)).toBe(PAGE);
			// A task/wait/lead change since the last 10-min round must not carry its now-old finding.
			const moving: UiWorkPage = {
				...PAGE,
				tasks: [
					{
						queue: "/fixture/queue.jsonl",
						task: 1,
						added: NOW,
						title: "Next task",
						parent: { project: f.id },
						state: "ready",
					},
				],
			};
			expect(withStall(moving, [f], asked, NOW).projects.some((p) => p.stall)).toBe(false);
			const waiting = {
				...empty,
				projects: empty.projects.map((p) =>
					p.id === f.id ? { ...p, wait: { until: NOW + HOUR, why: "next review", at: NOW, by: "frontend" } } : p,
				),
			};
			expect(withStall(waiting, [f], asked, NOW).projects.some((p) => p.stall)).toBe(false);
			const reassigned = { ...empty, projects: empty.projects.map((p) => (p.id === f.id ? { ...p, lead: "ops" } : p)) };
			expect(withStall(reassigned, [f], asked, NOW).projects.some((p) => p.stall)).toBe(false);
		});
	});
}
