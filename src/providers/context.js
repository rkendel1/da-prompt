// Context-window helpers shared by the provider adapters and the agent loop. Kept in the provider layer so an adapter can
// raise the same explicit error the loop handles, without importing anything about runs.

/** The request does not fit the model's context window. Retrying the same request cannot help, so it is its own failure kind. */
export class ContextOverflowError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.kind = 'context_overflow';
    this.detail = detail;
  }
}

/** Tokens reserved for the reply: never more than a quarter of the window, never more than the configured maximum. */
export const outputReserve = (contextTokens, maxTokens) => (contextTokens > 0 ? Math.max(256, Math.min(maxTokens || 8192, Math.floor(contextTokens / 4))) : maxTokens || 8192);
