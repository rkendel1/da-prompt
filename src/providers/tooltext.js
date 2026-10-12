// Tool calling for models without native function calling (many local models), and recovery
// when a model writes its tool call as text instead of using the structured channel.

/** Remove <think>…</think> reasoning blocks some local models emit. */
export function stripThinking(text = '') {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

/** Find balanced top-level JSON objects/arrays in free text (string-aware). */
export function extractJsonValues(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          if (c === close) {
            try {
              out.push({ value: JSON.parse(s.slice(i, j + 1)), start: i, end: j + 1 });
              i = j;
            } catch {
              /* not valid JSON; keep scanning from next char */
            }
          }
          break;
        }
      }
    }
  }
  return out;
}

/** Parse tool-call arguments that may be a JSON string, an object, or slightly malformed. */
export function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    const found = extractJsonValues(args).find((v) => v.value && typeof v.value === 'object' && !Array.isArray(v.value));
    return found ? found.value : { _raw: args };
  }
}

function normalizeCall(v, toolNames) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const fn = v.function && typeof v.function === 'object' ? v.function : null;
  const name = v.tool ?? v.name ?? v.tool_name ?? fn?.name;
  if (typeof name !== 'string' || !toolNames.has(name)) return null;
  const input = v.input ?? v.arguments ?? v.parameters ?? v.args ?? fn?.arguments ?? {};
  return { name, input: parseArgs(input) };
}

/**
 * Extract tool calls written as text. Accepts {"tool","input"}, {"name","arguments"},
 * {"function":{...}}, {"tool_calls":[...]} and arrays of those, with or without code fences.
 * Returns { calls, text } where text is whatever prose remains.
 */
export function parseToolCallsFromText(text, toolNames) {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const clean = stripThinking(text);
  const calls = [];
  const spans = [];
  for (const { value, start, end } of extractJsonValues(clean)) {
    const candidates = Array.isArray(value) ? value : Array.isArray(value?.tool_calls) ? value.tool_calls : [value];
    const parsed = candidates.map((c) => normalizeCall(c, names)).filter(Boolean);
    if (parsed.length) {
      calls.push(...parsed);
      spans.push([start, end]);
    }
  }
  let rest = clean;
  for (const [a, b] of spans.reverse()) rest = rest.slice(0, a) + rest.slice(b);
  rest = rest.replace(/```(?:json)?\s*```/g, '').trim();
  return { calls, text: rest };
}

/** System-prompt section that teaches a model the JSON tool protocol. */
export function jsonToolInstructions(tools, { forceTool } = {}) {
  const lines = [
    '## How to use tools',
    'You do not have native function calling. To call a tool, reply with ONLY one JSON object and nothing else (no prose, no code fences):',
    '{"tool": "<tool name>", "input": { ...arguments... }}',
    'Call one tool per reply. You will receive the result in the next message. Escape newlines and quotes inside JSON strings.',
    forceTool ? `You must reply with a call to "${forceTool}".` : 'When the task is finished and verified, call complete_task.',
    '',
    'Available tools:',
  ];
  for (const t of tools) lines.push(`- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`);
  return lines.join('\n');
}
