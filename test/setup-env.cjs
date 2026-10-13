// Preloaded by `npm test` (node --require): the suite must give the same result whatever the developer has exported.
// da-prompt itself is configured through the environment (FACTORY_*, PORT, HOST, provider keys, tokens) and the CLI
// makes it normal to have a backend's variables in your shell, so none of them may leak into a test.
// DA_PROMPT_PAX_BIN is kept: it is the opt-in for the real-PAX smoke test. Tests that need a value set it themselves (per server `env`, or process.env inside the test).
for (const k of Object.keys(process.env)) {
  if ((/^(FACTORY_|DA_PROMPT_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|GROQ_|MISTRAL_|DEEPSEEK_|XAI_|TOGETHER_|OLLAMA_|LMSTUDIO_|LLAMACPP_|VLLM_|GITHUB_|GH_)/.test(k) || k === 'PORT' || k === 'HOST') && k !== 'DA_PROMPT_PAX_BIN') delete process.env[k];
}
