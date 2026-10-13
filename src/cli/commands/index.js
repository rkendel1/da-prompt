import system from './system.js';
import config from './config.js';
import providers from './providers.js';
import projects from './projects.js';
import runs from './runs.js';
import pax from './pax.js';

export const commands = [...system, ...config, ...providers, ...projects, ...runs, ...pax];
export default commands;
