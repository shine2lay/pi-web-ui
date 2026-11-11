/**
 * @vitest-environment jsdom
 *
 * Brings Task 1's rendered-page acceptance files into the unit gate (frontend #258, Task 2).
 *
 * The page and drawer files mount React into a real DOM, so this wrapper asks for jsdom; the
 * view-model files run in node and are wrapped in `openviking-dashboard-suite-node.test.ts`.
 */

import "../openviking-dashboard/openviking-dashboard-page.test.js";
import "../openviking-dashboard/openviking-dashboard-drawer.test.js";
