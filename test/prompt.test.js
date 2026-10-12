import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, normalizeInputs, PROMPT_TEMPLATE } from '../src/prompt.js';

test('template contains every layer of the factory', () => {
  for (const tag of ['goal', 'role', 'principles', 'inputs', 'layer_1_plan', 'layer_2_agents', 'layer_3_execution', 'layer_4_artifacts', 'layer_5_verification', 'layer_6_feedback', 'layer_7_completion', 'execution_loop', 'deliver']) {
    assert.ok(PROMPT_TEMPLATE.includes(`<${tag}>`) && PROMPT_TEMPLATE.includes(`</${tag}>`), tag);
  }
});

test('renderPrompt fills inputs and normalizeInputs applies defaults', () => {
  const inputs = normalizeInputs({ idea: '  A todo app ' });
  assert.equal(inputs.idea, 'A todo app');
  assert.ok(inputs.stack.length > 0);
  const out = renderPrompt(inputs);
  assert.ok(out.includes('Turn A todo app into a working'));
  assert.ok(!out.includes('{{'));
  assert.throws(() => normalizeInputs({}), /idea is required/);
});
