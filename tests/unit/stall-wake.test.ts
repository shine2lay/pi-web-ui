/**
 * stall-wake (Ops #284): the stall check wakes each stalled stretch's chain in turn (server/stall-wake.ts), and
 * the work check's role messages (role-messages.ts requestStall). Fixed findings and a temporary ledger only:
 * never the live registry, ledger or role message store.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { starterOf } from "../../server/quiet-turns.js";
import {
	RoleMessages,
	STALL_HINT,
	STALL_OWNER_HINT,
	roleMessageHeader,
	roleMessageHint,
	type RoleMessageHost,
} from "../../server/role-messages.js";
import type { UiWorkPage } from "../../server/protocol.js";
import type { StallExtra, StallFinding } from "../../server/stall-watch.js";
import {
	STALL_DAY_CAP,
	STALL_HOUR_CAP,
	StallWake,
	planStallRound,
	readStallLedger,
	stallLeadItemText,
	stallStretchEnded,
	stallWhen,
	stallWakesOn,
	type StallItemInfo,
	type StallLedgerLine,
	type StallWakeHost,
} from "../../server/stall-wake.js";
import { parseRoleMessageText } from "../../web/src/role-message-text.js";

const HOUR = 3_600_000;
const MIN = 60_000;
/** Local noon, so a few hours on stay the same local day. */
const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();

function finding(o: Partial<StallFinding> & { id: string }): StallFinding {
	const kind = o.kind ?? "project";
	const rule = o.rule ?? "empty";
	const since = o.since ?? T0 - 3 * HOUR;
	return {
		kind,
		name: o.name ?? `Name ${o.id}`,
		rule,
		since,
		stretch: `${kind}:${o.id}:${rule}:${since}`,
		chain: o.chain ?? ["ops", "architecture", "owner"],
		open: o.open ?? [],
		...o,
		...(o.stretch ? {} : { stretch: `${kind}:${o.id}:${rule}:${since}` }),
	};
}

let dir = "";
let ledgerFile = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stall-wake-"));
	ledgerFile = join(dir, "data", "stall-watch.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Sent {
	role: string;
	items: StallItemInfo[];
	text: string;
}

function harness(o: { paused?: boolean; wakesOn?: boolean; noHome?: string[]; gapHours?: number } = {}) {
	const sent: Sent[] = [];
	const logs: string[] = [];
	const state = { paused: !!o.paused, wakesOn: o.wakesOn ?? true, lost: [] as Sent[], ended: new Set<string>() };
	let n = 0;
	const host: StallWakeHost = {
		paused: () => state.paused,
		wakesOn: () => state.wakesOn,
		hasHome: (r) => !(o.noHome ?? []).includes(r),
		ended: (stretch) => state.ended.has(stretch),
		send: (input) => {
			sent.push(input);
			return { ok: true, id: `rm-${String(++n).padStart(8, "0")}` };
		},
		log: (l) => logs.push(l),
	};
	const make = () => new StallWake(host, ledgerFile, () => ({ gapHours: o.gapHours ?? 2 }));
	return { sent, logs, state, host, make, wake: make() };
}

