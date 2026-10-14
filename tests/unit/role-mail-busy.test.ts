// H-MAIL-1: identical busy-turn fixture on the unmodified base and the fix.
// ROLE_MAIL_NEGATIVE_CONTROL=1 asserts the old code's zero deliveries, not a skipped test.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { RoleMessages, roleMessageIdOf, type RoleMessageHost } from "../../server/role-messages.js";

const services: RoleMessages[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of services.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("five back-to-back busy turns: the complete oldest-first batch lands once at the first boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "role-mail-busy-"));
	dirs.push(dir);
	const fromFile = join(dir, "sender.jsonl");
	const file = join(dir, "target.jsonl");
	for (const f of [fromFile, file])
		writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id: f, cwd: dir })}\n`);
	let now = Date.parse("2026-10-13T18:52:00Z");
	const pending: Array<{ text: string; note: boolean }> = [];
	const landed: string[] = [];
	const host: RoleMessageHost = {
		roles: () => [
			{ id: "alpha", title: "Alpha", homeChat: fromFile } as IdentityDef,
			{ id: "beta", title: "Beta", homeChat: file } as IdentityDef,
		],
		chatState: () => "working", // no idle tick in any of the five turns
		deliver: async (_file, text) => {
			pending.push({ text, note: false });
			return { ok: true };
		},
		note: async (_file, text) => {
			pending.push({ text, note: true });
			return { ok: true };
		},
		log: () => {},
	};
	const service = new RoleMessages(join(dir, "mail.json"), host, () => now);
	services.push(service);
	const ids: string[] = [];
	for (const kind of ["request", "question", "fyi"] as const) {
		const sent = service.send(
			{ role: "alpha", title: "Alpha", file: fromFile, chat: "home chat", handling: 0 },
			{ to: "beta", kind, text: kind },
		);
		if (!sent.ok) throw new Error(sent.error);
		ids.push(sent.record.id);
		now += 1;
	}
	await service.tick();
	const negative = process.env.ROLE_MAIL_NEGATIVE_CONTROL === "1";
	if (negative) expect(pending).toHaveLength(0);
	else {
		expect(pending.map((m) => roleMessageIdOf(m.text))).toEqual(ids);
		expect(landed).toHaveLength(0); // admission is not transcript proof
		expect(ids.map((id) => service.byId(id)?.state)).toEqual(["waiting", "waiting", "waiting"]);
	}
	for (let turn = 1; turn <= 5; turn++) {
		// The fake host commits accepted follow-ups only at a boundary.
		for (const { text, note } of pending.splice(0)) {
			const row = note
				? { type: "custom_message", customType: "role-message", content: [{ type: "text", text }], display: true }
				: { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
			appendFileSync(file, `${JSON.stringify(row)}\n`);
			landed.push(roleMessageIdOf(text)!);
		}
		now += 3000;
		await service.tick();
		expect(landed).toEqual(negative ? [] : ids);
	}
	if (!negative) {
		expect(ids.map((id) => service.byId(id)?.state)).toEqual(["delivered", "delivered", "delivered"]);
		expect(ids.map((id) => service.byId(id)?.sends)).toEqual([1, 1, 1]);
		const transcript = readFileSync(file, "utf8");
		for (const id of ids) expect(transcript.split(`[Role message ${id} `)).toHaveLength(2);
	}
});

it("restart mid-flight while still working re-admits only missing ids and proves each once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "role-mail-restart-"));
	dirs.push(dir);
	const file = join(dir, "target.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "fixed", cwd: dir })}\n`);
	const store = join(dir, "mail.json");
	let now = Date.parse("2026-10-13T18:52:00Z");
	const pending: string[] = [];
	let admissions = 0;
	const admit = async (_file: string, text: string) => {
		pending.push(text);
		admissions++;
		return { ok: true as const };
	};
	const host: RoleMessageHost = {
		roles: () => [{ id: "beta", title: "Beta", homeChat: file } as IdentityDef],
		chatState: () => "working",
		deliver: admit,
		note: admit,
		log: () => {},
	};
	const first = new RoleMessages(store, host, () => now);
	services.push(first);
	const sent = first.send(
		{ role: "alpha", title: "Alpha", file: join(dir, "sender.jsonl"), chat: "home chat", handling: 0 },
		{ to: "beta", kind: "request", text: "fixed" },
	);
	if (!sent.ok) throw new Error(sent.error);
	await first.tick();
	expect(admissions).toBe(1);
	first.stop();
	pending.splice(0); // a real restart loses the SDK's RAM queue, not the persisted store
	now += 3000;
	const second = new RoleMessages(store, host, () => now);
	services.push(second);
	await second.tick();
	expect(admissions).toBe(2);
	const text = pending.shift()!;
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
	);
	second.stop(); // restart after the transcript commit, before its acknowledgement tick
	const third = new RoleMessages(store, host, () => now);
	services.push(third);
	await third.tick();
	await third.tick();
	expect(admissions).toBe(2);
	expect(third.byId(sent.record.id)?.state).toBe("delivered");
	expect(readFileSync(file, "utf8").split(`[Role message ${sent.record.id} `)).toHaveLength(2);
});
