// department-specialists (Ops #1097): the shared cases (Architecture #591), read by case id. The copy in
// tests/fixtures is byte-for-byte Architecture's file, pinned here by sha256: an edited or re-copied file fails at
// load, before any case runs. Re-pinning is a reviewed change (Architecture publishes the new sha).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const CASES_SHA256 = "5c473f3349186111ac99cf6930618f2020007b1374f6719c280345146c4213d6";
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES_FILE = join(REPO_ROOT, "tests", "fixtures", "department-specialists.cases.json");

export interface SpecialistCase {
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
}

function load(): SpecialistCase[] {
	const bytes = readFileSync(CASES_FILE);
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== CASES_SHA256) {
		throw new Error(`department-specialists.cases.json sha256 ${sha}, pinned ${CASES_SHA256}: never edit the copy`);
	}
	const file = JSON.parse(bytes.toString("utf8")) as { cases: SpecialistCase[] };
	return file.cases;
}

export const SPECIALIST_CASES: readonly SpecialistCase[] = load();

export function caseById(id: string): SpecialistCase {
	const c = SPECIALIST_CASES.find((x) => x.id === id);
	if (!c) throw new Error(`no shared case ${id} in department-specialists.cases.json`);
	return c;
}

/** Cases pi-web-ui takes part in (as a boundary or a consumer). */
export function piWebUiCases(): SpecialistCase[] {
	return SPECIALIST_CASES.filter((c) => c.boundaries.includes("pi-web-ui") || c.consumers.includes("pi-web-ui"));
}

const PI_WEB_UI_PREFIX = "/home/shinelay/projects/pi-web-ui/";

/**
 * C-PARITY-1's two files on this machine: pi-web-ui's own copy from this checkout (a worktree or a land's copy, not
 * the main clone), pi-identity's from the case's path (PI_IDENTITY_PEER=<pi-identity folder> overrides it). A
 * missing file fails loudly: a parity check that can't see both sides never passes.
 */
export function parityFiles(c: SpecialistCase): { own: string; peer: string } {
	const files = c.input.files as string[];
	const ownCase = files.find((f) => f.startsWith(PI_WEB_UI_PREFIX));
	const peerCase = files.find((f) => !f.startsWith(PI_WEB_UI_PREFIX));
	if (!ownCase || !peerCase || files.length !== 2) throw new Error(`${c.id}: expected one pi-web-ui and one peer file`);
	const own = join(REPO_ROOT, relative(PI_WEB_UI_PREFIX, ownCase));
	const peerDir = process.env.PI_IDENTITY_PEER;
	const peer = peerDir ? join(peerDir, relative("/home/shinelay/projects/pi-identity/", peerCase)) : peerCase;
	for (const f of [own, peer]) {
		if (!existsSync(f)) throw new Error(`${c.id}: ${f} is missing; set PI_IDENTITY_PEER to a pi-identity checkout`);
	}
	return { own, peer };
}
