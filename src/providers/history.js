// Keeping an agent's conversation inside a small context window. Ollama silently drops the oldest messages when a prompt
// exceeds num_ctx, and the oldest message is the task brief, so the agent forgets what it is doing. Both engines shorten the
// history themselves before that happens: the built-in loop in runAgent, fx through the bridge.

const blockChars = (b) => (b.type === 'text' ? b.text.length : b.type === 'tool_use' ? JSON.stringify(b.input || {}).length + 40 : b.type === 'tool_result' ? String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).length + 40 : 40);
const messageChars = (m) => (typeof m.content === 'string' ? m.content.length : m.content.reduce((n, b) => n + blockChars(b), 0)) + 10;

/**
 * How many characters of conversation history fit the provider's context window, or Infinity when the window is unknown or
 * large. About 3 characters per token (code tokenizes densely), with room kept for the reply, the system prompt and the tools.
 */
export function historyBudget(provider, system = '', tools = []) {
  const ctx = Number(provider?.contextTokens ?? provider?.numCtx);
  if (!Number.isFinite(ctx) || ctx <= 0 || ctx >= 200_000) return Infinity;
  const reply = Math.min(Number(provider?.maxTokens) || 8192, Math.floor(ctx / 4));
  const fixed = String(system).length + JSON.stringify(tools).length;
  return Math.max(6000, (ctx - reply) * 3 - fixed);
}

const KEEP_RECENT = 6; // the latest messages (three tool rounds) are always sent whole

/**
 * The history to send when it would not fit `budget` characters: the task brief stays, the latest rounds stay whole, older
 * tool output and written file contents are shortened, and if that is not enough the oldest rounds are dropped (in
 * assistant/user pairs, so every tool result keeps its call). The caller's history is not changed.
 */
export function compactHistory(messages, budget) {
  const total = (ms) => ms.reduce((n, m) => n + messageChars(m), 0);
  if (!Number.isFinite(budget) || total(messages) <= budget) return messages;
  const out = messages.map((m) => ({ ...m }));
  const old = Math.max(1, out.length - KEEP_RECENT);
  for (let i = 1; i < old && total(out) > budget; i++) {
    if (typeof out[i].content === 'string') {
      if (out[i].content.length > 800) out[i].content = `${out[i].content.slice(0, 400)}\n…[shortened]`;
      continue;
    }
    out[i].content = out[i].content.map((b) => {
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return text.length > 600 ? { ...b, content: `${text.slice(0, 300)}\n…[${text.length - 300} more characters omitted from this earlier result]` } : b;
      }
      if (b.type === 'tool_use' && b.name === 'write_file' && typeof b.input?.content === 'string' && b.input.content.length > 200) {
        return { ...b, input: { ...b.input, content: `[${b.input.content.length} characters written; read_file shows the current content]` } };
      }
      if (b.type === 'text' && b.text.length > 800) return { ...b, text: `${b.text.slice(0, 400)}…` };
      return b;
    });
  }
  let dropped = 0;
  while (total(out) > budget && out.length - 1 > KEEP_RECENT && out[1]?.role === 'assistant' && out[2]?.role === 'user') {
    out.splice(1, 2);
    dropped++;
  }
  if (dropped) {
    const note = `\n\n(${dropped} earlier tool round${dropped === 1 ? ' was' : 's were'} left out to fit the model's context window. Your earlier changes are in the workspace: use list_files and read_file to see them.)`;
    out[0] = { ...out[0], content: typeof out[0].content === 'string' ? out[0].content + note : [...out[0].content, { type: 'text', text: note.trim() }] };
  }
  return out;
}
