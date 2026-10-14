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
            const value = parseLenient(s.slice(i, j + 1));
            if (value !== undefined) {
              out.push({ value, start: i, end: j + 1 });
              i = j;
            }
          }
          break;
        }
      }
    }
  }
  return out;
}

/**
 * JSON.parse that also accepts what local models commonly get wrong: raw newlines/tabs inside strings (a whole file written
 * as a JSON string) and trailing commas. Returns undefined when the text is still not JSON.
 */
export function parseLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* try a repaired copy */
  }
  let out = '';
  let inStr = false;
  let esc = false;
  for (const c of String(text)) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      else if (c === '\n') { out += '\\n'; continue; }
      else if (c === '\r') { out += '\\r'; continue; }
      else if (c === '\t') { out += '\\t'; continue; }
      else if (c < ' ') { out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    } else if (c === '"') inStr = true;
    else if (c === '}' || c === ']') out = out.replace(/,\s*$/, ''); // trailing comma, outside strings only
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/** Parse tool-call arguments that may be a JSON string, an object, or slightly malformed. */
export function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  const direct = parseLenient(args);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const found = extractJsonValues(args).find((v) => v.value && typeof v.value === 'object' && !Array.isArray(v.value));
  return found ? found.value : { _raw: args };
}

// Names local models use for the factory's tools (they were trained on other agents' tool sets).
const TOOL_ALIASES = {
  write_file: ['write', 'writefile', 'write_to_file', 'create_file', 'save_file', 'file_write', 'edit_file', 'str_replace_editor'],
  read_file: ['read', 'readfile', 'open_file', 'view_file', 'cat', 'file_read', 'view'],
  list_files: ['ls', 'list', 'list_dir', 'list_directory', 'listfiles', 'list_files_in_directory', 'glob'],
  run_command: ['bash', 'shell', 'sh', 'exec', 'execute', 'run', 'run_shell', 'run_shell_command', 'execute_command', 'execute_bash', 'terminal', 'command'],
  complete_task: ['finish', 'done', 'complete', 'task_complete', 'finish_task', 'attempt_completion', 'submit'],
};

/** Map a tool name a model wrote ("functions.write_file", "Bash", "create_file") to one of `toolNames`, or null. */
export function resolveToolName(name, toolNames) {
  if (typeof name !== 'string') return null;
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  if (names.has(name)) return name;
  const bare = name.trim().replace(/^(functions|function|tools|tool)[.:]/i, '');
  if (names.has(bare)) return bare;
  const key = bare.toLowerCase().replace(/[\s-]+/g, '_');
  for (const n of names) if (n.toLowerCase() === key || n.replace(/_/g, '') === key.replace(/_/g, '')) return n;
  for (const [target, aliases] of Object.entries(TOOL_ALIASES)) if (names.has(target) && aliases.includes(key)) return target;
  return null;
}

function normalizeCall(v, toolNames) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const fn = v.function && typeof v.function === 'object' ? v.function : null;
  const name = resolveToolName(v.tool ?? v.name ?? v.tool_name ?? fn?.name, toolNames);
  if (!name) return null;
  const input = v.input ?? v.arguments ?? v.parameters ?? v.args ?? fn?.arguments ?? {};
  return { name, input: parseArgs(input) };
}

/** A parameter value from an XML-style call: JSON when it clearly is (arrays, numbers), otherwise the raw text. */
function xmlValue(raw) {
  const v = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  if (/^\s*[[{]/.test(v) || /^\s*-?\d+(\.\d+)?\s*$/.test(v) || /^\s*(true|false)\s*$/.test(v)) {
    const j = parseLenient(v.trim());
    if (j !== undefined) return j;
  }
  return v;
}

const XML_CALLS = [
  // qwen3-coder: <function=write_file>\n<parameter=path>\na.js\n</parameter>\n</function>
  { call: /<function=([\w.:-]+)>([\s\S]*?)(?:<\/function>|$)/g, param: /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g },
  // Claude-style XML some fine-tunes copy: <invoke name="write_file"><parameter name="path">a.js</parameter></invoke>
  { call: /<invoke\s+name="([\w.:-]+)"\s*>([\s\S]*?)(?:<\/invoke>|$)/g, param: /<parameter\s+name="([\w.-]+)"\s*>([\s\S]*?)<\/parameter>/g },
];

/** Tool calls written as XML-ish tags (qwen3-coder and others), as { calls, spans }. */
function parseXmlCalls(text, names) {
  const calls = [];
  const spans = [];
  for (const { call, param } of XML_CALLS) {
    for (const m of text.matchAll(call)) {
      const name = resolveToolName(m[1], names);
      if (!name) continue;
      const input = {};
      for (const p of m[2].matchAll(param)) input[p[1]] = xmlValue(p[2]);
      calls.push({ name, input });
      // Remove the call and any <tool_call> wrapper around it.
      let a = m.index;
      let b = m.index + m[0].length;
      const before = text.slice(0, a).match(/<tool_call>\s*$/);
      if (before) a -= before[0].length;
      const after = text.slice(b).match(/^\s*<\/tool_call>/);
      if (after) b += after[0].length;
      spans.push([a, b]);
    }
    if (calls.length) break;
  }
  return { calls, spans };
}

/**
 * Extract tool calls written as text. Accepts {"tool","input"}, {"name","arguments"},
 * {"function":{...}}, {"tool_calls":[...]} and arrays of those, with or without code fences.
 * Returns { calls, text } where text is whatever prose remains.
 */
export function parseToolCallsFromText(text, toolNames) {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const clean = stripThinking(text);
  const xml = parseXmlCalls(clean, names);
  if (xml.calls.length) {
    let rest = clean;
    for (const [a, b] of xml.spans.sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + rest.slice(b);
    return { calls: xml.calls, text: rest.trim() };
  }
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
  rest = rest.replace(/<\/?tool_call>/g, '').replace(/```(?:json)?\s*```/g, '').trim();
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
