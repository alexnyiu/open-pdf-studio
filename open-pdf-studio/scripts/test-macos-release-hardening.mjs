import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startPackagedApp } from './lib/macos-packaged-app.mjs';
import { verifyOcrAssets } from './verify-ocr-assets.mjs';
import { verifyExecutableTarget } from './verify-pdfium-sidecar.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultAppPath = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
);

function parseArguments(argv) {
  const options = {
    appPath: process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultAppPath,
    dmgPath: null,
    outputPath: path.join(projectDir, 'output', 'ocr-release-hardening', 'artifact-latest.json'),
    expectedAppArchitecture: 'arm64',
    requireDistributionTrust: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') options.appPath = path.resolve(argv[++index]);
    else if (value === '--dmg') options.dmgPath = path.resolve(argv[++index]);
    else if (value === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (value === '--expected-app-architecture') options.expectedAppArchitecture = argv[++index];
    else if (value === '--require-distribution-trust') options.requireDistributionTrust = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!['arm64', 'universal'].includes(options.expectedAppArchitecture)) {
    throw new Error('--expected-app-architecture must be arm64 or universal');
  }
  return options;
}

function textOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

async function commandResult(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd || projectDir,
      env: options.env || process.env,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout?.toString?.() || '',
      stderr: error.stderr?.toString?.() || error.message || String(error),
    };
  }
}

