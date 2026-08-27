import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('arm64 release packaging is macOS-only');
if (process.arch !== 'arm64') throw new Error('arm64 release packaging requires an Apple-silicon host');

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const binariesDir = path.join(projectDir, 'src-tauri', 'binaries');
const targetDir = path.join(repoDir, 'target');
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-';
const appPath = path.join(
  targetDir,
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
);

async function run(command, args, { cwd = projectDir, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

await mkdir(binariesDir, { recursive: true });
for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
  await run('cargo', ['build', '--release', '-p', 'pdfium-worker', '--target', target], { cwd: repoDir });
  await copyFile(
    path.join(targetDir, target, 'release', 'pdfium-worker'),
    path.join(binariesDir, `pdfium-worker-${target}`),
  );
}

const universalWorker = path.join(binariesDir, 'pdfium-worker-universal-apple-darwin');
await run('/usr/bin/lipo', [
  '-create',
  '-output', universalWorker,
  path.join(binariesDir, 'pdfium-worker-aarch64-apple-darwin'),
  path.join(binariesDir, 'pdfium-worker-x86_64-apple-darwin'),
]);
for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin']) {
  await run(process.execPath, [
    path.join(projectDir, 'scripts', 'verify-pdfium-sidecar.mjs'),
    target,
    path.join(binariesDir, `pdfium-worker-${target}`),
  ]);
}

await run(process.execPath, [path.join(projectDir, 'scripts', 'native-runtime.mjs')]);
await run(process.execPath, [path.join(projectDir, 'scripts', 'verify-ocr-assets.mjs')]);

const timestamp = signingIdentity === '-' ? '--timestamp=none' : '--timestamp';
await run('/usr/bin/codesign', [
  '--force', '--sign', signingIdentity, '--options', 'runtime', timestamp,
  path.join(binariesDir, 'macos-universal', 'libpdfium.dylib'),
]);
for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin']) {
  await run('/usr/bin/codesign', [
    '--force', '--sign', signingIdentity, '--options', 'runtime', timestamp,
    '--entitlements', path.join(projectDir, 'src-tauri', 'pdfium-worker.entitlements.plist'),
    path.join(binariesDir, `pdfium-worker-${target}`),
  ]);
}

// Tauri applies the app entitlement file to external binaries as it signs the
// bundle. Defer notarization until after the nested code is re-signed with its
// own minimal entitlement set.
const bundleEnvironment = { ...process.env, APPLE_SIGNING_IDENTITY: signingIdentity };
for (const name of [
  'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH',
]) delete bundleEnvironment[name];

await run('npm', [
  'run', 'tauri', '--', 'build',
  '--target', 'aarch64-apple-darwin',
  '--bundles', 'app',
  '--config', '{"bundle":{"createUpdaterArtifacts":false}}',
], {
  env: bundleEnvironment,
});

const bundledPdfium = path.join(appPath, 'Contents', 'Resources', 'libpdfium.dylib');
const bundledWorker = path.join(appPath, 'Contents', 'MacOS', 'pdfium-worker');
await run('/usr/bin/codesign', [
  '--force', '--sign', signingIdentity, '--options', 'runtime', timestamp,
  bundledPdfium,
]);
await run('/usr/bin/codesign', [
  '--force', '--sign', signingIdentity, '--options', 'runtime', timestamp,
  '--entitlements', path.join(projectDir, 'src-tauri', 'pdfium-worker.entitlements.plist'),
  bundledWorker,
]);
await run('/usr/bin/codesign', [
  '--force', '--sign', signingIdentity, '--options', 'runtime', timestamp,
  '--entitlements', path.join(projectDir, 'src-tauri', 'entitlements.plist'),
  appPath,
]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
// Exercise the final, signed nested artifact. A structurally valid signature is
// insufficient if a later deep-sign step stripped the worker's library-
// validation entitlement or if the resource landed outside its lookup roots.
await run(bundledWorker, ['--probe-pdfium']);

const apiCredentials = process.env.APPLE_API_KEY
  && process.env.APPLE_API_ISSUER
  && process.env.APPLE_API_KEY_PATH;
const appleIdCredentials = process.env.APPLE_ID
  && process.env.APPLE_PASSWORD
  && process.env.APPLE_TEAM_ID;
if (signingIdentity !== '-' && (apiCredentials || appleIdCredentials)) {
  const notarizationDir = await mkdtemp(path.join(tmpdir(), 'opds-notarization-'));
  const archivePath = path.join(notarizationDir, 'Open PDF Studio.zip');
  try {
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archivePath]);
    const authentication = apiCredentials
      ? [
        '--key', process.env.APPLE_API_KEY_PATH,
        '--key-id', process.env.APPLE_API_KEY,
        '--issuer', process.env.APPLE_API_ISSUER,
      ]
      : [
        '--apple-id', process.env.APPLE_ID,
        '--password', process.env.APPLE_PASSWORD,
        '--team-id', process.env.APPLE_TEAM_ID,
      ];
    await run('/usr/bin/xcrun', ['notarytool', 'submit', archivePath, '--wait', ...authentication]);
    await run('/usr/bin/xcrun', ['stapler', 'staple', appPath]);
    await run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  } finally {
    await rm(notarizationDir, { recursive: true, force: true });
  }
} else if (signingIdentity !== '-') {
  process.stderr.write('Skipping notarization: complete Apple notarization credentials are unavailable.\n');
}

process.stdout.write(`${appPath}\n`);
