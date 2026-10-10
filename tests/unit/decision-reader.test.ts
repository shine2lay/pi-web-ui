/**
 * decision-reader (task #84): batching, the answer's schema check, verbatim quotes and owner fields,
 * changes and repeats, filing (tag, markers, the model's guess), retries, the daily cap, and the
 * previews of older answers; with a fake model. Also the store's seed and the decision_log tool.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDecisionLog, type DecisionLogHost } from "../../server/decision-log-tool.js";
import {
	claudePoolMembers,
	isLimitRefusal,
	lastError,
	pickAccount,
	timeoutNote,
	type DecisionModel,
	type DecisionModelCall as ModelCall,
} from "../../server/decision-model.js";
import { AnswerPreviews, previewsOfLine } from "../../server/decision-previews.js";
import {
	DecisionReader,
	LIMIT_REST_MS,
	lineDelta,
	parseAnswer,
	READER_SYSTEM,
	readerStatus,
	renderRecord,
} from "../../server/decision-reader.js";
import { DecisionRecords, type DecisionRecord, type NewDecisionRecord } from "../../server/decision-records.js";
import { DecisionStore, fileRecord, TEAM_IN_TEMPER } from "../../server/decision-store.js";
import { buildDecisionsPage, citedRecords } from "../../server/decision-view.js";
import type { RoleMessageSender } from "../../server/role-messages.js";

let dir: string;
let records: DecisionRecords;
let store: DecisionStore;
const T0 = Date.parse("2026-10-05T09:00:00-07:00");
let clock = T0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decision-reader-unit-"));
	records = new DecisionRecords(dir, { now: () => clock });
	store = new DecisionStore(dir, { now: () => clock });
	clock = T0;
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabled: true, readFrom: "2026-10-01", batchRecords: 2 }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const msg = (ref: string, text: string, over: Partial<NewDecisionRecord> = {}): NewDecisionRecord => ({
	source: "message",
	at: (clock += 60_000),
	from: "temper",
	to: "architecture",
	ref,
	kind: "fyi",
	text,
	...over,
});

/** A fake model: answers in turn from the list (a function gets the call), counting tokens. */
function fakeModel(answers: (string | ((c: ModelCall) => string) | Error)[]): DecisionModel & { calls: ModelCall[] } {
	const calls: ModelCall[] = [];
	const fn = (async (c: ModelCall) => {
		calls.push(c);
		const a = answers[Math.min(calls.length - 1, answers.length - 1)];
		if (a instanceof Error) return { ok: false, error: a.message, usage: { input: 100, output: 0 } };
		return {
			ok: true,
			text: typeof a === "function" ? a(c) : a,
			model: "anthropic/claude-haiku-5-5",
			usage: { input: 1000, output: 200 },
		};
	}) as DecisionModel & { calls: ModelCall[] };
	fn.calls = calls;
	return fn;
}

const reader = (model: DecisionModel, extra: Partial<ConstructorParameters<typeof DecisionReader>[0]> = {}) =>
	new DecisionReader({ records, store, model, now: () => clock, retryWaitMs: [0], ...extra });

const answer = (records: { r: string; initiative?: string | null; items: unknown[] }[]) => JSON.stringify({ records });

describe("parseAnswer: the schema check", () => {
	it("keeps good items, drops bad ones with a reason, and notes records left out", () => {
		const text =
			"Here you go:\n```json\n" +
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Serial turns",
							what: "Members take turns.",
							quotes: ["take turns"],
							part: "weird",
							claimsOwner: "yes",
						},
					],
				},
				{
					r: "R2",
					items: [
						{ kind: "new", what: "No quotes" },
						{ kind: "change", of: "n1", type: "Widened", what: "More.", quotes: ["more"] },
						{ kind: "bogus" },
					],
				},
				{ r: "R9", items: [] },
			]) +
			"\n```";
		const p = parseAnswer(text, ["R1", "R2", "R3"]);
		expect(p.records.get("R1")).toEqual([
			expect.objectContaining({ kind: "new", id: "N1", part: null, claimsOwner: false, quotes: ["take turns"] }),
		]);
		expect(p.records.get("R2")).toEqual([expect.objectContaining({ kind: "change", of: "N1", type: "widened" })]);
		expect(p.problems).toEqual(
			expect.arrayContaining([
				"R2: new item without what or quotes",
				"R2: unknown kind bogus",
				"unknown record R9",
				"records left out: R3",
			]),
		);
		expect(parseAnswer("no json here", ["R1"]).records.size).toBe(0);
	});

	it("keeps an item whose point type was written where its kind goes, telling the kind from its fields", () => {
		const p = parseAnswer(
			answer([
				{
					r: "R1",
					items: [
						{ kind: "go", id: "N1", title: "Ship it", what: "Ship it.", quotes: ["ship it"] },
						{ kind: "Rule", of: "d1", type: "widened", what: "Wider.", quotes: ["wider"] },
						{ kind: "rule", of: "d2", quotes: ["again"] },
					],
				},
			]),
			["R1"],
		);
		expect(p.problems).toEqual([]);
		expect(p.records.get("R1")?.map((i) => [i.kind, i.kind === "same" ? "" : i.point])).toEqual([
			["new", "go"],
			["change", "rule"],
			["same", ""],
		]);
	});

	it("reads each item's point (rule by default) and the record's initiative", () => {
		const p = parseAnswer(
			answer([
				{
					r: "R1",
					initiative: "Team-In-Temper",
					items: [
						{ kind: "new", id: "N1", what: "X.", quotes: ["x"], point: "own step" },
						{ kind: "change", of: "d1", type: "widened", what: "Y.", quotes: ["y"], point: "go" },
						{ kind: "new", id: "N2", what: "Z.", quotes: ["z"] },
					],
				},
				{ r: "R2", initiative: "none", items: [] },
			]),
			["R1", "R2"],
		);
		expect(p.records.get("R1")?.map((i) => (i.kind === "same" ? "" : i.point))).toEqual(["own-step", "go", "rule"]);
		expect([...p.initiatives]).toEqual([
			["R1", "team-in-temper"],
			["R2", null],
		]);
	});
});

