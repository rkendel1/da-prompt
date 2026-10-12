import { AnthropicProvider } from './anthropic.js';
import { OfflineProvider } from './offline.js';

export const PROVIDERS = ['anthropic', 'offline'];

export function createProvider(name, cfg) {
  if (name === 'anthropic') return new AnthropicProvider(cfg.anthropic);
  if (name === 'offline') return new OfflineProvider({ faults: cfg.offlineFaults });
  throw new Error(`unknown provider "${name}" (use ${PROVIDERS.join(' or ')})`);
}

export function availableProviders(cfg) {
  return [
    { name: 'anthropic', available: Boolean(cfg.anthropic.apiKey), model: cfg.anthropic.model, plannerModel: cfg.anthropic.plannerModel },
    { name: 'offline', available: true, model: 'offline-template-agent' },
  ];
}
