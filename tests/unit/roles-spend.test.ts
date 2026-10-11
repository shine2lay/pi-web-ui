import { mkdtemp, mkdir, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSpend, readRoleSpend, spendFromText, SPEND_FILE_MAX } from "../../server/roles-spend.js";

const NOW = Date.parse("2026-10-11T12:00:00-07:00");
const base = {
	v: 1,
	budgetUsd: 2000,
	budgetFrom: "department-weekly",
	weekStart: "2026-10-10",
	weekEnd: "2026-10-18",
	spentUsd: 412,
	updatedAt: "2026-10-11T09:00:00-07:00",
	stopped: false,
};
const text = (delta: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...delta });
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("own-work spend v1 display (never a meter or stop)", () => {
	it("under budget: exact owner line, readable amounts and age", () => {
		expect(spendFromText(text(), NOW)).toEqual({
			state: "ok",
			spent: "$412",
			budget: "$2,000",
			age: "3 h ago",
			line: "Own work this week: $412 of $2,000 · updated 3 h ago",
		});
	});
	it.each([{ spentUsd: 2000 }, { spentUsd: 2100 }, { stopped: true }])(
		"at/over/stopped: amber state only, even with stale age: %j",
		(delta) => {
			const s = spendFromText(text({ updatedAt: "2026-10-10T09:00:00-07:00", ...delta }), NOW);
			expect(s.state).toBe("over");
			expect(s.line).toBe("Budget used up: own work stopped until Mon");
			expect(s).not.toHaveProperty("age");
		},
	);
	it("only strictly more than 24 hours is stale", () => {
		expect(spendFromText(text({ updatedAt: "2026-10-10T12:00:00-07:00" }), NOW).state).toBe("ok");
		expect(spendFromText(text({ updatedAt: "2026-10-10T11:59:59-07:00" }), NOW)).toMatchObject({
			state: "stale",
			age: "1 d ago",
		});
	});
	it("elapsed hours survive a DST change", () => {
		const v = text({
			weekStart: "2026-10-26",
			weekEnd: "2026-11-01",
			updatedAt: "2026-11-01T00:30:00-07:00",
		});
		expect(spendFromText(v, Date.parse("2026-11-01T01:30:00-08:00"))).toMatchObject({ state: "ok", age: "2 h ago" });
	});
	it("expired/new future week: honest absence wins over spent up or stopped", () => {
		for (const delta of [
			{ weekStart: "2026-10-05", weekEnd: "2026-10-11", stopped: true },
			{ weekStart: "2026-10-19", weekEnd: "2026-10-25" },
		]) {
			expect(spendFromText(text(delta), Date.parse("2026-10-12T00:00:00-07:00"))).toEqual({
				state: "old-week",
				line: "No figure for this week yet",
			});
		}
	});
	it("Pacific inclusive end dates, not the host UTC date", () => {
		const v = text({ weekStart: "2026-10-05", weekEnd: "2026-10-11" });
		expect(spendFromText(v, Date.parse("2026-10-12T06:59:59Z")).state).toBe("ok");
		expect(spendFromText(v, Date.parse("2026-10-12T07:00:00Z")).state).toBe("old-week");
		const dst = text({
			weekStart: "2026-10-26",
			weekEnd: "2026-11-01",
			updatedAt: "2026-11-01T23:00:00-08:00",
		});
		expect(spendFromText(dst, Date.parse("2026-11-02T07:59:59Z")).state).toBe("ok");
		expect(spendFromText(dst, Date.parse("2026-11-02T08:00:00Z")).state).toBe("old-week");
	});
	it("first Oct10–18 week is valid, normal weeks are Monday–Sunday", () => {
		expect(parseSpend(base)).not.toBeNull();
		expect(parseSpend({ ...base, weekStart: "2026-10-12", weekEnd: "2026-10-18" })).not.toBeNull();
		expect(parseSpend({ ...base, weekStart: "2026-10-11" })).toBeNull();
	});
	it("optional byInitiative appears only when non-empty, with stable order and cents", () => {
		expect(spendFromText(text(), NOW)).not.toHaveProperty("byInitiative");
		expect(spendFromText(text({ byInitiative: {} }), NOW)).not.toHaveProperty("byInitiative");
		expect(
			spendFromText(text({ spentUsd: 412.25, byInitiative: { "z-last": 12.25, "a-first": 400 } }), NOW),
		).toMatchObject({
			spent: "$412.25",
			byInitiative: [
				{ id: "a-first", amount: "$400" },
				{ id: "z-last", amount: "$12.25" },
			],
		});
	});
	it.each([
		{ v: 2 },
		{ v: "1" },
		{ budgetUsd: 0 },
		{ budgetUsd: -1 },
		{ budgetUsd: "2000" },
		{ spentUsd: -1 },
		{ spentUsd: null },
		{ stopped: "false" },
		{ stopped: undefined },
		{ budgetFrom: "" },
		{ budgetFrom: "two words" },
		{ extraField: true },
		{ weekStart: "2026-02-30" },
		{ weekEnd: "2026-10-19" },
		{ updatedAt: "2026-10-11T09:00:00" },
		{ updatedAt: "2026-10-11T09:00:00Z" },
		{ updatedAt: "2026-02-30T09:00:00-08:00" },
		{ updatedAt: "2026-10-11T25:00:00-07:00" },
		{ byInitiative: [] },
		{ byInitiative: { "Bad-ID": 4 } },
		{ byInitiative: { "a-first": -2 } },
	])("bad v1 gives unreadable, not absence or a partial amount: %j", (delta) => {
		expect(spendFromText(text(delta), NOW)).toEqual({ state: "unreadable", line: "Spend figure unreadable" });
	});
	it("rejects malformed JSON, non-objects and non-finite numbers", () => {
		for (const v of ["{", "null", "[]", text().replace('"spentUsd":412', '"spentUsd":1e999')])
			expect(spendFromText(v, NOW).state).toBe("unreadable");
		expect(parseSpend({ ...base, spentUsd: NaN })).toBeNull();
		expect(parseSpend({ ...base, budgetUsd: Infinity })).toBeNull();
	});
	it("future timestamps cannot produce a negative age", () => {
		expect(spendFromText(text({ updatedAt: "2026-10-11T13:00:00-07:00" }), NOW).line).toContain("updated just now");
	});
	it("no file/no budget: quiet absence; bad files never prevent another role's read", async () => {
		const d = await mkdtemp(join(tmpdir(), "roles-spend-"));
		roots.push(d);
		await mkdir(join(d, "good"));
		await mkdir(join(d, "bad"));
		expect(await readRoleSpend(d, NOW)).toEqual({ state: "none", line: "No own-work budget" });
		await writeFile(join(d, "good", "spend.json"), text());
		await writeFile(join(d, "bad", "spend.json"), "{");
		const [good, bad] = await Promise.all([readRoleSpend(join(d, "good"), NOW), readRoleSpend(join(d, "bad"), NOW)]);
		expect(good.state).toBe("ok");
		expect(bad.state).toBe("unreadable");
		expect(await import("node:fs/promises").then((fs) => fs.readFile(join(d, "good", "spend.json"), "utf8"))).toBe(
			text(),
		);
	});
	it("links, directories and excessive data are unreadable, never followed", async () => {
		const d = await mkdtemp(join(tmpdir(), "roles-spend-refuse-"));
		roots.push(d);
		const outside = join(d, "outside.json");
		await writeFile(outside, text());
		const file = join(d, "spend.json");
		await symlink(outside, file);
		expect((await readRoleSpend(d, NOW)).state).toBe("unreadable");
		await rm(file);
		await link(outside, file);
		expect((await readRoleSpend(d, NOW)).state).toBe("unreadable");
		await rm(file);
		await mkdir(file);
		expect((await readRoleSpend(d, NOW)).state).toBe("unreadable");
		await rm(file, { recursive: true });
		await writeFile(file, " ".repeat(SPEND_FILE_MAX + 1));
		expect((await readRoleSpend(d, NOW)).state).toBe("unreadable");
	});
});
