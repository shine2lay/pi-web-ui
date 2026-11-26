/**
 * department-specialists (Ops #1101; Architecture #591 §3.1, §3.3, §4.3): the specialist fields of pi-queue's journal
 * as the Queue panel replays them, for the one chip on a task's row and its chat's header (R-SPEC-UI-1).
 *
 * pi-queue writes `specialist: "<slug>"` on `add` (and its task chat's `assigned`) ops, `specialist: "<slug>" | null`
 * on `update` ops, and the launch snapshot as `launch.specialist` at the real start. The panel keeps only the slug
 * and the snapshot's title: nothing else of a snapshot (limits, hashes, model) reaches the page. A task without a
 * specialist gets no key at all (R-SPEC-NOSPEC-1). A malformed value is dropped, never shown.
 */

/** §1.2 slug shape (same as pi-queue's role id); every pi-web-ui reader checks it again and fails closed. */
export const SPECIALIST_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The longest title the chip shows (a longer one is cut, never dropped). */
const TITLE_MAX = 80;

/** The task fields the chip reads (pi-queue's task `specialist` and its launch snapshot's title). */
export interface SpecialistTaskFields {
	specialist?: string;
	launch?: { specialist?: { title?: string } };
}

/** What a task chat's identity (the header's IdentityTag) gains in a specialist's task chat. */
export interface SpecialistChatIdentity {
	specialist?: { slug: string; title?: string };
}

/** The launch snapshot as the panel keeps it. */
export interface LaunchSpecialist {
	slug: string;
	title?: string;
}

/** A slug-valid specialist value, else undefined. */
export function specialistSlugOf(raw: unknown): string | undefined {
	return typeof raw === "string" && SPECIALIST_SLUG_RE.test(raw) ? raw : undefined;
}

/** The slug and title of a launch's `specialist` snapshot; undefined when it has none or its slug isn't valid. */
export function launchSpecialistOf(launch: unknown): LaunchSpecialist | undefined {
	if (!launch || typeof launch !== "object") return undefined;
	const snap = (launch as { specialist?: unknown }).specialist;
	if (!snap || typeof snap !== "object") return undefined;
	const { slug: rawSlug, title: rawTitle } = snap as { slug?: unknown; title?: unknown };
	const slug = specialistSlugOf(rawSlug);
	if (!slug) return undefined;
	const title = typeof rawTitle === "string" ? rawTitle.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) : "";
	return title ? { slug, title } : { slug };
}

/** The launch field on the wire (protocol.ts UiTaskQueueTask.launch adds it to UiTaskLaunch). */
export interface SpecialistLaunchWire {
	specialist?: LaunchSpecialist;
}

/** normLaunch's part: `{ specialist }` for a launch that has a valid snapshot, else `{}` (no key). */
export function launchSpecialistField(launch: unknown): { specialist?: LaunchSpecialist } {
	const specialist = launchSpecialistOf(launch);
	return specialist ? { specialist } : {};
}

/** An `add` / `assigned` op sets the task's specialist; an `update` op sets it (a slug) or clears it (null);
 *  a value that isn't a valid slug changes nothing. Also a replayed task checkpoint (`op` absent: set only). */
export function applySpecialistOp(task: object, op: { op?: unknown; specialist?: unknown }): void {
	const t = task as SpecialistTaskFields;
	if (op.op === "update" && op.specialist === null) {
		delete t.specialist;
		return;
	}
	const slug = specialistSlugOf(op.specialist);
	if (slug) t.specialist = slug;
}
