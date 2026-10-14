// Compute execution: run an agent's shell commands inside a Compute environment instead of on the host.
// This only changes HOW a command is launched (Workspace.runCommand still applies the deny list, the project policy,
// the scrubbed environment, the timeout and output caps). File access stays on Workspace; the workspace directory
// must be visible inside the environment at the same path.
//
// The Compute CLI's exec syntax is not baked in: FACTORY_COMPUTE_EXEC is a JSON argv template, e.g.
//   ["compute","exec","{environment}","--","{inner}"]
// "{inner}" (an element on its own) expands to the real argv; "{environment}" and "{cwd}" are substituted elsewhere.

export function computeLauncher(cfg = {}) {
  const c = cfg.compute || {};
  if (!c.enabled) return null;
  const template = c.exec;
  if (!Array.isArray(template) || !template.length || !template.includes('{inner}')) {
    throw new Error('compute is enabled but FACTORY_COMPUTE_EXEC must be a JSON argv array containing "{inner}"');
  }
  return ({ command, cwd, env }) => {
    const inner = ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'sh', '-c', `cd ${shq(cwd)} && ${command}`];
    const argv = template.flatMap((t) => (t === '{inner}' ? inner : [String(t).replaceAll('{environment}', c.environment || '').replaceAll('{cwd}', cwd)]));
    return { file: argv[0], args: argv.slice(1), env: process.env.PATH ? { PATH: process.env.PATH } : {} };
  };
}

export function computeConfig(env = process.env) {
  let exec = null;
  try {
    exec = env.FACTORY_COMPUTE_EXEC ? JSON.parse(env.FACTORY_COMPUTE_EXEC) : null;
  } catch {
    exec = null;
  }
  return { enabled: /^(1|true|on|yes)$/i.test(env.FACTORY_COMPUTE || ''), environment: env.FACTORY_COMPUTE_ENV || 'workstation', exec };
}

function shq(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}
