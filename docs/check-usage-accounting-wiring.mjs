#!/usr/bin/env node
// Documentation-only checker. Queue rules copied from pi-queue/queue.ts
// checkPlan/PARTS at 2026-10-20; do not import the running queue or app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const minima = { title: 5, goal: 20, done_when: 20, decided: 15, steps: 30, verify: 15, must_not: 10 };
const placeholder = /^(n\/?a|none|nothing|no|nope|same|same as above|see above|as above|tbd|tbc|later|etc\.?|-+|—+|\.+|…|\?+|x)$/i;
const unsettled = /\b(tbd|tbc|to be (decided|determined|confirmed|discussed)|decide later|figure (it |this |that )?out later|not sure yet|not decided yet|undecided|open question)\b/i;
const roles = new Set(['ops', 'temper', 'security', 'data']);
const localId = /^[A-Z][0-9]+[a-z]?$/;
const project = 'automatic-cost-accounting';
const s0Plans = ['T0', 'T1', 'W7', 'D0b', 'C0'];
// rm-a6acd2fd: #125 capture/drain behavior is not a frozen route schema.
// Enforce S0 wording, not extra producer field names beyond reviewed v2.1.
const queuedAs = { W0: 311, W1: 312, W2: 313, W3: 314, W4: 320, W5: 315, W6: 321, W7: 316, R0: 322 };
const unknownCoverage = /\bTemper coverage is always UNKNOWN in v1\b/i;
const s0Bans = [
  ['completeness', /\bcomplete(?:_|\s+|-)through\b/i, 'complete_through'],
  ['completeness', /\bcomplete(?:_|\s+|-)through\b/i, 'complete through'],
  // seq-regression is a closed v2.1 409 code, not an exposed sequence cursor.
  ['sequence cursor', /\bseq\b(?!-regression\b)/i, 'seq'],
  ['sequence cursor', /\bafter\s*=/i, 'after='],
  ['sequence cursor', /\bthrough_seq\b/i, 'through_seq'],
  ['sequence cursor', /\bmax_seq\b/i, 'max_seq'],
  ['general named key', /\bTEMPER_USAGE_FEED_KEYS\b/i, 'TEMPER_USAGE_FEED_KEYS'],
];

function planStrings(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'must_not' ? [] : planStrings(child, path ? `${path}.${key}` : key));
}

