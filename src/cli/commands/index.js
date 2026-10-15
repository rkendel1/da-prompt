import system from './system.js';
import config from './config.js';
import providers from './providers.js';
import projects from './projects.js';
import runs from './runs.js';
import pax from './pax.js';
import diagnostics from './diagnostics.js';
import stack from './stack.js';
import spec from './spec.js';

export const commands = [...system, ...config, ...providers, ...projects, ...runs, ...pax, ...diagnostics, ...stack, ...spec];
export default commands;
