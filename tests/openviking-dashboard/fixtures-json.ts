/**
 * Prints the dashboard's DOM-test fixtures as JSON, so a browser E2E can serve the same answers the
 * jsdom suite asserts on instead of keeping a second hand-written copy (one fixture source).
 *
 * Run: node_modules/.bin/tsx tests/openviking-dashboard/fixtures-json.ts
 */
import { auditResponse, entriesResponse, liveOverview } from "./openviking-dashboard-fixtures.js";

process.stdout.write(JSON.stringify({ overview: liveOverview(), entries: entriesResponse(), audit: auditResponse() }));
