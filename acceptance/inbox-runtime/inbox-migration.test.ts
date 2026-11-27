import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { InboxMigration, type InboxMigrationPlan, type InboxMigrationProgress } from "../../server/inbox-migration.js";
import { decodeInboxLine } from "../../server/shared/inbox-wire.js";
import { A, B, data, send, useGuardWorld } from "../../tests/unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

const spec = fs.readFileSync("/home/shinelay/architecture-dept/conventions/role-priority-inbox/migration-administration.md");
if (createHash("sha256").update(spec).digest("hex") !== "751f1416ffbcec7b1cd9e6e37b351f2d283e648e76a73432b230567c8c3ef0e0") throw new Error("RET-4 administration contract drift");
useGuardWorld();
async function migration() {
	const h = await setup();
	const ports = { stateDir: data, runtime: h.runtime, role: "beta" };
	const root = join(data, "role-inbox-migration-v1");
	const planFile = join(root, "plan.json");
	const progressFile = join(root, "progress.jsonl");
	return {
		...h, root, planFile, progressFile, ports,
		process: new InboxMigration(ports),
		plan: () => JSON.parse(fs.readFileSync(planFile, "utf8")) as InboxMigrationPlan,
		progress: () => fs.readFileSync(progressFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) as InboxMigrationProgress[],
	};
}
it("RET-4 frozen plan excludes later arrivals; replay skips already classified ids", async () => {
	const h = await migration();
	expect((await h.process.run()).status).toBe("complete");
	const planBytes = fs.readFileSync(h.planFile, "utf8");
	const progressBytes = fs.readFileSync(h.progressFile, "utf8");
	const later = await send(h.w, "alpha", A, "beta");
	if (!later.ok) throw new Error("Fixture new request refused");
	expect((await new InboxMigration(h.ports).run()).status).toBe("complete");
	expect(fs.readFileSync(h.planFile, "utf8") === planBytes).toBe(true);
	expect(fs.readFileSync(h.progressFile, "utf8").startsWith(progressBytes)).toBe(true);
	expect(h.plan().items.some(item => item.id === later.record.id)).toBe(false);
	expect(h.progress().filter(row => row.kind === "item" && row.key === `migrate:${h.id}`)).toHaveLength(1);
	expect(h.progress().filter(row => row.kind === "attempt")).toHaveLength(2);
});
it("RET-4 changed source hash appends refusal without rewriting classified receipt", async () => {
	const h = await migration();
	await h.process.run();
	const before = fs.readFileSync(h.progressFile, "utf8");
	h.w.rm.byId(h.id)!.text = "changed canonical source fixture";
	(h.w.rm as unknown as { save(schedule: (fn: () => void) => void): void }).save(() => {});
	await h.process.run();
	expect(fs.readFileSync(h.progressFile, "utf8").startsWith(before)).toBe(true);
	expect(h.progress().some(row => row.kind === "item" && row.key === `migrate:${h.id}` && row.outcome === "refused_changed_hash")).toBe(true);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
});
it("RET-4 crash after durable item but before attempt resumes contiguous prefix", async () => {
	const h = await migration();
	await send(h.w, "alpha", A, "beta");
	await h.process.run();
	const lines = fs.readFileSync(h.progressFile, "utf8").trim().split("\n");
	const first = lines.findIndex(line => JSON.parse(line).kind === "item");
	expect(first).toBeGreaterThanOrEqual(0);
	// External crash-image wrapper: preserve actual writer bytes through first item,
	// omit later writes (including attempt), then reopen. No reference replay model.
	const crashPrefix = lines.slice(0, first + 1).join("\n") + "\n";
	fs.writeFileSync(h.progressFile, crashPrefix);
	const resumed = await new InboxMigration(h.ports).run();
	expect(resumed.status).toBe("complete");
	expect(fs.readFileSync(h.progressFile, "utf8").startsWith(crashPrefix)).toBe(true);
	const receipts = h.progress().filter(row => row.kind === "item" && row.outcome === "classified");
	expect(receipts).toHaveLength(2);
	expect(new Set(receipts.map(row => row.kind === "item" ? row.index : -1)).size).toBe(2);
	expect(h.progress().some(row => row.kind === "attempt" && row.fromCursor === 1 && row.toCursor === 2)).toBe(true);
});
it("RET-4 abort after an item is partial; next attempt retains plan and cursor", async () => {
	const h = await migration();
	await send(h.w, "alpha", A, "beta");
	const controller = new AbortController();
	const append = fs.appendFileSync;
	const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
		append(...args);
		if (String(args[0]) === h.progressFile && String(args[1]).includes('"kind":"item"')) controller.abort();
	});
	try {
		expect(await h.process.run(controller.signal)).toMatchObject({ status: "partial", cursor: 1 });
	} finally { spy.mockRestore(); }
	const bytes = fs.readFileSync(h.progressFile, "utf8");
	expect(await new InboxMigration(h.ports).run()).toMatchObject({ status: "complete", cursor: 2 });
	expect(fs.readFileSync(h.progressFile, "utf8").startsWith(bytes)).toBe(true);
});
it("RET-4 unreadable actual source never publishes a partial plan", async () => {
	const h = await migration();
	fs.writeFileSync(h.roleMessagesFile, '{"messages":');
	expect((await h.process.run()).status).toBe("unknown");
	expect(fs.existsSync(h.planFile)).toBe(false);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
});
it("RET-4 unreadable administrative progress stays UNKNOWN, never absence-as-success", async () => {
	const h = await migration();
	await h.process.run();
	fs.writeFileSync(h.progressFile, '{"v":"rpi-migration/1"');
	const before = fs.readFileSync(h.progressFile, "utf8");
	expect((await new InboxMigration(h.ports).run()).status).toBe("unknown");
	expect(fs.readFileSync(h.progressFile, "utf8") === before).toBe(true);
});
it("RET-4 private metadata uses 0700/0600 and never captures message words", async () => {
	const h = await migration();
	await h.process.run();
	expect(fs.statSync(h.root).mode & 0o777).toBe(0o700);
	for (const file of [h.planFile, h.progressFile]) {
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(file, "utf8").includes("hello from alpha")).toBe(false);
	}
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	const answer = await send(h.w, "beta", B, "alpha", { kind: "reply", replyTo: h.id });
	expect(answer.ok).toBe(true);
	await h.process.run();
	expect(h.w.rm.byId(h.id)?.replyId).toBeDefined();
	expect(h.progress().filter(row => row.kind === "item" && row.outcome === "refused_changed_hash")).toHaveLength(0);
});
it("RET-4 refuses symlink-selected administrative directory without touching target", async () => {
	const h = await migration();
	const elsewhere = join(data, "elsewhere");
	fs.mkdirSync(elsewhere);
	fs.symlinkSync(elsewhere, h.root);
	expect((await h.process.run()).status).toBe("unknown");
	expect(fs.readdirSync(elsewhere)).toHaveLength(0);
});
it.each(["unknown-field", "numeric-hash", "boolean-index"])("RET-4 malformed administrative %s refuses without rewriting durable files", async variant => {
	const h = await migration();
	await h.process.run();
	if (variant === "boolean-index") {
		const rows = h.progress() as unknown as Array<Record<string, unknown>>;
		const row = rows.find(entry => entry.kind === "item")!;
		row.index = true;
		fs.writeFileSync(h.progressFile, rows.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	} else {
		const plan = h.plan() as unknown as Record<string, unknown>;
		if (variant === "unknown-field") plan.payload = "forbidden fixture data";
		else plan.planHash = 7;
		fs.writeFileSync(h.planFile, JSON.stringify(plan));
	}
	const before = [fs.readFileSync(h.planFile, "utf8"), fs.readFileSync(h.progressFile, "utf8")];
	expect((await new InboxMigration(h.ports).run()).status).toBe("unknown");
	expect([fs.readFileSync(h.planFile, "utf8"), fs.readFileSync(h.progressFile, "utf8")]).toEqual(before);
});
it("RET-4 admin rows are rejected by unchanged actual inbox codec, never migration opcodes", () => {
	for (const row of [
		{ v: "rpi-migration/1", migrationId: "rpi-legacy-v1", planHash: `sha256:${"a".repeat(64)}`, items: [] },
		{ v: "rpi-migration/1", kind: "item", migrationId: "rpi-legacy-v1", planHash: `sha256:${"a".repeat(64)}`, key: "migrate:rm-00000001", sourceHash: `sha256:${"b".repeat(64)}`, index: 0, outcome: "classified", at: 1 },
	]) {
		let result;
		expect(() => { result = decodeInboxLine(row); }).not.toThrow();
		expect(result).toEqual({ ok: false, code: "E_RPI_SCHEMA" });
	}
});
