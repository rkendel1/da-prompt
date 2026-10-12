import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FACTORY_OFFLINE_DELAY_MS = '0';

export function tmpDir(prefix = 'da-prompt-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
