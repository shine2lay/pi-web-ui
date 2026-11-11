/**
 * Brings Task 1's view-model acceptance files into the unit gate (frontend #258, Task 2).
 *
 * The page is built, so the suite that proves it no longer has a reason to sit outside
 * `tests/unit/**` — `tests/unit/openviking-dashboard-ui-contract.test.ts` requires exactly this
 * wrapper once the Task 1 stub is gone. These two files run in node; the rendered-page files need
 * jsdom and are wrapped separately in `openviking-dashboard-suite-dom.test.ts`.
 *
 * `npm run test:openviking-dashboard` still runs the whole suite on its own config.
 */

import "../openviking-dashboard/openviking-dashboard-seam.test.js";
import "../openviking-dashboard/openviking-dashboard-explorer-audit.test.js";
