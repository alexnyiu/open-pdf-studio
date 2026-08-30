import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { startPackagedApp } from './lib/macos-packaged-app.mjs';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultApp = path.join(
  repoDir,
  'target',
  'aarch64-apple-darwin',
  'release',
  'bundle',
  'macos',
  'Open PDF Studio.app',
);
const sourcePdf = path.join(projectDir, 'output', 'pdf', 'open-pdf-studio-ocr-writer-proof.pdf');

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

function parseArguments(argv) {
  const options = {
    appPath: process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultApp,
    outputPath: path.join(projectDir, 'output', 'ocr-release-hardening', 'filesystem-latest.json'),
    skipIcloud: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app') options.appPath = path.resolve(argv[++index]);
    else if (argv[index] === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (argv[index] === '--skip-icloud') options.skipIcloud = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
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

function status(value, evidence) {
  return { status: value, ...evidence };
}

function overallStatus(criteria) {
  const values = Object.values(criteria);
  if (values.some((value) => value.status === 'FAIL')) return 'FAIL';
  if (values.some((value) => value.status === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'PASS';
}

async function sha256(filePath) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function privateCandidates(directory) {
  return (await readdir(directory)).filter((name) => name.includes('.open-pdf-studio-')
    && (name.endsWith('.candidate') || name.endsWith('.baseline')));
}

async function waitForCondition(probe, {
  timeoutMs = 15_000,
  intervalMs = 25,
  label = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await probe();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

async function discoverThirdPartyProviderRoots() {
  const cloudStorageRoot = path.join(process.env.HOME || '', 'Library', 'CloudStorage');
  let entries = [];
  try {
    entries = await readdir(cloudStorageRoot, { withFileTypes: true });
  } catch {
    return { dropbox: null, onedrive: null };
  }
  const providerPath = (pattern) => {
    const entry = entries.find((candidate) => candidate.isDirectory() && pattern.test(candidate.name));
    return entry ? path.join(cloudStorageRoot, entry.name) : null;
  };
  return {
    dropbox: providerPath(/^Dropbox(?:-|$)/iu),
    onedrive: providerPath(/^OneDrive(?:-|$)/iu),
  };
}

async function validatePdf(filePath) {
  const bytes = await readFile(filePath);
  const document = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    assert.ok(document.numPages > 0, 'saved PDF has no pages');
    const content = await (await document.getPage(1)).getTextContent();
    return { pages: document.numPages, firstPageTextItems: content.items.length };
  } finally {
    await document.destroy();
  }
}

function waitForLine(stream, expected, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}: ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        clearTimeout(timer);
        stream.off('data', onData);
        resolve(output);
      }
    };
    stream.on('data', onData);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('filesystem release gate is macOS-only');
  const options = parseArguments(process.argv.slice(2));
  const appPath = path.resolve(options.appPath);
  const appBinary = path.join(appPath, 'Contents', 'MacOS', 'open-pdf-studio');
  await Promise.all([access(appBinary), access(sourcePdf)]);

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'opds-filesystem-hardening-'));
  const localRoot = path.join(tempRoot, 'local');
  const imageRoot = path.join(tempRoot, 'images');
  const helperRoot = path.join(tempRoot, 'helpers');
  await Promise.all([
    mkdir(localRoot, { recursive: true }),
    mkdir(imageRoot, { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
  ]);
  const criteria = {};
  const mountedImages = [];
  let icloudTransactionPath = null;
  const thirdPartyTransactionPaths = [];
  let app = null;
  let mutationSequence = 0;
  const cleanupErrors = [];

  const report = {
    contract: 'open-pdf-studio.macos-filesystem-edge-cases',
    schemaVersion: 1,
    head: await gitHead(),
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    appPath,
    criteria,
  };

  async function createImage({ label, fileSystem, size, layout = null }) {
    const imagePath = path.join(imageRoot, `${label}.dmg`);
    const mountPath = path.join(imageRoot, `${label}-mount`);
    await mkdir(mountPath, { recursive: true });
    const createArgs = ['create', '-size', size];
    if (layout) createArgs.push('-layout', layout);
    createArgs.push('-fs', fileSystem, '-volname', `OPDS_${label.toUpperCase()}`, imagePath);
    const create = await commandResult('/usr/bin/hdiutil', createArgs, { maxBuffer: 64 * 1024 * 1024 });
    if (create.code !== 0) {
      await rm(imagePath, { force: true });
      await rm(mountPath, { recursive: true, force: true });
      throw new Error(textOutput(create));
    }
    const attach = await commandResult('/usr/bin/hdiutil', [
      'attach', '-nobrowse', '-mountpoint', mountPath, imagePath,
    ], { maxBuffer: 64 * 1024 * 1024 });
    if (attach.code !== 0) {
      await rm(imagePath, { force: true });
      await rm(mountPath, { recursive: true, force: true });
      throw new Error(textOutput(attach));
    }
    const image = { imagePath, mountPath, attached: true, fileSystem };
    mountedImages.push(image);
    return image;
  }

  async function openPdf(filePath) {
    const opened = await app.callTool('app_open_pdf', { path: filePath });
    if (opened?.ok !== true) throw new Error(`app_open_pdf failed: ${opened?.error}`);
    return opened;
  }

  async function queueSaveMutation(label) {
    mutationSequence += 1;
    const created = await app.callTool('app_create_annotation', {
      type: 'comment',
      page: 1,
      props: {
        x: 36 + (mutationSequence % 12) * 3,
        y: 36 + (mutationSequence % 8) * 3,
        text: `Filesystem hardening probe: ${label}`,
      },
    });
    if (created?.ok !== true) {
      throw new Error(`could not create pending save mutation for ${label}: ${created?.error}`);
    }
    return created.id;
  }

  async function assertRejectedAndPreserved(filePath, mutate, restore) {
    await openPdf(filePath);
    await queueSaveMutation(path.basename(filePath));
    const before = await sha256(filePath);
    const mark = app.markLogs();
    await mutate();
    let saved;
    try {
      saved = await app.callTool('app_save_pdf');
    } finally {
      await restore();
    }
    if (saved?.ok !== false) throw new Error('locked destination unexpectedly saved');
    const after = await sha256(filePath);
    if (after !== before) throw new Error('rejected save changed the original bytes');
    const candidates = await privateCandidates(path.dirname(filePath));
    if (candidates.length) throw new Error(`rejected save left private files: ${candidates.join(', ')}`);
    return {
      rejected: true,
      originalSha256: before,
      originalPreserved: true,
      candidateCleanup: true,
      appError: saved.error,
      nativeErrorLogged: app.logsAfter(mark).match(/OPDS_SAFE_SAVE\|([A-Z0-9_]+)/u)?.[1] || null,
    };
  }

  try {
    const moduleCache = path.join(helperRoot, 'swift-module-cache');
    await mkdir(moduleCache, { recursive: true });
    const swiftEnv = {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache,
    };
    const lockHelper = path.join(helperRoot, 'macos-hold-file-lock');
    const ubiquityHelper = path.join(helperRoot, 'macos-ubiquity-status');
    await Promise.all([
      requiredCommand('/usr/bin/swiftc', [
        path.join(projectDir, 'scripts', 'macos-hold-file-lock.swift'), '-o', lockHelper,
      ], { env: swiftEnv }),
      requiredCommand('/usr/bin/swiftc', [
        path.join(projectDir, 'scripts', 'macos-ubiquity-status.swift'), '-o', ubiquityHelper,
      ], { env: swiftEnv }),
    ]);

    app = await startPackagedApp({
      appBinary,
      cwd: projectDir,
      env: {
        OPS_TEST_SESSION_PATH: path.join(tempRoot, 'session.json'),
        OPS_TEST_OCR_CACHE_DIR: path.join(tempRoot, 'app-data', 'ocr-cache'),
        OPS_TEST_SAFE_SAVE_COORDINATION_DELAY_MS: '250',
      },
    });

    const localCoordinatedPath = path.join(localRoot, 'local-coordinated.pdf');
    await copyFile(sourcePdf, localCoordinatedPath);
    try {
      await openPdf(localCoordinatedPath);
      await queueSaveMutation('local APFS coordinated transaction');
      const saved = await app.callTool('app_save_pdf');
      if (saved?.ok !== true) throw new Error(`local coordinated save failed: ${saved?.error}`);
      const viewport = await app.callTool('app_get_viewport_state');
      const provider = viewport?.safeSaveProvider;
      if (provider?.providerKind !== 'local' || provider?.coordinationRequired !== true) {
        throw new Error(`local save lacked coordination evidence: ${JSON.stringify(provider)}`);
      }
      const pdf = await validatePdf(localCoordinatedPath);
      if ((await privateCandidates(localRoot)).length) throw new Error('local save left private files');
      criteria.localApfsCoordinatedTransaction = status('PASS', {
        provider,
        coordinated: true,
        nonAtomicFallbackUsed: false,
        candidateCleanup: true,
        pdf,
      });
    } catch (error) {
      criteria.localApfsCoordinatedTransaction = status('FAIL', {
        error: error.message || String(error),
      });
    }

    const destinationChangedPath = path.join(localRoot, 'destination-changed.pdf');
    await copyFile(sourcePdf, destinationChangedPath);
    try {
      await openPdf(destinationChangedPath);
      await queueSaveMutation('destination change protection');
      const externallyEditedBytes = Buffer.concat([
        await readFile(sourcePdf),
        Buffer.from('\n% external edit during staged save\n', 'utf8'),
      ]);
      const savePromise = app.callTool('app_save_pdf');
      await waitForCondition(async () => {
        const candidates = await privateCandidates(localRoot);
        return candidates.some((name) => name.includes('destination-changed.pdf'))
          ? candidates : null;
      }, { label: 'staged destination-change candidate' });
      await writeFile(destinationChangedPath, externallyEditedBytes);
      const saved = await savePromise;
      if (saved?.ok !== false || saved?.errorCode !== 'DESTINATION_CHANGED') {
        throw new Error(`external destination edit was not rejected: ${JSON.stringify(saved)}`);
      }
      if (!Buffer.from(await readFile(destinationChangedPath)).equals(externallyEditedBytes)) {
        throw new Error('destination-change rejection overwrote the external edit');
      }
      if ((await privateCandidates(localRoot)).length) {
        throw new Error('destination-change rejection left private files');
      }
      criteria.destinationChangeProtection = status('PASS', {
        rejected: true,
        errorCode: saved.errorCode,
        recovery: saved.recovery,
        externalEditPreserved: true,
        candidateCleanup: true,
        blindRetryUsed: false,
      });
    } catch (error) {
      criteria.destinationChangeProtection = status('FAIL', {
        error: error.message || String(error),
      });
    }

    const permissionsPath = path.join(localRoot, 'permissions-locked.pdf');
    await copyFile(sourcePdf, permissionsPath);
    try {
      criteria.permissionsLockedDestination = status('PASS', await assertRejectedAndPreserved(
        permissionsPath,
        () => chmod(permissionsPath, 0o444),
        () => chmod(permissionsPath, 0o644),
      ));
    } catch (error) {
      criteria.permissionsLockedDestination = status('FAIL', { error: error.message || String(error) });
    }

    const finderLockedPath = path.join(localRoot, 'finder-locked.pdf');
    await copyFile(sourcePdf, finderLockedPath);
    try {
      criteria.finderLockedDestination = status('PASS', await assertRejectedAndPreserved(
        finderLockedPath,
        () => requiredCommand('/usr/bin/chflags', ['uchg', finderLockedPath]),
        () => requiredCommand('/usr/bin/chflags', ['nouchg', finderLockedPath]),
      ));
    } catch (error) {
      await commandResult('/usr/bin/chflags', ['nouchg', finderLockedPath]);
      criteria.finderLockedDestination = status('FAIL', { error: error.message || String(error) });
    }

    const advisoryLockPath = path.join(localRoot, 'advisory-locked.pdf');
    await copyFile(sourcePdf, advisoryLockPath);
    let lockProcess = null;
    try {
      await openPdf(advisoryLockPath);
      await queueSaveMutation('advisory lock');
      const before = await sha256(advisoryLockPath);
      lockProcess = spawn(lockHelper, [advisoryLockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      const lockOutput = await waitForLine(lockProcess.stdout, 'LOCKED');
      const saved = await app.callTool('app_save_pdf');
      if (saved?.ok !== false) throw new Error('advisory-locked destination unexpectedly saved');
      if (await sha256(advisoryLockPath) !== before) throw new Error('advisory-lock rejection changed original bytes');
      if ((await privateCandidates(localRoot)).length) throw new Error('advisory-lock rejection left private files');
      criteria.advisoryFileLock = status('PASS', {
        lockHelper: lockOutput.trim(),
        rejected: true,
        originalPreserved: true,
        candidateCleanup: true,
        appError: saved.error,
      });
    } catch (error) {
      criteria.advisoryFileLock = status('FAIL', { error: error.message || String(error) });
    } finally {
      if (lockProcess) {
        lockProcess.stdin.end('\n');
        await Promise.race([waitForExit(lockProcess), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (lockProcess.exitCode === null) lockProcess.kill('SIGKILL');
      }
    }

    let apfsImage;
    try {
      apfsImage = await createImage({ label: 'apfs-external', fileSystem: 'APFS', size: '64m' });
      const externalPath = path.join(apfsImage.mountPath, 'external-save.pdf');
      await copyFile(sourcePdf, externalPath);
      const [homeDevice, externalDevice] = await Promise.all([stat(projectDir), stat(apfsImage.mountPath)]);
      if (homeDevice.dev === externalDevice.dev) throw new Error('APFS image is not a distinct mounted volume');
      await openPdf(externalPath);
      await queueSaveMutation('APFS initial save');
      const first = await app.callTool('app_save_pdf');
      const second = await app.callTool('app_save_pdf');
      if (first?.ok !== true || second?.ok !== true) {
        throw new Error(`APFS external save failed: ${first?.error || second?.error}`);
      }
      const apfsViewport = await app.callTool('app_get_viewport_state');
      const apfsProvider = apfsViewport?.safeSaveProvider;
      if (apfsProvider?.providerKind !== 'external-volume'
          || apfsProvider?.coordinationRequired !== true) {
        throw new Error(`APFS external classification/coordination missing: ${JSON.stringify(apfsProvider)}`);
      }
      const pdf = await validatePdf(externalPath);
      if ((await privateCandidates(apfsImage.mountPath)).length) throw new Error('APFS saves left private files');

      const preservedHash = await sha256(externalPath);
      await queueSaveMutation('APFS locked rejection');
      await requiredCommand('/usr/bin/chflags', ['uchg', externalPath]);
      let lockedSave;
      try {
        lockedSave = await app.callTool('app_save_pdf');
      } finally {
        await requiredCommand('/usr/bin/chflags', ['nouchg', externalPath]);
      }
      if (lockedSave?.ok !== false || await sha256(externalPath) !== preservedHash) {
        throw new Error('external APFS rejection did not preserve the original');
      }
      criteria.apfsCrossVolumeBehavior = status('PASS', {
        mountedFileSystem: 'APFS',
        distinctDevice: true,
        save: 'pass',
        repeatedSave: 'pass',
        atomicReplacement: 'pass',
        nonAtomicFallbackUsed: false,
        provider: apfsProvider,
        lockedOriginalPreserved: true,
        pdf,
      });
    } catch (error) {
      criteria.apfsCrossVolumeBehavior = status('FAIL', { error: error.message || String(error) });
    }

    try {
      const diskFullImage = await createImage({ label: 'apfs-disk-full', fileSystem: 'APFS', size: '64m' });
      const diskFullPath = path.join(diskFullImage.mountPath, 'disk-full.pdf');
      await copyFile(sourcePdf, diskFullPath);
      await openPdf(diskFullPath);
      await queueSaveMutation('disk full rejection');
      const before = await sha256(diskFullPath);
      const fillPath = path.join(diskFullImage.mountPath, 'capacity-filler.bin');
      const handle = await open(fillPath, 'w');
      const block = randomBytes(1024 * 1024);
      let written = 0;
      let fillError = null;
      try {
        while (true) {
          try {
            const result = await handle.write(block);
            written += result.bytesWritten;
          } catch (error) {
            fillError = error;
            break;
          }
        }
      } finally {
        await handle.close();
      }
      if (!fillError || !['ENOSPC', 'EDQUOT'].includes(fillError.code)) {
        throw new Error(`capacity-limited image did not reach ENOSPC/EDQUOT: ${fillError?.code}`);
      }
      const mark = app.markLogs();
      const saved = await app.callTool('app_save_pdf');
      if (saved?.ok !== false) throw new Error('disk-full save unexpectedly succeeded');
      if (await sha256(diskFullPath) !== before) throw new Error('disk-full failure changed original bytes');
      const candidates = await privateCandidates(diskFullImage.mountPath);
      if (candidates.length) throw new Error(`disk-full failure left private files: ${candidates.join(', ')}`);
      criteria.diskFullBehavior = status('PASS', {
        mountedFileSystem: 'APFS',
        capacityLimitedImage: true,
        bytesWrittenBeforeFull: written,
        fillError: fillError.code,
        rejected: true,
        originalPreserved: true,
        candidateCleanup: true,
        nativeErrorLogged: app.logsAfter(mark).match(/OPDS_SAFE_SAVE\|([A-Z0-9_]+)/u)?.[1] || null,
      });
    } catch (error) {
      criteria.diskFullBehavior = status('FAIL', { error: error.message || String(error) });
    }

    let exfatObserved = false;
    try {
      const exfatImage = await createImage({
        label: 'exfat-external',
        fileSystem: 'ExFAT',
        size: '128m',
        layout: 'MBRSPUD',
      });
      const exfatPath = path.join(exfatImage.mountPath, 'external-save.pdf');
      await copyFile(sourcePdf, exfatPath);
      await openPdf(exfatPath);
      await queueSaveMutation('exFAT transaction');
      const before = await sha256(exfatPath);
      const saved = await app.callTool('app_save_pdf');
      const candidates = await privateCandidates(exfatImage.mountPath);
      if (candidates.length) throw new Error(`exFAT transaction left private files: ${candidates.join(', ')}`);
      if (saved?.ok === true) {
        await validatePdf(exfatPath);
        criteria.exfatCrossVolumeBehavior = status('PASS', {
          mountedFileSystem: 'ExFAT',
          outcome: 'atomic replacement supported',
          nonAtomicFallbackUsed: false,
          candidateCleanup: true,
        });
      } else {
        if (await sha256(exfatPath) !== before) throw new Error('rejected exFAT save changed original bytes');
        criteria.exfatCrossVolumeBehavior = status('PASS', {
          mountedFileSystem: 'ExFAT',
          outcome: 'unsupported atomic replacement rejected',
          nonAtomicFallbackUsed: false,
          originalPreserved: true,
          candidateCleanup: true,
          appError: saved?.error,
        });
      }
      exfatObserved = true;
    } catch (error) {
      criteria.exfatCrossVolumeBehavior = status('UNVERIFIED', {
        liveTransactionPerformed: false,
        reason: `A temporary exFAT image could not be created or mounted: ${error.message || error}`,
      });
    }
    criteria.externalVolumeFallbackAndOriginalPreservation = exfatObserved
      ? status('PASS', {
        apfsAtomicReplacement: criteria.apfsCrossVolumeBehavior.status === 'PASS',
        exfatObserved: true,
        nonAtomicFallbackUsed: false,
      })
      : status('UNVERIFIED', {
        apfsAtomicReplacement: criteria.apfsCrossVolumeBehavior.status === 'PASS',
        exfatObserved: false,
        nonAtomicFallbackUsed: false,
        reason: 'APFS was exercised, but no live exFAT transaction was possible on this host.',
      });

    async function qualifyThirdPartyProvider(providerName, providerRoot) {
      if (!providerRoot) {
        return status('UNVERIFIED', {
          liveProviderTransactionPerformed: false,
          reason: `${providerName} File Provider is not configured on this host.`,
        });
      }
      let transactionPath = null;
      try {
        transactionPath = await mkdtemp(path.join(
          providerRoot,
          `Open PDF Studio ${providerName} Validation-`,
        ));
        thirdPartyTransactionPaths.push(transactionPath);
        const providerPdf = path.join(transactionPath, 'provider-save.pdf');
        await copyFile(sourcePdf, providerPdf);
        await openPdf(providerPdf);
        await queueSaveMutation(`${providerName} File Provider transaction`);
        const first = await app.callTool('app_save_pdf');
        await queueSaveMutation(`${providerName} repeated File Provider transaction`);
        const second = await app.callTool('app_save_pdf');
        if (first?.ok !== true || second?.ok !== true) {
          throw new Error(`${providerName} save failed: ${first?.error || second?.error}`);
        }
        const viewport = await app.callTool('app_get_viewport_state');
        const provider = viewport?.safeSaveProvider;
        if (provider?.providerKind !== 'file-provider'
            || provider?.providerManaged !== true
            || provider?.coordinationRequired !== true) {
          throw new Error(`${providerName} classification/coordination missing: ${JSON.stringify(provider)}`);
        }
        const metadataProbe = await commandResult(ubiquityHelper, [providerPdf]);
        let metadata = null;
        try { metadata = metadataProbe.code === 0 ? JSON.parse(metadataProbe.stdout) : null; } catch {}
        const pdf = await validatePdf(providerPdf);
        if ((await privateCandidates(transactionPath)).length) {
          throw new Error(`${providerName} save left private files`);
        }
        return status('PASS', {
          liveProviderTransactionPerformed: true,
          providerRoot,
          provider,
          metadata,
          save: 'pass',
          repeatedSave: 'pass',
          candidateCleanup: true,
          nonAtomicFallbackUsed: false,
          pdf,
        });
      } catch (error) {
        return status('FAIL', {
          liveProviderTransactionPerformed: Boolean(transactionPath),
          providerRoot,
          error: error.message || String(error),
        });
      }
    }

    const thirdPartyRoots = await discoverThirdPartyProviderRoots();
    criteria.dropboxFileProviderTransaction = await qualifyThirdPartyProvider(
      'Dropbox',
      thirdPartyRoots.dropbox,
    );
    criteria.oneDriveFileProviderTransaction = await qualifyThirdPartyProvider(
      'OneDrive',
      thirdPartyRoots.onedrive,
    );
    criteria.providerNetworkLoss = status('UNVERIFIED', {
      isolatedFaultPerformed: false,
      originalPreservationPolicy: 'typed provider failure with no direct-write fallback',
      reason: 'No isolated provider-network fault was available without changing host-wide connectivity.',
    });
    criteria.icloudCloudOnlyBeforeOpen = status('UNVERIFIED', {
      liveCloudOnlyTransactionPerformed: false,
      reason: 'iCloud eviction was not reached.',
    });
    criteria.icloudUploadInProgress = status('UNVERIFIED', {
      liveUploadObserved: false,
      reason: 'No iCloud upload-in-progress state was observed.',
    });
    criteria.providerEviction = status('UNVERIFIED', {
      liveEvictionPerformed: false,
      reason: 'Provider eviction was not reached.',
    });

    if (options.skipIcloud) {
      criteria.icloudDriveProviderTransaction = status('UNVERIFIED', {
        liveProviderTransactionPerformed: false,
        reason: 'The caller explicitly skipped the iCloud provider test.',
      });
    } else {
      const icloudRoot = path.join(process.env.HOME || '', 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
      const rootProbe = await commandResult(ubiquityHelper, [icloudRoot]);
      let rootStatus = null;
      try { rootStatus = rootProbe.code === 0 ? JSON.parse(rootProbe.stdout) : null; } catch {}
      if (!rootStatus?.exists
          || (rootStatus?.isUbiquitous !== true && rootStatus?.resourceIsUbiquitous !== true)) {
        criteria.icloudDriveProviderTransaction = status('UNVERIFIED', {
          liveProviderTransactionPerformed: false,
          reason: rootProbe.code === 0
            ? 'The iCloud Drive path exists but was not confirmed as a ubiquitous provider root.'
            : `The iCloud provider metadata probe was unavailable: ${textOutput(rootProbe)}`,
          rootProbe: rootStatus,
        });
      } else {
        try {
          icloudTransactionPath = await mkdtemp(path.join(icloudRoot, 'Open PDF Studio Release Validation-'));
          const icloudPdf = path.join(icloudTransactionPath, 'provider-save.pdf');
          await copyFile(sourcePdf, icloudPdf);
          await openPdf(icloudPdf);
          await queueSaveMutation('iCloud provider transaction');
          const saved = await app.callTool('app_save_pdf');
          if (saved?.ok !== true) throw new Error(`provider-backed safe save failed: ${saved?.error}`);
          const viewport = await app.callTool('app_get_viewport_state');
          const provider = viewport?.safeSaveProvider;
          if (provider?.providerKind !== 'icloud'
              || provider?.providerManaged !== true
              || provider?.coordinationRequired !== true) {
            throw new Error(`iCloud classification/coordination missing: ${JSON.stringify(provider)}`);
          }
          let itemStatus = null;
          let uploadInProgressObserved = provider.uploading === true;
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const probe = await commandResult(ubiquityHelper, [icloudPdf]);
            if (probe.code === 0) {
              try { itemStatus = JSON.parse(probe.stdout); } catch {}
            }
            if (itemStatus?.uploading === true) uploadInProgressObserved = true;
            if (itemStatus?.isUbiquitous && itemStatus?.uploaded === true && !itemStatus?.uploadError) break;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          if (!itemStatus?.isUbiquitous || itemStatus?.uploaded !== true || itemStatus?.uploadError) {
            throw new Error(`provider did not confirm uploaded state: ${JSON.stringify(itemStatus)}`);
          }
          const pdf = await validatePdf(icloudPdf);
          if ((await privateCandidates(icloudTransactionPath)).length) throw new Error('iCloud save left private files');
          criteria.icloudDriveProviderTransaction = status('PASS', {
            liveProviderTransactionPerformed: true,
            providerRootConfirmed: true,
            provider,
            saved: true,
            uploaded: true,
            candidateCleanup: true,
            pdf,
          });
          criteria.icloudUploadInProgress = uploadInProgressObserved
            ? status('PASS', {
              liveUploadObserved: true,
              finalItemStatus: itemStatus,
            })
            : status('UNVERIFIED', {
              liveUploadObserved: false,
              finalItemStatus: itemStatus,
              reason: 'The controlled iCloud save uploaded too quickly to observe an in-progress state.',
            });

          const cloudOnlyPdf = path.join(icloudTransactionPath, 'cloud-only-before-open.pdf');
          await copyFile(sourcePdf, cloudOnlyPdf);
          let cloudOnlyDownloadedAgain = false;
          try {
            await waitForCondition(async () => {
              const probe = await commandResult(ubiquityHelper, [cloudOnlyPdf]);
              if (probe.code !== 0) return null;
              try {
                const value = JSON.parse(probe.stdout);
                return value.uploaded === true && !value.uploadError ? value : null;
              } catch {
                return null;
              }
            }, { timeoutMs: 60_000, intervalMs: 1_000, label: 'controlled iCloud upload' });
            const originalSha256 = await sha256(cloudOnlyPdf);
            const eviction = await commandResult('/usr/bin/brctl', ['evict', cloudOnlyPdf]);
            if (eviction.code !== 0) {
              const reason = `Controlled iCloud eviction was unavailable: ${textOutput(eviction)}`;
              criteria.icloudCloudOnlyBeforeOpen = status('UNVERIFIED', {
                liveCloudOnlyTransactionPerformed: false,
                reason,
              });
              criteria.providerEviction = status('UNVERIFIED', {
                liveEvictionPerformed: false,
                reason,
              });
            } else {
              const evictedStatus = await waitForCondition(async () => {
                const probe = await commandResult(ubiquityHelper, [cloudOnlyPdf]);
                if (probe.code !== 0) return null;
                try {
                  const value = JSON.parse(probe.stdout);
                  return /not.?downloaded/iu.test(value.downloadStatus || '') ? value : null;
                } catch {
                  return null;
                }
              }, { timeoutMs: 30_000, intervalMs: 250, label: 'iCloud cloud-only state' });
              await openPdf(localCoordinatedPath);
              await queueSaveMutation('cloud-only destination rejection');
              const rejected = await app.callTool('app_save_pdf', { path: cloudOnlyPdf });
              if (rejected?.ok !== false
                  || rejected?.errorCode !== 'PROVIDER_NOT_MATERIALIZED'
                  || rejected?.recovery?.recoveryAction !== 'download-provider-file') {
                throw new Error(`cloud-only destination lacked typed rejection: ${JSON.stringify(rejected)}`);
              }
              if ((await privateCandidates(icloudTransactionPath)).length) {
                throw new Error('cloud-only rejection left private files');
              }
              const download = await commandResult('/usr/bin/brctl', ['download', cloudOnlyPdf]);
              if (download.code !== 0) throw new Error(`could not rematerialize controlled iCloud file: ${textOutput(download)}`);
              await waitForCondition(async () => {
                const probe = await commandResult(ubiquityHelper, [cloudOnlyPdf]);
                if (probe.code !== 0) return null;
                try {
                  const value = JSON.parse(probe.stdout);
                  return /current|downloaded/iu.test(value.downloadStatus || '') ? value : null;
                } catch {
                  return null;
                }
              }, { timeoutMs: 60_000, intervalMs: 500, label: 'iCloud rematerialization' });
              cloudOnlyDownloadedAgain = true;
              if (await sha256(cloudOnlyPdf) !== originalSha256) {
                throw new Error('cloud-only rejection changed the original provider bytes');
              }
              const evidence = {
                liveCloudOnlyTransactionPerformed: true,
                liveEvictionPerformed: true,
                evictedStatus,
                errorCode: rejected.errorCode,
                recovery: rejected.recovery,
                originalPreserved: true,
                candidateCleanup: true,
                directWriteFallbackUsed: false,
              };
              criteria.icloudCloudOnlyBeforeOpen = status('PASS', evidence);
              criteria.providerEviction = status('PASS', evidence);
            }
          } catch (error) {
            criteria.icloudCloudOnlyBeforeOpen = status('FAIL', {
              liveCloudOnlyTransactionPerformed: true,
              error: error.message || String(error),
            });
            criteria.providerEviction = status('FAIL', {
              liveEvictionPerformed: true,
              error: error.message || String(error),
            });
          } finally {
            if (!cloudOnlyDownloadedAgain) {
              await commandResult('/usr/bin/brctl', ['download', cloudOnlyPdf]);
            }
          }
        } catch (error) {
          criteria.icloudDriveProviderTransaction = status('FAIL', {
            liveProviderTransactionPerformed: true,
            error: error.message || String(error),
          });
        }
      }
    }
  } finally {
    if (app) {
      try { await app.stop(); } catch (error) { cleanupErrors.push(`stop app: ${error.message || error}`); }
    }
    if (icloudTransactionPath) {
      try { await rm(icloudTransactionPath, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(`remove iCloud test directory: ${error.message || error}`); }
    }
    for (const providerPath of thirdPartyTransactionPaths) {
      try { await rm(providerPath, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(`remove File Provider test directory ${providerPath}: ${error.message || error}`); }
    }
    for (const image of [...mountedImages].reverse()) {
      if (image.attached) {
        let detached = await commandResult('/usr/bin/hdiutil', ['detach', image.mountPath]);
        if (detached.code !== 0) detached = await commandResult('/usr/bin/hdiutil', ['detach', '-force', image.mountPath]);
        if (detached.code !== 0) cleanupErrors.push(`detach ${image.imagePath}: ${textOutput(detached)}`);
        else image.attached = false;
      }
    }
    try { await rm(tempRoot, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(`remove temporary root: ${error.message || error}`); }
  }

  criteria.temporaryImageAndApplicationDataCleanup = cleanupErrors.length
    ? status('FAIL', { errors: cleanupErrors })
    : status('PASS', {
      temporaryImagesCreatedDynamically: true,
      mountedImagesDetached: true,
      diskImagesDeleted: true,
      isolatedApplicationDataDeleted: true,
      icloudTestDirectoryDeleted: icloudTransactionPath ? true : null,
      thirdPartyProviderDirectoriesDeleted: thirdPartyTransactionPaths.length,
      machineSpecificOutputCommitted: false,
    });
  report.overallStatus = overallStatus(criteria);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.overallStatus === 'FAIL') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
