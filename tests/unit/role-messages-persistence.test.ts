// #539 H-RM-SEAM-2: single-instance equivalence, and unchanged-base bytes (length + SHA-256).
// Golden captured BEFORE the seam from 2dca0e27 with exactly exercise() below; never regenerate on a mismatch.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RoleMessages,
	ROLE_MESSAGES_KEEP,
	ROLE_MESSAGE_CHAIN_MEMORY_MS,
	type RoleMessageHost,
	type RoleMessageRecord,
	type RoleMessagePersistence,
} from "../../server/role-messages.js";
import { memoryRoleMessagePersistence } from "./role-messages-memory.js";

const at = Date.parse("2026-10-25T12:00:00Z");
const host = (logs: string[]): RoleMessageHost => ({
	roles: () => [],
	chatState: () => "idle",
	deliver: async () => ({ ok: true }),
	note: async () => ({ ok: true }),
	log: (line) => logs.push(line),
});
const record = (n: number, extra: Partial<RoleMessageRecord> = {}): RoleMessageRecord => ({
	id: `rm-${n.toString(16).padStart(8, "0")}`,
	at: at - 2 * 3_600_000,
	from: { role: "ops", title: "Ops", chat: "home chat", file: "/sender" },
	to: { role: "beta", title: "Beta" },
	kind: "request",
	chain: 1,
	text: `fixed ${n} — héllo`,
	state: "delivered",
	sends: 1,
	attempts: 0,
	root: "root-fixed",
	...extra,
});
const digest = (bytes: string) => ({
	bytes: Buffer.byteLength(bytes),
	sha256: createHash("sha256").update(bytes).digest("hex"),
});
const golden = JSON.parse(
	readFileSync(new URL("../fixtures/role-messages-persistence-golden.json", import.meta.url), "utf8"),
) as {
	checkpoints: { store: ReturnType<typeof digest>; chains: ReturnType<typeof digest> | null }[];
	tidy: ReturnType<typeof digest>;
	logs: { count: number; sha256: string; last: string[] };
};
function exercise(s: RoleMessages, checkpoint: () => void): void {
	s.admit(record(1, { hash: "hash-one", target: "/beta-chat" }), () => {});
	s.admit(record(2, { kind: "reply", replyTo: record(1).id, parent: record(1).id, chain: 2 }), () => {});
	s.admit(record(3, { state: "waiting" }), () => {});
	s.admit(
		record(4, { at: at - 60_000, from: { role: "alpha", title: "Alpha", chat: "home chat", file: "/alpha" } }),
		() => {},
	);
	checkpoint();
	for (let n = 5; n <= ROLE_MESSAGES_KEEP + 5; n++) s.admit(record(n), () => {});
	s.admit(record(ROLE_MESSAGES_KEEP + 5), () => {}); // idempotent
	checkpoint();
	s.setPaused(true);
	checkpoint();
	s.setPaused(false);
	checkpoint();
}
function observe(s: RoleMessages): unknown {
	return structuredClone({
		data: (s as unknown as { data: unknown }).data,
		chainMemory: [...(s as unknown as { chainMemory: Map<string, unknown> }).chainMemory],
		paused: s.paused,
		rows: s.rows(2000),
		hourly: s.hourlyCount("alpha"),
		incoming: s.openRequestsTo("beta"),
		outgoing: s.openRequestsFrom("ops"),
		pairs: s.openPairs(),
		chain: s.chainFact(record(1).id),
		dropped: s.dropped(record(1).id),
		ancestor: s.ancestorAt(record(2).id, 1),
	});
}

