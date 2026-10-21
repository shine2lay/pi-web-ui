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
  return errors;
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
  console.log(`PASS: ${plans.length} tasks; seven complete fields each; no queue-refused phrases; owned gaps, five criteria and dependency results mapped.`);
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
  console.log(`PASS: ${controls + 5} in-memory negative controls; no source, queue, app or model calls.`);
}