describe("the model call", () => {
	it("a failed call says why in the provider's words (a sign-in error), not just 'no text'", () => {
		const failed = [
			{ role: "user", content: "x" },
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "OAuth refresh failed for anthropic-3:\n invalid_grant",
			},
		];
		expect(lastError(failed)).toBe("the model call failed: OAuth refresh failed for anthropic-3: invalid_grant");
		expect(lastError([{ role: "assistant", content: [], stopReason: "stop" }])).toBeUndefined();
		expect(lastError([{ role: "assistant", content: [], stopReason: "aborted" }])).toBe(
			"the model call ended: aborted",
		);
	});

	it("a call that runs out of time says which tries failed before it, in the provider's words", () => {
		const tries = [
			{ role: "user", content: "x" },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: 429" },
		];
		expect(timeoutNote(tries)).toBe("2 failed tries before it, last: rate_limit_error: 429");
		// pi's own retries drop the failed answer; the events say what happened.
		expect(timeoutNote([{ role: "user", content: "x" }], [{ errorMessage: "429 rate limited", delayMs: 60_000 }])).toBe(
			"1 failed try before it, last: 429 rate limited, next try after 60 s",
		);
		expect(timeoutNote([{ role: "user", content: "x" }])).toBe("no answer and no error from the provider");
	});
});

