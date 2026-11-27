// department-specialists Phase 2 (Ops #1113): the §6 collaboration cases (Architecture #595, final read-only-args pin
// work/department-specialists-595/pin-readonly-args.sha256) and #596's principal cases, read by case id. The copies in
// tests/fixtures are byte-for-byte Architecture's files, pinned here by sha256: an edited or re-copied file fails at
// load, before any case runs. Re-pinning is a reviewed change (Architecture publishes the new sha).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./department-specialists-cases.js";

export const COLLAB_CASES_SHA256 = "2e083f39bc515c050b2f5f8fad2f44bdcc67da3bcc024ae3fa0bb6cdb57ca97e";
export const PRINCIPAL_CASES_SHA256 = "07dd113c349854722c779c40c29433ab36a105f4ebb2a5dae2201aa7c86970d1";

export interface SharedCase {
	id: string;
	req: string[];
	kind: string;
	producer: string;
	consumers: string[];
	boundaries: string[];
	input: Record<string, unknown>;
	expect: Record<string, unknown> & { result: "allow" | "refuse"; code?: string };
	twin?: string;
	live: string;
	source_red?: { today: Record<string, unknown>; why: string };
}

interface CaseFile {
	fixtures: Record<string, unknown>;
	cases: SharedCase[];
}

function pinned(name: string, sha256: string): CaseFile {
	const bytes = readFileSync(join(REPO_ROOT, "tests", "fixtures", name));
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== sha256) throw new Error(`${name} sha256 ${sha}, pinned ${sha256}: never edit the copy`);
	return JSON.parse(bytes.toString("utf8")) as CaseFile;
}

const COLLAB = pinned("department-specialists-collab.cases.json", COLLAB_CASES_SHA256);
const PRINCIPAL = pinned("principal.cases.json", PRINCIPAL_CASES_SHA256);

const takesPart = (c: SharedCase) => c.boundaries.includes("pi-web-ui") || c.consumers.includes("pi-web-ui");

/** The §6 cases pi-web-ui takes part in (as a boundary or a consumer). */
export const collabPiWebUiCases = (): SharedCase[] => COLLAB.cases.filter(takesPart);
/** The #596 principal cases pi-web-ui takes part in. */
export const principalPiWebUiCases = (): SharedCase[] => PRINCIPAL.cases.filter(takesPart);

export function collabCase(id: string): SharedCase {
	const c = COLLAB.cases.find((x) => x.id === id);
	if (!c) throw new Error(`no shared case ${id} in department-specialists-collab.cases.json`);
	return c;
}

export function principalCase(id: string): SharedCase {
	const c = PRINCIPAL.cases.find((x) => x.id === id);
	if (!c) throw new Error(`no shared case ${id} in principal.cases.json`);
	return c;
}

/** A case value with its "@NAME" fixture references replaced, all the way down (the corpus's own notation). */
export function resolved<T = unknown>(value: unknown): T {
	if (typeof value === "string" && value.startsWith("@")) {
		const name = value.slice(1);
		if (!(name in COLLAB.fixtures)) throw new Error(`no fixture ${name} in department-specialists-collab.cases.json`);
		return resolved<T>(COLLAB.fixtures[name]);
	}
	if (Array.isArray(value)) return value.map((v) => resolved(v)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolved(v)])) as T;
	}
	return value as T;
}
