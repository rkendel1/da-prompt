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

/**
 * Command policy for runs against an existing project. It refuses the consequential things a
 * repository's docs or an agent might ask for: dependency installs (they execute project scripts),
 * publishing/deploying, database migrations, privileged commands, and git operations that could
 * move the source branch. This is a speed bump on well-meaning mistakes, NOT a security boundary:
 * `sh -c` can always indirect around a pattern. Real isolation is the container (see README) and the
 * post-run integrity checks on the source branch.
 */
const POLICY = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update|upgrade)\b|\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\bpoetry\s+(install|add|update)\b|\bpipenv\s+install\b|\buv\s+(pip|sync|add)\b|\bbundle\s+(install|update)\b|\bgem\s+install\b|\bgo\s+(get|install)\b|\bcargo\s+(install|add)\b|\bcomposer\s+(install|require|update)\b|\b(apt|apt-get|apk|yum|dnf|brew)\s+(install|add)\b/, 'installing dependencies runs project scripts and needs explicit authorization (enable "Allow dependency installs" for this run)', 'install'],
  [/\bnpm\s+publish\b|\b(yarn|pnpm)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+(push|login|run|exec|compose|build)\b|\bkubectl\b|\bhelm\s+(install|upgrade)\b|\bterraform\s+(apply|destroy)\b|\bpulumi\s+(up|destroy)\b|\b(vercel|netlify|flyctl|heroku|firebase|wrangler|serverless|sls)\b|\b(gcloud|aws|az)\s/, 'publishing, deploying and infrastructure commands are never run by agents'],
  [/\bprisma\s+(migrate|db\s+push)\b|\balembic\s+(upgrade|downgrade)\b|\brails\s+db:|\brake\s+db:|manage\.py\s+(migrate|flush|loaddata)\b|\bdjango-admin\s+migrate\b|\bflyway\b|\bliquibase\b|\bknex\s+migrate\b|\bsequelize(-cli)?\s+db:|\btypeorm\s+migration:run\b|\bgoose\s+(up|down)\b|\bdbmate\s+(up|down)\b|\bsqlx\s+migrate\b/, 'database migrations are consequential and need explicit authorization'],
  [/\b(su|doas|chown|mount|umount|systemctl|service|crontab|iptables)\b|\bchmod\s+(-[a-zA-Z]*R|-R)\b/, 'privileged and system commands are not allowed'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'piping downloads into a shell is not allowed'],
  [/\bgit\s+(?:-[Cc]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*(push|pull|fetch|clone|remote|config|switch|rebase|update-ref|filter-branch|worktree|reflog|branch|tag|reset|submodule|gc|prune)\b/, 'this git operation could move or rewrite the source branch; the factory manages branches, commits and publishing itself'],
  [/\bgit\s+(?:-[Cc]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*checkout\b(?!\s+(HEAD\s+)?--\s)/, 'git checkout is only allowed for restoring files (git checkout -- <path>)'],
];

export function existingProjectPolicy({ allowInstall = false } = {}) {
  return (command) => {
    for (const [re, reason, kind] of POLICY) {
      if (kind === 'install' && allowInstall) continue;
      if (re.test(command)) return reason;
    }
    return null;
  };
}

/** Scan workspace files. Returns findings with file/line; critical/high count as blocking. `only` limits the scan to those paths. */
export async function scanWorkspace(ws, { only } = {}) {
  const files = (await ws.listFiles('.')).filter((f) => !only || only.has(f.path));
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
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}

/**
 * Remove the exact values of known credentials from text, plus a cut-off copy of one at either end of the text: upstream
 * truncation (a provider error body sliced to N characters) can leave only the first or last characters of a key, which
 * redact() cannot recognise by shape. Values shorter than 8 characters are ignored (too likely to match ordinary text).
 */
export function hideSecretValues(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) {
    if (typeof v !== 'string' || v.length < 8) continue;
    s = s.split(v).join('***');
    for (let k = v.length - 1; k >= 6; k--) {
      if (s.endsWith(v.slice(0, k))) {
        s = `${s.slice(0, -k)}***`;
        break;
      }
      if (s.startsWith(v.slice(-k))) {
        s = `***${s.slice(k)}`;
        break;
      }
    }
  }
  return s;
}
