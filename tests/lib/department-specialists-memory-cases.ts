// department-specialists §5l (Frontend #364; Architecture #597): the specialist-memory cases, read by case id. The copy in
// tests/fixtures is byte-for-byte Architecture's
// /home/shinelay/architecture-dept/tests/department-specialists/department-specialists-memory.cases.json, pinned
// here by sha256 (manifest /home/shinelay/architecture-dept/work/department-specialists-597/pin.sha256): an edited
// or re-copied file fails at load, before any case runs. Re-pinning is a reviewed change.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./department-specialists-cases.js";

export const MEMORY_CASES_SHA256 = "d700e4f216237d874dec28580c5b242d86407392841844953473bb7b07af72d7";
const CASES_FILE = join(REPO_ROOT, "tests", "fixtures", "department-specialists-memory.cases.json");

export interface MemoryCase {
	id: string;
	req: string[];
	kind: string;
	input: Record<string, unknown>;
	expect: Record<string, unknown> & { result: "allow" | "refuse"; code?: string };
	twin?: string;
	private?: string[];
	live: string;
}

interface CasesFile {
	fixtures: Record<string, unknown>;
	cases: MemoryCase[];
}

function load(): CasesFile {
	const bytes = readFileSync(CASES_FILE);
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== MEMORY_CASES_SHA256) {
		throw new Error(`department-specialists-memory.cases.json sha256 ${sha}, pinned ${MEMORY_CASES_SHA256}`);
	}
	return JSON.parse(bytes.toString("utf8")) as CasesFile;
}

const FILE = load();

export function memoryCase(id: string): MemoryCase {
	const c = FILE.cases.find((x) => x.id === id);
	if (!c) throw new Error(`no case ${id} in department-specialists-memory.cases.json`);
	return c;
}

/** A case value with its `@NAME` fixture references resolved (fixtures that are strings: the URIs). */
export function resolved<T>(value: T): T {
	if (typeof value === "string" && value.startsWith("@")) {
		const fixture = FILE.fixtures[value.slice(1)];
		if (typeof fixture !== "string") throw new Error(`fixture ${value} is not a uri`);
		return fixture as T;
	}
	if (Array.isArray(value)) return value.map((v) => resolved(v)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolved(v)])) as T;
	}
	return value;
}

/** The server's uri form: one trailing `/` dropped (R-EXPLORER-URI-1), as every explorer answer writes it. */
export const explorerUri = (uri: string): string => (uri.endsWith("/") ? uri.slice(0, -1) : uri);
