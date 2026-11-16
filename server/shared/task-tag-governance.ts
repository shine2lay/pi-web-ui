// ---------------------------------------------------------------------------
// Tag governance: one canonical tag per effort for queue_add and message_role (ops #963 seam, built by ops #964).
// Owner 2026-11-15, Design home chat (via rm-ae23a75e): "also i see the tags being used freely, like i saw 2 for
// open viking work". Canonical copy: pi-queue tag-governance.ts. pi-web-ui server/shared/task-tag-governance.ts is
// the same bytes except the one import line; both repos' test:tag-governance-acceptance compare them.
// ---------------------------------------------------------------------------
import { checkTags, MAX_TAGS_PER_ITEM } from "./task-tags.js";

/** Historical duplicate slug -> the canonical slug of the same effort. No target is itself a key (no chains). */
export type TagAliasMap = Readonly<Record<string, string>>;

/**
 * Seed audited 2026-11-16 (read only) against ~/.pi-web-ui/role-messages.json (50 slugs), queue tasks in
 * ~/.pi/agent/sessions (95 slugs) and the work registry's project and initiative ids. A slug folds only when its
 * own messages or tasks show the same effort; distinct efforts stay apart (openviking-v2 vs openviking-dashboard,
 * qa-setup vs testing-standards, wt-check vs deliverable-checks, claim-check vs marketing-claim-check-test).
 */
export const CANONICAL_TAG_ALIASES: TagAliasMap = Object.freeze({
	// OpenViking v2 memory rebuild: its fix, audit, contract, smoke, model-bench (/tmp/ov-v2-model-bench),
	// eviction (R-EVICT-SCALE-1), telemetry and notebook tidy-up restore threads, all co-tagged with it.
	openviking: "openviking-v2",
	"openviking-fixes": "openviking-v2",
	"openviking-audit": "openviking-v2",
	"openviking-contract": "openviking-v2",
	"openviking-evict": "openviking-v2",
	"openviking-telemetry": "openviking-v2",
	"ov-smoke": "openviking-v2",
	"model-bench": "openviking-v2",
	"memory-tidy-up": "openviking-v2",
	// The OpenViking Memory Dashboard project (its explorer view and QA re-runs).
	"memory-explorer": "openviking-dashboard",
	// Product's discovery projects and their demand tests / collectors.
	"automation-watcher": "ai-workflow-builder",
	"market-research-toolkit": "market-research-studio",
	"scorecard-studio": "market-research-studio",
	"claim-check": "checked-research",
	"research-method": "checked-research",
	// Marketing's posting app: Roamee on Pinterest, counted through Roamee's source tracking.
	"roamee-marketing": "posting-app",
	"roamee-tracking": "posting-app",
	// Inkflow is the tattoo booking assistant's app.
	inkflow: "tattoo-assistant",
	"pi-upgrade": "pi-upgrade-1-5",
	// bp-11f1b4b5 frontier model research replies.
	"model-research": "frontier-model-research",
	retro: "design-retro",
	backups: "backup",
});

/** Optional extension file in the work registry folder (~/.pi/agent/work), read only, never written by the tools:
 *  `{ "aliases": { "<old-slug>": "<canonical-slug>" } }`. Malformed content fails loud (mergeTagAliases). */
export const TAG_ALIASES_FILE = "tag-aliases.json";

/** Near-match rules for a brand-new tag against the known canonical tags. */
export const NEAR_TAG_RULES = Object.freeze({
	/** Dropped before comparing tokens (the slug is split on "-"). */
	stopTokens: Object.freeze("a an and the of for to in on with new old fix fixes v1 v2 v3".split(" ")),
	/** "stem": the first remaining tokens are equal and at least this long. */
	minStemLength: 4,
	/** "tokens": |A ∩ B| / |A ∪ B| of the remaining token sets reaches this. */
	minTokenJaccard: 0.5,
	/** "spelling": Levenshtein distance of the whole slugs at most this, when both are at least minSpellingLength. */
	maxEditDistance: 2,
	minSpellingLength: 5,
});

