/**
 * ui-check for the specialist chip (department-specialists, Ops #1101 §5.2): the real Queue panel and chat-header tag
 * from `specialist-chip-harness.tsx`, every state at 320/390/1440 in light and dark with @2x screenshots
 * (tests/lib/harness-ui-check.mjs).
 *
 *   node tests/specialist-chip-ui-check.mjs [out-dir] [states]
 *
 * Exit 0 when every state passes, 1 otherwise.
 */
import { runHarnessUiCheck } from "./lib/harness-ui-check.mjs";

const failed = await runHarnessUiCheck({
	entry: "tests/specialist-chip-harness.tsx",
	title: "Specialist chip",
	outDir: process.argv[2] ?? "/tmp/specialist-chip-ui-check",
	states: process.argv[3]?.split(",") ?? ["queue", "long", "plain"],
});
process.exit(failed === 0 ? 0 : 1);
