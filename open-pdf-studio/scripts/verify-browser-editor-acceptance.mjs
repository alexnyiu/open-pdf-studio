import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateBrowserEditorAcceptanceManifest } from './browser-editor-acceptance-manifest.mjs';

const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');
const headIndex = args.indexOf('--head');
if (inputIndex < 0 || !args[inputIndex + 1]) throw new Error('--input is required');
const inputPath = path.resolve(args[inputIndex + 1]);
const expectedHead = headIndex >= 0 ? args[headIndex + 1] : process.env.GITHUB_SHA;
const manifest = JSON.parse(await readFile(inputPath, 'utf8'));
const issues = validateBrowserEditorAcceptanceManifest(manifest, { expectedHead });
if (issues.length) {
  process.stderr.write(`${issues.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Browser editor acceptance manifest passed: ${inputPath}\n`);
}
