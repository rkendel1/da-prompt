// Replay fixtures: a scripted sequence of model replies plus the project they act on, run through the REAL factory (planning,
// the agent loop, the sandbox, verification, feedback, delivery). They show what the factory does with a given sequence of
// replies. They do not show that any model would produce such a sequence, and nothing in them is a prompt, a credential or
// private content.
//
// A step is one model reply:
//   [call, call…]          tool calls:  w(path, content) · cmd(command) · finish(summary, files) · tool(name, input)
//   { text }               prose, no tool call
//   { empty: true }        an empty reply
//   { hang: true }         never answers (until the run is cancelled)
//   { fail: 'message' }    the provider call itself throws
// `attempts[i]` is the script for task attempt i+1 (the last one repeats if the task is attempted more often).
import { toolUse } from '../project-helpers.js';

export const w = (path, content) => toolUse('write_file', { path, content });
export const cmd = (command) => toolUse('run_command', { command });
export const finish = (summary, files = []) => toolUse('complete_task', { summary, files, commands: [], nextSteps: [] });
export const tool = (name, input) => toolUse(name, input);
export const repeat = (n, step) => Array.from({ length: n }, () => step);

export const FAREWELL = "export const farewell = (name) => `Bye, ${name}!`;\n";
export const FAREWELL_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { farewell } from '../src/farewell.js';\ntest('farewell', () => assert.equal(farewell('Ada'), 'Bye, Ada!'));\n";
export const FAILING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('claimed to pass', () => assert.equal(1, 2));\n";

export const PLAN_ONE = (verify = ['npm test'], finalVerify = ['npm test']) => ({ tasks: [{ id: 't', verify }], finalVerify });

export const FIXTURES = {
  success: {
    idea: 'Add a farewell function with a test',
    attempts: [[[w('src/farewell.js', FAREWELL)], [w('test/farewell.test.js', FAREWELL_TEST)], [cmd('npm test')], [finish('added farewell with a test', ['src/farewell.js', 'test/farewell.test.js'])]]],
  },
  sandboxRejections: {
    idea: 'Try things a sandbox must refuse, then do the work',
    attempts: [[
      [w('../escape.txt', 'outside')],
      [w('ESCAPE_ABSOLUTE', 'outside')], // replaced with an absolute temp path by the test
      [w('.git/config', '[core]\n\tfsmonitor = evil')],
      [cmd('npm install left-pad')],
      [tool('format_disk', { target: '/' })],
      [tool('write_file', { content: 'no path' })],
      [tool('read_file', { path: '../../etc/passwd' })],
      [w('src/farewell.js', FAREWELL)],
      [finish('did the work after the refusals', ['src/farewell.js'])],
    ]],
    maxTurns: 12,
  },
  recovery: {
    idea: 'Recover from a failed command',
    attempts: [[[cmd('node -e "process.exit(3)"')], [w('src/farewell.js', FAREWELL)], [cmd('npm test')], [finish('recovered', ['src/farewell.js'])]]],
  },
  repeatedFailure: {
    idea: 'A model stuck repeating one failing command',
    attempts: [repeat(4, [cmd('node -e "process.exit(2)"')])],
    maxTurns: 4,
    maxAttempts: 2,
  },
  falseClaim: {
    idea: 'A model that claims success it did not earn',
    attempts: [[[w('test/liar.test.js', FAILING_TEST)], [finish('all tests pass, verified', ['test/liar.test.js'])]]],
    maxAttempts: 2,
  },
  cancelled: {
    idea: 'Cancel while the model is thinking',
    attempts: [[[w('src/farewell.js', FAREWELL)], { hang: true }]],
  },
  emptyReplies: {
    idea: 'A model that answers with nothing',
    attempts: [repeat(3, { empty: true })],
    maxTurns: 3,
    maxAttempts: 2,
  },
};
