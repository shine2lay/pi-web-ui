/**
 * department-specialists (Ops #1097, Rule 18 Task 1 seam; Architecture #591 §4.1, R-SPEC-ENTRY-1, R-SPEC-BIND-2):
 * pi-web-ui's read of the `specialist` field on a chat's `identity` entry, and the sticky binding that makes
 * pi-web-ui's own `/identity <id>` writers refuse in a specialist chat.
 *
 * Producer: pi-identity writes the entry (`{v:1, id:"<dept>", via:"queue", from, specialist:"<slug>"}`). This is a
 * reader copy of that field only, beside `identityIdOfEntry` in identities.ts (Task 2 makes that call this, so
 * identities.ts keeps its size). It never reads a specialist's files, decides tools or hashes a launch snapshot: those stay in
 * pi-identity (§5.4). Shared cases: tests/fixtures/department-specialists.cases.json (C-ENTRY-*, C-BIND-*).
 *
 * Task 1 leaves the functions unbuilt (they throw E_NOT_BUILT); Ops #1097 Task 2 builds them and wires them into
 * identities.ts and the two `/identity` writers in agent-service.ts.
 */
import type { IdentityEntryLike } from "./identities.js";

/** §1.2 slug shape (same as pi-queue's role id): checked again at this reader, which fails closed. */
export const SPECIALIST_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

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

function notBuilt(name: string): never {
	throw new Error(`E_NOT_BUILT: ${name} (department specialists, Ops #1097 Task 2)`);
}

/** The identity an entry carries; undefined when it isn't an `identity` entry (same test as identityIdOfEntry). */
export function identityOfEntry(_entry: IdentityEntryLike): EntryIdentity | undefined {
	return notBuilt("identityOfEntry");
}

/** The sticky binding over a branch's entries, oldest first; undefined when it has no identity entry. */
export function specialistBindingOnBranch(_entries: Iterable<IdentityEntryLike>): SpecialistBinding | undefined {
	return notBuilt("specialistBindingOnBranch");
}

/** Whether `/identity <id>` (or `/identity none`) must be refused on this branch: null = allowed, as today. */
export function identityCommandRefusal(_entries: Iterable<IdentityEntryLike>): IdentityCommandRefusal | null {
	return notBuilt("identityCommandRefusal");
}