const ledgerLines = (): StallLedgerLine[] =>
	readFileSync(ledgerFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

// Every case runs twice in a row (rule 16: steady on known cases).
for (const pass of [1, 2]) {
	describe(`stall-wake chain (pass ${pass})`, () => {
		it("sends step 1 to the lead when a stretch is first found", () => {
			const h = harness();
			const f = finding({ id: "team-page-truth", initiative: "team-in-temper" });
			h.wake.act([f], T0);
			expect(h.sent).toHaveLength(1);
			expect(h.sent[0]).toMatchObject({ role: "ops", items: [{ kind: "project", id: "team-page-truth", step: 1 }] });
			expect(ledgerLines()).toEqual([
				{ stretch: f.stretch, step: 1, to: "ops", at: T0, id: "rm-00000001", state: "sent" },
			]);
		});

		it("sends step 2 only after the gap, and only while the same stretch is found", () => {
			const h = harness();
			const f = finding({ id: "p1" });
			h.wake.act([f], T0);
			h.wake.act([f], T0 + HOUR);
			h.wake.act([f], T0 + 2 * HOUR - MIN);
			expect(h.sent).toHaveLength(1);
			h.wake.act([], T0 + 2 * HOUR); // not found this round: nothing
			expect(h.sent).toHaveLength(1);
			h.wake.act([f], T0 + 2 * HOUR + MIN);
			expect(h.sent.map((s) => [s.role, s.items[0]!.step])).toEqual([
				["ops", 1],
				["architecture", 2],
			]);
		});

		it("stops the chain when the stretch ends; a new stretch starts again at step 1", () => {
			const h = harness();
			const f = finding({ id: "p1" });
			h.wake.act([f], T0);
			h.wake.act([], T0 + 3 * HOUR);
			h.wake.act([], T0 + 6 * HOUR);
			expect(h.sent).toHaveLength(1);
			const again = finding({ id: "p1", since: T0 + 5 * HOUR });
			h.wake.act([again], T0 + 7 * HOUR);
			expect(h.sent.map((s) => [s.role, s.items[0]!.step, s.items[0]!.since])).toEqual([
				["ops", 1, f.since],
				["ops", 1, again.since],
			]);
		});

		it("sends the owner's step once, to COO, after both earlier steps, gapHours apart", () => {
			const h = harness();
			const f = finding({ id: "p1" });
			for (let t = 0; t <= 12; t++) h.wake.act([f], T0 + t * HOUR);
			expect(h.sent.map((s) => s.role)).toEqual(["ops", "architecture", "coo"]);
			const owner = h.sent[2]!;
			expect(owner.items).toEqual([expect.objectContaining({ step: 3, owner: true })]);
			expect(owner.text).toContain(
				`Woken: ops at ${stallWhen(T0, T0)}, architecture at ${stallWhen(T0 + 2 * HOUR, T0)}; nothing changed.`,
			);
			expect(owner.text).toContain(
				"Put it to the owner as one dialog with the full package (rule 21): drop it, pause it, reassign it, or name the next work.",
			);
			const at = ledgerLines()
				.filter((l) => l.state === "sent")
				.map((l) => l.at);
			expect(at).toEqual([T0, T0 + 2 * HOUR, T0 + 4 * HOUR]);
			expect(ledgerLines().at(-1)).toMatchObject({ to: "coo", owner: true, step: 3 });
		});

		it("says so when COO was an earlier step, and when the lead is the owner", () => {
			const h = harness();
			const coo = finding({ id: "c1", chain: ["coo", "owner"] });
			const own = finding({ id: "o1", kind: "initiative", chain: ["owner"] });
			h.wake.act([coo, own], T0);
			h.wake.act([coo, own], T0 + 2 * HOUR);
			expect(h.sent).toHaveLength(2);
			expect(h.sent[0]!.items.map((i) => [i.id, i.step, !!i.owner])).toEqual([
				["c1", 1, false],
				["o1", 1, true],
			]);
			expect(h.sent[0]!.text).toContain("Its lead is the owner, so no role was woken first.");
			expect(h.sent[1]!.text).toContain("Woken: COO (you) at");
		});

		it("batches all due items for one recipient into one message", () => {
			const h = harness();
			const a = finding({ id: "a" });
			const b = finding({ id: "b", kind: "initiative", rule: "silent", chain: ["ops", "owner"] });
			const c = finding({ id: "c", chain: ["docs", "owner"] });
			h.wake.act([a, b, c], T0);
			expect(h.sent.map((s) => [s.role, s.items.map((i) => i.id)])).toEqual([
				["ops", ["a", "b"]],
				["docs", ["c"]],
			]);
			expect(h.sent[0]!.text).toContain('Project "Name a" (a): no open task since');
			expect(h.sent[0]!.text).toContain('Initiative "Name b" (b): nothing recorded since');
			expect(
				new Set(
					ledgerLines()
						.filter((l) => l.to === "ops")
						.map((l) => l.id),
				).size,
			).toBe(1);
		});

		it("keeps the per-recipient day cap; a capped step waits for room and is written once", () => {
			const h = harness();
			const found: StallFinding[] = [];
			for (let i = 0; i < STALL_DAY_CAP + 2; i++) {
				found.push(finding({ id: `p${i}`, chain: ["ops", "owner"] }));
				h.wake.act([...found], T0 + i * 10 * MIN);
			}
			expect(h.sent).toHaveLength(STALL_DAY_CAP);
			const capped = ledgerLines().filter((l) => l.state === "capped");
			expect(capped.map((l) => l.stretch)).toEqual([found[6]!.stretch, found[7]!.stretch]);
			// Next local day: room again; both waiting steps go together.
			const tomorrow = new Date(2026, 9, 21, 0, 5).getTime();
			h.wake.act(found.slice(6), tomorrow);
			expect(h.sent).toHaveLength(STALL_DAY_CAP + 1);
			expect(h.sent.at(-1)!.items.map((i) => i.id)).toEqual(["p6", "p7"]);
		});

		it("keeps the hourly cap across recipients", () => {
			const h = harness();
			const found = Array.from({ length: STALL_HOUR_CAP + 1 }, (_, i) =>
				finding({ id: `p${i}`, chain: [`role${i}`, "owner"] }),
			);
			h.wake.act(found, T0);
			expect(h.sent).toHaveLength(STALL_HOUR_CAP);
			expect(
				ledgerLines()
					.filter((l) => l.state === "capped")
					.map((l) => l.to),
			).toEqual([`role${STALL_HOUR_CAP}`]);
			h.wake.act(found, T0 + 30 * MIN);
			expect(h.sent).toHaveLength(STALL_HOUR_CAP);
			h.wake.act(found, T0 + HOUR + MIN);
			expect(h.sent.at(-1)!.role).toBe(`role${STALL_HOUR_CAP}`);
		});

		it("holds everything while the owner has role messages paused; re-checks once he resumes", () => {
			const h = harness({ paused: true });
			const f = finding({ id: "p1" });
			const g = finding({ id: "p2", chain: ["docs", "owner"] });
			h.wake.act([f, g], T0);
			h.wake.act([f, g], T0 + 10 * MIN);
			expect(h.sent).toHaveLength(0);
			expect(ledgerLines().map((l) => [l.stretch, l.state])).toEqual([
				[f.stretch, "held"],
				[g.stretch, "held"],
			]);
			h.state.paused = false;
			h.wake.act([f], T0 + 20 * MIN); // g's stretch ended meanwhile: nothing for it
			expect(h.sent.map((s) => [s.role, s.items[0]!.id])).toEqual([["ops", "p1"]]);
		});

		it("skips a recipient with wakes off, and the chain moves on after the gap", () => {
			const h = harness({ wakesOn: false });
			const f = finding({ id: "p1" });
			h.wake.act([f], T0);
			expect(h.sent).toHaveLength(0);
			expect(ledgerLines()).toEqual([expect.objectContaining({ step: 1, to: "ops", state: "wakes-off" })]);
			h.state.wakesOn = true;
			h.wake.act([f], T0 + HOUR);
			expect(h.sent).toHaveLength(0);
			h.wake.act([f], T0 + 2 * HOUR);
			expect(h.sent.map((s) => [s.role, s.items[0]!.step])).toEqual([["architecture", 2]]);
		});

		it("skips a role with no home chat the same way", () => {
			const h = harness({ noHome: ["ops"] });
			h.wake.act([finding({ id: "p1" })], T0);
			expect(h.sent).toHaveLength(0);
			expect(ledgerLines()[0]).toMatchObject({ state: "no-chat", to: "ops" });
		});

		it("sends no duplicate after a restart (the ledger read again), nor when a ledger line was lost", () => {
			const h = harness();
			const f = finding({ id: "p1" });
			h.wake.act([f], T0);
			const again = h.make();
			again.act([f], T0 + 10 * MIN);
			again.act([f], T0 + HOUR);
			expect(h.sent).toHaveLength(1);
			// The send went but its ledger line didn't (a crash between): the store's record says so.
			unlinkSync(ledgerFile);
			h.host.sentBefore = (stretch, step, to) =>
				stretch === f.stretch && step === 1 && to === "ops" ? { id: "rm-00000001", at: T0 } : undefined;
			const third = h.make();
			third.act([f], T0 + HOUR);
			expect(h.sent).toHaveLength(1);
			expect(ledgerLines()).toEqual([
				{ stretch: f.stretch, step: 1, to: "ops", at: T0, id: "rm-00000001", state: "sent" },
			]);
			third.act([f], T0 + 2 * HOUR);
			expect(h.sent.map((s) => s.role)).toEqual(["ops", "architecture"]);
		});

		it("recovers all creation receipts before applying caps, including stretches no longer found", () => {
			const h = harness();
			h.host.history = () =>
				Array.from({ length: STALL_DAY_CAP }, (_, i) => ({
					stretch: finding({ id: `old${i}` }).stretch,
					step: 1,
					to: "ops",
					at: T0 - MIN,
					id: `rm-old${i}`,
					state: "sent" as const,
				}));
			h.wake.act([finding({ id: "new" })], T0);
			expect(h.sent).toHaveLength(0);
			expect(ledgerLines().filter((l) => l.state === "sent")).toHaveLength(STALL_DAY_CAP);
			expect(ledgerLines().at(-1)).toMatchObject({ state: "capped", to: "ops" });
			h.make().act([finding({ id: "new" })], T0 + MIN);
			expect(ledgerLines()).toHaveLength(STALL_DAY_CAP + 1);
		});

		it("uses pi-queue's disabled-wakes switch and fails quiet on unreadable settings", () => {
			const file = join(dir, "pi-queue.json");
			expect(stallWakesOn(file)).toBe(true);
			writeFileSync(file, JSON.stringify({ wakeOnDone: false }));
			expect(stallWakesOn(file)).toBe(false);
			writeFileSync(file, JSON.stringify({ wakeOnDone: true }));
			expect(stallWakesOn(file)).toBe(true);
			writeFileSync(file, "{");
			expect(stallWakesOn(file)).toBe(false);
		});

		it("expires verified-ended history after 30 days, retains unresolved checkpoints, and removes a cut-off line", () => {
			const old: StallLedgerLine = {
				stretch: "project:x:empty:1",
				step: 1,
				to: "ops",
				at: T0 - 31 * 24 * HOUR,
				state: "sent",
				id: "rm-1",
				endedAt: T0 - 31 * 24 * HOUR,
			};
			const kept: StallLedgerLine = { ...old, stretch: "project:y:empty:1", endedAt: undefined };
			mkdirSync(dirname(ledgerFile), { recursive: true });
			writeFileSync(ledgerFile, `${JSON.stringify(old)}\n${JSON.stringify(kept)}\n{"stretch":"cut`);
			expect(readStallLedger(ledgerFile, T0)).toEqual([kept]);
			expect(readFileSync(ledgerFile, "utf8")).toBe(`${JSON.stringify(kept)}\n`);
		});

		it("never replays an unchanged finished chain after more than 30 days and a reload", () => {
			const h = harness();
			const f = finding({ id: "long-lived" });
			for (const t of [0, 2, 4]) h.wake.act([f], T0 + t * HOUR);
			const original = ledgerLines();
			h.make().act([f], T0 + 40 * 24 * HOUR);
			expect(h.sent).toHaveLength(3);
			expect(ledgerLines()).toEqual(original);
		});

		it("retains every partial-chain step and its original time across a long quiet period", () => {
			const h = harness({ wakesOn: false });
			const f = finding({ id: "partial" });
			h.wake.act([f], T0); // consumed but not sent
			h.wake.act([f], T0 + 2 * HOUR); // second consumed step, not just the final chain step
			h.wake.act([], T0 + 40 * 24 * HOUR); // absence alone proves nothing
			h.state.wakesOn = true;
			h.make().act([f], T0 + 40 * 24 * HOUR + MIN);
			expect(h.sent.map((s) => [s.role, s.items[0]!.step])).toEqual([["coo", 3]]);
			expect(
				ledgerLines()
					.slice(0, 2)
					.map((l) => [l.step, l.at, l.state]),
			).toEqual([
				[1, T0, "wakes-off"],
				[2, T0 + 2 * HOUR, "wakes-off"],
			]);
		});

		it("does not expire steps through suppression or unavailable evidence, and keeps the escalation gap", () => {
			const h = harness();
			const f = finding({ id: "suppressed" });
			h.wake.act([f], T0);
			h.state.paused = true;
			h.host.ended = undefined; // failed/incomplete read offers no positive end evidence
			h.wake.act([], T0 + 40 * 24 * HOUR);
			h.make().act([], T0 + 41 * 24 * HOUR);
			expect(h.sent).toHaveLength(1);
			h.state.paused = false;
			const resumed = h.make();
			const at = T0 + 42 * 24 * HOUR;
			resumed.act([f], at);
			resumed.act([f], at + 2 * HOUR - 1);
			expect(h.sent.map((s) => s.items[0]!.step)).toEqual([1, 2]);
			resumed.act([f], at + 2 * HOUR);
			expect(h.sent.map((s) => s.items[0]!.step)).toEqual([1, 2, 3]);
			expect(ledgerLines()[0]!.at).toBe(T0);
		});

		it("cleans checkpoints only 30 days after a verified end; a genuinely new stretch starts normally", () => {
			const h = harness();
			const f = finding({ id: "ended" });
			h.wake.act([f], T0);
			h.state.ended.add(f.stretch);
			const end = T0 + HOUR;
			h.wake.act([], end);
			expect(ledgerLines()[0]).toMatchObject({ at: T0, endedAt: end });
			expect(readStallLedger(ledgerFile, end + 30 * 24 * HOUR - 1)).toHaveLength(1);
			expect(readStallLedger(ledgerFile, end + 30 * 24 * HOUR)).toEqual([]);
			const again = finding({ id: "ended", since: end + 31 * 24 * HOUR });
			h.make().act([again], again.since + 3 * HOUR);
			expect(h.sent.map((s) => [s.items[0]!.since, s.items[0]!.step])).toEqual([
				[f.since, 1],
				[again.since, 1],
			]);
		});

		it("requires positive end evidence, never a pause, needs-you state, missing item or failed read", () => {
			const f = finding({ id: "p" });
			const r = {
				id: "p",
				name: "P",
				outcome: "",
				lead: "ops",
				status: "active" as const,
				createdAt: f.since - HOUR,
				createdBy: "owner",
				updatedAt: f.since,
				doneWhen: [],
			};
			const task = {
				queue: "/fixture/queue",
				task: 1,
				added: f.since - HOUR,
				title: "Work",
				parent: { project: "p" },
				state: "blocked" as const,
			};
			const page: UiWorkPage = { at: T0, initiatives: [], projects: [r], tasks: [], activity: [] };
			const extra: StallExtra = { times: new Map(), leadUpdates: new Map() };
			expect(stallStretchEnded(f.stretch, page, extra)).toBe(false);
			expect(stallStretchEnded(f.stretch, { ...page, projects: [] }, extra)).toBe(false);
			expect(
				stallStretchEnded(f.stretch, { ...page, tasks: [{ ...task, paused: { at: T0, why: "owner" } }] }, extra),
			).toBe(false);
			expect(
				stallStretchEnded(f.stretch, { ...page, tasks: [{ ...task, needsYou: { text: "Owner choice" } }] }, extra),
			).toBe(false);
			const done: UiWorkPage = { ...page, projects: [{ ...r, status: "done" }] };
			expect(stallStretchEnded(f.stretch, { ...done, problem: "unreadable" }, extra)).toBe(false);
			expect(stallStretchEnded(f.stretch, done, extra)).toBe(true);
			expect(stallStretchEnded(f.stretch, { ...page, tasks: [{ ...task, added: T0 }] }, extra)).toBe(true);
			// A renamed open task leaves added/stateAt unchanged but advances the registry's eventAt.
			const silent = finding({ id: "p", rule: "silent", since: f.since });
			const renamed = { ...page, tasks: [{ ...task, title: "Renamed" }] };
			expect(stallStretchEnded(silent.stretch, renamed, extra)).toBe(false);
			const changed: StallExtra = { ...extra, times: new Map([["project:p", { eventAt: T0 }]]) };
			expect(stallStretchEnded(silent.stretch, renamed, changed)).toBe(true);
		});

		it("the global wakes-off switch also suppresses the COO owner step", () => {
			const h = harness({ wakesOn: false });
			const f = finding({ id: "quiet-owner" });
			for (const t of [0, 2, 4, 50]) h.wake.act([f], T0 + t * HOUR);
			expect(h.sent).toHaveLength(0);
			expect(ledgerLines().map((l) => [l.to, l.state])).toEqual([
				["ops", "wakes-off"],
				["architecture", "wakes-off"],
				["coo", "wakes-off"],
			]);
		});

		it("plans nothing for a finding whose owner step already went", () => {
			const f = finding({ id: "p1", chain: ["owner"] });
			const ledger: StallLedgerLine[] = [
				{ stretch: f.stretch, step: 1, to: "coo", at: T0, state: "sent", id: "rm-1", owner: true },
			];
			const plan = planStallRound({
				findings: [f],
				ledger,
				now: T0 + 48 * HOUR,
				gapHours: 2,
				paused: false,
				wakesOn: true,
				hasHome: () => true,
			});
			expect(plan).toEqual({ batches: [], lines: [] });
		});

		it("keeps one item's text short and says who comes next", () => {
			const f = finding({
				id: "p1",
				name: "A".repeat(200),
				initiative: "team-in-temper",
				lastDone: { queue: "ops", task: 281, title: "T".repeat(200), summary: "S".repeat(400), at: T0 - 4 * HOUR },
				open: Array.from({ length: 6 }, (_, i) => ({
					queue: "ops",
					task: i,
					title: "x".repeat(100),
					status: "blocked",
					waitsOn: "w".repeat(200),
				})),
			});
			const text = stallLeadItemText({ finding: f, step: 1, to: "ops", owner: false }, T0, 2);
			expect(text.length).toBeLessThanOrEqual(650);
			expect(text).toContain(
				`Next: if nothing changes, architecture is woken at ${stallWhen(T0 + 2 * HOUR, T0)}, then the owner through COO.`,
			);
			expect(text).toContain(
				"To clear it: queue the next task under it (queue_add with project p1), close it (work_project change, status done or dropped), or record a wait with its end (work_project wait).",
			);
			expect(text).toContain("Last done: ops #281");
		});
	});

	describe(`work check role messages (pass ${pass})`, () => {
		const items: StallItemInfo[] = [
			{ kind: "project", id: "team-page-truth", name: "Team page truth", rule: "empty", since: T0 - 3 * HOUR, step: 1 },
			{ kind: "initiative", id: "x", name: "X work", rule: "silent", since: T0 - 30 * HOUR, step: 1 },
		];

		it("has its own header and hint, and the owner's step its own hint", () => {
			const base = {
				id: "rm-0123abcd",
				from: { role: "app", title: "the work check", chat: "Work check", file: "" },
				kind: "report" as const,
			};
			expect(roleMessageHeader({ ...base, stall: { items } })).toBe(
				"[Role message rm-0123abcd from the work check \u00b7 stalled work \u00b7 Team page truth, X work]",
			);
			expect(roleMessageHint({ ...base, stall: { items } })).toBe(STALL_HINT);
			expect(roleMessageHint({ ...base, stall: { items: [{ ...items[0]!, owner: true }] } })).toBe(STALL_OWNER_HINT);
			expect(roleMessageHint({ ...base, stall: { items: [items[0]!, { ...items[1]!, owner: true }] } })).toBe(
				`(This batch has both lead-action and owner-step items. Apply the lead-action hint only to items saying "To clear it", and the owner-dialog hint only to items saying "Put it to the owner".) ${STALL_HINT} ${STALL_OWNER_HINT}`,
			);
			expect(STALL_HINT).toBe(
				"(The work check found work you lead that isn't moving. Act with your tools: queue the next task under it (queue_add with its project or initiative), close it (work_project or work_initiative change, status done or dropped), or record a wait with its end (work_project or work_initiative wait). Nothing starts by itself. No reply is needed: the check sees what you do. Write nothing for the owner in this chat.)",
			);
		});

		it("is delivered like a poke, folds like a role's turn, parses on the page, and takes no reply", async () => {
			const home = join(dir, "ops-home.jsonl");
			writeFileSync(home, `${JSON.stringify({ type: "session", version: 3, id: "ops", cwd: dir })}\n`);
			const sent: { file: string; text: string }[] = [];
			const host: RoleMessageHost = {
				roles: () => [
					{
						id: "ops",
						title: "ops/tooling",
						homeChat: home,
						pastHomeChats: [],
						raw: {},
						dir,
					} as unknown as IdentityDef,
					{ id: "docs", title: "docs", pastHomeChats: [], raw: {}, dir } as unknown as IdentityDef,
				],
				chatState: () => "idle",
				deliver: async (file, text) => {
					sent.push({ file, text });
					appendFileSync(
						file,
						`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
					);
					return { ok: true };
				},
				note: async () => ({ ok: true }),
				log: () => {},
			};
			const s = new RoleMessages(join(dir, "rm", "role-messages.json"), host, () => T0);
			try {
				const r = s.requestStall({ role: "ops", items, text: "body" });
				if (!r.ok) throw new Error(r.error);
				expect(r.record).toMatchObject({
					kind: "report",
					chain: 1,
					from: { role: "app", title: "the work check", chat: "Work check", file: "" },
					stall: { items },
				});
				expect(r.record.initiative).toBeUndefined();
				await s.tick();
				expect(sent).toHaveLength(1);
				const text = sent[0]!.text;
				expect(text.split("\n")[0]).toBe(
					`[Role message ${r.record.id} from the work check \u00b7 stalled work \u00b7 Team page truth, X work]`,
				);
				expect(text.endsWith(STALL_HINT)).toBe(true);
				expect(starterOf({ role: "user", text })).toEqual({ kind: "role" });
				expect(starterOf({ role: "user", text, stamp: { kind: "report", stall: true } })).toEqual({ kind: "role" });
				expect(parseRoleMessageText(text)).toMatchObject({
					id: r.record.id,
					kind: "report",
					stall: { names: "Team page truth, X work" },
					body: "body",
					hint: STALL_HINT,
				});
				expect(s.stampFor(home, text)).toMatchObject({ kind: "report", stall: { names: "Team page truth, X work" } });
				expect(s.stallStepSent("project:team-page-truth:empty:" + (T0 - 3 * HOUR), 1, "ops")).toEqual({
					id: r.record.id,
					at: T0,
				});
				expect(s.stallStepSent("project:team-page-truth:empty:" + (T0 - 3 * HOUR), 2, "ops")).toBeUndefined();
				expect(s.stallHistory()).toHaveLength(2);
				expect(s.stallHistory()[0]).toEqual({
					stretch: `project:team-page-truth:empty:${T0 - 3 * HOUR}`,
					step: 1,
					to: "ops",
					id: r.record.id,
					at: T0,
				});
				expect(s.requestStall({ role: "docs", items, text: "x" })).toEqual({
					ok: false,
					error: "docs has no home chat",
				});
				expect(s.requestStall({ role: "nobody", items, text: "x" })).toMatchObject({ ok: false });
			} finally {
				s.stop();
			}
		});
	});
}
