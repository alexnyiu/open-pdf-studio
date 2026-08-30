import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { evaluateLargePdfPerformanceReport } from './verify-large-pdf-performance-report.mjs';

assert.equal(process.platform, 'darwin', 'large-PDF packaged performance acceptance is macOS-only');

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(projectDir, '..');
const defaultBundle = path.join(
  repoDir, 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Open PDF Studio.app',
);
const defaultPdf = '/Users/alexander/Downloads/Market_Screen_50_Stock_CANSLIM_Analysis_Competitive_Deep_Dive.pdf';

function parseArguments(argv) {
  const options = {
    appBundle: path.resolve(process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || defaultBundle),
    pdfPath: path.resolve(process.env.OPEN_PDF_STUDIO_LARGE_PDF_FIXTURE || defaultPdf),
    outputPath: path.resolve(process.env.OPEN_PDF_STUDIO_LARGE_PDF_PERFORMANCE_REPORT
      || path.join(projectDir, 'test-artifacts', 'large-pdf-performance', 'performance.json')),
    runs: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app') options.appBundle = path.resolve(argv[++index]);
    else if (argv[index] === '--pdf') options.pdfPath = path.resolve(argv[++index]);
    else if (argv[index] === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (argv[index] === '--runs') options.runs = Math.max(1, Number(argv[++index]) || 2);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const now = () => performance.now();
const maximum = (...values) => {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length ? Math.max(...finiteValues) : null;
};

async function pixelDifferencePercent(leftPng, rightPng) {
  const left = await sharp(leftPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height
      || left.info.channels !== right.info.channels) return 100;
  let differingPixels = 0;
  const channels = left.info.channels;
  for (let offset = 0; offset < left.data.length; offset += channels) {
    let differs = false;
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
      if (Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 2) {
        differs = true;
        break;
      }
    }
    if (differs) differingPixels += 1;
  }
  return (differingPixels / (left.info.width * left.info.height)) * 100;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function gitHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return stdout.trim();
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function bundleIdentity(appBundle) {
  const executablePath = path.join(appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
  const executable = await stat(executablePath);
  const plistValue = async (key) => {
    try {
      const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath]);
      return stdout.trim();
    } catch { return null; }
  };
  return {
    bundlePath: appBundle,
    executablePath,
    bundleIdentifier: await plistValue('CFBundleIdentifier'),
    shortVersion: await plistValue('CFBundleShortVersionString'),
    bundleVersion: await plistValue('CFBundleVersion'),
    executableBytes: executable.size,
    signingScope: 'packaged usability evidence; not Developer ID or notarization evidence',
  };
}

async function rssBytes(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)]);
    const kibibytes = Number(stdout.trim());
    return Number.isFinite(kibibytes) && kibibytes > 0 ? kibibytes * 1024 : null;
  } catch { return null; }
}

function sample(metrics, name, field = 'p95') {
  return metrics?.metrics?.measurements?.[name]?.[field] ?? null;
}

