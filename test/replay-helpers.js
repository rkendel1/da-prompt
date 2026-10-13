// The replay runner: a scripted "model" (ReplayProvider) plugged in where a real provider would be, driving the real factory
// against a throwaway git project. Nothing about the factory is faked: planning, the agent loop, the sandbox, verification,
// feedback, delivery and the stored run record are the production code. Only the model's replies are scripted.
import fs from 'node:fs';
import { OfflineProvider } from '../src/providers/offline.js';
import { buildEvidence } from '../src/evidence.js';
import { readRecords, summarizeRun } from '../src/diagnostics.js';
import { makeRepo, makeRoot, dirId, setup, plan, task, NODE_FILES, toolUse } from './project-helpers.js';
import { PLAN_ONE } from './replay/fixtures.js';

const USAGE = { input_tokens: 100, output_tokens: 20, reported: true };

export class ReplayProvider extends OfflineProvider {
  constructor(fixture) {
    super({ faults: false, delayMs: 0 });
    this.fixture = fixture;
    this.requests = []; // every request, as the model saw it (kind, attempt, message list at that moment)
    this.planCalls = 0;
    this.hanging = null; // resolves when a { hang } step has been reached
    this.onHang = null;
    this.hangSeen = new Promise((r) => (this.onHang = r));
  }

  describe() {
    return { name: 'replay', label: 'Replay', model: 'scripted', plannerModel: 'scripted', dialect: 'replay', toolMode: 'native' };
  }

  async chat(req) {
    const meta = req.meta || {};
    this.requests.push({ kind: meta.kind, attempt: meta.attempt, messages: req.messages.slice(), tools: (req.tools || []).map((t) => t.name) });
    if (meta.kind === 'plan') {
      const step = this.fixture.planResponses?.[this.planCalls++] ?? { plan: PLAN_ONE(...(this.fixture.planArgs || [])) };
      if (step.empty) return { content: [], stop_reason: 'end_turn', usage: USAGE };
      if (step.text) return { content: [{ type: 'text', text: step.text }], stop_reason: 'end_turn', usage: USAGE };
      const body = step.plan;
      const spec = plan((body.tasks || []).map((t) => task(t.id, { verify: t.verify || [], ...t })), { finalVerify: body.finalVerify ?? ['npm test'] });
      if (body.tasks && body.tasks.length === 0) spec.tasks = [];
      return { content: [toolUse('submit_plan', spec)], stop_reason: 'tool_use', usage: USAGE };
    }
    if (meta.kind === 'task') {
      const attempts = this.fixture.attempts || [];
      const script = attempts[Math.min(meta.attempt, attempts.length) - 1] || [];
      const turn = req.messages.filter((m) => m.role === 'assistant').length;
      const step = script[turn];
      if (step === undefined) return { content: [{ type: 'text', text: 'I am not sure what to do next.' }], stop_reason: 'end_turn', usage: USAGE };
      if (step.hang) {
        this.onHang();
        return new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('cancelled'))));
      }
      if (step.fail) throw new Error(step.fail);
      if (step.empty) return { content: [], stop_reason: 'end_turn', usage: USAGE };
      if (step.text) return { content: [{ type: 'text', text: step.text }], stop_reason: 'end_turn', usage: USAGE };
      return { content: step, stop_reason: 'tool_use', usage: USAGE };
    }
    return super.chat(req);
  }
}

/** Run one fixture end to end. Returns everything a test needs to assert on the stored record. */
export async function runReplay(fixture, { files = fixture.files || NODE_FILES, cancel = false, cfg: extraCfg = {}, source: sourceExtra = {}, beforeStart } = {}) {
  const origin = makeRepo(files);
  const { root, dirs, cfg: rootCfg } = makeRoot({ app: (d) => fs.cpSync(origin, d, { recursive: true }) });
  const provider = new ReplayProvider(fixture);
  const env = setup({ provider, cfg: { ...rootCfg, ...extraCfg } });
  const { cfg, store, factory } = env;
  const created = await factory.createRun({
    idea: fixture.idea,
    provider: 'offline',
    source: { mode: 'local', directoryId: dirId(cfg, 'app'), ...sourceExtra },
    settings: { deploy: false, maxAttempts: fixture.maxAttempts ?? 2, maxAgentTurns: fixture.maxTurns ?? 8, ...(fixture.settings || {}) },
  });
  await beforeStart?.({ created, env });
  const finished = factory.start(created.id);
  if (cancel) {
    await provider.hangSeen;
    await factory.cancel(created.id);
  }
  await finished;
  const run = await store.load(created.id);
  const events = await store.events(created.id);
  const records = readRecords(store.runDir(created.id));
  return { run, events, tools: events.filter((e) => e.type === 'tool'), evidence: buildEvidence(run), diag: summarizeRun(run, events, records), records, provider, store, factory, cfg, root, source: dirs.app, id: created.id };
}

/** Properties that must hold for EVERY stored run, whatever the model said. */
export function runInvariants(run, store) {
  const where = `run ${run.id} (${run.status})`;
  const checklist = run.checklist || [];
  const tasks = run.plan?.tasks || [];
  if (run.status === 'completed') {
    if (!tasks.length || !tasks.every((t) => t.status === 'completed' || t.status === 'skipped')) throw new Error(`${where}: completed with an unfinished task`);
    if (!checklist.length || !checklist.every((c) => c.ok)) throw new Error(`${where}: completed with a failing checklist item`);
    if (!run.delivery) throw new Error(`${where}: completed without a delivery`);
    if (run.delivery.integrity && run.delivery.integrity.ok === false) throw new Error(`${where}: completed although source protection failed`);
  }
  if (run.status === 'cancelled' && run.delivery) throw new Error(`${where}: a cancelled run was delivered`);
  if (['completed', 'needs_attention'].includes(run.status) && !run.finishedAt) throw new Error(`${where}: no finish time`);
  for (const t of tasks) {
    if (t.status === 'completed' && !t.attempts.at(-1)?.ok) throw new Error(`${where}: task ${t.id} completed but its last attempt is not ok`);
    if (t.status === 'completed' && t.attempts.at(-1)?.verification?.some((v) => !v.ok)) throw new Error(`${where}: task ${t.id} completed with a failing check`);
  }
  if (checklist.some((c) => !c.ok) && run.status === 'completed') throw new Error(`${where}: checklist/status disagree`);
  void store;
}