// Only explicit refusal clauses (including negative lists) are exempt. Split
// contrast/positive-action clauses so 'No X; accept Y' cannot hide acceptance.
// This is a wording check, not a claim to understand arbitrary English.
function acceptanceClauses(value) {
  return value.replace(/[`"“”]/g, '').split(
    /[;!?\n]+|\.(?=\s|$)|\b(?:but|however|then|while|yet)\b|,\s*(?=(?:use|accept|support|require|rely|allow|show|display|treat|enable|set)\b)|\b(?:and|or)\s+(?=(?:no|never|do not|must not|use|accept|support|require|rely|allow|show|display|treat|enable|set)\b)/i,
  ).map((clause) => clause.trim()).filter((clause) =>
    clause && !/^(?:\d+\s*)?(?:no|never|do not|must not)\b/i.test(clause));
}

function checkS0(plans) {
  const errors = [];
  for (const id of s0Plans) {
    const plan = plans.find((item) => item?.id === id);
    if (!plan) { errors.push(`${id}: missing S0-scoped plan`); continue; }
    const fields = planStrings(plan).map(([path, value]) => [path, acceptanceClauses(value)]);
    if (!fields.some(([, clauses]) => clauses.some((clause) => unknownCoverage.test(clause)))) {
      errors.push(`${id}: S0 requires explicit 'Temper coverage is always UNKNOWN in v1' acceptance wording`);
    }
    for (const [path, clauses] of fields) {
      for (const [name, pattern] of s0Bans) {
        if (clauses.some((clause) => pattern.test(clause))) {
          const error = `${id}.${path}: S0 forbids ${name} acceptance`;
          if (!errors.includes(error)) errors.push(error);
        }
      }
    }
  }
  return errors;
}

function plansFrom(text) {
  const blocks = [...text.matchAll(/^```usage-task\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  assert.equal(blocks.length, (text.match(/^```usage-task[ \t]*$/gm) ?? []).length, 'Unclosed task block');
  assert.ok(blocks.length > 0, 'No task blocks');
  return blocks.map((match, index) => {
    try { return JSON.parse(match[1]); }
    catch (error) { throw new Error(`Task block ${index + 1}: ${error.message}`); }
  });
}

function check(plans) {
  const errors = [];
  const ids = new Set();
  for (const plan of plans) {
    const label = String(plan?.id ?? '<missing id>');
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      errors.push(`${label}: task must be an object`);
      continue;
    }
    if (!localId.test(label) || ids.has(label)) errors.push(`${label}: missing/invalid/duplicate id`);
    ids.add(label);
    for (const [key, min] of Object.entries(minima)) {
      const value = typeof plan[key] === 'string' ? plan[key].trim() : '';
      if (value.length < min) errors.push(`${label}.${key}: missing or too short (minimum ${min})`);
      if (placeholder.test(value) || unsettled.test(value)) errors.push(`${label}.${key}: queue-refused phrase`);
    }
    if (typeof plan.title === 'string' && (plan.title.trim().length > 100 || /\n/.test(plan.title))) {
      errors.push(`${label}.title: over 100 characters or multiline`);
    }
    if (plan.project !== project || !roles.has(plan.queue) || plan.lead !== plan.queue) {
      errors.push(`${label}: wrong project/queue/accountable lead`);
    }
    if (!Array.isArray(plan.touches) || !plan.touches.length || plan.touches.some((item) => !['pi-web-ui repo', 'pi-web-deploy'].includes(item))) {
      errors.push(`${label}: unsupported/missing touches`);
    }
    if (!Array.isArray(plan.owns) || !plan.owns.length || plan.owns.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push(`${label}: missing path ownership`);
    }
    if (!Array.isArray(plan.after) || new Set(plan.after).size !== plan.after.length || !plan.uses || typeof plan.uses !== 'object' || Array.isArray(plan.uses)) {
      errors.push(`${label}: missing dependency/result map`);
      continue;
    }
    for (const edge of plan.after) {
      if (edge === plan.id || typeof plan.uses[edge] !== 'string' || plan.uses[edge].trim().length < 15) {
        errors.push(`${label}: ${edge} must name the consumed result`);
      }
    }
    if (Object.keys(plan.uses).some((edge) => !plan.after.includes(edge))) errors.push(`${label}: result without dependency`);
  }
  const visited = new Set();
  const active = new Set();
  const byId = new Map(plans.map((plan) => [plan?.id, plan]));
  function visit(id) {
    if (active.has(id)) { errors.push(`${id}: dependency cycle`); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const edge of byId.get(id)?.after ?? []) {
      if (localId.test(edge)) {
        if (!byId.has(edge)) errors.push(`${id}: missing local dependency ${edge}`);
        else visit(edge);
      } else if (!/^(ops|temper|security|data) #[1-9][0-9]*$/.test(edge)) {
        errors.push(`${id}: invalid external dependency ${String(edge)}`);
      }
    }
    active.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return [...errors, ...checkS0(plans)];
}

function checkMaps(text, plans) {
  const errors = [];
  const rows = [...text.matchAll(/^\| (P[1-5]) \| ([^\n]+) \| ([^\n]+) \|$/gm)];
  if (rows.length !== 5 || new Set(rows.map((row) => row[1])).size !== 5) errors.push('Expected five unique project acceptance rows');
  for (const [, id, , deliveries] of rows) {
    if (!plans.some((plan) => new RegExp(`\\b${plan.id}\\b`).test(deliveries)) && !/#(?:293|30[0-7])\b/.test(deliveries)) {
      errors.push(`${id}: no task or landed foundation mapping`);
    }
  }
  const gaps = [...text.matchAll(/^\| (G[0-9]+) [^|]+\| ([^|]+) \| ([^|]+) \|$/gm)];
  const gapIds = new Set(gaps.map((row) => row[1]));
  if (gaps.length !== 13 || gapIds.size !== 13 || [...Array(13)].some((_, i) => !gapIds.has(`G${i + 1}`))) {
    errors.push('Expected thirteen uniquely owned gaps G1-G13');
  }
  for (const [, id, owner, result] of gaps) {
    if (!/\*\*(Ops|Temper|Security|Data)\*\*/.test(owner) || result.trim().length < 25) errors.push(`${id}: missing owner/owed result`);
  }
  if (!text.includes("### Architecture's answer (rm-9a25d418)")) errors.push('Missing recorded Architecture answer');
  if (!text.includes('c7a0755c') || !text.includes('v2.1')) errors.push('Missing Security S0/v2.1 reference');
  for (const [id, task] of Object.entries(queuedAs)) {
    if (!text.includes(`| ${id} | Ops #${task} |`)) errors.push(`${id}: missing/correct queued-as copy Ops #${task}`);
  }
  return errors;
}

const selfTest = process.argv.includes('--self-test');
const extra = process.argv.slice(2).filter((arg) => arg !== '--self-test');
assert.ok(extra.length <= 1, 'Usage: node docs/check-usage-accounting-wiring.mjs [--self-test] [document]');
const path = extra[0] ?? fileURLToPath(new URL('./usage-accounting-wiring.md', import.meta.url));
const text = readFileSync(path, 'utf8');
const plans = plansFrom(text);
const errors = [...check(plans), ...checkMaps(text, plans)];
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${plans.length} tasks; seven complete fields each; owned gaps, criteria, dependencies and queued copies mapped; S0 UNKNOWN/completeness/cursor/key guards pass.`);
}

if (selfTest) {
  let controls = 0;
  function rejects(change) {
    const mutated = structuredClone(plans);
    change(mutated);
    assert.ok(check(mutated).length > 0, 'Checker accepted a planted bad task');
    controls++;
  }
  assert.equal(check(plans).length, 0, 'Self-test requires a valid positive fixture');
  for (const field of Object.keys(minima)) {
    rejects((items) => { delete items[0][field]; });
    rejects((items) => { items[0][field] = 'TBD'; });
    rejects((items) => { items[0][field] = 'A full length explanation with an open question hidden in it'; });
  }
  rejects((items) => { items[0].title = 'x'.repeat(101); });
  rejects((items) => { items[0].title = 'Long enough title\nsecond line'; });
  rejects((items) => { items[1].id = items[0].id; });
  rejects((items) => { items[0].project = 'wrong-project'; });
  rejects((items) => { delete items[0].uses; });
  rejects((items) => { items[0].after = [items[0].id]; items[0].uses = { [items[0].id]: 'An invalid self dependency with sufficient length' }; });
  rejects((items) => { items[0].after = ['Z99']; items[0].uses = { Z99: 'A missing local task with a plausible result' }; });
  rejects((items) => { items[0].after = [items[1].id]; items[1].after = [items[0].id]; });
  assert.throws(() => plansFrom('```usage-task\n{}\n'), /Unclosed/);
  assert.throws(() => plansFrom('```usage-task\nnot json\n```'), /Task block 1/);
  assert.ok(checkMaps(text.replace('| P1 |', '| PX |'), plans).length > 0);
  assert.ok(checkMaps(text.replace(/\*\*(Ops|Temper|Security|Data)\*\*/g, '**Nobody**'), plans).length > 0);
  assert.ok(checkMaps(text.replace("### Architecture's answer (rm-9a25d418)", '### Missing review'), plans).length > 0);
  assert.ok(checkMaps(text.replace('| W7 | Ops #316 |', '| W7 | Ops #999 |'), plans).length > 0);
  assert.ok(checkMaps(text.replaceAll('c7a0755c', 'missing-s0'), plans).length > 0);
  let s0Negative = 0;
  let s0Positive = 0;
  function rejectsS0(change, expected) {
    const mutated = structuredClone(plans);
    change(mutated);
    assert.ok(checkS0(mutated).some((error) => error.includes(expected)), `S0 accepted planted ${expected}`);
    s0Negative++;
  }
  function acceptsS0(change) {
    const mutated = structuredClone(plans);
    change(mutated);
    assert.deepEqual(check(mutated), [], 'Checker rejected a clean S0 refusal/code case');
    s0Positive++;
  }
  for (const id of s0Plans) {
    for (const [name, , example] of s0Bans) {
      // Check every acceptance field and the nested dependency/result map;
      // otherwise a correct decided field can mask a stale verify/uses field.
      for (const field of Object.keys(minima).filter((key) => key !== 'must_not')) {
        rejectsS0((items) => {
          const plan = items.find((item) => item.id === id);
          if (field === 'title') plan[field] = `Automatic costs: accept ${example}`;
          else plan[field] += ` Accept ${example}.`;
        }, `${id}.${field}: S0 forbids ${name}`);
      }
      rejectsS0((items) => {
        const plan = items.find((item) => item.id === id);
        plan.uses[plan.after[0]] += ` Accept ${example}.`;
      }, `${id}.uses.${plans.find((item) => item.id === id).after[0]}: S0 forbids ${name}`);
      acceptsS0((items) => {
        items.find((item) => item.id === id).must_not += ` ${example} acceptance is prohibited.`;
      });
      acceptsS0((items) => {
        const plan = items.find((item) => item.id === id);
        plan.verify += ` No ${example} acceptance.`;
        plan.uses[plan.after[0]] += ` No ${example} acceptance.`;
      });
      acceptsS0((items) => {
        const plan = items.find((item) => item.id === id);
        plan.verify += ` No response.${example} field.`;
        plan.uses[plan.after[0]] += ` No response.${example} field.`;
      });
    }
    for (const contrast of ['; accept', ', accept', ' but accept', ' and accept', ', enable', ' and enable', ', set', ' and set']) {
      rejectsS0((items) => {
        items.find((item) => item.id === id).verify += ` No complete_through${contrast} max_seq.`;
      }, `${id}.verify: S0 forbids sequence cursor`);
    }
    rejectsS0((items) => {
      items.find((item) => item.id === id).verify += ' No complete_through, enable TEMPER_USAGE_FEED_KEYS.';
    }, `${id}.verify: S0 forbids general named key`);
    rejectsS0((items) => {
      const plan = items.find((item) => item.id === id);
      plan.decided = plan.decided.replace(unknownCoverage, 'Temper coverage varies in v1');
    }, `${id}: S0 requires explicit`);
    rejectsS0((items) => {
      const plan = items.find((item) => item.id === id);
      plan.decided = plan.decided.replace(unknownCoverage, 'Temper coverage varies in v1');
      plan.must_not += ' Temper coverage is always UNKNOWN in v1.';
      plan.verify += ' No Temper coverage is always UNKNOWN in v1 claim.';
    }, `${id}: S0 requires explicit`);
    rejectsS0((items) => { items.splice(items.findIndex((item) => item.id === id), 1); }, `${id}: missing S0-scoped plan`);
    acceptsS0((items) => {
      items.find((item) => item.id === id).verify += ' No seq, after=, through_seq or max_seq. No complete_through or complete through acceptance. The fixed 409 seq-regression code is diagnostic. Use TEMPER_USAGE_FEED_KEYS_FILE, never a fallback.';
    });
    for (const refusal of ['Never accept', 'Do not accept', 'Must not accept']) {
      acceptsS0((items) => {
        items.find((item) => item.id === id).verify += ` ${refusal} complete_through.`;
      });
    }
  }
  for (const id of ['T0', 'T1', 'D0b', 'C0']) {
    acceptsS0((items) => {
      const plan = items.find((item) => item.id === id);
      // A reviewed producer may rename internal helpers/metadata. Do not pin
      // these as route fields; v2.1's call_key/frontier/epoch contract stays put.
      for (const field of Object.keys(minima)) {
        plan[field] = plan[field]
          .replaceAll('drain_pending_row(session, event_id, revision)', 'the reviewed native drain primitive')
          .replaceAll('usage_pending', 'the reviewed typed pending state')
          .replaceAll('ordering-deferred', 'the reviewed ordering-fault indication');
      }
    });
  }
  console.log(`PASS: ${controls + 7 + s0Negative} in-memory negative controls; ${s0Positive} clean S0 controls; no source, queue, app or model calls.`);
}
