import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, readyTasks, levels, propagateBlocked, dependentsOf, findCycle } from '../src/graph.js';
import { buildPlan } from '../src/providers/offline.js';

const t = (id, dependsOn = [], extra = {}) => ({ id, role: 'engineer', title: id, description: id, acceptance: ['works'], verify: [], dependsOn, status: 'pending', ...extra });
const plan = (tasks) => ({ product: { summary: 'x', successCriteria: ['y'] }, tasks });

test('the offline plan is a valid DAG with parallel levels', () => {
  const p = buildPlan({ idea: 'A habit tracker' });
  assert.deepEqual(validatePlan(p), []);
  const lv = levels(p.tasks);
  assert.equal(lv.prd, 0);
  assert.equal(lv.core, 1);
  assert.equal(lv.ui, 1);
  assert.equal(lv.docs, 3);
});

test('validatePlan reports unknown deps, duplicates, bad roles and cycles', () => {
  assert.match(validatePlan(plan([t('a', ['zzz'])])).join(), /unknown task "zzz"/);
  assert.match(validatePlan(plan([t('a'), t('a')])).join(), /duplicate/);
  assert.match(validatePlan(plan([t('a', [], { role: 'wizard' })])).join(), /unknown role/);
  assert.match(validatePlan(plan([t('a', ['b']), t('b', ['a'])])).join(), /cycle/);
  assert.match(validatePlan({ tasks: [] }).join(), /product.summary/);
  assert.deepEqual(findCycle([t('a'), t('b', ['a'])]), null);
});

test('readyTasks only returns tasks whose dependencies are done', () => {
  const tasks = [t('a', [], { status: 'completed' }), t('b', ['a']), t('c', ['b']), t('d', ['a'])];
  assert.deepEqual(readyTasks(tasks).map((x) => x.id), ['b', 'd']);
  tasks[1].status = 'skipped';
  assert.deepEqual(readyTasks(tasks).map((x) => x.id), ['c', 'd']);
});

test('escalated tasks block their transitive dependents', () => {
  const tasks = [t('a', [], { status: 'escalated' }), t('b', ['a']), t('c', ['b']), t('d')];
  assert.deepEqual(propagateBlocked(tasks).sort(), ['b', 'c']);
  assert.equal(tasks[3].status, 'pending');
  assert.deepEqual(dependentsOf(tasks, 'a').sort(), ['b', 'c']);
});
