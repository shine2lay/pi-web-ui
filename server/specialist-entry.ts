/**
 * department-specialists (Ops #1097 seam, Ops #1101 build; Architecture #591 §4.1, R-SPEC-ENTRY-1, R-SPEC-BIND-2):
 * pi-web-ui's read of the `specialist` field on a chat's `identity` entry, the sticky binding that makes pi-web-ui's
 * own `/identity <id>` writers refuse in a specialist chat, and the chat's specialist for its header chip and the
 * role-message stamp.
 *
 * Producer: pi-identity writes the entry (`{v:1, id:"<dept>", via:"queue", from, specialist:"<slug>"}`). This is a
 * reader copy of that field only: identities.ts's `identityIdOfEntry` / `identityIdOnBranch` call it, so identities.ts
 * keeps its size. It never reads a specialist's files, decides tools or hashes a launch snapshot: those stay in
 * pi-identity (§5.4). Shared cases: tests/fixtures/department-specialists.cases.json (C-ENTRY-*, C-BIND-*).
 */
import { IDENTITY_ENTRY_TYPE, isIdentityData, type IdentityEntryLike } from "./identities.js";
import type { UiChatIdentity } from "./protocol.js";
import { TASK_QUEUE_ENTRY_TYPE } from "./task-queue-fields.js";
import { launchSpecialistOf, SPECIALIST_SLUG_RE, type SpecialistChatIdentity } from "./task-queue-specialist.js";

/** R-SPEC-BIND-2: the refusal code pi-identity logs and pi-web-ui's `/identity` writers return. */
export const E_SPEC_BINDING_CONFLICT = "E_SPEC_BINDING_CONFLICT";

/**
 * What one `identity` entry says:
 * - `{ id }`: a plain entry (`id: null` = cleared), as today;
 * - `{ id, specialist }`: a queue entry naming a slug-valid specialist of a string department;
 * - `"unusable"`: a `specialist` field that fails the checks (bad slug, not a string, not `via:"queue"`, no string
 *   `id`): the chat has no usable identity, never the plain department.
 */
export type EntryIdentity = { id: string | null; specialist?: string } | "unusable";

/** The binding of a branch's identity entries (C-BIND-*): the first specialist entry wins and stays. */
export interface SpecialistBinding {
	binding: { id: string | null; specialist?: string };
	/** A later entry tried to change a specialist binding (other slug, other department, or none). */
	conflict: boolean;
}

/** The `/identity` writers' refusal in a specialist-bound chat (nothing is written). */
export interface IdentityCommandRefusal {
	code: typeof E_SPEC_BINDING_CONFLICT;
	message: string;
}

/** The identity an entry carries; undefined when it isn't an `identity` entry (same test as identityIdOfEntry). */
export function identityOfEntry(entry: IdentityEntryLike): EntryIdentity | undefined {
	if (entry.type !== "custom" || entry.customType !== IDENTITY_ENTRY_TYPE || !isIdentityData(entry.data)) {
		return undefined;
	}
	const data = entry.data as { id: string | null; via: string; specialist?: unknown };
	if (!("specialist" in data)) return { id: data.id };
	const { id, via, specialist } = data;
	const usable = via === "queue" && typeof id === "string" && typeof specialist === "string";
	return usable && SPECIALIST_SLUG_RE.test(specialist) ? { id, specialist } : "unusable";
}

/** The sticky binding over a branch's entries, oldest first; undefined when it has no identity entry. An unusable
 *  entry reads as `{ id: null }` (no usable identity); once a specialist is bound, nothing later changes it. */
export function specialistBindingOnBranch(entries: Iterable<IdentityEntryLike>): SpecialistBinding | undefined {
	let out: SpecialistBinding | undefined;
	for (const e of entries) {
		const read = identityOfEntry(e);
		if (read === undefined) continue;
		const next = read === "unusable" ? { id: null } : read;
		const bound = out?.binding.specialist !== undefined ? out.binding : undefined;
		if (!bound) out = { binding: next, conflict: false };
		else if (next.id !== bound.id || next.specialist !== bound.specialist) out = { binding: bound, conflict: true };
	}
	return out;
}