describe("the reader", () => {
	it("a role's choice said again as the owner's becomes a 're-recorded' change; his own pick said again stays a repeat", async () => {
		// rm-r: a role's own choice. ask:x: the owner's pick in a dialog. rm-s: both said again as his.
		records.append(msg("rm-r", "We will run members one at a time."));
		records.append({
			source: "answer",
			at: (clock += 60_000),
			from: "owner",
			to: "temper",
			ref: "ask:x",
			ask: "question",
			questions: [
				{
					id: "q",
					question: "How are rounds run?",
					options: [{ label: "Review rounds" }, { label: "Free flow" }],
					picked: ["Review rounds"],
				},
			],
		});
		records.append(msg("rm-s", "Owner (10-05): one at a time, and review rounds."));
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ enabled: true, readFrom: "2026-10-01", batchRecords: 3 }),
		);
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "One at a time",
							what: "Members run one at a time.",
							quotes: ["run members one at a time"],
						},
					],
				},
				{
					r: "R2",
					items: [
						{
							kind: "new",
							id: "N2",
							title: "Review rounds",
							what: "Rounds are review rounds.",
							quotes: ["Review rounds"],
							part: "main",
						},
					],
				},
				{
					r: "R3",
					items: [
						{ kind: "same", of: "N1", quotes: ["one at a time"], claimsOwner: false },
						{ kind: "same", of: "N2", quotes: ["review rounds"], claimsOwner: true },
					],
				},
			]),
		]);
		await reader(model).readAll();
		const [turns, rounds] = store.decisions();
		// The wording ("Owner (10-05):") credits him with the role's choice: a change of its own, flagged.
		expect(turns.changes).toEqual([
			expect.objectContaining({
				type: "re-recorded",
				sources: [expect.objectContaining({ ref: "rm-s", claimsOwner: true })],
			}),
		]);
		expect(turns.sources.map((s) => s.ref)).toEqual(["rm-r"]);
		// His own pick, said again as his: just one more source.
		expect(rounds.changes).toEqual([]);
		expect(rounds.sources.map((s) => [s.ref, !!s.same])).toEqual([
			["ask:x", false],
			["rm-s", true],
		]);
	});

	it("reads in batches, keeps decisions with their quotes, a change of one found earlier in the batch, and 'not a decision'", async () => {
		records.append(
			msg("rm-a", "Decided: members take turns one at a time in the pilot. Cost: the pilot runs about twice as long."),
		);
		records.append(msg("rm-b", "Status: tests pass."));
		records.append(msg("rm-c", "Widening it: two members may work at once from round three."));
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Turns one at a time",
							what: "Members take turns one at a time in the pilot.",
							quotes: ["members take turns one at a time"],
							claimsOwner: false,
							part: null,
							impact: "the pilot runs about twice as long",
							options: "invented option text",
							until: "",
						},
					],
				},
				{ r: "R2", items: [] },
			]),
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "change",
							of: "D1",
							type: "widened",
							what: "Two at once from round three.",
							quotes: ["two members may work at once"],
							claimsOwner: false,
							part: null,
							impact: "",
							until: "from round three",
						},
					],
				},
			]),
		]);
		const res = await reader(model).readAll();
		expect(res).toMatchObject({ batches: 2, read: 3, stopped: "done" });
		expect(model.calls[0].system).toBe(READER_SYSTEM);
		expect(model.calls[0].prompt).toContain("=== R1");
		expect(model.calls[0].prompt).toContain("=== R2");
		expect(model.calls[0].prompt).not.toContain("Widening it");
		// The second batch is shown the decision found in the first, as D1.
		expect(model.calls[1].prompt).toMatch(/D1 \[unfiled\] Turns one at a time/);
		const [d] = store.decisions();
		expect(d).toMatchObject({ id: "d1", title: "Turns one at a time", initiative: null, by: "reader" });
		expect(d.impact?.text).toBe("the pilot runs about twice as long");
		// An owner field the record doesn't hold word for word isn't kept.
		expect(d.options).toBeUndefined();
		expect(d.sources).toEqual([
			expect.objectContaining({ ref: "rm-a", quotes: ["members take turns one at a time"], by: "reader" }),
		]);
		expect(d.changes).toEqual([
			expect.objectContaining({ type: "widened", until: expect.objectContaining({ text: "from round three" }) }),
		]);
		const state = store.readerState();
		expect(Object.values(state.read).sort()).toEqual(["d", "d", "n"]);
		expect(state.tokens["2026-10-05"]).toEqual({ input: 2000, output: 400, calls: 2 });
		// Nothing left: no call.
		expect(await reader(model).readAll()).toMatchObject({ batches: 0, stopped: "done" });
		expect(model.calls).toHaveLength(2);
	});

	it("an order is his: when the reader quotes only the relayer's text, his words still show as his decision", async () => {
		const order = (ref: string): NewDecisionRecord => ({
			source: "board",
			at: (clock += 60_000),
			from: "owner",
			to: ["ops", "temper"],
			ref,
			kind: "order",
			title: "Only temper-dev from now on",
			text: "Every Temper run uses temper-dev only. Keep it tailnet-only until the trial ends.",
			ownerWords: "Owner in the Architecture chat: FROM NOW ON ONLY USE THE temper-dev no more TEST TEMPER",
			via: "architecture",
		});
		records.append(order("bp-relayed"));
		records.append(order("bp-his"));
		const model = fakeModel([
			answer([
				// Only the relayer's addition: it's flagged, and the code adds his words as his decision.
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Tailnet only",
							what: "Tailnet only until the trial ends.",
							quotes: ["Keep it tailnet-only until the trial ends"],
							claimsOwner: true,
						},
					],
				},
				// His own words quoted: nothing added.
				{
					r: "R2",
					items: [
						{
							kind: "new",
							id: "N2",
							title: "Only temper-dev",
							what: "Only temper-dev.",
							quotes: ["ONLY USE THE temper-dev"],
						},
					],
				},
			]),
		]);
		const res = await reader(model, {}).readAll();
		expect(res).toMatchObject({ read: 2, stopped: "done" });
		expect(store.decisions()).toHaveLength(3);
		const byRef = (ref: string) => store.decisions().filter((d) => d.sources.some((s) => s.ref === ref));
		const relayed = byRef("bp-relayed");
		expect(relayed.map((d) => d.title).sort()).toEqual(["Only temper-dev from now on", "Tailnet only"]);
		const his = relayed.find((d) => d.title === "Only temper-dev from now on");
		expect(his?.sources[0].quotes).toEqual([
			"Owner in the Architecture chat: FROM NOW ON ONLY USE THE temper-dev no more TEST TEMPER",
		]);
		const page = buildDecisionsPage(
			store,
			citedRecords(store, records.list()),
			readerStatus(store, reader(model), clock),
		);
		const view = (title: string) => page.decisions.find((d) => d.title === title);
		expect(view("Only temper-dev from now on")).toMatchObject({ you: true, flags: [] });
		expect(view("Tailnet only")).toMatchObject({ you: false, flags: ["claims-owner"] });
		expect(byRef("bp-his").map((d) => d.title)).toEqual(["Only temper-dev"]);
	});

	it("a repeat adds a source; a change of an unknown decision becomes a new one", async () => {
		records.append(msg("rm-a", "Members take turns one at a time."));
		records.append(msg("rm-b", "Reminder: members take turns one at a time."));
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Turns",
							what: "One at a time.",
							quotes: ["Members take turns one at a time"],
						},
					],
				},
				{
					r: "R2",
					items: [
						{ kind: "same", of: "N1", quotes: ["members take turns one at a time"] },
						{ kind: "change", of: "D77", type: "reversed", what: "Something else.", quotes: ["Reminder"] },
					],
				},
			]),
		]);
		await reader(model).readAll();
		const list = store.decisions();
		expect(list).toHaveLength(2);
		expect(list[0].sources.map((s) => [s.ref, Boolean(s.same)])).toEqual([
			["rm-a", false],
			["rm-b", true],
		]);
		expect(list[1].what).toBe("Something else.");
	});

	it("files by the record's tag, then markers, then the model's guess", async () => {
		records.append(msg("rm-tag", "Decided: X.", { initiative: "team-in-temper" }));
		records.append(msg("rm-mark", "Decided for the first trial: Y."));
		records.append(msg("rm-none", "Decided: Z."));
		records.append(msg("rm-bad", "Decided: W."));
		const item = (id: string, initiative: string | null) => ({
			kind: "new",
			id,
			title: id,
			what: `${id}.`,
			quotes: ["Decided"],
			initiative,
		});
		const model = fakeModel([
			answer([
				{ r: "R1", items: [item("N1", null)] },
				{ r: "R2", items: [item("N2", "other")] },
			]),
			answer([
				{ r: "R1", items: [item("N3", "team-in-temper")] },
				{ r: "R2", items: [item("N4", "not-an-initiative")] },
			]),
		]);
		await reader(model).readAll();
		expect(store.decisions().map((d) => [d.initiative, d.filedBy])).toEqual([
			["team-in-temper", "tag"],
			["team-in-temper", "marker"],
			["team-in-temper", "reader"],
			[null, ""],
		]);
		expect(model.calls[0].prompt).toContain("filed: team-in-temper");
	});

	it("keeps a decision's own filing when another initiative's record changes it, and lists it there too", async () => {
		records.append(msg("rm-rule", "Please use message_role from now on."));
		records.append(
			msg("rm-trial", "For the first trial: reach other roles with message_role, and members take turns."),
		);
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Use message_role",
							what: "Roles use message_role.",
							quotes: ["use message_role from now on"],
						},
					],
				},
				{
					r: "R2",
					items: [
						{ kind: "same", of: "N1", quotes: ["reach other roles with message_role"] },
						{ kind: "new", id: "N2", title: "Turns", what: "Members take turns.", quotes: ["members take turns"] },
					],
				},
			]),
		]);
		await reader(model).readAll();
		const rule = store.decisions().find((d) => d.title === "Use message_role")!;
		// The trial record (filed by its marker) mentions the rule: the rule stays unfiled, and is listed there too.
		expect([rule.initiative, rule.filedBy, rule.alsoIn]).toEqual([null, "", ["team-in-temper"]]);
		const page = buildDecisionsPage(store, citedRecords(store, records.list()), readerStatus(store, undefined, clock), {
			initiative: "team-in-temper",
		});
		expect(page.decisions.map((d) => d.title).sort()).toEqual(["Turns", "Use message_role"]);
		expect(page.unfiled.decisions).toBe(1);
	});

	it("files all of a record's points by the model's answer for the record (after tag and markers)", async () => {
		records.append(msg("rm-rec", "Decided: A. Also decided: B."));
		records.append(msg("rm-unknown", "Decided: C."));
		const item = (id: string, extra: object = {}) => ({
			kind: "new",
			id,
			title: id,
			what: `${id}.`,
			quotes: ["Decided"],
			...extra,
		});
		const model = fakeModel([
			answer([
				{ r: "R1", initiative: "team-in-temper", items: [item("N1"), item("N2", { initiative: null })] },
				{ r: "R2", initiative: "not-an-initiative", items: [item("N3")] },
			]),
		]);
		await reader(model).readAll();
		expect(store.decisions().map((d) => [d.title, d.initiative, d.filedBy])).toEqual([
			["N1", "team-in-temper", "reader"],
			["N2", "team-in-temper", "reader"],
			["N3", null, ""],
		]);
	});

	it("leaves out a point that is only the writer's own step (the model labels it, the code drops it)", async () => {
		records.append(
			msg("rm-own", "Not retrying automatically; asking for a bounded correction. Reviews stay weekly from now on."),
		);
		const skipped: string[] = [];
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "No automatic retry",
							what: "The task doesn't retry.",
							point: "own-step",
							quotes: ["Not retrying automatically"],
						},
						{
							kind: "new",
							id: "N2",
							title: "Weekly reviews",
							what: "Reviews stay weekly.",
							point: "rule",
							quotes: ["Reviews stay weekly from now on"],
						},
					],
				},
			]),
		]);
		await reader(model, { onSkip: (_rec, it) => skipped.push(it.kind === "new" ? it.title : it.kind) }).readAll();
		expect(store.decisions().map((d) => d.title)).toEqual(["Weekly reviews"]);
		expect(skipped).toEqual(["No automatic retry"]);
	});

	it("reads a plan with choices in its Decided part once more, alone, when the first read finds nothing in it", async () => {
		const plan = (ref: string, decided: string): NewDecisionRecord => ({
			...msg(ref, ""),
			source: "plan",
			from: "temper",
			to: undefined,
			kind: undefined,
			text: undefined,
			plan: { title: `Plan ${ref}`, goal: "Ship the team trial.", decided },
		});
		records.append(plan("chat-a.jsonl:10", "Members take turns one at a time."));
		records.append(plan("chat-b.jsonl:20", ""));
		records.append(plan("chat-c.jsonl:30", "Reviews stay weekly."));
		const model = fakeModel([
			// First read: nothing in any of the three.
			answer([
				{ r: "R1", items: [] },
				{ r: "R2", items: [] },
			]),
			// The plan with a Decided part, alone: its choice.
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Turns one at a time",
							what: "Members take turns.",
							quotes: ["Members take turns one at a time"],
						},
					],
				},
			]),
			// The third plan, then alone again: still nothing, and that stands.
			answer([{ r: "R1", items: [] }]),
			answer([{ r: "R1", items: [] }]),
		]);
		await reader(model).readAll();
		const id = (ref: string) => records.list().find((r) => r.ref === ref)!.id;
		expect(store.decisions().map((d) => d.title)).toEqual(["Turns one at a time"]);
		const state = store.readerState();
		expect(state.read[id("chat-a.jsonl:10")]).toBe("d");
		expect(state.read[id("chat-b.jsonl:20")]).toBe("n"); // nothing decided in it: no second read
		expect(state.read[id("chat-c.jsonl:30")]).toBe("n");
		// Batch of two, then plan a alone; plan c, then plan c alone; no third read of anything.
		expect(model.calls).toHaveLength(4);
		expect(model.calls[1].prompt).toContain("Members take turns one at a time");
		expect(model.calls[1].prompt).not.toContain("Plan chat-b.jsonl:20");
	});

	it("retries a failed call, and leaves the records for later when it keeps failing", async () => {
		records.append(msg("rm-a", "Decided: X."));
		const ok = answer([{ r: "R1", items: [] }]);
		const flaky = fakeModel([new Error("overloaded"), new Error("overloaded"), ok]);
		expect(await reader(flaky).readAll()).toMatchObject({ read: 1, stopped: "done" });
		expect(flaky.calls).toHaveLength(3);

		records.append(msg("rm-b", "Decided: Y."));
		const down = fakeModel([new Error("rate limited (429)")]);
		const res = await reader(down).readAll();
		expect(res).toMatchObject({ stopped: "error", read: 0 });
		expect(store.readerState().read).not.toHaveProperty(records.list().find((r) => r.ref === "rm-b")!.id);
		expect(store.readerState().lastError?.error).toContain("429");
	});

	it("splits a batch whose answer won't parse, and sets aside a single record that can't be read", async () => {
		records.append(msg("rm-a", "One."));
		records.append(msg("rm-b", "Two."));
		const model = fakeModel([
			"not json",
			"not json",
			"not json",
			(c) => (c.prompt.includes("One.") ? answer([{ r: "R1", items: [] }]) : "still not json"),
		]);
		const res = await reader(model).readAll();
		expect(res.read).toBe(2);
		const state = store.readerState();
		const id = (ref: string) => records.list().find((r) => r.ref === ref)!.id;
		expect(state.read[id("rm-a")]).toBe("n");
		expect(state.read[id("rm-b")]).toBe("x");
	});

	it("reads a batch that times out in halves at once, with the timeout from the settings", async () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ enabled: true, readFrom: "2026-10-01", callTimeoutSeconds: 90 }),
		);
		records.append(msg("rm-a", "One."));
		records.append(msg("rm-b", "Two."));
		const model = fakeModel([new Error("timed out after 90 s"), answer([{ r: "R1", items: [] }])]);
		const res = await reader(model).readAll();
		expect(res).toMatchObject({ read: 2, stopped: "done" });
		expect(model.calls).toHaveLength(3);
		expect(model.calls.map((c) => c.timeoutMs)).toEqual([90_000, 90_000, 90_000]);
		expect(model.calls[1].prompt).toContain("One.");
		expect(model.calls[1].prompt).not.toContain("Two.");
	});

	it("stops at the daily token cap and says so; the next day it reads again", async () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ enabled: true, readFrom: "2026-10-01", batchRecords: 1, dailyTokenCap: 7_000 }),
		);
		records.append(msg("rm-a", "One."));
		records.append(msg("rm-b", "Two."));
		const model = fakeModel([answer([{ r: "R1", items: [] }])]);
		const r = reader(model);
		expect(await r.readAll()).toMatchObject({ batches: 1, stopped: "cap" });
		expect(readerStatus(store, r, clock)).toMatchObject({
			capHit: true,
			tokensToday: 1200,
			dailyTokenCap: 7_000,
			unread: 1,
		});
		clock += 24 * 3600_000;
		expect(await r.readAll()).toMatchObject({ batches: 1, stopped: "done" });
		expect(readerStatus(store, r, clock).capHit).toBe(false);
		expect(readerStatus(store, r, clock).tokensByDay).toEqual({ "2026-10-05": 1200, "2026-10-06": 1200 });
	});

	it("reads a plan change as what changed since the task's last version, and checks a taken-out quote against that version", async () => {
		const before = Date.parse("2026-09-30T09:00:00-07:00"); // before readFrom: read earlier, still its last version
		const planRec = (ref: string, at: number, op: "add" | "update", decided: string): NewDecisionRecord => ({
			source: "plan",
			at,
			from: "temper",
			ref,
			file: ref.split(":")[0],
			task: 7,
			op,
			approval: "auto",
			plan: {
				title: "Team trial",
				decided: decided,
				steps:
					"1. Build the members.\n2. Run the scratch project.\n3. Watch every turn on the page and write down what each member did.",
				verify: "Unit tests pass, and the trial's page shows each member's turns in order.",
			},
		});
		records.append(
			planRec("chat-a.jsonl:10", before, "add", "Members take turns one at a time.\nReviews stay weekly."),
		);
		records.append(
			planRec(
				"chat-a.jsonl:20",
				(clock += 60_000),
				"update",
				"Members take turns one at a time.\nThe cap is 6 calls per turn.",
			),
		);
		// Another chat's task 7 is another task: not this plan's last version.
		records.append({ ...planRec("chat-b.jsonl:30", before, "add", "Something else."), file: "chat-b.jsonl" });
		const st = store.readerState();
		st.read[records.list().find((r) => r.ref === "chat-a.jsonl:10")!.id] = "d";
		store.saveReaderState(st);
		const known = store.addDecision({
			initiative: null,
			filedBy: "",
			title: "Weekly reviews",
			what: "Reviews stay weekly.",
			at: before,
			sources: [],
			by: "seed",
		});
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Cap per turn",
							what: "6 calls per turn.",
							quotes: ["The cap is 6 calls per turn"],
						},
						{
							kind: "change",
							of: known.id,
							type: "reversed",
							what: "Weekly reviews dropped.",
							quotes: ["Reviews stay weekly"],
						},
					],
				},
			]),
		]);
		await reader(model).readAll();
		expect(model.calls).toHaveLength(1);
		const prompt = model.calls[0].prompt;
		expect(prompt).toContain("Decided, lines added or changed:\nThe cap is 6 calls per turn.");
		expect(prompt).toContain("Decided, lines taken out:\nReviews stay weekly.");
		expect(prompt).toContain("Unchanged since the task's last version: Steps, Verify");
		expect(prompt).toContain("Title: Team trial");
		expect(prompt).not.toContain("Run the scratch project");
		expect(prompt).not.toContain("Members take turns one at a time");
		// The taken-out words are found in the version before: no "quote not found" on the change.
		const page = buildDecisionsPage(store, citedRecords(store, records.list()), readerStatus(store, undefined, clock), {
			initiative: "",
		});
		const change = page.decisions.find((d) => d.id === known.id)!.changes[0];
		expect(change.sources[0].flags).not.toContain("quote-not-found");
		expect(store.get(known.id)!.changes[0].sources[0].was).toBe(
			records.list().find((r) => r.ref === "chat-a.jsonl:10")!.id,
		);
	});

	it("reads a plan change in full when its last version was never read, or when the change is longer to read", async () => {
		const plan = (ref: string, at: number, op: "add" | "update", decided: string): NewDecisionRecord => ({
			source: "plan",
			at,
			from: "temper",
			ref,
			file: ref.split(":")[0],
			task: 9,
			op,
			approval: "auto",
			plan: { title: "Trial", decided, steps: "1. Build the members and run the scratch project end to end." },
		});
		// Never read: its last version is from before readFrom, so its unchanged lines were never seen.
		records.append(
			plan("chat-a.jsonl:10", Date.parse("2026-09-30T09:00:00-07:00"), "add", "Members take turns one at a time."),
		);
		records.append(
			plan("chat-a.jsonl:20", (clock += 60_000), "update", "Members take turns one at a time.\nThe cap is 6 calls."),
		);
		// Read in this pass, but every line changed: the change (added + taken out) is longer than the plan.
		const t2 = {
			...plan(
				"chat-b.jsonl:10",
				(clock += 60_000),
				"add",
				"Old rule one stays as written here.\nOld rule two stays as written here.",
			),
			file: "chat-b.jsonl",
			task: 4,
		};
		records.append(t2);
		records.append({
			...t2,
			ref: "chat-b.jsonl:20",
			at: (clock += 60_000),
			op: "update",
			plan: { ...t2.plan, decided: "New rule one replaces it all.\nNew rule two replaces it all." },
		});
		const model = fakeModel([
			answer([
				{ r: "R1", items: [] },
				{ r: "R2", items: [] },
			]),
			answer([{ r: "R1", items: [] }]),
		]);
		await reader(model).readAll();
		const prompts = model.calls.map((c) => c.prompt).join("\n");
		expect(prompts).toContain("Members take turns one at a time.");
		expect(prompts).toContain("Build the members and run the scratch project");
		expect(prompts).not.toContain("Unchanged since the task's last version");
		expect(prompts).not.toContain("lines taken out");
	});

	it("a plan change shows every line it adds or takes out (random edits)", () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		for (let k = 0; k < 200; k++) {
			const prev = Array.from({ length: 1 + rand(8) }, (_, i) => `line ${i} ${rand(5)}`);
			const cur = prev.filter(() => rand(4) !== 0).map((l) => (rand(5) === 0 ? `${l} changed` : l));
			if (rand(2)) cur.splice(rand(cur.length + 1), 0, `added ${k}`);
			const d = lineDelta(prev.join("\n"), cur.join("\n"));
			for (const l of cur) if (!prev.includes(l)) expect(d.added).toContain(l);
			for (const l of prev) if (!cur.includes(l)) expect(d.removed).toContain(l);
			const was: DecisionRecord = {
				v: 1,
				id: "dr-was",
				seen: 0,
				how: "live",
				source: "plan",
				at: 0,
				from: "temper",
				ref: "c.jsonl:1",
				file: "c.jsonl",
				task: 1,
				op: "add",
				plan: { decided: prev.join("\n") },
			} as DecisionRecord;
			const rec = {
				...was,
				id: "dr-cur",
				ref: "c.jsonl:2",
				op: "update",
				plan: { decided: cur.join("\n") },
			} as DecisionRecord;
			const text = renderRecord(rec, "R1", undefined, Number.POSITIVE_INFINITY, was);
			for (const l of [...d.added, ...d.removed]) expect(text).toContain(l);
		}
	});

	it("reads an exact copy of a record once (a done note in two chats); the copy takes its reading", async () => {
		const done = (ref: string, summary: string): NewDecisionRecord => ({
			source: "plan",
			at: T0 + 3600_000,
			from: "design",
			ref,
			file: ref.split(":")[0],
			chat: ref,
			task: 3,
			op: "done",
			summary,
		});
		records.append(done("chat-a.jsonl:30", "Done: the view shows three columns from now on."));
		records.append(done("chat-b.jsonl:5", "Done: the view shows three columns from now on."));
		records.append(done("chat-c.jsonl:9", "Done: the view shows four columns from now on."));
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Three columns",
							what: "Three columns.",
							quotes: ["the view shows three columns"],
						},
					],
				},
				{ r: "R2", items: [] },
			]),
		]);
		const r = reader(model);
		expect(await r.readAll()).toMatchObject({ stopped: "done" });
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].prompt.split("shows three columns").length - 1).toBe(1);
		expect(model.calls[0].prompt).toContain("shows four columns");
		const id = (ref: string) => records.list().find((x) => x.ref === ref)!.id;
		const state = store.readerState();
		expect(state.read[id("chat-b.jsonl:5")]).toBe("d");
		expect(state.copies).toEqual({ [id("chat-b.jsonl:5")]: id("chat-a.jsonl:30") });
		expect(readerStatus(store, r, clock).unread).toBe(0);
	});

	it("thinks at medium unless the settings say otherwise", async () => {
		records.append(msg("rm-a", "One."));
		const model = fakeModel([answer([{ r: "R1", items: [] }])]);
		await reader(model).readAll();
		expect(model.calls[0].thinking).toBe("medium");
	});

	it("an account that refuses for its limit rests an hour, and the next account reads the batch at once", async () => {
		records.append(msg("rm-a", "One."));
		const calls: ModelCall[] = [];
		const model: DecisionModel = async (c) => {
			calls.push(c);
			const account = pickAccount(["anthropic", "anthropic-2"], c.avoid);
			if (account === "anthropic")
				return { ok: false, limited: true, account, error: "limit refusal on anthropic: 429 rate_limit_error" };
			return {
				ok: true,
				text: answer([{ r: "R1", items: [] }]),
				model: `${account}/claude-haiku-5-5`,
				usage: { input: 10, output: 5 },
			};
		};
		const r = reader(model);
		expect(await r.readAll()).toMatchObject({ stopped: "done", read: 1 });
		expect(calls.map((c) => c.avoid)).toEqual([[], ["anthropic"]]);
		expect(store.readerState().resting).toEqual({ anthropic: clock + LIMIT_REST_MS });
		expect(readerStatus(store, r, clock).resting).toEqual({ anthropic: clock + LIMIT_REST_MS });
		// Still resting for the next batch; asked again once the hour is over.
		records.append(msg("rm-b", "Two."));
		await r.readAll();
		expect(calls[2].avoid).toEqual(["anthropic"]);
		clock += LIMIT_REST_MS + 1;
		records.append(msg("rm-c", "Three."));
		await r.readAll();
		expect(calls[3].avoid).toEqual([]);
		// It refuses again, so it rests a new hour and the next account reads.
		expect(calls[4].avoid).toEqual(["anthropic"]);
		expect(readerStatus(store, r, clock).resting).toEqual({ anthropic: clock + LIMIT_REST_MS });
		clock += LIMIT_REST_MS + 1;
		expect(readerStatus(store, r, clock).resting).toEqual({});
	});

	it("with every account resting it stops and waits: no tries spent, nothing set aside", async () => {
		records.append(msg("rm-a", "One."));
		const calls: ModelCall[] = [];
		const model: DecisionModel = async (c) => {
			calls.push(c);
			return {
				ok: false,
				limited: true,
				error: "every Claude account of the chat pool (anthropic) is resting after a limit refusal",
			};
		};
		const res = await reader(model).readAll();
		expect(res).toMatchObject({ stopped: "quota" });
		expect(res.error).toContain("resting");
		expect(calls).toHaveLength(1);
		expect(store.readerState().read).toEqual({});
	});

	it("tells a limit refusal from a passing fault, and picks the first account not resting", () => {
		expect(
			isLimitRefusal(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
			),
		).toBe(true);
		expect(isLimitRefusal("You have hit your usage limit")).toBe(true);
		expect(isLimitRefusal('529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe(false);
		expect(isLimitRefusal("OAuth refresh failed: invalid_grant")).toBe(false);
		expect(isLimitRefusal(undefined)).toBe(false);
		expect(pickAccount(["anthropic", "anthropic-2", "anthropic-3"], ["anthropic", "anthropic-2"])).toBe("anthropic-3");
		expect(pickAccount(["anthropic"], ["anthropic"])).toBeUndefined();
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		expect(claudePoolMembers(agentDir)).toEqual(["anthropic"]);
		writeFileSync(
			join(agentDir, "multi-pass.json"),
			JSON.stringify({
				pools: [
					{ name: "off", baseProvider: "anthropic", members: ["x"], enabled: false },
					{ name: "claude-real", baseProvider: "anthropic", members: ["anthropic", "anthropic-3"], enabled: true },
				],
			}),
		);
		expect(claudePoolMembers(agentDir)).toEqual(["anthropic", "anthropic-3"]);
	});

	it("does nothing when switched off", async () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabled: false }));
		records.append(msg("rm-a", "One."));
		const model = fakeModel([answer([])]);
		expect(await reader(model).readAll()).toMatchObject({ stopped: "disabled" });
		expect(model.calls).toHaveLength(0);
	});

	it("is off until its settings turn it on, so an install never starts reading by itself", async () => {
		rmSync(join(dir, "settings.json"));
		records.append(msg("rm-a", "One."));
		const model = fakeModel([answer([])]);
		expect(await reader(model).readAll()).toMatchObject({ stopped: "disabled" });
		expect(model.calls).toHaveLength(0);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ readFrom: "2026-10-01" }));
		expect(await reader(model).readAll()).toMatchObject({ stopped: "disabled" });
		expect(model.calls).toHaveLength(0);
	});

	it("shows the reader a dialog's picks and previews, and an order's two parts", () => {
		const ans = {
			v: 1,
			id: "dr-x",
			source: "answer",
			at: T0,
			from: "owner",
			to: "temper",
			ref: "ask:t1",
			how: "live",
			seen: T0,
			questions: [
				{
					id: "q",
					question: "Which?",
					options: [{ label: "A", description: "Alpha", preview: "Cards newest first" }, { label: "B" }],
					picked: ["A"],
					typed: "and quickly",
				},
			],
		} as DecisionRecord;
		const text = renderRecord(ans, "R1", undefined, 10_000);
		expect(text).toContain("[PICKED] A - Alpha");
		expect(text).toContain("preview: Cards newest first");
		expect(text).toContain("[not picked] B");
		expect(text).toContain("he typed: and quickly");
		const order = {
			...ans,
			source: "board",
			kind: "order",
			title: "T",
			text: "Relayed text",
			ownerWords: "his words",
			via: "coo",
			questions: undefined,
		} as DecisionRecord;
		const o = renderRecord(order, "R2", "team-in-temper", 10_000);
		expect(o).toContain("The owner's own words: his words");
		expect(o).toContain("coo's text: Relayed text");
		expect(o).toContain("filed: team-in-temper");
	});

	it("his main pick carries the option's own label, whatever words the model quoted from it; a rider doesn't", async () => {
		records.append({
			source: "answer",
			at: (clock += 60_000),
			from: "owner",
			to: "temper",
			ref: "ask:l",
			ask: "question",
			questions: [
				{
					id: "q",
					question: "How are rounds run?",
					options: [
						{
							label: "Review rounds (recommended)",
							description: "The leader asks for a review. The others each give a view.",
							preview: "Members take turns one at a time at first.",
						} as never,
						{ label: "Free flow" },
					],
					picked: ["Review rounds (recommended)"],
				},
			],
		});
		const model = fakeModel([
			answer([
				{
					r: "R1",
					items: [
						{
							kind: "new",
							id: "N1",
							title: "Leader asks for reviews",
							what: "The leader asks.",
							quotes: ["The leader asks for a review."],
							part: "main",
						},
						{
							kind: "new",
							id: "N2",
							title: "Turns one at a time",
							what: "One at a time.",
							quotes: ["Members take turns one at a time at first."],
							part: "rider",
						},
					],
				},
			]),
		]);
		await reader(model).readAll();
		const [pick, rider] = store.decisions();
		expect(pick.sources[0].quotes).toEqual(["Review rounds (recommended)", "The leader asks for a review."]);
		expect(rider.sources[0].quotes).toEqual(["Members take turns one at a time at first."]);
	});

	it("always shows the known decisions most like each record (rare shared words first), however many there are", async () => {
		// An old decision sharing rare words with the record, and 70 newer ones sharing more, but common, words:
		// by raw word hits and by age the old one would be left out of the 60 shown.
		const old = store.addDecision({
			initiative: null,
			filedBy: "",
			title: "Every department runs its own work proactively",
			what: "Every department runs its own work proactively.",
			at: T0 - 86_400_000,
			sources: [{ at: T0 - 86_400_000, quotes: [], by: "role" }],
			by: "role",
		});
		for (let i = 0; i < 70; i++)
			store.addDecision({
				initiative: null,
				filedBy: "",
				title: `Design note ${i}`,
				what: `Only product design work for the other page ${i}.`,
				at: T0 + i * 1000,
				sources: [{ at: T0 + i * 1000, quotes: [], by: "role" }],
				by: "role",
			});
		store.save();
		clock = T0 + 200_000;
		records.append(
			msg("rm-o", "Only product, design and QA work proactively now; every other department is request-only."),
		);
		const model = fakeModel([answer([{ r: "R1", items: [] }])]);
		await reader(model).readAll();
		const prompt = model.calls[0].prompt;
		expect(prompt).toContain(`${old.id.toUpperCase()} [unfiled] Every department runs its own work proactively`);
	});
});