async function requiredCommand(command, args, options = {}) {
  const result = await commandResult(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.code}): ${textOutput(result)}`);
  }
  return result;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function directoryBytes(filePath) {
  const information = await lstat(filePath);
  if (!information.isDirectory()) return information.size;
  let total = 0;
  for (const name of await readdir(filePath)) total += await directoryBytes(path.join(filePath, name));
  return total;
}

async function regularFiles(root) {
  const result = [];
  async function visit(current) {
    const information = await lstat(current);
    if (information.isSymbolicLink()) return;
    if (information.isFile()) {
      result.push(current);
      return;
    }
    if (!information.isDirectory()) return;
    for (const name of await readdir(current)) await visit(path.join(current, name));
  }
  await visit(root);
  return result;
}

async function isMachO(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 4) return false;
    return new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
      .has(header.toString('hex'));
  } finally {
    await handle.close();
  }
}

async function packagedMachOFiles(appPath) {
  const result = [];
  for (const filePath of await regularFiles(appPath)) {
    if (await isMachO(filePath)) result.push(filePath);
  }
  return result.sort();
}

function entry(status, evidence) {
  return { status, ...evidence };
}

function summarizeCriteria(criteria) {
  const values = Object.values(criteria);
  if (values.some((value) => value.status === 'FAIL')) return 'FAIL';
  if (values.some((value) => value.status === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'PASS';
}

function entitlementKeys(display) {
  return [...display.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]).sort();
}

async function verifyDistAssets(sourceVerification) {
  const publicRoot = path.join(projectDir, 'public', 'ocr', 'pp-ocrv6-small');
  const distRoot = path.join(projectDir, 'dist', 'ocr', 'pp-ocrv6-small');
  const publicManifest = path.join(publicRoot, 'manifest.json');
  const distManifest = path.join(distRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(publicManifest, 'utf8'));
  if (await sha256(publicManifest) !== await sha256(distManifest)) {
    throw new Error('built OCR manifest differs from the pinned public manifest');
  }
  const models = [];
  for (const record of Object.values(manifest.assets)) {
    const filePath = path.join(distRoot, record.file);
    const information = await stat(filePath);
    const digest = await sha256(filePath);
    if (information.size !== record.bytes || digest !== record.sha256) {
      throw new Error(`built OCR asset mismatch: ${record.file}`);
    }
    models.push({ file: path.relative(projectDir, filePath), bytes: information.size, sha256: digest });
  }

  const assetDir = path.join(projectDir, 'dist', 'assets');
  const names = await readdir(assetDir);
  const runtime = [];
  for (const source of sourceVerification.runtime) {
    const suffix = path.extname(source.file);
    const candidates = names.filter((name) => name.startsWith('ort-wasm-simd-threaded-') && name.endsWith(suffix));
    const matches = [];
    for (const name of candidates) {
      const filePath = path.join(assetDir, name);
      if (await sha256(filePath) === source.sha256) matches.push(filePath);
    }
    if (matches.length !== 1) {
      throw new Error(`built ONNX Runtime ${suffix} asset did not match its pinned checksum exactly once`);
    }
    const information = await stat(matches[0]);
    if (information.size !== source.bytes) throw new Error(`built ONNX Runtime ${suffix} size mismatch`);
    runtime.push({ file: path.relative(projectDir, matches[0]), bytes: information.size, sha256: source.sha256 });
  }
  return { manifestSha256: await sha256(distManifest), models, runtime };
}

async function signAdHocRuntime(target, entitlements = null) {
  const args = ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none'];
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(target);
  await requiredCommand('/usr/bin/codesign', args);
}

async function verifyHardenedRuntimeApp(appPath, tempRoot) {
  const copyRoot = path.join(tempRoot, 'hardened-app');
  const copiedApp = path.join(copyRoot, 'Open PDF Studio.app');
  await mkdir(copyRoot, { recursive: true });
  await requiredCommand('/usr/bin/ditto', [appPath, copiedApp]);
  const dylib = path.join(copiedApp, 'Contents', 'Resources', 'libpdfium.dylib');
  const worker = path.join(copiedApp, 'Contents', 'MacOS', 'pdfium-worker');
  await signAdHocRuntime(dylib);
  await signAdHocRuntime(worker, path.join(projectDir, 'src-tauri', 'pdfium-worker.entitlements.plist'));
  await signAdHocRuntime(copiedApp, path.join(projectDir, 'src-tauri', 'entitlements.plist'));
  await requiredCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', copiedApp]);
  const [appDisplay, workerDisplay, probe] = await Promise.all([
    requiredCommand('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', copiedApp]),
    requiredCommand('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', worker]),
    requiredCommand(worker, ['--probe-pdfium']),
  ]);
  const appSigning = textOutput(appDisplay);
  const workerSigning = textOutput(workerDisplay);
  if (!/flags=.*runtime/iu.test(appSigning)) throw new Error('hardened test app lacks the runtime flag');
  if (!/flags=.*runtime/iu.test(workerSigning)) throw new Error('hardened worker lacks the runtime flag');
  if (!/disable-library-validation/iu.test(workerSigning)) {
    throw new Error('hardened worker lacks its library-validation entitlement');
  }
  if (!/"pdfium"\s*:\s*"ready"/u.test(textOutput(probe))) {
    throw new Error('hardened packaged worker did not initialize PDFium');
  }

  const app = await startPackagedApp({
    appBinary: path.join(copiedApp, 'Contents', 'MacOS', 'open-pdf-studio'),
    cwd: projectDir,
    env: {
      OPS_TEST_SESSION_PATH: path.join(tempRoot, 'hardened-session.json'),
      OPS_TEST_OCR_CACHE_DIR: path.join(tempRoot, 'hardened-cache'),
    },
  });
  try {
    const tabs = await app.callTool('app_list_tabs');
    if (tabs?.ok !== true) throw new Error(`hardened packaged app MCP smoke failed: ${tabs?.error}`);
  } finally {
    await app.stop();
  }
  return {
    appRuntime: true,
    workerRuntime: true,
    workerLibraryValidationEntitlement: true,
    packagedMcpSmoke: 'pass',
  };
}

async function verifyUniversalSidecarAndPdfium(tempRoot) {
  const binariesDir = path.join(projectDir, 'src-tauri', 'binaries');
  const armWorker = path.join(binariesDir, 'pdfium-worker-aarch64-apple-darwin');
  const intelWorker = path.join(binariesDir, 'pdfium-worker-x86_64-apple-darwin');
  const pdfium = path.join(binariesDir, 'macos-universal', 'libpdfium.dylib');
  await Promise.all([access(armWorker), access(intelWorker), access(pdfium)]);
  const universalWorker = path.join(tempRoot, 'pdfium-worker-universal-apple-darwin');
  await requiredCommand('/usr/bin/lipo', ['-create', '-output', universalWorker, armWorker, intelWorker]);
  const [arm, intel, universal, libraryArchitectures] = await Promise.all([
    verifyExecutableTarget(await readFile(armWorker), 'aarch64-apple-darwin'),
    verifyExecutableTarget(await readFile(intelWorker), 'x86_64-apple-darwin'),
    verifyExecutableTarget(await readFile(universalWorker), 'universal-apple-darwin'),
    requiredCommand('/usr/bin/lipo', ['-archs', pdfium]),
  ]);
  const pdfiumArchitectures = libraryArchitectures.stdout.trim().split(/\s+/u).sort();
  if (pdfiumArchitectures.join(',') !== ['arm64', 'x86_64'].sort().join(',')) {
    throw new Error(`PDFium is not universal: ${pdfiumArchitectures.join(',')}`);
  }

  const probeRoot = path.join(tempRoot, 'universal-probe', 'Contents');
  const probeMacos = path.join(probeRoot, 'MacOS');
  const probeResources = path.join(probeRoot, 'Resources');
  await Promise.all([mkdir(probeMacos, { recursive: true }), mkdir(probeResources, { recursive: true })]);
  const stagedWorker = path.join(probeMacos, 'pdfium-worker');
  const stagedPdfium = path.join(probeResources, 'libpdfium.dylib');
  await Promise.all([copyFile(universalWorker, stagedWorker), copyFile(pdfium, stagedPdfium)]);
  await chmod(stagedWorker, 0o755);
  await signAdHocRuntime(stagedPdfium);
  await signAdHocRuntime(stagedWorker, path.join(projectDir, 'src-tauri', 'pdfium-worker.entitlements.plist'));

  const probes = {};
  for (const architecture of ['arm64', 'x86_64']) {
    const result = await requiredCommand('/usr/bin/arch', [`-${architecture}`, stagedWorker, '--probe-pdfium']);
    if (!/"pdfium"\s*:\s*"ready"/u.test(textOutput(result))) {
      throw new Error(`${architecture} universal sidecar slice did not initialize universal PDFium`);
    }
    probes[architecture] = 'pass';
  }
  return { arm, intel, universal, pdfiumArchitectures, probes };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('release hardening gate is macOS-only');
  const options = parseArguments(process.argv.slice(2));
  const appPath = path.resolve(options.appPath);
  const appBinary = path.join(appPath, 'Contents', 'MacOS', 'open-pdf-studio');
  const bundledWorker = path.join(appPath, 'Contents', 'MacOS', 'pdfium-worker');
  const bundledPdfium = path.join(appPath, 'Contents', 'Resources', 'libpdfium.dylib');
  // Tauri rejects executables whose canonical startup path traverses a symlink.
  // Node reports /var/... on macOS even though /var resolves to /private/var, so
  // place the hardened bundle copy under the canonical temporary directory.
  const canonicalTmp = await realpath(tmpdir());
  const tempRoot = await mkdtemp(path.join(canonicalTmp, 'opds-release-hardening-'));
  const criteria = {};
  const report = {
    contract: 'open-pdf-studio.macos-release-hardening',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    appPath,
    expectedAppArchitecture: options.expectedAppArchitecture,
    distributionTrustRequired: options.requireDistributionTrust,
    criteria,
  };

  async function check(name, operation) {
    try {
      criteria[name] = entry('PASS', await operation());
    } catch (error) {
      criteria[name] = entry('FAIL', { error: error.message || String(error) });
    }
  }

  await check('arm64AppPackaging', async () => {
    await Promise.all([access(appPath), access(appBinary), access(bundledWorker), access(bundledPdfium)]);
    const [mainArchitectures, workerArchitectures, pdfiumArchitectures, plist] = await Promise.all([
      requiredCommand('/usr/bin/lipo', ['-archs', appBinary]),
      requiredCommand('/usr/bin/lipo', ['-archs', bundledWorker]),
      requiredCommand('/usr/bin/lipo', ['-archs', bundledPdfium]),
      requiredCommand('/usr/bin/plutil', ['-p', path.join(appPath, 'Contents', 'Info.plist')]),
    ]);
    const main = mainArchitectures.stdout.trim().split(/\s+/u).sort();
    const expected = options.expectedAppArchitecture === 'universal'
      ? ['arm64', 'x86_64'].sort()
      : ['arm64'];
    if (main.join(',') !== expected.join(',')) {
      throw new Error(`app architecture mismatch: expected ${expected.join('+')}, got ${main.join('+')}`);
    }
    if (!plist.stdout.includes('org.openaec.openpdfstudio') || !plist.stdout.includes('1.85.0')) {
      throw new Error('packaged Info.plist identity/version mismatch');
    }
    return {
      appArchitectures: main,
      bundledWorkerArchitectures: workerArchitectures.stdout.trim().split(/\s+/u).sort(),
      bundledPdfiumArchitectures: pdfiumArchitectures.stdout.trim().split(/\s+/u).sort(),
      bundleIdentifier: 'org.openaec.openpdfstudio',
      version: '1.85.0',
    };
  });

  await check('universalSidecarAndPdfiumProbes', () => verifyUniversalSidecarAndPdfium(tempRoot));

  await check('bundledModelAssetsAndChecksums', async () => {
    const source = await verifyOcrAssets();
    const built = await verifyDistAssets(source);
    return { source, built, packagedLoadProof: 'covered by the packaged OCR workflow suite' };
  });

  await check('hardenedRuntimeCompatibility', () => verifyHardenedRuntimeApp(appPath, tempRoot));

  let signatureDisplay = '';
  await check('codeSigningValidation', async () => {
    const codeObjects = await packagedMachOFiles(appPath);
    if (codeObjects.length === 0) throw new Error('packaged app contains no Mach-O code objects');
    const hashesBeforeVerification = Object.fromEntries(await Promise.all(codeObjects.map(async (filePath) => [
      path.relative(appPath, filePath),
      await sha256(filePath),
    ])));
    await requiredCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
    const display = await requiredCommand('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', appPath]);
    signatureDisplay = textOutput(display);
    if (!/flags=.*runtime/iu.test(signatureDisplay)) {
      throw new Error('packaged app signature does not enable the hardened runtime');
    }
    const verifiedCodeObjects = [];
    for (const filePath of codeObjects) {
      await requiredCommand('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', filePath]);
      const requirement = await requiredCommand('/usr/bin/codesign', ['-d', '-r-', filePath]);
      const requirementText = textOutput(requirement);
      if (!/designated\s*=>/iu.test(requirementText)) {
        throw new Error(`code object lacks a designated requirement: ${path.relative(appPath, filePath)}`);
      }
      verifiedCodeObjects.push({
        path: path.relative(appPath, filePath),
        designatedRequirement: requirementText.replace(/^[\s\S]*?designated\s*=>\s*/iu, '').trim(),
      });
    }
    const hashesAfterVerification = Object.fromEntries(await Promise.all(codeObjects.map(async (filePath) => [
      path.relative(appPath, filePath),
      await sha256(filePath),
    ])));
    if (JSON.stringify(hashesBeforeVerification) !== JSON.stringify(hashesAfterVerification)) {
      throw new Error('post-sign verification changed packaged code-object bytes');
    }
    return {
      validOnDisk: true,
      hardenedRuntime: true,
      signatureKind: /Signature=adhoc/iu.test(signatureDisplay) ? 'ad-hoc' : 'identity',
      codeObjectsVerified: verifiedCodeObjects.length,
      codeObjects: verifiedCodeObjects,
      designatedRequirementsValid: true,
      postSignArtifactIntegrity: true,
      hashesBeforeVerification,
      hashesAfterVerification,
    };
  });

  await check('entitlementsIntentionalAndMinimal', async () => {
    const [appDisplay, workerDisplay, pdfiumDisplay] = await Promise.all([
      requiredCommand('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath]),
      requiredCommand('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundledWorker]),
      requiredCommand('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundledPdfium]),
    ]);
    const actual = {
      app: entitlementKeys(textOutput(appDisplay)),
      worker: entitlementKeys(textOutput(workerDisplay)),
      pdfium: entitlementKeys(textOutput(pdfiumDisplay)),
    };
    const expected = {
      app: [
        'com.apple.security.cs.allow-jit',
        'com.apple.security.cs.allow-unsigned-executable-memory',
        'com.apple.security.cs.disable-library-validation',
        'com.apple.security.files.user-selected.read-write',
        'com.apple.security.network.client',
      ].sort(),
      worker: ['com.apple.security.cs.disable-library-validation'],
      pdfium: [],
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`packaged entitlement set mismatch: ${JSON.stringify(actual)}`);
    }
    return { actual, expected, exactMatch: true };
  });

  const developerId = /Authority=Developer ID Application:/iu.test(signatureDisplay)
    && /TeamIdentifier=(?!not set)\S+/iu.test(signatureDisplay);
  const identities = await commandResult('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identityCount = Number.parseInt(textOutput(identities).match(/(\d+) valid identities found/u)?.[1] || '0', 10);
  if (developerId) {
    criteria.developerIdSigning = entry('PASS', { artifact: 'Developer ID Application', availableIdentityCount: identityCount });
  } else {
    criteria.developerIdSigning = entry(
      options.requireDistributionTrust ? 'FAIL' : 'UNVERIFIED',
      {
        artifact: /Signature=adhoc/iu.test(signatureDisplay) ? 'ad-hoc' : 'not Developer ID',
        availableIdentityCount: identityCount,
        requiredIdentity: 'Developer ID Application',
        reason: 'No Developer ID signed artifact was available; ad-hoc signing is only hardened-runtime compatibility evidence.',
      },
    );
  }

  const stapler = await commandResult('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  if (developerId && stapler.code === 0) {
    criteria.notarization = entry('PASS', { stapledTicketValidated: true });
  } else {
    criteria.notarization = entry(
      options.requireDistributionTrust ? 'FAIL' : 'UNVERIFIED',
      {
        stapledTicketValidated: false,
        reason: developerId
          ? `Developer ID artifact has no valid stapled ticket: ${textOutput(stapler)}`
          : 'No Developer ID artifact was submitted to Apple; no live notarization is claimed.',
        credentialAvailability: {
          appleIdProfile: Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID),
          appStoreConnectApi: Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER),
        },
      },
    );
  }

  const gatekeeper = await commandResult('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  if (developerId && gatekeeper.code === 0) {
    criteria.gatekeeperAssessment = entry('PASS', { accepted: true, assessment: textOutput(gatekeeper) });
  } else {
    criteria.gatekeeperAssessment = entry(
      options.requireDistributionTrust ? 'FAIL' : 'UNVERIFIED',
      {
        accepted: false,
        reason: developerId
          ? `Gatekeeper rejected the Developer ID artifact: ${textOutput(gatekeeper)}`
          : 'Gatekeeper rejection of an ad-hoc build is expected and is not release-distribution evidence.',
      },
    );
  }

  if (developerId && stapler.code === 0 && gatekeeper.code === 0) {
    await check('quarantineDownloadStyleLaunch', async () => {
      const quarantineRoot = path.join(tempRoot, 'quarantine-launch');
      const quarantinedApp = path.join(quarantineRoot, 'Open PDF Studio.app');
      await mkdir(quarantineRoot, { recursive: true });
      await requiredCommand('/usr/bin/ditto', [appPath, quarantinedApp]);
      const quarantineValue = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;OpenPDFStudioReleaseQualification`;
      await requiredCommand('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue, quarantinedApp]);
      const attribute = await requiredCommand('/usr/bin/xattr', ['-p', 'com.apple.quarantine', quarantinedApp]);
      if (!textOutput(attribute).includes('OpenPDFStudioReleaseQualification')) {
        throw new Error('quarantine attribute was not retained on the staged app');
      }
      await requiredCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', quarantinedApp]);
      await requiredCommand('/bin/bash', [path.join(projectDir, 'scripts', 'macos-startup-smoke.sh'), quarantinedApp], {
        maxBuffer: 64 * 1024 * 1024,
      });
      await requiredCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', quarantinedApp]);
      return {
        quarantineAttribute: 'present',
        gatekeeperAssessment: 'accepted',
        visibleFrontendReadyLaunch: 'pass',
        postLaunchSignatureIntegrity: 'pass',
      };
    });
  } else {
    criteria.quarantineDownloadStyleLaunch = entry(
      options.requireDistributionTrust ? 'FAIL' : 'UNVERIFIED',
      {
        reason: 'A quarantine/download-style launch cannot qualify without a Developer ID signature, notarization ticket, and passing Gatekeeper assessment.',
      },
    );
  }

  await check('cacheApplicationDataCleanup', async () => {
    const result = await requiredCommand('cargo', [
      'test', '-p', 'open-pdf-studio',
      'cache_clear_removes_only_managed_application_data',
      '--', '--nocapture',
    ], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 });
    if (!/test result: ok/iu.test(textOutput(result))) throw new Error('focused OCR cache cleanup test did not pass');
    return {
      managedCacheRemoved: true,
      unrelatedApplicationDataPreserved: true,
      isolatedRuntimeDirectories: [
        path.join(tempRoot, 'hardened-cache'),
        path.join(tempRoot, 'hardened-session.json'),
      ],
    };
  });

  await check('installerSizeMeasurement', async () => {
    const logicalAppBytes = await directoryBytes(appPath);
    const allocated = await requiredCommand('/usr/bin/du', ['-sk', appPath]);
    let dmgPath = options.dmgPath;
    let temporary = false;
    if (!dmgPath) {
      dmgPath = path.join(tempRoot, 'Open-PDF-Studio-arm64-measurement.dmg');
      await requiredCommand('/usr/bin/hdiutil', [
        'create', '-volname', 'Open PDF Studio', '-srcfolder', appPath,
        '-ov', '-format', 'UDZO', dmgPath,
      ], { maxBuffer: 64 * 1024 * 1024 });
      temporary = true;
    }
    await requiredCommand('/usr/bin/hdiutil', ['verify', dmgPath], { maxBuffer: 64 * 1024 * 1024 });
    const dmg = await stat(dmgPath);
    return {
      logicalAppBytes,
      allocatedAppKiB: Number.parseInt(allocated.stdout.trim().split(/\s+/u)[0], 10),
      installerDmgBytes: dmg.size,
      measurementArtifact: temporary ? 'temporary unsigned compressed DMG' : 'provided release DMG',
      temporaryArtifactDeletedAfterMeasurement: temporary,
    };
  });

  try {
    await rm(tempRoot, { recursive: true, force: true });
    try {
      await access(tempRoot);
      criteria.temporaryArtifactCleanup = entry('FAIL', { reason: 'temporary release-hardening directory still exists' });
    } catch {
      criteria.temporaryArtifactCleanup = entry('PASS', {
        temporaryDiskImagesCommitted: false,
        machineSpecificArtifactsCommitted: false,
      });
    }
  } catch (error) {
    criteria.temporaryArtifactCleanup = entry('FAIL', { reason: error.message || String(error) });
  }

  report.overallStatus = summarizeCriteria(criteria);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.overallStatus === 'FAIL') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