/** Whether `/identity <id>` (or `/identity none`) must be refused on this branch: null = allowed, as today. */
export function identityCommandRefusal(entries: Iterable<IdentityEntryLike>): IdentityCommandRefusal | null {
	const bound = specialistBindingOnBranch(entries)?.binding;
	if (bound?.specialist === undefined) return null;
	const message = `${E_SPEC_BINDING_CONFLICT}: this task chat works as one of ${bound.id}'s specialists; its identity can't be changed.`;
	return { code: E_SPEC_BINDING_CONFLICT, message };
}

type BranchEntry = IdentityEntryLike & { id?: string; parentId?: string | null };
/** The parts of a loaded chat's session the walk reads (pi's SessionManager; a durable chat's has no getEntry). */
interface BranchSource {
	getSessionId(): string;
	getLeafId(): string | null;
	getEntry?(id: string): BranchEntry | undefined;
	getBranch(): BranchEntry[];
}

/** The branch's entries, newest first: by parent links when the session can look one up, else its branch list. */
function* newestFirst(sm: BranchSource): Generator<BranchEntry> {
	if (typeof sm.getEntry !== "function") {
		const branch = sm.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) yield branch[i]!;
		return;
	}
	for (let id = sm.getLeafId(); id;) {
		const entry = sm.getEntry(id);
		if (!entry) return;
		yield entry;
		id = entry.parentId ?? null;
	}
}
interface ChatSpecialist {
	id: string;
	slug: string;
	title?: string;
}
const seen = new WeakMap<object, { sessionId: string; leafId: string | null; found?: ChatSpecialist }>();

/** The earliest specialist entry on the current branch, with the title of the task's launch snapshot (its queue
 *  `assigned` entry), walking back only to the leaf seen last time: the binding is sticky, so new entries never
 *  replace a found one. */
function chatSpecialistOf(sm: BranchSource): ChatSpecialist | undefined {
	const sessionId = sm.getSessionId();
	const leafId = sm.getLeafId();
	const last = seen.get(sm);
	const same = last?.sessionId === sessionId;
	if (same && last.leafId === leafId) return last.found;
	let found: ChatSpecialist | undefined;
	let title: string | undefined;
	let reached = false;
	for (const entry of newestFirst(sm)) {
		if (same && entry.id !== undefined && entry.id === last.leafId) {
			reached = true;
			break;
		}
		const read = identityOfEntry(entry);
		if (read !== undefined && read !== "unusable" && read.id && read.specialist) {
			found = { id: read.id, slug: read.specialist };
		}
		const op = entry.customType === TASK_QUEUE_ENTRY_TYPE ? (entry.data as { op?: unknown; launch?: unknown }) : null;
		if (op?.op === "assigned") title = launchSpecialistOf(op.launch)?.title ?? title;
	}
	if (reached && last?.found) found = { ...last.found };
	if (found && !found.title && title) found.title = title;
	seen.set(sm, { sessionId, leafId, found });
	return found;
}

/**
 * A loaded chat's identity with its specialist (the header chip, the role-message stamp): only when the chat's
 * sticky specialist binding is of the same department as the identity shown. Any read failure = no specialist.
 */
export function withSpecialist(
	identity: UiChatIdentity | undefined,
	conv: { session: { sessionManager: unknown } },
): (UiChatIdentity & SpecialistChatIdentity) | undefined {
	if (!identity) return identity;
	try {
		const found = chatSpecialistOf(conv.session.sessionManager as BranchSource);
		if (!found || found.id !== identity.id) return identity;
		return { ...identity, specialist: { slug: found.slug, ...(found.title ? { title: found.title } : {}) } };
	} catch {
		return identity;
	}
}