async function runOnce(options) {
  const outputDir = path.dirname(options.outputPath);
  const executablePath = path.join(options.appBundle, 'Contents', 'MacOS', 'open-pdf-studio');
  const fixtureStat = await stat(options.pdfPath);
  await Promise.all([access(options.appBundle), access(executablePath), mkdir(outputDir, { recursive: true })]);
  const reportBase = {
    contract: 'open-pdf-studio.large-pdf-performance',
    schemaVersion: 2,
    status: 'RUNNING',
    head: await gitHead(),
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, architecture: process.arch },
    packagedApp: await bundleIdentity(options.appBundle),
    fixture: {
      path: options.pdfPath,
      committed: false,
      bytes: fixtureStat.size,
      sha256: await sha256(options.pdfPath),
      pageCount: null,
    },
    provenance: {
      execution: 'packaged-production-ui',
      realClock: true,
      virtualTime: false,
      stateSeeding: false,
      directStoreMutation: false,
      input: 'MCP-dispatched production wheel events and browser-default-equivalent scrolling',
    },
    testCommands: ['npm run test:large-pdf-performance:macos'],
    artifacts: [
      path.relative(outputDir, options.outputPath),
      'app.stdout.log',
      'app.stderr.log',
      'vmmap-summary.txt',
    ],
  };
  await writeFile(options.outputPath, `${JSON.stringify(reportBase, null, 2)}\n`);

  const stdoutPath = path.join(outputDir, 'app.stdout.log');
  const stderrPath = path.join(outputDir, 'app.stderr.log');
  await Promise.all([
    writeFile(stdoutPath, ''),
    writeFile(stderrPath, ''),
  ]);
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  let requestId = 0;
  let applicationPid = null;
  let exited = false;
  const stdoutFd = openSync(stdoutPath, 'a');
  const stderrFd = openSync(stderrPath, 'a');
  const application = spawn(executablePath, [
    '--mcp-server', '--mcp-port', String(port),
  ], {
    cwd: projectDir,
    env: { ...process.env, OPS_ENABLE_MCP: '1', OPDS_DETACHED: '1' },
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  application.once('exit', () => { exited = true; });

  async function rpc(method, params = {}) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`MCP ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  async function callTool(name, arguments_ = {}) {
    const result = await rpc('tools/call', { name, arguments: arguments_ });
    const payload = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof payload !== 'string') throw new Error(`${name} returned no JSON payload`);
    return JSON.parse(payload);
  }

  async function waitUntil(description, probe, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await probe().catch(() => null);
      if (latest) return latest;
      await delay(100);
    }
    throw new Error(`timed out waiting for ${description}: ${JSON.stringify(latest)}`);
  }

  async function waitForRenderIdle(description = 'render scheduler', timeoutMs = 60_000) {
    return waitUntil(description, async () => {
      const value = await callTool('app_get_performance_metrics');
      const scheduled = value.resources?.scheduled;
      return scheduled && scheduled.queued?.length === 0 && scheduled.running?.length === 0 ? value : null;
    }, timeoutMs);
  }

  const rssSamples = [];
  const sampleRss = async (label) => {
    const value = await rssBytes(applicationPid);
    if (value) rssSamples.push({ label, at: new Date().toISOString(), rssBytes: value });
    return value;
  };

  try {
    const initialized = await waitUntil('packaged app MCP', async () => {
      if (exited) throw new Error('packaged app exited before MCP initialization');
      const value = await rpc('initialize');
      applicationPid = value?._meta?.openPdfStudio?.processId || applicationPid;
      return value?._meta?.openPdfStudio?.webviewReady ? value : null;
    }, 90_000);
    assert.ok(initialized);
    await callTool('app_set_window_size', { width: 1440, height: 960, keepVisible: true });
    await callTool('app_clear_caches');
    const processStartRssBytes = await sampleRss('process-start');

    const coldOpenStartedAt = now();
    const opened = await callTool('app_open_pdf', { path: options.pdfPath });
    assert.equal(opened.ok, true, opened.error);
    const initial = await waitUntil('uploaded PDF and performance profile', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.filePath === options.pdfPath
        && viewport.pageCount === 108
        && viewport.performanceProfile?.largeDocument === true
        && viewport.pageGeometry?.pages === 108
        ? viewport : null;
    }, 90_000);
    const coldOpenMs = now() - coldOpenStartedAt;
    reportBase.fixture.pageCount = initial.pageCount;
    const baselineRssBytes = await sampleRss('loaded-baseline');

    // Single-page direct jumps use the production navigation path and prove
    // that virtualization does not change random access.
    const singleMode = { jumps: [] };
    for (const page of [54, 108, 1]) {
      const startedAt = now();
      const result = await callTool('app_go_to_page', { page });
      assert.equal(result.ok, true, result.error);
      await waitUntil(`single-page jump ${page}`, async () => {
        const viewport = await callTool('app_get_viewport_state');
        return viewport.doc?.currentPage === page ? viewport : null;
      });
      singleMode.jumps.push({ page, elapsedMs: now() - startedAt });
      await sampleRss(`single-page-${page}`);
    }

    // Facing mode retains at most one two-page spread.
    const facingSet = await callTool('app_set_view_mode', { mode: 'facing' });
    assert.equal(facingSet.ok, true, facingSet.error);
    await callTool('app_go_to_page', { page: 55 });
    const facing = await waitForRenderIdle('facing spread render');
    await sampleRss('facing-settled');

    const continuousSet = await callTool('app_set_view_mode', { mode: 'continuous' });
    assert.equal(continuousSet.ok, true, continuousSet.error);
    await callTool('app_go_to_page', { page: 1 });
    await waitUntil('continuous virtual shell', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.viewMode === 'continuous'
        && viewport.renderResources?.mountedPageSurfaces > 0
        && viewport.renderResources.mountedPageSurfaces <= 9 ? viewport : null;
    });
    await waitForRenderIdle('initial continuous render');
    await sampleRss('continuous-initial-settled');

    // Page 3 contains the supplied ASML/EUV paragraph and is also a stable
    // small-text sharpness target. Capture the actual mounted raster and a
    // direct PDFium render at exactly the same pixel width.
    await callTool('app_go_to_page', { page: 3 });
    await waitForRenderIdle('page 3 sharp render');
    await delay(500);
    const sharpnessCapture = await waitUntil('page 3 final-density raster', async () => {
      const capture = await callTool('app_screenshot_rendered_page', {
        pageNum: 3, xPt: 36, yPt: 54, widthPt: 540, heightPt: 260,
      });
      return capture.ok && capture.quality === 'final' ? capture : null;
    }, 5_000);
    assert.equal(sharpnessCapture.quality, 'final');
    const directPdfiumCapture = await callTool('screenshot_page', {
      path: options.pdfPath,
      page_index: 2,
      width: sharpnessCapture.fullWidth,
    });
    const directPdfiumPayload = directPdfiumCapture?.content?.find?.((entry) => entry.type === 'text')?.text;
    const directPdfium = typeof directPdfiumPayload === 'string'
      ? JSON.parse(directPdfiumPayload) : directPdfiumCapture;
    const directCrop = await sharp(Buffer.from(directPdfium.png_base64, 'base64'))
      .extract({
        left: sharpnessCapture.cropLeft,
        top: sharpnessCapture.cropTop,
        width: sharpnessCapture.cropWidth,
        height: sharpnessCapture.cropHeight,
      })
      .png()
      .toBuffer();
    const pixelDifference = await pixelDifferencePercent(
      Buffer.from(sharpnessCapture.png_base64, 'base64'),
      directCrop,
    );
    const preScrollCapture = await callTool('app_get_performance_metrics');
    await callTool('app_go_to_page', { page: 1 });
    await waitForRenderIdle('return to page 1 before traversal');

    const scrollReset = await callTool('app_reset_performance_metrics', { observeLongTasks: true });
    const scrollSchedulerStart = scrollReset.resources?.scheduled?.statistics || {};
    let scrollViewport = await callTool('app_get_viewport_state');
    const scrollX = scrollViewport.container.left + scrollViewport.container.width / 2;
    const scrollY = scrollViewport.container.top + scrollViewport.container.height / 2;
    let scrollEvents = 0;
    for (let index = 0; index < 150; index += 1) {
      await callTool('app_scroll', { x: scrollX, y: scrollY, dy: 1_400 });
      scrollEvents += 1;
      if (index % 10 === 0) {
        scrollViewport = await callTool('app_get_viewport_state');
        await sampleRss(`scroll-down-${scrollViewport.doc?.currentPage || index}`);
        if (scrollViewport.doc?.currentPage === 108) break;
      }
      await delay(4);
    }
    await waitUntil('bottom page selection', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.currentPage === 108 ? viewport : null;
    });
    for (let index = 0; index < 150; index += 1) {
      await callTool('app_scroll', { x: scrollX, y: scrollY, dy: -1_400 });
      scrollEvents += 1;
      if (index % 10 === 0) {
        scrollViewport = await callTool('app_get_viewport_state');
        await sampleRss(`scroll-up-${scrollViewport.doc?.currentPage || index}`);
        if (scrollViewport.doc?.currentPage === 1) break;
      }
      await delay(4);
    }
    await waitUntil('top page selection', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.currentPage === 1 ? viewport : null;
    });
    await delay(300);
    const scrollCapture = await waitForRenderIdle('settled top-page render');
    await delay(5_000);
    const firstTraversalSettledRssBytes = await sampleRss('first-traversal-settled-five-seconds');

    // Repeat the complete traversal in the same process. The second pass is
    // the leak/regrowth gate; it may retain at most 32 MiB after settling.
    for (let index = 0; index < 150; index += 1) {
      await callTool('app_scroll', { x: scrollX, y: scrollY, dy: 1_400 });
      if (index % 10 === 0
          && (await callTool('app_get_viewport_state')).doc?.currentPage === 108) break;
      await delay(4);
    }
    await waitUntil('second traversal bottom page', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.currentPage === 108 ? viewport : null;
    });
    for (let index = 0; index < 150; index += 1) {
      await callTool('app_scroll', { x: scrollX, y: scrollY, dy: -1_400 });
      if (index % 10 === 0
          && (await callTool('app_get_viewport_state')).doc?.currentPage === 1) break;
      await delay(4);
    }
    await waitUntil('second traversal top page', async () => {
      const viewport = await callTool('app_get_viewport_state');
      return viewport.doc?.currentPage === 1 ? viewport : null;
    });
    await waitForRenderIdle('second traversal settled render');
    await delay(5_000);
    const secondTraversalSettledRssBytes = await sampleRss('second-traversal-settled-five-seconds');
    const secondTraversalCapture = await callTool('app_get_performance_metrics');
    const secondTraversalGrowthBytes = Number.isFinite(firstTraversalSettledRssBytes)
      && Number.isFinite(secondTraversalSettledRssBytes)
      ? Math.max(0, secondTraversalSettledRssBytes - firstTraversalSettledRssBytes)
      : null;

    // Start the zoom capture from a stable, rendered middle page. A stream of
    // small pixel-wheel deltas represents macOS precision-trackpad input.
    await callTool('app_go_to_page', { page: 54 });
    await delay(300);
    await waitForRenderIdle('middle-page render');
    const zoomReset = await callTool('app_reset_performance_metrics', { observeLongTasks: true });
    const zoomSchedulerStart = zoomReset.resources?.scheduled?.statistics || {};
    const beforeZoom = await callTool('app_get_viewport_state');
    const zoomX = beforeZoom.container.left + beforeZoom.container.width * 0.64;
    const zoomY = beforeZoom.container.top + beforeZoom.container.height * 0.42;
    for (let index = 0; index < 24; index += 1) {
      const wheelResult = await callTool('app_wheel_zoom', {
        x: zoomX, y: zoomY, deltaY: -4, ctrlKey: true,
      });
      assert.equal(wheelResult.ok, true, wheelResult.error);
      assert.equal(wheelResult.eventCtrlKey, true, 'synthetic precision-wheel lost Ctrl state');
      assert.equal(wheelResult.defaultPrevented, true, 'production zoom handler did not consume precision-wheel input');
      await delay(3);
    }
    await delay(120);
    const stoppedScale = (await callTool('app_get_viewport_state')).doc.scale;
    await delay(34);
    const finalScale = (await callTool('app_get_viewport_state')).doc.scale;
    const zoomStopsAfterGesture = stoppedScale === finalScale;
    const zoomCapture = await waitForRenderIdle('final crisp zoom render');
    const finalCapture = await callTool('app_get_performance_metrics', { stop: true });
    await sampleRss('post-zoom');

    // Give released canvases/bitmaps and native cache eviction five seconds
    // before the final resident-memory sample required by the gate.
    await delay(5_000);
    const settledCapture = await callTool('app_get_performance_metrics');
    const settledRssBytes = await sampleRss('settled-five-seconds');
    try {
      const { stdout } = await execFileAsync('/usr/bin/vmmap', ['-summary', String(applicationPid)], {
        maxBuffer: 8 * 1024 * 1024,
      });
      await writeFile(path.join(outputDir, 'vmmap-summary.txt'), stdout);
    } catch { /* RSS remains authoritative when vmmap is unavailable. */ }
    if (process.env.OPS_CAPTURE_MALLOC_HISTORY === '1') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/malloc_history', [
          String(applicationPid),
          '-callTree',
          '-highWaterMark',
          '-invert',
          '-ignoreThreads',
          '-chargeSystemLibraries',
          'malloc[1m-]',
        ], { maxBuffer: 32 * 1024 * 1024 });
        await writeFile(path.join(outputDir, 'malloc-history.txt'), stdout);
      } catch { /* Optional diagnostic; never changes acceptance evidence. */ }
    }
    const scrollMetric = scrollCapture.metrics;
    const zoomMetric = finalCapture.metrics;
    const scrollSchedulerEnd = scrollCapture.resources?.scheduled?.statistics || {};
    const zoomSchedulerEnd = finalCapture.resources?.scheduled?.statistics || {};
    const budget = finalCapture.performanceProfile?.budget || initial.performanceProfile?.budget || {};
    const native = finalCapture.nativeRenderResources || {};
    const longTaskMax = maximum(
      sample(scrollCapture, 'longTaskMs', 'max'),
      sample(finalCapture, 'longTaskMs', 'max'),
    );
    const measuredWorkMax = maximum(
      sample(scrollCapture, 'scrollFrameWorkMs', 'max'),
      sample(scrollCapture, 'scrollHandlerMs', 'max'),
      sample(finalCapture, 'zoomTransformWorkMs', 'max'),
    );
    const peakRssBytes = maximum(...rssSamples.map(({ rssBytes }) => rssBytes));
    const resourcePeak = maximum(
      scrollMetric?.peaks?.javascriptResourceBytes,
      zoomMetric?.peaks?.javascriptResourceBytes,
    );
    const thumbnailPeak = maximum(
      scrollMetric?.peaks?.mountedThumbnails,
      zoomMetric?.peaks?.mountedThumbnails,
      scrollCapture.mountedThumbnails,
      finalCapture.mountedThumbnails,
    );
    const mountedPagePeak = maximum(
      scrollMetric?.peaks?.mountedPageSurfaces,
      zoomMetric?.peaks?.mountedPageSurfaces,
    );
    const settledSurfaces = settledCapture.renderedSurfaceStates || [];
    const undersampledSettledSurfaces = settledSurfaces.filter((surface) =>
      Number(surface.actualRasterScale) + 0.01 < Number(surface.targetRasterScale)).length;
    const maximumSettledDensityError = maximum(
      0,
      ...settledSurfaces.map((surface) => Math.max(
        0,
        Number(surface.targetRasterScale) - Number(surface.actualRasterScale),
      )),
    );
    const previewSurfacesAfter500Ms = settledSurfaces.filter((surface) =>
      surface.quality !== 'final').length;
    const duplicateFinalPublications = (preScrollCapture.metrics?.counters?.duplicateFinalPublications || 0)
      + (secondTraversalCapture.metrics?.counters?.duplicateFinalPublications || 0)
      + (finalCapture.metrics?.counters?.duplicateFinalPublications || 0);
    const rasterMemoryPeaks = {
      canvasBytes: maximum(scrollMetric?.peaks?.mountedCanvasBytes, zoomMetric?.peaks?.mountedCanvasBytes),
      decodedImageBytes: maximum(scrollMetric?.peaks?.mountedImageBytes, zoomMetric?.peaks?.mountedImageBytes),
      decodedBitmapBytes: maximum(scrollMetric?.peaks?.decodedBitmapBytes, zoomMetric?.peaks?.decodedBitmapBytes),
      tileBytes: maximum(scrollMetric?.peaks?.tileBitmapBytes, zoomMetric?.peaks?.tileBitmapBytes),
      previewBytes: maximum(scrollMetric?.peaks?.previewCanvasBytes, zoomMetric?.peaks?.previewCanvasBytes),
      thumbnailBytes: maximum(scrollMetric?.peaks?.thumbnailBytes, zoomMetric?.peaks?.thumbnailBytes),
      transferBufferBytes: maximum(scrollMetric?.peaks?.transferBufferBytes, zoomMetric?.peaks?.transferBufferBytes),
      streamResponseBytes: maximum(scrollMetric?.peaks?.streamResponseBytes, zoomMetric?.peaks?.streamResponseBytes),
      nativePixmapBytes: native.nativePixmapPeakBytes ?? null,
    };
    const transferMethods = new Set([
      ...(scrollMetric?.events || []),
      ...(zoomMetric?.events || []),
    ].filter((event) => event.type === 'raster:completed' && event.transferMethod)
      .map((event) => event.transferMethod));
    const rasterTransfer = {
      method: transferMethods.size === 1 ? [...transferMethods][0]
        : transferMethods.size > 1 ? [...transferMethods].sort().join('+') : null,
      bytes: (scrollMetric?.counters?.rasterTransferBytes || 0)
        + (zoomMetric?.counters?.rasterTransferBytes || 0),
      calls: (scrollMetric?.counters?.rasterTransferCalls || 0)
        + (zoomMetric?.counters?.rasterTransferCalls || 0),
      requested: (scrollMetric?.counters?.rasterRequested || 0)
        + (zoomMetric?.counters?.rasterRequested || 0),
      coalesced: (scrollMetric?.counters?.rasterCoalesced || 0)
        + (zoomMetric?.counters?.rasterCoalesced || 0),
      completed: (scrollMetric?.counters?.rasterCompleted || 0)
        + (zoomMetric?.counters?.rasterCompleted || 0),
      cancelled: (scrollMetric?.counters?.rasterCancelled || 0)
        + (zoomMetric?.counters?.rasterCancelled || 0),
      reused: (scrollMetric?.counters?.rasterReused || 0)
        + (zoomMetric?.counters?.rasterReused || 0),
      published: (scrollMetric?.counters?.fullQualityPublishes || 0)
        + (zoomMetric?.counters?.fullQualityPublishes || 0),
    };
    const report = evaluateLargePdfPerformanceReport({
      ...reportBase,
      completedAt: new Date().toISOString(),
      measurements: {
        coldOpenMs,
        singleMode,
        facing: {
          viewMode: facingSet.viewMode,
          facingSpread: facingSet.facingSpread,
          mountedPageSurfaces: facing.resources?.mountedPageSurfaces ?? null,
        },
        continuous: {
          scrollEvents,
          scroll: scrollCapture,
          zoom: finalCapture,
          settled: settledCapture,
          scaleBefore: beforeZoom.doc.scale,
          scaleAfter: finalScale,
        },
        rssSamples,
        sharpness: {
          pageNum: 3,
          applicationWidth: sharpnessCapture.width,
          applicationHeight: sharpnessCapture.height,
          targetScale: sharpnessCapture.targetScale,
          actualScale: sharpnessCapture.actualScale,
          quality: sharpnessCapture.quality,
          pixelDifferencePercent: pixelDifference,
        },
        rasterMemoryPeaks,
        rasterTransfer,
      },
      metrics: {
        largeDocument: finalCapture.performanceProfile?.largeDocument === true,
        coldOpenMs,
        scrollHandlerP95Ms: sample(scrollCapture, 'scrollHandlerMs'),
        ordinaryMainThreadTaskMaxMs: longTaskMax || measuredWorkMax,
        longTaskInstrumentationAvailable: scrollMetric?.longTaskSupported === true
          && zoomMetric?.longTaskSupported === true,
        cachedPreviewPaints: scrollMetric?.counters?.cachedPreviewPaints || 0,
        cachedPreviewP95Ms: sample(scrollCapture, 'cachedPreviewLatencyMs'),
        visiblePagePreviewPublishes: (scrollMetric?.counters?.visiblePreviewPublishes || 0)
          + (zoomMetric?.counters?.visiblePreviewPublishes || 0),
        visiblePagePreviewP95Ms: maximum(
          sample(scrollCapture, 'visiblePagePreviewLatencyMs'),
          sample(finalCapture, 'visiblePagePreviewLatencyMs'),
        ),
        visibleBlankWithSourceSamples:
          (scrollMetric?.measurements?.visibleBlankWithSourceDurationMs?.count || 0)
          + (zoomMetric?.measurements?.visibleBlankWithSourceDurationMs?.count || 0),
        visibleBlankWithSourceMaxMs: maximum(
          sample(scrollCapture, 'visibleBlankWithSourceDurationMs', 'max'),
          sample(finalCapture, 'visibleBlankWithSourceDurationMs', 'max'),
        ),
        fullQualityLatencyMaxMs: maximum(
          sample(scrollCapture, 'visiblePageFullRasterLatencyMs', 'max'),
          sample(finalCapture, 'visiblePageFullRasterLatencyMs', 'max'),
        ),
        visibleColdRenderSuppressedCount:
          (scrollMetric?.counters?.visibleColdRenderSuppressedCount || 0)
          + (zoomMetric?.counters?.visibleColdRenderSuppressedCount || 0),
        previewUsefulCancellationCount:
          (scrollMetric?.counters?.previewUsefulCancellationCount || 0)
          + (zoomMetric?.counters?.previewUsefulCancellationCount || 0),
        retiredNativeWorkPeak: maximum(
          scrollMetric?.peaks?.retiredNativeWork,
          zoomMetric?.peaks?.retiredNativeWork,
          scrollCapture.resources?.scheduled?.lanes?.full?.retired?.length,
          finalCapture.resources?.scheduled?.lanes?.full?.retired?.length,
        ),
        retiredNativeStalePublicationCount:
          (scrollMetric?.counters?.retiredNativeStalePublicationCount || 0)
          + (zoomMetric?.counters?.retiredNativeStalePublicationCount || 0),
        pageRenderFailureBlockedLaterPagesCount:
          (scrollMetric?.counters?.pageRenderFailureBlockedLaterPagesCount || 0)
          + (zoomMetric?.counters?.pageRenderFailureBlockedLaterPagesCount || 0),
        mountedPageSurfacesPeak: mountedPagePeak,
        mountedThumbnailsPeak: thumbnailPeak,
        zoomInputToTransformP95Ms: sample(finalCapture, 'zoomInputToTransformMs'),
        zoomFramesBelow20MsPercent: sample(finalCapture, 'zoomFrameIntervalMs', 'below20MsPercent'),
        zoomAnchorDriftMaxPx: sample(finalCapture, 'zoomAnchorDriftPx', 'max'),
        zoomStopsAfterGesture,
        crispRenderRevisions: zoomMetric?.counters?.crispRenderRevisions || 0,
        maximumSettledDensityError,
        undersampledSettledSurfaces,
        previewSurfacesAfter500Ms,
        duplicateFinalPublications,
        pixelDifferencePercent: pixelDifference,
        scrollRenderCancellations: (scrollSchedulerEnd.cancelled || 0) - (scrollSchedulerStart.cancelled || 0),
        zoomRenderCancellations: (zoomSchedulerEnd.cancelled || 0) - (zoomSchedulerStart.cancelled || 0),
        javascriptResourcePeakBytes: resourcePeak,
        javascriptResourceBudgetBytes: budget.javascriptBytes ?? null,
        nativePixmapPeakBytes: native.nativePixmapPeakBytes ?? null,
        nativePixmapBudgetBytes: native.nativePixmapBudgetBytes ?? null,
        baselineRssBytes,
        processStartRssBytes,
        peakRssBytes,
        settledRssBytes,
        rssCeilingBytes: Number.isFinite(baselineRssBytes) && Number.isFinite(budget.globalBytes)
          ? baselineRssBytes + budget.globalBytes + 128 * 1024 * 1024 : null,
        secondTraversalGrowthBytes,
        // The two-process wrapper replaces this per-run value in the final
        // authoritative artifact.
        freshPackagedProcessRuns: 1,
      },
    });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    let failureDiagnostics = null;
    try {
      failureDiagnostics = {
        viewport: await callTool('app_get_viewport_state'),
        performance: await callTool('app_get_performance_metrics'),
        console: await callTool('app_get_recent_console', { limit: 300 }),
      };
      await writeFile(
        path.join(outputDir, 'failure-diagnostics.json'),
        `${JSON.stringify(failureDiagnostics, null, 2)}\n`,
      );
    } catch { /* Preserve the original failure when diagnostics are unavailable. */ }
    const report = evaluateLargePdfPerformanceReport({
      ...reportBase,
      completedAt: new Date().toISOString(),
      error: error.stack || error.message || String(error),
      failureDiagnostics,
      metrics: {},
    });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    if (applicationPid) {
      try { process.kill(applicationPid, 'SIGTERM'); } catch {}
    } else if (!exited) {
      try { application.kill('SIGTERM'); } catch {}
    }
    await delay(250);
    try { closeSync(stdoutFd); } catch {}
    try { closeSync(stderrFd); } catch {}
  }
}

function runOutputPath(outputPath, index) {
  return path.join(path.dirname(outputPath), `run-${index}`, path.basename(outputPath));
}

function aggregateMetrics(reports) {
  const values = reports.map((report) => report.metrics || {});
  const maxField = (name) => maximum(...values.map((metrics) => Number(metrics[name])));
  const minField = (name) => {
    const finiteValues = values.map((metrics) => Number(metrics[name])).filter(Number.isFinite);
    return finiteValues.length ? Math.min(...finiteValues) : null;
  };
  const worstRss = values.reduce((worst, metrics) => {
    const margin = Number(metrics.settledRssBytes) - Number(metrics.rssCeilingBytes);
    if (!Number.isFinite(margin)) return worst;
    return !worst || margin > worst.margin ? { metrics, margin } : worst;
  }, null)?.metrics || {};
  return {
    largeDocument: values.every((metrics) => metrics.largeDocument === true),
    coldOpenMs: maxField('coldOpenMs'),
    scrollHandlerP95Ms: maxField('scrollHandlerP95Ms'),
    ordinaryMainThreadTaskMaxMs: maxField('ordinaryMainThreadTaskMaxMs'),
    longTaskInstrumentationAvailable: values.every((metrics) =>
      metrics.longTaskInstrumentationAvailable === true),
    cachedPreviewPaints: values.reduce((sum, metrics) => sum + (metrics.cachedPreviewPaints || 0), 0),
    cachedPreviewP95Ms: maxField('cachedPreviewP95Ms'),
    visiblePagePreviewPublishes: values.reduce((sum, metrics) =>
      sum + (metrics.visiblePagePreviewPublishes || 0), 0),
    visiblePagePreviewP95Ms: maxField('visiblePagePreviewP95Ms'),
    visibleBlankWithSourceSamples: values.reduce((sum, metrics) =>
      sum + (metrics.visibleBlankWithSourceSamples || 0), 0),
    visibleBlankWithSourceMaxMs: maxField('visibleBlankWithSourceMaxMs'),
    fullQualityLatencyMaxMs: maxField('fullQualityLatencyMaxMs'),
    visibleColdRenderSuppressedCount: values.reduce((sum, metrics) =>
      sum + (metrics.visibleColdRenderSuppressedCount || 0), 0),
    previewUsefulCancellationCount: values.reduce((sum, metrics) =>
      sum + (metrics.previewUsefulCancellationCount || 0), 0),
    retiredNativeWorkPeak: maxField('retiredNativeWorkPeak'),
    retiredNativeStalePublicationCount: values.reduce((sum, metrics) =>
      sum + (metrics.retiredNativeStalePublicationCount || 0), 0),
    pageRenderFailureBlockedLaterPagesCount: values.reduce((sum, metrics) =>
      sum + (metrics.pageRenderFailureBlockedLaterPagesCount || 0), 0),
    mountedPageSurfacesPeak: maxField('mountedPageSurfacesPeak'),
    mountedThumbnailsPeak: maxField('mountedThumbnailsPeak'),
    zoomInputToTransformP95Ms: maxField('zoomInputToTransformP95Ms'),
    zoomFramesBelow20MsPercent: minField('zoomFramesBelow20MsPercent'),
    zoomAnchorDriftMaxPx: maxField('zoomAnchorDriftMaxPx'),
    zoomStopsAfterGesture: values.every((metrics) => metrics.zoomStopsAfterGesture === true),
    crispRenderRevisions: values.every((metrics) => metrics.crispRenderRevisions === 1) ? 1 : 0,
    maximumSettledDensityError: maxField('maximumSettledDensityError'),
    undersampledSettledSurfaces: maxField('undersampledSettledSurfaces'),
    previewSurfacesAfter500Ms: maxField('previewSurfacesAfter500Ms'),
    duplicateFinalPublications: values.reduce((sum, metrics) =>
      sum + (metrics.duplicateFinalPublications || 0), 0),
    pixelDifferencePercent: maxField('pixelDifferencePercent'),
    scrollRenderCancellations: values.reduce((sum, metrics) =>
      sum + (metrics.scrollRenderCancellations || 0), 0),
    zoomRenderCancellations: values.reduce((sum, metrics) =>
      sum + (metrics.zoomRenderCancellations || 0), 0),
    javascriptResourcePeakBytes: maxField('javascriptResourcePeakBytes'),
    javascriptResourceBudgetBytes: minField('javascriptResourceBudgetBytes'),
    nativePixmapPeakBytes: maxField('nativePixmapPeakBytes'),
    nativePixmapBudgetBytes: minField('nativePixmapBudgetBytes'),
    baselineRssBytes: maxField('baselineRssBytes'),
    processStartRssBytes: maxField('processStartRssBytes'),
    peakRssBytes: maxField('peakRssBytes'),
    settledRssBytes: worstRss.settledRssBytes ?? null,
    rssCeilingBytes: worstRss.rssCeilingBytes ?? null,
    secondTraversalGrowthBytes: maxField('secondTraversalGrowthBytes'),
    freshPackagedProcessRuns: reports.length,
  };
}

async function run(options) {
  const runCount = Math.max(1, Number(options.runs) || 2);
  const reports = [];
  for (let index = 1; index <= runCount; index += 1) {
    reports.push(await runOnce({
      ...options,
      runs: 1,
      outputPath: runOutputPath(options.outputPath, index),
    }));
  }
  if (runCount === 1) {
    await writeFile(options.outputPath, `${JSON.stringify(reports[0], null, 2)}\n`);
    return reports[0];
  }
  const source = reports.at(-1);
  const aggregate = evaluateLargePdfPerformanceReport({
    ...source,
    status: 'RUNNING',
    decision: null,
    failures: [],
    evidenceIssues: [],
    criteria: {},
    generatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metrics: aggregateMetrics(reports),
    measurements: {
      processRuns: reports.map((report, index) => ({
        run: index + 1,
        statusIgnoringFreshProcessCount: report.failures?.every?.((failure) =>
          failure === 'freshPackagedProcessRuns') === true ? 'PASS' : report.status,
        output: path.relative(path.dirname(options.outputPath), runOutputPath(options.outputPath, index + 1)),
        metrics: report.metrics,
      })),
    },
    artifacts: [
      ...(source.artifacts || []),
      ...reports.map((_, index) =>
        path.relative(path.dirname(options.outputPath), runOutputPath(options.outputPath, index + 1))),
    ],
  });
  await writeFile(options.outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  return aggregate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArguments(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'PASS') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message || error}\n`);
      process.exitCode = 1;
    });
}
