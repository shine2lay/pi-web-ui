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

const NOT_BUILT = "tag governance is not built yet (ops #964)";

/** Seed plus the extension file's parsed JSON (undefined = no file). Refuses loudly: non-object, invalid slugs, a
 *  target that is an alias key, a key that is a target. The result is frozen. */
export function mergeTagAliases(seed: TagAliasMap, extra: unknown): TagAliasMap {
	void seed;
	void extra;
	throw new Error(NOT_BUILT);
}

/** Registry project and initiative ids, every alias target, and observed tags that are not alias keys. */
export function buildKnownCanonicalTags(sources: {
	registryIds: Iterable<string>;
	observedTags: Iterable<string>;
	aliases?: TagAliasMap;
}): Set<string> {
	void sources;
	throw new Error(NOT_BUILT);
}

/** Each tag through the aliases (default CANONICAL_TAG_ALIASES), deduplicated, first-seen order kept. */
export function canonicalizeTagList(tags: readonly string[], aliases: TagAliasMap = CANONICAL_TAG_ALIASES): string[] {
	void tags;
	void aliases;
	throw new Error(NOT_BUILT);
}

/** Known canonical tags near a tag not in the set (NEAR_TAG_RULES; reason = the first rule that matches, in the order
 *  stem, tokens, spelling), sorted by tag; [] for a known tag. */
export function findNearCanonicalTags(tag: string, knownCanonicalTags: ReadonlySet<string>): NearTag[] {
	void tag;
	void knownCanonicalTags;
	throw new Error(NOT_BUILT);
}

/** checkTags, then alias rewrite, then near-match refusal for tags outside knownCanonicalTags unless confirmNewTag. */
export function governTags(raw: unknown, options: GovernTagsOptions): GovernTagsResult {
	void checkTags;
	void raw;
	void options;
	throw new Error(NOT_BUILT);
}

/** A new task or message that omitted tags: [project, ...inherited], canonicalized, deduplicated, project first, at
 *  most maxTags; undefined when both are empty. */
export function resolveDefaultProjectTags(
	project: string | undefined,
	inherited: readonly string[] | undefined,
	aliases: TagAliasMap = CANONICAL_TAG_ALIASES,
	maxTags: number = MAX_TAGS_PER_ITEM,
): string[] | undefined {
	void project;
	void inherited;
	void aliases;
	void maxTags;
	throw new Error(NOT_BUILT);
}
