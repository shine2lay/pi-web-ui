/**
 * Memory Explorer, a specialist node's status label (Architecture #597 v2 §5l.15, R-V2-SPMEM-20): `retired` when the
 * department's `specialists/<slug>/specialist.json` (pi-identity Phase 1, §1.2) says so, `no config` when it has
 * none, else no label. Display only: the label never hides, moves or locks a node, and no access depends on it.
 *
 * Read-only copy of pi-identity's `readConfig` (specialists/files.ts: lstat every part, no symlink, a regular file,
 * realpath under `<dept>/specialists/`, O_NOFOLLOW, at most 4 x 8 KiB; then schema.ts's strict reader as it reads a
 * stored file back: shape only, no registry or ceiling). A config that reader refuses is `no config`. Parity with
 * pi-identity's own reader, case by case: tests/unit/specialist-config-label.test.ts.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { SPECIALIST_SLUG_RE } from "../task-queue-specialist.js";
import type { OpenVikingSpecialistLabel } from "./explorer-types.js";

const SPECIALISTS_DIR = "specialists";
const SPECIALIST_JSON = "specialist.json";
/** pi-identity reads a stored config up to 4 x SPECIALIST_JSON_MAX (8 KiB). */
const CONFIG_READ_MAX = 4 * 8 * 1024;

/** The file's text when every part is a real folder or file (no symlink) inside `<dept>/specialists/`; else null. */
function readConfigText(identitiesDir: string, dept: string, slug: string): string | null {
	const base = join(identitiesDir, dept, SPECIALISTS_DIR);
	const parts = [SPECIALISTS_DIR, slug, SPECIALIST_JSON];
	let path = join(identitiesDir, dept);
	try {
		for (let i = 0; i < parts.length; i++) {
			path = join(path, parts[i]);
			const st = lstatSync(path);
			if (st.isSymbolicLink()) return null;
			if (i === parts.length - 1 ? !st.isFile() : !st.isDirectory()) return null;
		}
		if (!realpathSync(path).startsWith(realpathSync(base) + sep)) return null;
	} catch {
		return null;
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > CONFIG_READ_MAX) return null;
		const bytes = Buffer.alloc(st.size);
		let read = 0;
		while (read < st.size) {
			const n = readSync(fd, bytes, read, st.size - read, read);
			if (n === 0) break;
			read += n;
		}
		return read === st.size ? bytes.toString("utf8") : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

// pi-identity specialists/types.ts and schema.ts, as a stored file is read back.
const SPECIALIST_JSON_MAX = 8 * 1024;
const REQUIRED = ["v", "id", "title", "status"];
const KNOWN = [...REQUIRED, "tier", "model", "thinking", "tools", "skills"];
const AUTHORITY = [
	"homeChat",
	"pastHomeChats",
	"folder",
	"zone",
	"spend",
	"owner",
	"alwaysAllow",
	"toolGroups",
	"prompt",
	"goals",
	"role",
];
const TIERS = ["max", "xhigh", "high", "medium", "low"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_RE = /^[^\s/]+\/\S+$/;
const TOOL_RE = /^[A-Za-z0-9_.:*-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const slugOk = (v: unknown): v is string => typeof v === "string" && SPECIALIST_SLUG_RE.test(v);
const toolList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && TOOL_RE.test(x));

/** pi-identity canon.ts canonJson: sorted keys, no spaces (only its byte length matters here). */
function canonJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonJson(v))).join(",")}]`;
	const o = value as Record<string, unknown>;
	const keys = Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonJson(o[k])}`).join(",")}}`;
}

function toolsShapeOk(t: unknown): boolean {
	if (!isObject(t) || Object.keys(t).some((k) => k !== "allow" && k !== "deny")) return false;
	if ((t.allow ?? null) !== null && !toolList(t.allow)) return false;
	return toolList(t.deny ?? []);
}

/** The stored config's status when pi-identity's reader would accept the document, else null. */
function storedStatus(folder: string, text: string): "active" | "retired" | null {
	if (Buffer.byteLength(text, "utf8") > CONFIG_READ_MAX) return null;
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(doc) || Buffer.byteLength(canonJson(doc), "utf8") > SPECIALIST_JSON_MAX) return null;
	if (Object.keys(doc).some((k) => AUTHORITY.includes(k) || !KNOWN.includes(k))) return null;
	if (REQUIRED.some((k) => !(k in doc))) return null;
	if (doc.v !== 1 || doc.id !== folder || !slugOk(doc.id)) return null;
	if (typeof doc.title !== "string" || doc.title.trim() === "" || [...doc.title].length > 80) return null;
	if (doc.status !== "active" && doc.status !== "retired") return null;
	if ("tier" in doc && !TIERS.includes(doc.tier as string)) return null;
	const model = doc.model;
	if ("model" in doc && !(typeof model === "string" && MODEL_RE.test(model.trim()) && model.length <= 200)) return null;
	if ("thinking" in doc && !THINKING.includes(doc.thinking as string)) return null;
	if ("skills" in doc && !(Array.isArray(doc.skills) && doc.skills.every(slugOk))) return null;
	if ("tools" in doc && !toolsShapeOk(doc.tools)) return null;
	return doc.status;
}

/** `retired`, `no config` (none, or one pi-identity's reader refuses), or null (active). */
export function specialistConfigLabel(identitiesDir: string, dept: string, slug: string): OpenVikingSpecialistLabel {
	if (!slugOk(slug)) return "no config";
	const text = readConfigText(identitiesDir, dept, slug);
	const status = text === null ? null : storedStatus(slug, text);
	return status === null ? "no config" : status === "retired" ? "retired" : null;
}