describe("RoleMessages persistence seam", () => {
	it("file and memory give equal live state/public reads; default bytes and logs equal the pre-seam golden", () => {
		const dir = mkdtempSync(join(tmpdir(), "rm-golden-"));
		const file = join(dir, "role-messages.json");
		const chains = join(dir, "role-messages-chains.jsonl");
		const logs: string[] = [];
		const memoryLogs: string[] = [];
		const checkpoints: typeof golden.checkpoints = [];
		const states: unknown[] = [];
		const s = new RoleMessages(file, host(logs), () => at);
		const memory = new RoleMessages(
			join(dir, "never-created.json"),
			host(memoryLogs),
			() => at,
			undefined,
			memoryRoleMessagePersistence(),
		);
		const made = [s, memory];
		try {
			exercise(s, () => {
				checkpoints.push({
					store: digest(readFileSync(file, "utf8")),
					chains: existsSync(chains) ? digest(readFileSync(chains, "utf8")) : null,
				});
				states.push(observe(s));
			});
			let next = 0;
			exercise(memory, () => expect(observe(memory)).toEqual(states[next++]));
			expect(next).toBe(states.length);
			expect(memoryLogs).toEqual(logs);
			expect(checkpoints).toEqual(golden.checkpoints);
			expect(s.chainFact(record(1).id)).toMatchObject({ id: record(1).id, hash: "hash-one", state: "replied" });
			expect(s.dropped(record(1).id)).toEqual({ at, state: "replied" });
			expect(s.byId(record(3).id)?.state).toBe("waiting");
			expect(s.hourlyCount("alpha")).toBe(1);
			expect(readdirSync(dir).sort()).toEqual(["role-messages-chains.jsonl", "role-messages.json"]);
			s.stop();
			// Persistence/restart cases stay on FILE, never the memory helper.
			appendFileSync(
				chains,
				`${JSON.stringify({ id: "rm-expired", chain: 1, at: at - ROLE_MESSAGE_CHAIN_MEMORY_MS })}\n{torn`,
			);
			const reloaded = new RoleMessages(file, host(logs), () => at);
			made.push(reloaded);
			expect(observe(reloaded)).toEqual(observe(s));
			expect(reloaded.chainFact("rm-expired")).toBeUndefined();
			expect(digest(readFileSync(chains, "utf8"))).toEqual(golden.tidy);
			reloaded.stop();
			writeFileSync(file, "{broken");
			const bad = new RoleMessages(file, host(logs), () => at);
			made.push(bad);
			expect(readFileSync(`${file}.bad-${at}`, "utf8")).toBe("{broken");
			expect(existsSync(file)).toBe(false);
			expect(bad.rows()).toEqual([]);
			const normalized = logs.map((l) => l.replaceAll(dir, "<dir>"));
			expect({
				count: normalized.length,
				sha256: digest(JSON.stringify(normalized)).sha256,
				last: normalized.slice(-3),
			}).toEqual(golden.logs);
		} finally {
			for (const s of made) s.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("swallows persistence failures without losing live state, chain facts or the original log messages", () => {
		const logs: string[] = [];
		const p: RoleMessagePersistence = {
			...memoryRoleMessagePersistence(),
			saveStore: () => {
				throw new Error("save failed");
			},
			appendChains: () => {
				throw new Error("append failed");
			},
		};
		const s = new RoleMessages("/unused/role-messages.json", host(logs), () => at, undefined, p);
		try {
			exercise(s, () => {});
			expect(s.paused).toBe(false);
			expect(s.dropped(record(1).id)).toEqual({ at, state: "replied" });
			expect(logs).toContain("[role-messages] couldn't save the store: save failed");
			expect(logs).toContain(
				"[role-messages] couldn't keep the chain memory (append failed); it holds until the next restart",
			);
			expect(s.byId(record(3).id)?.state).toBe("waiting");
		} finally {
			s.stop();
		}
	});

	it("keeps the bad-store rename attempt and chain-tidy failure handling in the service", () => {
		const logs: string[] = [];
		const renamed: string[][] = [];
		const s = new RoleMessages("/unused/role-messages.json", host(logs), () => at, undefined, {
			...memoryRoleMessagePersistence(),
			read: (file) =>
				file.endsWith(".json")
					? "{broken"
					: [
							JSON.stringify({ id: "rm-old", chain: 1, at: at - ROLE_MESSAGE_CHAIN_MEMORY_MS }),
							JSON.stringify({ id: "rm-kept", chain: 2, at }),
							"{torn",
						].join("\n"),
			rename: (a, b) => {
				renamed.push([a, b]);
				throw new Error("rename failed");
			},
			replaceChains: () => {
				throw new Error("tidy failed");
			},
		});
		try {
			expect(renamed).toEqual([["/unused/role-messages.json", `/unused/role-messages.json.bad-${at}`]]);
			expect(logs[0]).toContain("couldn't read the store (");
			expect(logs[0]).toContain(`kept it as /unused/role-messages.json.bad-${at}`);
			expect(logs[1]).toBe("[role-messages] couldn't tidy the chain memory (tidy failed)");
			expect(s.chainFact("rm-old")).toBeUndefined();
			expect(s.chainFact("rm-kept")).toMatchObject({ chain: 2 });
		} finally {
			s.stop();
		}
	});
});
