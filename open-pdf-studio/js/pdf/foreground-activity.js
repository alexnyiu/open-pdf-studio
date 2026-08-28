import {
  incrementPerformanceCounter,
  recordPerformanceEvent,
  recordPerformanceSample,
} from './performance-metrics.js';

const clock = () => globalThis.performance?.now?.() ?? Date.now();

let interactionUntil = 0;
let interactionRevision = 0;
let idleMemoryReleaseTimer = null;
let idleMemoryReleaseInFlight = false;
let idleMemoryReleasedRevision = 0;

function scheduleIdleMemoryRelease(settleMs, minimumDelayMs = 2_000) {
  if (typeof window === 'undefined') return;
  if (idleMemoryReleaseTimer) clearTimeout(idleMemoryReleaseTimer);
  const requestedRevision = interactionRevision;
  const attempt = async () => {
    idleMemoryReleaseTimer = null;
    if (idleMemoryReleasedRevision >= requestedRevision) return;
    if (idleMemoryReleaseInFlight) {
      idleMemoryReleaseTimer = setTimeout(attempt, 250);
      return;
    }
    if (!isPdfForegroundIdle()) {
      idleMemoryReleaseTimer = setTimeout(attempt, 250);
      return;
    }
    idleMemoryReleaseInFlight = true;
    const releaseStartedAt = clock();
    recordPerformanceEvent('memory:idle-release-start', {
      revision: requestedRevision,
      currentRevision: interactionRevision,
    });
    try {
      const platform = await import('../core/platform.js');
      const stateModule = await import('../core/state.js');
      const activeDocument = stateModule.getActiveDocument?.();
      let bitmapTrim = null;
      let continuousSurfaceTrim = null;
      if (activeDocument?.performanceProfile?.largeDocument && activeDocument.filePath) {
        const [bitmapCache, textSessions, renderer] = await Promise.all([
          import('./page-bitmap-cache.js'),
          import('../text/text-edit-session.js'),
          import('./renderer.js'),
        ]);
        continuousSurfaceTrim = renderer.trimIdleContinuousPageSurfaces?.() || null;
        const editSession = textSessions.getActiveTextEditSession?.();
        bitmapTrim = bitmapCache.trimIdlePageBitmaps({
          filePath: activeDocument.filePath,
          currentPageNum: activeDocument.currentPage,
          protectedPageNums: editSession?.ownerDocumentId === activeDocument.id
            ? [editSession.pageNum] : [],
        });
        incrementPerformanceCounter(
          'idleDecodedBitmapEvictions',
          Number(bitmapTrim?.evictedEntries) || 0,
        );
        incrementPerformanceCounter(
          'idleDecodedBitmapEvictedBytes',
          Number(bitmapTrim?.evictedBytes) || 0,
        );
        recordPerformanceEvent('memory:decoded-bitmap-trim', {
          revision: requestedRevision,
          ...bitmapTrim,
        });
        if ((Number(continuousSurfaceTrim?.releasedPages) || 0) > 0) {
          // Let WebKit retire the removed canvas layers before allocator
          // pressure relief. The timeout fallback still progresses when RAF
          // is throttled in an occluded packaged window.
          await Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            new Promise((resolve) => setTimeout(resolve, 50)),
          ]);
        }
      }
      if (platform.isTauri()) {
        const firstRelease = await platform.invoke('release_idle_render_memory');
        let secondRelease = null;
        if ((Number(bitmapTrim?.evictedEntries) || 0) > 0
            || (Number(continuousSurfaceTrim?.releasedPages) || 0) > 0) {
          // WebKit retires an explicitly closed ImageBitmap after its
          // compositor lease unwinds. Give that handoff time to finish, then
          // re-check ownership and idleness before asking libmalloc for a
          // second pressure-relief pass. Never let this follow-up overlap a
          // newly started scroll, zoom, edit, or save operation.
          await new Promise((resolve) => setTimeout(resolve, 750));
          if (interactionRevision === requestedRevision && isPdfForegroundIdle()) {
            secondRelease = await platform.invoke('release_idle_render_memory');
          } else {
            recordPerformanceEvent('memory:allocator-relief-deferred', {
              revision: requestedRevision,
              currentRevision: interactionRevision,
            });
          }
        }
        const allocatorReclaimedBytes = (Number(firstRelease?.allocatorReclaimedBytes) || 0)
          + (Number(secondRelease?.allocatorReclaimedBytes) || 0);
        const nativePixmapEvictedBytes = (Number(firstRelease?.nativePixmapEvictedBytes) || 0)
          + (Number(secondRelease?.nativePixmapEvictedBytes) || 0);
        incrementPerformanceCounter('idleMemoryReleases');
        incrementPerformanceCounter(
          'allocatorReclaimedBytes',
          allocatorReclaimedBytes,
        );
        recordPerformanceEvent('memory:idle-release-complete', {
          revision: requestedRevision,
          currentRevision: interactionRevision,
          elapsedMs: clock() - releaseStartedAt,
          allocatorReclaimedBytes,
          nativePixmapEvictedBytes,
          decodedBitmapEvictedBytes: Number(bitmapTrim?.evictedBytes) || 0,
          duplicateDecodedBitmapEvictedBytes: Number(bitmapTrim?.duplicateBytesEvicted) || 0,
          continuousSurfaceEvictedBytes: Number(continuousSurfaceTrim?.releasedBytes) || 0,
          continuousSurfaceEvictedPages: Number(continuousSurfaceTrim?.releasedPages) || 0,
          allocatorPressureReliefPasses: secondRelease ? 2 : 1,
        });
        recordPerformanceSample('idleMemoryReleaseMs', clock() - releaseStartedAt);
      }
    } catch (error) {
      recordPerformanceEvent('memory:idle-release-failed', {
        revision: requestedRevision,
        elapsedMs: clock() - releaseStartedAt,
        message: error?.message || String(error),
      });
      console.warn('[performance] Idle render-memory release failed:', error?.message || error);
    } finally {
      idleMemoryReleasedRevision = Math.max(idleMemoryReleasedRevision, requestedRevision);
      idleMemoryReleaseInFlight = false;
      if (interactionRevision > idleMemoryReleasedRevision && !idleMemoryReleaseTimer) {
        // Activity that arrived while pressure relief was running already sat
        // through the ordinary two-second debounce. Recheck promptly instead
        // of imposing a second full delay; attempt() still refuses to run
        // until the foreground and render scheduler are genuinely idle.
        scheduleIdleMemoryRelease(0, 250);
      }
    }
  };
  // Wait long enough for scroll/zoom paint and WebKit response lifecycles to
  // unwind. One coalesced release after genuine idle is both more effective
  // and avoids repeatedly contending on macOS allocator-zone locks.
  idleMemoryReleaseTimer = setTimeout(
    attempt,
    Math.max(minimumDelayMs, settleMs + Math.max(0, minimumDelayMs - 250)),
  );
}