/** queue_add and message_role parameter `confirmNewTag` (boolean, optional): the same words in both tools. */
export const CONFIRM_NEW_TAG_DESCRIPTION =
	"Optional: true only when a tag you give is genuinely new work that looks like an existing tag (the call was refused naming it). Otherwise reuse the existing tag and leave this out.";

export type NearTagReason = "stem" | "tokens" | "spelling";
export type NearTag = { tag: string; reason: NearTagReason };

/** What a caller knows when it checks tags: computed per call from live sources, never cached across writes. */
export type TagGovernanceContext = {
	/** buildKnownCanonicalTags of the registry ids, alias targets and tags already in use. */
	knownCanonicalTags: ReadonlySet<string>;
	/** Open work-registry project ids, named in a near-match refusal. */
	activeProjectIds: readonly string[];
	/** mergeTagAliases(CANONICAL_TAG_ALIASES, <TAG_ALIASES_FILE content>). */
	aliases: TagAliasMap;
};

export type GovernTagsOptions = Partial<Pick<TagGovernanceContext, "activeProjectIds" | "aliases">> &
	Pick<TagGovernanceContext, "knownCanonicalTags"> & { confirmNewTag?: boolean; maxTags?: number };

/** ok: value as checkTags gives it (undefined = omitted, [] = cleared), after alias rewrite; rewritten lists each
 *  alias it applied. Refused: error names the submitted tag, every near match, the active project ids and
 *  `confirmNewTag: true`; checkTags's own errors come through unchanged. */
export type GovernTagsResult =
	| { ok: true; value: string[] | undefined; rewritten: ReadonlyArray<{ from: string; to: string }> }
	| { ok: false; error: string; tag?: string; nearMatches?: readonly string[] };

/** The project and tags of a queued worker task (message_role's default tags when a non-reply omits tags). */
export type WorkerTaskTags = { project?: string; tags?: readonly string[] };

/** pi-web-ui RoleMessageHost gains these (ops #964); pi-queue reads the same facts from its own registry. */
export type TagGovernanceHost = {
	tagGovernance?(): TagGovernanceContext;
	workerTaskTags?(task: { queueId: string; taskId: number }): WorkerTaskTags | undefined;
};

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Seed plus the extension file's parsed JSON (undefined = no file). Refuses loudly: non-object, invalid slugs, a
 *  target that is an alias key, a key that is a target. The result is frozen. */
export function mergeTagAliases(seed: TagAliasMap, extra: unknown): TagAliasMap {
	if (extra === undefined) return seed;
	const where = TAG_ALIASES_FILE;
	if (!isRecord(extra) || !isRecord(extra.aliases)) {
		throw new Error(`${where}: expected { "aliases": { "<old-slug>": "<canonical-slug>" } }`);
	}
	const merged: Record<string, string> = { ...seed };
	for (const [from, to] of Object.entries(extra.aliases)) {
		const check = checkTags([from, to]);
		if (typeof to !== "string" || !check.ok || check.value?.[0] !== from || check.value?.[1] !== to) {
			throw new Error(`${where}: alias "${from}" -> ${JSON.stringify(to)} is not a pair of different tag slugs`);
		}
		merged[from] = to;
	}
	for (const [from, to] of Object.entries(merged)) {
		if (to in merged) throw new Error(`${where}: alias "${from}" points at "${to}", which is itself an alias`);
	}
	return Object.freeze(merged);
}

/** Registry project and initiative ids, every alias target, and observed tags that are not alias keys. */
export function buildKnownCanonicalTags(sources: {
	registryIds: Iterable<string>;
	observedTags: Iterable<string>;
	aliases?: TagAliasMap;
}): Set<string> {
	const aliases = sources.aliases ?? CANONICAL_TAG_ALIASES;
	const out = new Set<string>(sources.registryIds);
	for (const to of Object.values(aliases)) out.add(to);
	for (const tag of sources.observedTags) if (!(tag in aliases)) out.add(tag);
	return out;
}

