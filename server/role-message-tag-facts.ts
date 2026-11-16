// ---------------------------------------------------------------------------
// The live facts message_role's tag guard checks against (ops #964): the work registry's ids and open projects,
// the aliases (built-in seed plus the registry folder's optional tag-aliases.json, read only), the tags already in
// use (role messages, the Roles overview's tag groups), and each queued worker task's project and tags, as its own
// chat's sender binding last read them. Files are read again only when they changed; nothing is written.
// ---------------------------------------------------------------------------
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { piQueueReaders } from "./pi-queue-readers.js";
import {
	buildKnownCanonicalTags,
	CANONICAL_TAG_ALIASES,
	mergeTagAliases,
	TAG_ALIASES_FILE,
	type TagAliasMap,
	type TagGovernanceContext,
	type TagGovernanceHost,
	type WorkerTaskTags,
} from "./shared/task-tag-governance.js";
import { WORK_LOG_MAX, workFolder, workRecordsFromState } from "./work-records.js";

/** Remembered worker tasks at most (the oldest is forgotten first). */
export const WORKER_TASKS_MAX = 500;

const stampOf = (file: string): string | undefined => {
	try {
		const st = statSync(file);
		return st.isFile() ? `${st.size}:${st.mtimeMs}` : undefined;
	} catch {
		return undefined;
	}
};

let aliasesSeen: { file: string; stamp: string | undefined; aliases: TagAliasMap } | null = null;

/** The seed plus `<dir>/tag-aliases.json` when it exists. A malformed file throws, naming it (fail loud). */
export function readTagAliases(dir: string = workFolder()): TagAliasMap {
	const file = join(dir, TAG_ALIASES_FILE);
	const stamp = stampOf(file);
	if (aliasesSeen && aliasesSeen.file === file && aliasesSeen.stamp === stamp) return aliasesSeen.aliases;
	let aliases = CANONICAL_TAG_ALIASES;
	if (stamp !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (err) {
			throw new Error(`${file}: ${(err as Error).message}`);
		}
		aliases = mergeTagAliases(CANONICAL_TAG_ALIASES, parsed);
	}
	aliasesSeen = { file, stamp, aliases };
	return aliases;
}

type RegistryIds = { ids: string[]; active: string[] };
let registrySeen: { file: string; stamp: string; ids: RegistryIds } | null = null;

/** Project and initiative ids, and the open project ids (sorted). Empty when the registry can't be read here
 *  (no log yet, pi-queue not loaded, a log it refuses): tags are then checked against the rest. */
export function registryTagIds(dir: string = workFolder()): RegistryIds {
	const file = join(dir, "events.jsonl");
	const stamp = stampOf(file);
	const none = { ids: [], active: [] };
	if (stamp === undefined || Number(stamp.split(":")[0]) > WORK_LOG_MAX) return none;
	if (registrySeen && registrySeen.file === file && registrySeen.stamp === stamp) return registrySeen.ids;
	const readers = piQueueReaders();
	if (!readers) return none;
	let records;
	try {
		records = workRecordsFromState(readers.readWork(dir));
	} catch {
		return none;
	}
	if (!records) return none;
	const ids = [...records.projects, ...records.initiatives].map((r) => r.id);
	const active = records.projects
		.filter((p) => p.status === "active")
		.map((p) => p.id)
		.sort();
	registrySeen = { file, stamp, ids: { ids, active } };
	return registrySeen.ids;
}

/** Where the tags already in use come from. */
export type ObservedTagSources = {
	messages?: ReadonlyArray<{ tags?: readonly string[] }>;
	overview?: { tagGroups?: ReadonlyArray<{ key: string; kind: string }> };
};

/** Every tag in use: on role messages, and the Roles overview's tag groups (its tasks' tags). */
export function observedTagsOf(sources: ObservedTagSources): string[] {
	const tags = (sources.messages ?? []).flatMap((m) => m.tags ?? []);
	for (const g of sources.overview?.tagGroups ?? []) if (g.kind === "tag") tags.push(g.key);
	return tags;
}

const workerTasks = new Map<string, WorkerTaskTags>();
const taskKey = (queueId: string, taskId: number) => `${queueId}#${taskId}`;

/** The sender binding read a queued task's own chat: remember its project and tags (returned as given). */
export function rememberWorkerTask<T extends ({ id?: number; queueChat?: string } & WorkerTaskTags) | undefined>(
	own: T,
): T {
	if (own?.id === undefined) return own;
	const key = taskKey(own.queueChat ?? "", own.id);
	workerTasks.delete(key);
	workerTasks.set(key, { ...(own.project ? { project: own.project } : {}), ...(own.tags ? { tags: own.tags } : {}) });
	if (workerTasks.size > WORKER_TASKS_MAX) workerTasks.delete(workerTasks.keys().next().value as string);
	return own;
}

/** RoleMessageHost's tag facts, read when a message is checked. */
export function roleMessageTagFacts(observed: () => ObservedTagSources, dir?: string): Required<TagGovernanceHost> {
	return {
		tagGovernance: (): TagGovernanceContext => {
			const aliases = readTagAliases(dir);
			const registry = registryTagIds(dir);
			const observedTags = observedTagsOf(observed());
			const knownCanonicalTags = buildKnownCanonicalTags({ registryIds: registry.ids, observedTags, aliases });
			return { knownCanonicalTags, activeProjectIds: registry.active, aliases };
		},
		workerTaskTags: (task) => workerTasks.get(taskKey(task.queueId, task.taskId)),
	};
}
