import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(overrides = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const cfg = {
    root: ROOT,
    port: int('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    dataDir: path.resolve(process.env.FACTORY_DATA_DIR || path.join(ROOT, 'data')),
    // Provider: "anthropic" when a key is present, otherwise the deterministic offline provider.
    defaultProvider: process.env.FACTORY_PROVIDER || (apiKey ? 'anthropic' : 'offline'),
    anthropic: {
      apiKey,
      model: process.env.FACTORY_MODEL || 'claude-sonnet-5-5',
      plannerModel: process.env.FACTORY_PLANNER_MODEL || process.env.FACTORY_MODEL || 'claude-opus-5-5',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      maxTokens: int('FACTORY_MAX_OUTPUT_TOKENS', 8192),
    },
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
