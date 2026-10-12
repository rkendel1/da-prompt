// Layer 5/7 support: a lightweight security review of generated code.

const PATTERNS = [
  { id: 'private-key', severity: 'critical', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'anthropic-key', severity: 'critical', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', severity: 'critical', re: /\bsk-(proj-)?[A-Za-z0-9]{32,}/ },
  { id: 'github-token', severity: 'critical', re: /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/ },
  { id: 'aws-access-key', severity: 'critical', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', severity: 'critical', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'hardcoded-password', severity: 'high', re: /(password|passwd|secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
  { id: 'eval', severity: 'medium', re: /\beval\s*\(/ },
  { id: 'child-process-exec-concat', severity: 'medium', re: /exec(Sync)?\(\s*[`'"][^`'"]*['"`]\s*\+/ },
  { id: 'inner-html-assignment', severity: 'low', re: /\.innerHTML\s*=\s*[^'"`;]*\b(req|input|params|query|body)\b/ },
];

const SCAN_EXT = /\.(m?[jt]sx?|cjs|json|py|rb|go|rs|java|kt|php|sh|ya?ml|toml|env|ini|cfg|html?|vue|svelte|md)$/i;

/** Scan workspace files. Returns findings with file/line; critical/high count as blocking. */
export async function scanWorkspace(ws) {
  const files = await ws.listFiles('.');
  const findings = [];
  for (const f of files) {
    if (!SCAN_EXT.test(f.path) && !/(^|\/)\.env/.test(f.path)) continue;
    if (f.size > 500_000) continue;
    let text;
    try {
      text = await ws.readFile(f.path);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          // Test files legitimately contain fake credentials; downgrade them.
          const inTest = /(^|\/)(test|tests|__tests__)\/|\.test\./.test(f.path);
          const severity = inTest && p.severity !== 'critical' ? 'low' : p.severity;
          findings.push({ rule: p.id, severity, file: f.path, line: i + 1, excerpt: redact(line.trim()).slice(0, 160) });
        }
      }
    });
  }
  const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  return { findings, blocking: blocking.length, ok: blocking.length === 0 };
}

/** Mask secret-looking substrings before anything is persisted or displayed. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/\bsk-(proj-)?[A-Za-z0-9]{20,}/g, 'sk-***')
    .replace(/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/g, '$1_***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***');
}