describe("previews of older answers", () => {
	it("reads them from the dialog's own chat line, once", async () => {
		const sessions = join(dir, "sessions");
		mkdirSync(join(sessions, "--home--"), { recursive: true });
		const call = {
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_1",
						name: "ask_user_question",
						arguments: {
							questions: [{ id: "q", options: [{ label: "A", preview: "Cards newest first" }, { label: "B" }] }],
						},
					},
				],
			},
		};
		writeFileSync(
			join(sessions, "--home--", "chat.jsonl"),
			`{"type":"session"}\n${JSON.stringify(call)}\n{"type":"x"}\n`,
		);
		expect(previewsOfLine(JSON.stringify(call), "toolu_1")).toEqual({ q: { A: "Cards newest first" } });
		const rec = {
			v: 1,
			id: "dr-a",
			source: "answer",
			at: T0,
			from: "owner",
			ref: "ask:toolu_1",
			how: "backfill",
			seen: T0,
			file: "chat.jsonl",
			lines: "2->3",
			questions: [{ id: "q", question: "Which?", options: [{ label: "A" }, { label: "B" }], picked: ["A"] }],
		} as DecisionRecord;
		const previews = new AnswerPreviews(dir, sessions);
		const got = await previews.withPreviews(rec);
		expect(got.questions![0].options[0]).toEqual({ label: "A", preview: "Cards newest first" });
		expect(JSON.parse(readFileSync(join(dir, "previews.json"), "utf8"))).toEqual({
			"dr-a": { q: { A: "Cards newest first" } },
		});
		// A live record without a line is found by its call id.
		const live = { ...rec, id: "dr-b", lines: undefined };
		expect((await previews.withPreviews(live)).questions![0].options[0].preview).toBe("Cards newest first");
	});
});

