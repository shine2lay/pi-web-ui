/**
 * ui-check for ask_user_question's dialog and its keep-for-later bar (Ops #1087): bundles the browser-only harness
 * (`question-later-harness.tsx`, the real ChatOwnerQuestion), serves it on a random local port and runs ui-check on
 * every state at 320/390/1440 in light and dark (tests/lib/harness-ui-check.mjs).
 *
 *   node tests/question-later-ui-check.mjs [out-dir] [states]
 *
 * Exit 0 when every state passes, 1 otherwise.
 */
import { runHarnessUiCheck } from "./lib/harness-ui-check.mjs";

const failed = await runHarnessUiCheck({
	entry: "tests/question-later-harness.tsx",
	title: "Question",
	outDir: process.argv[2] ?? "/tmp/question-later-ui-check",
	states: process.argv[3]?.split(",") ?? ["dialog", "bar", "bar-many", "reopened"],
});
process.exit(failed === 0 ? 0 : 1);
