// Preloaded by `npm test` (node --require): the suite must give the same result whatever the developer has exported.
// da-prompt itself is configured through the environment (FACTORY_*, PORT, HOST, provider keys, tokens) and the CLI
// makes it normal to have a backend's variables in your shell, so none of them may leak into a test.
// DA_PROMPT_PAX_BIN is kept: it is the opt-in for the real-PAX smoke test. Tests that need a value set it themselves (per server `env`, or process.env inside the test).
for (const k of Object.keys(process.env)) {
  if ((/^(FACTORY_|DA_PROMPT_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|GROQ_|MISTRAL_|DEEPSEEK_|XAI_|TOGETHER_|OLLAMA_|LMSTUDIO_|LLAMACPP_|VLLM_|GITHUB_|GH_)/.test(k) || k === 'PORT' || k === 'HOST') && k !== 'DA_PROMPT_PAX_BIN') delete process.env[k];
}

// Test-first QA (src/testfirst.js) is on by default; the suite's older tests drive mock providers through one-task plans, so it
// is off unless a test asks for it with settings.testFirst (test/test-first.test.js does).
process.env.FACTORY_TEST_FIRST = '0';

// Generated apps depend on the pinned @appport/* packages (src/appport.js): every test run of the factory installs them. One
// npm cache for the whole suite (outside every test's data dir) means they are downloaded at most once per machine; installs
// use --prefer-offline, so a warm cache needs no network.
process.env.FACTORY_NPM_CACHE = require('node:path').join(require('node:os').tmpdir(), 'da-prompt-test-npm-cache');

// A developer machine may have a `pax` on PATH (the real PAX, or the POSIX archiver at /usr/bin/pax on macOS and many
// Linuxes). Tests that expect "pax is not installed" must not depend on that, and tests that want PAX put a fake or a
// real one on PATH themselves. So: remember a real one for the opt-in smoke test, then hide every `pax` from PATH by
// replacing each directory that holds one with a shim directory of symlinks to everything else in it.
(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (!dirs.some((d) => d && fs.existsSync(path.join(d, 'pax')))) return;
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'da-prompt-test-path-'));
  const seen = new Set();
  const out = [];
  let placed = false;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, 'pax'))) { out.push(d); continue; }
    if (!process.env.DA_PROMPT_PAX_BIN) {
      try { fs.accessSync(path.join(d, 'pax'), fs.constants.X_OK); process.env.DA_PROMPT_PAX_BIN = path.join(d, 'pax'); } catch { /* not executable */ }
    }
    try {
      for (const name of fs.readdirSync(d)) {
        if (name === 'pax' || seen.has(name)) continue;
        seen.add(name);
        try { fs.symlinkSync(path.join(d, name), path.join(shim, name)); } catch { /* ignore */ }
      }
    } catch { /* unreadable */ }
    if (!placed) { out.push(shim); placed = true; }
  }
  process.env.PATH = out.join(path.delimiter);
})();