/** Each tag through the aliases (default CANONICAL_TAG_ALIASES), deduplicated, first-seen order kept. */
export function canonicalizeTagList(tags: readonly string[], aliases: TagAliasMap = CANONICAL_TAG_ALIASES): string[] {
	return [...new Set(tags.map((tag) => (Object.hasOwn(aliases, tag) ? aliases[tag] : tag)))];
}

const tokensOf = (tag: string): string[] => tag.split("-").filter((t) => t && !NEAR_TAG_RULES.stopTokens.includes(t));

function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length];
}

function nearReason(tag: string, other: string): NearTagReason | undefined {
	const a = tokensOf(tag);
	const b = tokensOf(other);
	if (a.length && b.length && a[0] === b[0] && a[0].length >= NEAR_TAG_RULES.minStemLength) return "stem";
	const setA = new Set(a);
	const setB = new Set(b);
	const shared = [...setA].filter((t) => setB.has(t)).length;
	const union = new Set([...setA, ...setB]).size;
	if (union && shared / union >= NEAR_TAG_RULES.minTokenJaccard) return "tokens";
	const long = Math.min(tag.length, other.length) >= NEAR_TAG_RULES.minSpellingLength;
	if (long && editDistance(tag, other) <= NEAR_TAG_RULES.maxEditDistance) return "spelling";
	return undefined;
}

/** Known canonical tags near a tag not in the set (NEAR_TAG_RULES; reason = the first rule that matches, in the order
 *  stem, tokens, spelling), sorted by tag; [] for a known tag. */
export function findNearCanonicalTags(tag: string, knownCanonicalTags: ReadonlySet<string>): NearTag[] {
	if (knownCanonicalTags.has(tag)) return [];
	const out: NearTag[] = [];
	for (const other of knownCanonicalTags) {
		const reason = nearReason(tag, other);
		if (reason) out.push({ tag: other, reason });
	}
	return out.sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));
}

/** checkTags, then alias rewrite, then near-match refusal for tags outside knownCanonicalTags unless confirmNewTag. */
export function governTags(raw: unknown, options: GovernTagsOptions): GovernTagsResult {
	const checked = checkTags(raw, options.maxTags);
	if (!checked.ok || checked.value === undefined) return checked.ok ? { ...checked, rewritten: [] } : checked;
	const aliases = options.aliases ?? CANONICAL_TAG_ALIASES;
	const rewritten: Array<{ from: string; to: string }> = [];
	for (const tag of checked.value) if (Object.hasOwn(aliases, tag)) rewritten.push({ from: tag, to: aliases[tag] });
	const value = canonicalizeTagList(checked.value, aliases);
	const targets = new Set(Object.values(aliases));
	for (const tag of options.confirmNewTag ? [] : value) {
		if (targets.has(tag)) continue;
		const near = findNearCanonicalTags(tag, options.knownCanonicalTags).map((n) => n.tag);
		if (!near.length) continue;
		const projects = options.activeProjectIds?.length ? options.activeProjectIds.join(", ") : "(none)";
		const error =
			`tag "${tag}" is new but looks like existing tag(s) ${near.map((n) => `"${n}"`).join(", ")}. ` +
			`Reuse the existing tag for the same effort (active project ids: ${projects}); only if "${tag}" is genuinely ` +
			`new work, call again with confirmNewTag: true.`;
		return { ok: false, error, tag, nearMatches: near };
	}
	return { ok: true, value, rewritten };
}

/** A new task or message that omitted tags: [project, ...inherited], canonicalized, deduplicated, project first, at
 *  most maxTags; undefined when both are empty. */
export function resolveDefaultProjectTags(
	project: string | undefined,
	inherited: readonly string[] | undefined,
	aliases: TagAliasMap = CANONICAL_TAG_ALIASES,
	maxTags: number = MAX_TAGS_PER_ITEM,
): string[] | undefined {
	const tags = canonicalizeTagList([...(project ? [project] : []), ...(inherited ?? [])], aliases);
	return tags.length ? tags.slice(0, maxTags) : undefined;
}
