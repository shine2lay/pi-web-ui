import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeInboxLine, decodeInboxView, inboxClaimable, inboxNextDispatch } from '../../server/shared/inbox-wire.ts';

// External contract artifacts are deliberate: a missing or changed pin fails closed.
// No Python reference code runs in these production-codec assertions.
const root = '/home/shinelay/architecture-dept/';
const pins = JSON.parse(readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));
function pinned(path: string, sha: string): any {
	const bytes = readFileSync(root + path);
	assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, `contract pin: ${path}`);
	return JSON.parse(bytes.toString('utf8'));
}
const core = pinned(pins.core.path, pins.core.sha256);
const corpus = pinned(pins.codec.path, pins.codec.sha256);
const boundary = pinned(pins.boundary.path, pins.boundary.sha256);
const byId = new Map(core.cases.map((c: any) => [c.id, c]));
function resolve(c: any): any {
	const input = c.input;
	if (input?.$from) return { ...structuredClone(resolve(byId.get(input.$from))), ...input.$set };
	return structuredClone(input);
}
function merge(a: any, b: any): any {
	const out = structuredClone(a);
	for (const [key, value] of Object.entries(b)) {
		out[key] = value && typeof value === 'object' && !Array.isArray(value)
			&& out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
			? merge(out[key], value) : structuredClone(value);
	}
	return out;
}
function substitute(value: any): any {
	if (typeof value === 'string' && value.startsWith('$') && corpus.op_keys[value.slice(1)]) {
		return corpus.op_keys[value.slice(1)];
	}
	if (Array.isArray(value)) return value.map(substitute);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
	}
	return value;
}
function checkDecode(result: ReturnType<typeof decodeInboxView> | ReturnType<typeof decodeInboxLine>, expected: string, input: unknown): void {
	assert.equal(result.ok, expected === 'allow');
	if (!result.ok) assert.equal(result.code, 'E_RPI_SCHEMA');
	else assert.deepEqual(result.value, input, 'codec preserves the wire, never coerces or strips fields');
}
test('pinned corpus has every declared case, no duplicate ids', () => {
	const ids = [...corpus.views, ...corpus.lines].map(c => c.id);
	assert.equal(core.cases.length, 90);
	assert.equal(ids.length, pins.codec.count);
	assert.equal(new Set(ids).size, ids.length);
});
for (const c of corpus.views) {
	test(c.id + ' canonical view decoder', () => {
		const view = merge(resolve(byId.get('C-SCHEMA-1')), c.set ?? {});
		view.lifecycle = substitute(c.life);
		const before = structuredClone(view);
		const result = decodeInboxView(view);
		checkDecode(result, c.expect, view);
		assert.deepEqual(view, before, 'decoder cannot mutate its caller');
		if (result.ok && 'claimable' in c) assert.equal(inboxClaimable(result.value), c.claimable);
		if (result.ok && 'next' in c) assert.equal(inboxNextDispatch(result.value), c.next);
	});
}
for (const c of corpus.lines) {
	test(c.id + ' canonical ledger decoder', () => {
		const line = { ...corpus.line_base, ...substitute(c.fields) };
		const before = structuredClone(line);
		checkDecode(decodeInboxLine(line), c.expect, line);
		assert.deepEqual(line, before);
	});
}
for (const c of core.cases.filter((c: any) => c.kind === 'view')) {
	test(c.id + ' unchanged core wire', () => {
		const view = resolve(c);
		checkDecode(decodeInboxView(view), c.expect.result, view);
	});
}

function boundaryBase(vector: any): any {
	if (vector.target === 'line') {
		const row = corpus.lines.find((c: any) => c.id === vector.base);
		assert.ok(row, vector.base);
		return { ...corpus.line_base, ...substitute(row.fields) };
	}
	const row = corpus.views.find((c: any) => c.id === vector.base);
	assert.ok(row, vector.base);
	return { ...merge(resolve(byId.get('C-SCHEMA-1')), row.set ?? {}), lifecycle: substitute(row.life) };
}
function replacePath(input: any, path: string[], value: unknown): any {
	if (!path.length) return structuredClone(value);
	let parent = input;
	for (const key of path.slice(0, -1)) parent = parent[key];
	parent[path.at(-1)!] = structuredClone(value);
	return input;
}
function checkBoundary(vector: any, value: unknown, expected: string): void {
	const decoder = vector.target === 'line' ? decodeInboxLine : decodeInboxView;
	let decoded: ReturnType<typeof decoder>;
	assert.doesNotThrow(() => { decoded = decoder(value); });
	checkDecode(decoded!, expected, value);
	if (vector.target !== 'line') {
		assert.doesNotThrow(() => inboxClaimable(value as any));
		assert.doesNotThrow(() => inboxNextDispatch(value as any));
		if (expected === 'refuse') {
			assert.equal(inboxClaimable(value as any), false, 'invalid view never claimable');
			assert.equal(inboxNextDispatch(value as any), null, 'invalid view never dispatched');
		} else {
			if ('claimable' in vector) assert.equal(inboxClaimable(value as any), vector.claimable);
			if ('next' in vector) assert.equal(inboxNextDispatch(value as any), vector.next);
		}
	}
}
test('#607 expanded coverage is 232 vectors and 47 valid twins', () => {
	assert.equal(boundary.cases.reduce((n: number, c: any) => n + c.values.length, 0), pins.boundary.count);
	assert.equal(boundary.cases.filter((c: any) => c.twin !== false).length, pins.boundary.twins);
});
for (const vector of boundary.cases) {
	if (vector.twin !== false) {
		test(`${vector.id}/valid-twin`, () => checkBoundary({ target: vector.target }, boundaryBase(vector), 'allow'));
	}
	for (const [index, value] of vector.values.entries()) {
		test(`${vector.id}/${index} strict boundary`, () => {
			let base = merge(boundaryBase(vector), vector.set ?? {});
			// check_effect is reference-only. Exercise the canonical production view
			// decoder by replacing its effect, rather than creating a second decoder.
			if (vector.target === 'effect') {
				base.lifecycle.effect = replacePath(base.lifecycle.effect, vector.path, value);
			} else base = replacePath(base, vector.path, value);
			checkBoundary(vector, base, vector.expect);
		});
	}
}
