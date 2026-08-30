import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PackagedAppLaunchError,
  preflightPackagedApp,
} from './lib/macos-packaged-app.mjs';

if (process.platform !== 'darwin') throw new Error('packaged launch preflight is macOS-only');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const appBundle = path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || path.join(
  repoDir, 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Open PDF Studio.app',
));
const artifactDir = path.resolve(process.env.OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR
  || path.join(projectDir, 'test-artifacts', 'packaged-launch-preflight'));
const reportPath = path.join(artifactDir, 'preflight.json');

await mkdir(artifactDir, { recursive: true });
try {
  const result = await preflightPackagedApp({
    appBundle,
    cwd: projectDir,
    artifactDir,
    startupTimeoutMs: 90_000,
  });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Packaged launch preflight passed: ${reportPath}`);
} catch (error) {
  const report = {
    contract: 'open-pdf-studio.packaged-launch-preflight',
    schemaVersion: 1,
    status: 'UNVERIFIED',
    generatedAt: new Date().toISOString(),
    bundlePath: appBundle,
    reason: error instanceof PackagedAppLaunchError
      ? 'packaged app did not reach WebView readiness in the available GUI execution context'
      : 'packaged launch preflight could not execute',
    launchEvidence: error?.evidence || null,
    error: error?.stack || error?.message || String(error),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
}
