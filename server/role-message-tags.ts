// ---------------------------------------------------------------------------
// message_role's tag guard (ops #964). The pure rules are server/shared/task-tag-governance.ts (pi-queue's
// tag-governance.ts byte for byte); this file applies them to one message: alias rewrite, the near-duplicate
// refusal, and a queued worker task's default tags. Stored records are never rewritten.
// ---------------------------------------------------------------------------
import {
	CANONICAL_TAG_ALIASES,
	canonicalizeTagList,
	governTags,
	resolveDefaultProjectTags,
	type TagAliasMap,
	type TagGovernanceHost,
	type WorkerTaskTags,
} from "./shared/task-tag-governance.js";
import type { TagCheckResult } from "./shared/task-tags.js";

export type { TagGovernanceHost, WorkerTaskTags };

/** The tag fields of RoleMessageSendInput. */
export interface RoleMessageTagInput {
	/** Optional tag slugs (1-16 items, lowercase letters, digits, dashes; at most 60 chars each). */
	tags?: unknown;
	/** true: a new tag near an existing one is meant (CONFIRM_NEW_TAG_DESCRIPTION). */
	confirmNewTag?: unknown;
}

type TaggedSender = { guard?: { task?: { queueId: string; taskId: number } } };

const aliasesOf = (host: TagGovernanceHost): TagAliasMap => host.tagGovernance?.().aliases ?? CANONICAL_TAG_ALIASES;

/** checkTags, then (when tags are given) alias rewrite and the near-duplicate refusal against the host's facts.
 *  A host without tagGovernance still rewrites the built-in aliases. */
export function governMessageTags(host: TagGovernanceHost, input: RoleMessageTagInput): TagCheckResult {
	const facts = Array.isArray(input.tags) && input.tags.length ? host.tagGovernance?.() : undefined;
	const r = governTags(input.tags, {
		knownCanonicalTags: facts?.knownCanonicalTags ?? new Set(),
		activeProjectIds: facts?.activeProjectIds ?? [],
		aliases: facts?.aliases ?? CANONICAL_TAG_ALIASES,
		confirmNewTag: input.confirmNewTag === true,
	});
	return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

/** A queued task's project and tags, as its own chat's sender binding remembers them (ownTaskOf). */
export function taskTagFacts(
	task: { parent?: { project?: string } | object; tags?: string[] } | undefined,
): WorkerTaskTags {
	const project = task?.parent && "project" in task.parent ? task.parent.project : undefined;
	return { ...(project ? { project } : {}), ...(task?.tags ? { tags: task.tags } : {}) };
}

/** A draft's tags: given ([] = none); omitted on a reply: its original's, canonicalized; omitted on a new message
 *  from a queued worker task: [task project, ...task tags], canonicalized; otherwise none. */
export function messageDraftTags(
	host: TagGovernanceHost,
	sender: TaggedSender,
	given: string[] | undefined,
	original: { tags?: string[] } | undefined,
	isReply: boolean,
): string[] | undefined {
	if (given !== undefined) return given.length ? [...given] : undefined;
	if (isReply) {
		const tags = original?.tags ? canonicalizeTagList(original.tags, aliasesOf(host)) : [];
		return tags.length ? tags : undefined;
	}
	const task = sender.guard?.task;
	const facts = task ? host.workerTaskTags?.(task) : undefined;
	return facts ? resolveDefaultProjectTags(facts.project, facts.tags, aliasesOf(host)) : undefined;
}