describe("the store and the decision_log tool", () => {
	const sender: RoleMessageSender = {
		role: "temper",
		title: "temper",
		file: "/x/temper.jsonl",
		chat: "home chat",
		handling: 0,
	};
	let changed = 0;
	const host = (who: RoleMessageSender | string = sender): DecisionLogHost => ({
		sender: () => who,
		store: () => store,
		record: (k) => records.list().find((r) => r.id === k || r.ref === k),
		records: (ids) =>
			new Map(
				records
					.list()
					.filter((r) => ids.includes(r.id))
					.map((r) => [r.id, r]),
			),
		changed: () => void changed++,
		now: () => clock,
	});

	it("seeds initiatives.json with Team in Temper (lead not set), and files by its markers", () => {
		expect(store.initiatives()).toEqual([TEAM_IN_TEMPER]);
		expect(JSON.parse(readFileSync(join(dir, "initiatives.json"), "utf8")).initiatives[0]).toMatchObject({
			id: "team-in-temper",
			lead: null,
		});
		const rec = (text: string, over = {}) =>
			({
				v: 1,
				id: "x",
				source: "message",
				at: 0,
				from: "a",
				ref: "r",
				how: "live",
				seen: 0,
				text,
				...over,
			}) as DecisionRecord;
		expect(fileRecord(rec("Plan for the first trial"), store.initiatives())).toEqual({
			initiative: "team-in-temper",
			by: "marker",
		});
		expect(fileRecord(rec("ADR-M4-19 is out"), store.initiatives())?.initiative).toBe("team-in-temper");
		expect(fileRecord(rec("Fix the login page"), store.initiatives())).toBeUndefined();
		expect(
			fileRecord({ ...rec("x"), source: "plan", from: "temper", task: 52 } as DecisionRecord, store.initiatives())?.by,
		).toBe("marker");
	});

	it("refuses a chat without a role", () => {
		expect(() => runDecisionLog(host("This chat has no role."), { action: "list" })).toThrow("This chat has no role.");
	});

	it("adds a decision that lived in a file, with a link; it's the role's, and a claim that he decided is flagged", () => {
		const r = runDecisionLog(host(), {
			action: "add",
			initiative: "team-in-temper",
			title: "Copies reset",
			what: "Temper moves each reviewer's copy to the review commit.",
			link: "/x/M2/report.md",
		});
		expect(r.text).toContain("Added decision d1 under team-in-temper");
		const claim = runDecisionLog(host(), {
			action: "add",
			what: "The owner chose serial turns.",
			link: "/x/profile.md",
		});
		expect(claim.text).toContain("flags it");
		const page = buildDecisionsPage(store, citedRecords(store, records.list()), readerStatus(store, undefined, clock));
		const [d1, d2] = [...page.decisions].sort((a, b) => a.id.localeCompare(b.id));
		expect(d1.sources[0]).toMatchObject({
			writer: "temper",
			approval: "role-entry",
			you: false,
			by: "role:temper",
			link: "/x/M2/report.md",
		});
		expect(d2.flags).toEqual(["claims-owner"]);
		expect(page.unfiled.decisions).toBe(1);
		expect(() => runDecisionLog(host(), { action: "add", what: "No link." })).toThrow(/needs a link/);
		expect(() => runDecisionLog(host(), { action: "add", what: "X", link: "y", initiative: "nope" })).toThrow(
			/No initiative nope/,
		);
	});

	it("points to one of his records: the code checks his own words", () => {
		records.append({
			source: "answer",
			at: T0,
			from: "owner",
			to: "temper",
			ref: "ask:toolu_9",
			ask: "question",
			questions: [
				{
					id: "q",
					question: "Turns?",
					options: [{ label: "One at a time" }, { label: "Free-flowing" }],
					picked: ["Free-flowing"],
				},
			],
		});
		const yes = runDecisionLog(host(), {
			action: "add",
			what: "Free-flowing turns.",
			owner_record: "ask:toolu_9",
			quotes: ["Free-flowing"],
		});
		expect(yes.text).toContain("counts as his");
		const no = runDecisionLog(host(), {
			action: "add",
			what: "Turns one at a time.",
			owner_record: "ask:toolu_9",
			quotes: ["One at a time"],
		});
		expect(no.text).toContain("doesn't count as his");
		const page = buildDecisionsPage(store, citedRecords(store, records.list()), readerStatus(store, undefined, clock));
		const byWhat = new Map(page.decisions.map((d) => [d.what, d]));
		expect(byWhat.get("Free-flowing turns.")).toMatchObject({ you: true });
		expect(byWhat.get("Free-flowing turns.")!.sources[0]).toMatchObject({
			writer: "owner",
			approval: "dialog-pick",
			by: "role:temper",
		});
		expect(byWhat.get("Turns one at a time.")).toMatchObject({ you: false });
		expect(() => runDecisionLog(host(), { action: "add", what: "X", owner_record: "ask:toolu_9" })).toThrow(
			/needs quotes/,
		);
	});

	it("fills, refiles, marks not a decision, adds a change and an initiative", () => {
		runDecisionLog(host(), { action: "add", what: "Serial turns.", link: "/x/a.md" });
		runDecisionLog(host(), {
			action: "fill",
			id: "d1",
			impact: "Trials take twice as long.",
			options: "Free-flowing: faster, harder to watch.",
			until: "After the first trial.",
		});
		expect(store.get("d1")).toMatchObject({
			impact: { text: "Trials take twice as long.", by: "role:temper" },
			until: { text: "After the first trial." },
		});
		runDecisionLog(host(), { action: "fill", id: "d1", until: "" });
		expect(store.get("d1")!.until).toBeUndefined();
		expect(
			runDecisionLog(host(), { action: "add", of: "d1", type: "reversed", what: "Free-flowing now.", link: "/x/b.md" })
				.text,
		).toContain("Added change c2 (reversed) to d1");
		expect(() => runDecisionLog(host(), { action: "add", of: "d1", type: "sideways", what: "x", link: "y" })).toThrow(
			/type must be one of/,
		);
		runDecisionLog(host(), { action: "add_initiative", name: "Decisions page", markers: ["Initiatives tab"] });
		expect(store.initiatives().map((i) => i.id)).toEqual(["team-in-temper", "decisions-page"]);
		runDecisionLog(host(), { action: "refile", id: "d1", initiative: "decisions-page" });
		expect(store.get("d1")).toMatchObject({ initiative: "decisions-page", filedBy: "role:temper" });
		runDecisionLog(host(), { action: "not_decision", id: "c2", why: "A status note." });
		expect(store.findChange("c2")!.change.notDecision).toMatchObject({ by: "role:temper", why: "A status note." });
		const listed = runDecisionLog(host(), { action: "list", initiative: "decisions-page" }).text;
		expect(listed).toContain("d1 [decisions-page]");
		expect(listed).toContain("c2 reversed");
		expect(listed).toContain("(marked not a decision)");
		runDecisionLog(host(), { action: "not_decision", id: "c2", restore: true });
		expect(store.findChange("c2")!.change.notDecision).toBeUndefined();
		expect(changed).toBeGreaterThan(5);
	});
});
