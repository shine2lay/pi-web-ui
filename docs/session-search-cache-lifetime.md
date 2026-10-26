# Full-text session-search cache lifetime

Ops #576, pi-durable-cutover review repair; accountable lead: Ops. No deployment or engine switch.

## Hypothesis, written before implementation

**H-SESSION-TTL-RELEASE-1.** `ClientSession.sessionInfosCache` owns an array of SDK `SessionInfo` objects, including complete `allMessagesText`. The baseline `7ec462dc4ef32ca83afee8b3a04ea93b7ac12929` checks the existing `SESSION_INFO_CACHE_TTL = 3000` only when `loadSessionInfosWithText()` runs again. After a search, a quiet, still-connected client therefore retains the full-text array indefinitely. Neither `dispose()` branch clears it. This is reference retention, not a measured process-memory claim.

One change: give this existing cache an unref'ed expiry timer and a generation fence for asynchronous refreshes. Invalidation, replacement and disposal release the cache and cancel its timer. A stale timer cannot clear a replacement; a late, invalidated, superseded or disposed load still returns its original complete result to its caller but cannot put it back in the cache. Do not change the separate file-cache LRU or truncate search data.

Expected: a matching scope returns the identical cached array until the request's original three-second deadline. At that deadline, without another request, the client no longer references the full-text array through this cache. A load taking one second has only two seconds of cache lifetime left; a load taking at least three seconds is returned without being cached. Hits do not extend the deadline. Of overlapping misses, only the most recently started request may publish a cache; each caller still receives its own result.

Disproof: the old implementation already releases the array without a later call; the fixed one retains an expired array, loses a replacement to an old callback, repopulates after invalidation/disposal, extends hit lifetime, changes scope selection or changes search results. Pending validation is not a HIT.

## Independently specified synthetic checks

`tests/unit/session-search-cache-lifetime.test.ts` specifies these observations before the production edit. It calls the actual `ClientSession` prototype on synthetic clients, mocks SDK list operations with synthetic summaries, uses a fake clock, and uses an owned empty directory for the existing search-anchor fallback. It never constructs a real session, starts a runtime/server, reads a real transcript or sends a model request.

- At 2999 ms, the matching scope hits the same array with one SDK listing; at 3000 ms, with no later request, the cache and timer fields are null and no timer remains. The timer has no event-loop reference.
- Delayed completion consumes the original deadline; completion at or beyond it is not retained.
- Invalidation releases the array/timer and still invalidates the shared metadata index. A captured, cancelled timer callback invoked manually cannot remove a replacement.
- Global scope keeps its `"*"` key across cwd changes. Project scope and global/project transitions preserve the correct SDK listing and cache-hit behavior. A delayed load from a now-different scope is not retained.
- Both orders of overlapping completion keep only the newest request's cache. A late old-project read cannot replace a newer project's cache. Invalidation during a read prevents repopulation; subsequent fresh reads work.
- Both `dispose()` paths (another client remains / last client) release immediately, leave another client's cache alone and prevent both pending and subsequent loads from caching. Per-client disposal does not invalidate the shared metadata index.
- A failed refresh drops the obsolete cache/timer and permits retry.
- Case-insensitive full-text matching well beyond the preview, metadata matching, complete long previews, descending modified-time order, request IDs, query echo and the existing 50-result projection remain unchanged before and after expiry. The source summaries are not mutated.

The existing global-history fixture inherits the production prototype so the lifecycle helper methods are available without invoking a real constructor. Its existing history/search assertions stay unchanged.

## Exact guarantee and limits

The cache releases its own array reference at the first event-loop opportunity for its existing three-second deadline, or synchronously on invalidation, replacement or disposal. Timer cancellation clears its stored callback; the independently created callback captures only its owner and timer identity, never the full-text array or cache entry. Disposal fences pending reads before either teardown branch. This is not hard real-time behavior while JavaScript is blocked or the process is suspended.

An in-progress SDK read and an awaiting caller can still own their results. Returned search rows can retain their existing full `firstMessage` strings, as can the ordinary metadata/history rows and SDK/session-index or other caches. Active conversation runtimes, parsed transcripts elsewhere and the separate file-cache LRU are outside this patch. No forced collection, heap/RSS claim, live memory probe, content cap or new retention policy is introduced.

## Validation and undo

Validation: in progress. The first sealed run passed typecheck, formatting and all 16 adjacent tests, but all 26 new cases stopped at fixture setup: `Object.assign` cannot shadow `ClientSession`'s getter-only `convs`. Its simultaneous old-code control is therefore invalid, not evidence of the retention defect.

**H-SESSION-TTL-FIXTURE-1**, before fixture repair: create the prototype-based fake with explicit own-property descriptors instead of assignment, so its inert conversation map shadows the getter without touching the shared map or invoking a constructor. Expect all cases to reach the cache behavior, with fixed-code passes and old-code failures for actual lifetime defects. Wrong if setup errors remain or shared state is exercised. Production policy is unchanged. Result: HIT — the corrected sealed run passes 26/26 dedicated cases and 16/16 adjacent cases; baseline reaches the real assertions with 19 failures and seven unchanged-behavior passes.

**H-SESSION-DISPOSAL-CONTROL-1**, before control refinement: the populated-cache disposal cases initially ask for an expiry callback before disposing, so baseline stops on its missing timer rather than demonstrating disposal retention directly. Remove that redundant precondition (stale callbacks are independently covered). Expect baseline to fail on its retained cache immediately after actual disposal in both branches, while fixed code still passes. Wrong if either disposal branch does not execute or baseline already clears the cache. Result: HIT — both unchanged-baseline disposal cases now fail specifically on the retained non-null cache after teardown; fixed code passes both.

**H-SESSION-TTL-RELEASE-1: HIT on focused validation.** The final dedicated suite passes 26/26; the adjacent global-history and history-preview suites pass 16/16. The exact same dedicated suite, using a Vite loader to substitute the control worktree's unchanged `server/agent-service.ts` at the original module identity (all other dependencies and tests unchanged), fails 19/26 against baseline `7ec462dc4ef32ca83afee8b3a04ea93b7ac12929` and passes seven existing-behavior cases. Failures include idle expiry with no further read, delayed/expired completion, overlapping/scope-invalidated completion and both completed/pending disposal paths. The baseline control worktree's tracked source remains clean. These are structural array/cache observations, not RSS measurements.

The sealed build, all five typecheck targets, formatting and whitespace checks pass. Independent read-only review finds no P0–P2 issue; the final-client test's real eval-kernel cleanup is a no-op because this isolated suite never creates a kernel. The normal detached `wt land` gate must still check the final rebased tree. No installation or restart.

Undo: revert the single `session-search-cache-lifetime` patch commit. This changes only ephemeral server state; no data format, source transcript or migration is involved.
