// Shared by the test files: each test file gets its own data folder, because test files run in parallel processes and an
// application's store has exactly one writer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'));
