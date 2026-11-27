// Reference-oracle integrity only; never a production reader, projector, or UI proof.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const nullableStrings = (v) => v === null || stringList(v);
const fields = {
	fraction: (v) => v === null || /^\d+ of \d+ met$/.test(v),
	names: nullableStrings,
	marks: (v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === "boolean")),
	activity: (v) => typeof v === "string",
	lifecycle: (v) => ["active", "done", "dropped", "unknown"].includes(v),
	notice: (v) => typeof v === "string" && v.length > 0,
	snapshot: (v) => ["live", "unknown", "partial", "loading", "last-known"].includes(v),
	canDeclareEmpty: (v) => typeof v === "boolean",
	warning: (v) => typeof v === "boolean",
	next: (v) => ["unknown", "not-recorded"].includes(v),
	preserve: stringList,
	freshPair: (v) => typeof v === "boolean",
	nowRefs: stringList,
	queuedRefs: stringList,
	milestoneTaskLinks: (v) => v === null,
	blockerOwner: (v) => v === null,
	unblockText: (v) => typeof v === "string",
	orderScope: (v) => v === "role-local",
	changedScope: (v) => v === "project-card-body",
	chrome: (v) => Array.isArray(v) && v.length === 0,
	fullText: (v) => v === true,
	nestedButtons: (v) => v === false,
	stripAccessible: (v) => v === false,
	states: (v) => Array.isArray(v) && v.every((x) => [null, "done", "waiting", "needs-you", "blocked", "working", "queued"].includes(x)),
	inferredLinks: (v) => Array.isArray(v) && v.length === 0,
};

function keys(value, required) {
	assert(object(value), "expected object");
	assert.deepEqual(Object.keys(value).sort(), [...required].sort(), "unexpected or missing keys");
}
function load(name) {
	const value = JSON.parse(readFileSync(resolve(here, name), "utf8"));
	keys(value, ["version", "builders", "cases"]);
	assert.equal(value.version, 1);
	assert.deepEqual(value.builders, ["frontend", "ops"]);
	assert(Array.isArray(value.cases) && value.cases.length > 0);
	return value.cases;
}
function identified(c, ids) {
	assert(/^RPP-\d+-[a-z]+(?:-[a-z]+)*$/.test(c.id), "bad case id");
	assert(!ids.has(c.id), `duplicate ${c.id}`);
	ids.add(c.id);
}
// Builders can import this assertion against a normalized observed view. It compares only
// the literal case oracle's selected fields; no state replay or business math lives here.
export function assertView(expected, observed) {
	assert(object(observed), "view missing");
	for (const [key, value] of Object.entries(expected)) assert.deepEqual(observed[key], value, key);
}

export function checkCases() {
	const good = load("good.cases.json");
	const bad = load("bad.cases.json");
	const ids = new Set();
	const byId = new Map();
	for (const c of good) {
		keys(c, ["id", "source", "input", "expected"]);
		identified(c, ids);
		assert(object(c.input) && Object.keys(c.input).length > 0);
		assert(object(c.expected) && Object.keys(c.expected).length > 0);
		assert(typeof c.source === "string");
		const parts = c.source.split("#");
		assert.equal(parts.length, 2);
		assert(/^(server|web)\/[a-zA-Z0-9/._-]+$/.test(parts[0]));
		assert(parts[1].length > 0 && existsSync(resolve(root, parts[0])));
		assert(readFileSync(resolve(root, parts[0]), "utf8").includes(parts[1]), `source symbol ${c.source}`);
		for (const [key, value] of Object.entries(c.expected)) {
			assert(Object.hasOwn(fields, key), `unknown assertion ${key}`);
			assert(fields[key](value), `invalid assertion ${c.id}.${key}`);
		}
		assertView(c.expected, c.expected);
		byId.set(c.id, c);
	}
	const twinned = new Set();
	for (const c of bad) {
		keys(c, ["id", "twin", "reject", "reason"]);
		identified(c, ids);
		assert(typeof c.twin === "string" && byId.has(c.twin), `missing twin ${c.id}`);
		assert(typeof c.reason === "string" && c.reason.trim().length > 0);
		assert(object(c.reject) && Object.keys(c.reject).length > 0);
		const expected = byId.get(c.twin).expected;
		for (const key of Object.keys(c.reject)) assert(Object.hasOwn(expected, key), `unknown mutation ${c.id}.${key}`);
		assert.notDeepEqual(c.reject, Object.fromEntries(Object.keys(c.reject).map((k) => [k, expected[k]])), `inert mutation ${c.id}`);
		assert.throws(() => assertView(expected, { ...expected, ...c.reject }), assert.AssertionError, `bad candidate accepted ${c.id}`);
		twinned.add(c.twin);
	}
	assert.deepEqual([...twinned].sort(), [...byId.keys()].sort(), "every good case needs a rejected twin");
	return { good: good.length, bad: bad.length, sources: new Set(good.map((c) => c.source)).size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const counts = checkCases();
	console.log(`reference cases: ${counts.good} allowed, ${counts.bad} rejected, ${counts.sources} source bindings; runtime NOT PROVEN`);
}
