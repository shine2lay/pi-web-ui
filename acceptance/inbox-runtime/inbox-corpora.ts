import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read Architecture's one corpus, never a reference interpreter. Fail loudly on drift.
const root = "/home/shinelay/architecture-dept/tests/role-priority-inbox";
export const pins = {
	core: { file: "role-priority-inbox.cases.json", count: 90, sha: "a93ee55478be95282bca124e31400e419035fe016e497995b828585e2242d7b1" },
	delivery: { file: "delivery/delivery.cases.json", count: 69, sha: "1aabea2f3198645e613beb47d66053e3085640a15003e71a62c28df037bdd059" },
	helper: { file: "helpers/helper.cases.json", count: 120, sha: "aabc75c5342fe85d6a3efefebb0ebd3546b9ed54ca78c95b3e6e5eec66fab81b" },
} as const;
export interface InboxCase {
	id: string;
	input?: Record<string, unknown>;
	expect: Record<string, unknown>;
}
export function corpus(name: keyof typeof pins): InboxCase[] {
	const pin = pins[name];
	const bytes = readFileSync(join(root, pin.file));
	if (createHash("sha256").update(bytes).digest("hex") !== pin.sha) throw new Error(`Corpus drift: ${name}`);
	const cases = JSON.parse(bytes.toString()).cases as InboxCase[];
	if (cases.length !== pin.count || new Set(cases.map(c => c.id)).size !== pin.count) throw new Error(`Corpus ids/count drift: ${name}`);
	return cases;
}
export function caseOf(name: keyof typeof pins, id: string): InboxCase {
	const found = corpus(name).find(c => c.id === id);
	if (!found) throw new Error(`Missing pinned case: ${id}`);
	return found;
}
