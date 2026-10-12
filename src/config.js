import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(overrides = {}) {
  const cfg = {
    root: ROOT,
    port: int('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    dataDir: path.resolve(process.env.FACTORY_DATA_DIR || path.join(ROOT, 'data')),
    // Optional: force a default provider/model. Otherwise the factory picks the first provider
    // that is ready (a configured key, or a local server such as Ollama that is running) and
    // remembers your last choice. Providers, keys and URLs are managed in src/providers/registry.js
    // presets, environment variables, and the Providers page.
    defaultProvider: process.env.FACTORY_PROVIDER || '',
    defaultModel: process.env.FACTORY_MODEL || '',
    defaultPlannerModel: process.env.FACTORY_PLANNER_MODEL || '',
    maxOutputTokens: int('FACTORY_MAX_OUTPUT_TOKENS', 8192),
    hideOffline: process.env.FACTORY_HIDE_OFFLINE === '1',
    // Offline provider faults: "on" injects one bug that the feedback loop fixes, "persistent"
    // keeps failing for a full round of attempts so escalation can be demonstrated, "off" disables.
    offlineFaults: ['on', 'off', 'persistent'].includes(process.env.FACTORY_OFFLINE_FAULTS) ? process.env.FACTORY_OFFLINE_FAULTS : 'on',
    defaults: {
      maxParallel: int('FACTORY_MAX_PARALLEL', 3),
      maxAttempts: int('FACTORY_MAX_ATTEMPTS', 3),
      maxAgentTurns: int('FACTORY_MAX_AGENT_TURNS', 40),
      tokenBudget: int('FACTORY_TOKEN_BUDGET', 2_000_000),
      commandTimeoutMs: int('FACTORY_COMMAND_TIMEOUT_MS', 180_000),
    },
    maxPreviews: int('FACTORY_MAX_PREVIEWS', 5),
    password: process.env.FACTORY_PASSWORD || '',
    githubToken: process.env.GITHUB_TOKEN || '',
  };
  return { ...cfg, ...overrides, defaults: { ...cfg.defaults, ...(overrides.defaults || {}) } };
}