/**
 * Announces foreground PDF work to every background producer. The deadline is
 * monotonic, so overlapping scroll/zoom/edit/save signals share one 250 ms
 * settle window instead of racing independent timers.
 */
export function notePdfForegroundActivity(reason = 'interaction', settleMs = 250) {
  const normalizedSettleMs = Math.max(0, Number(settleMs) || 0);
  interactionUntil = Math.max(interactionUntil, clock() + normalizedSettleMs);
  interactionRevision += 1;
  scheduleIdleMemoryRelease(normalizedSettleMs);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('opds:pdf-foreground-activity', {
      detail: { reason, interactionUntil, revision: interactionRevision },
    }));
  }
  return interactionRevision;
}

export function pdfForegroundActivitySnapshot() {
  return Object.freeze({
    active: clock() < interactionUntil,
    interactionUntil,
    revision: interactionRevision,
  });
}

export function isPdfForegroundIdle() {
  if (clock() < interactionUntil) return false;
  if (typeof window === 'undefined') return true;
  return (window.__pdfRenderInFlight || 0) === 0
    && !window.__pdfSaveInProgress;
}

export async function waitForPdfForegroundIdle({ isCurrent = () => true, pollMs = 50 } = {}) {
  while (isCurrent() && !isPdfForegroundIdle()) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return isCurrent();
}

export function resetPdfForegroundActivityForTests() {
  if (idleMemoryReleaseTimer) clearTimeout(idleMemoryReleaseTimer);
  idleMemoryReleaseTimer = null;
  idleMemoryReleaseInFlight = false;
  idleMemoryReleasedRevision = 0;
  interactionUntil = 0;
  interactionRevision = 0;
}
