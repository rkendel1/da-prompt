#!/usr/bin/env node
// Install an optional agent engine into <data dir>/engines (NOT into this project: da-prompt has no runtime dependencies).
//   npm run engine:install -- fx          install @appport/fx
//   npm run engine:install -- fx --remove uninstall it again
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ENGINES, enginesDir } from '../src/engines/index.js';

const [id, flag] = process.argv.slice(2);
const engine = ENGINES.find((e) => e.id === id && e.package);
if (!engine) {
  console.error(`Usage: npm run engine:install -- <${ENGINES.filter((e) => e.package).map((e) => e.id).join('|')}> [--remove]`);
  process.exit(2);
}
const cfg = loadConfig();
const dir = enginesDir(cfg);
fs.mkdirSync(dir, { recursive: true });
const pkgFile = path.join(dir, 'package.json');
if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify({ name: 'da-prompt-engines', private: true, type: 'module' }, null, 2));
const args = flag === '--remove' ? ['uninstall', engine.package] : ['install', '--ignore-scripts', '--no-audit', '--no-fund', engine.package];
console.log(`npm ${args.join(' ')}   (in ${dir})`);
const r = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
if (r.status === 0) console.log(flag === '--remove' ? `Removed ${engine.package}. The built-in engine is unaffected.` : `Installed ${engine.package}. Choose "${id}" as the Agent engine for a run (or in Settings → Models).`);
process.exit(r.status ?? 1);
