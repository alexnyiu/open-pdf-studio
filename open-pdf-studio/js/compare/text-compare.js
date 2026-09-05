import i18next from '../i18n/config.js';
const tr = (key, values) => i18next.t(`common:repair.${key}`, values);
import { comparisonGeneration, onComparisonDispose } from './comparison-session.js';
import { getCachedPdfBytes } from '../pdf/loader.js';
// Tekstvergelijking voor de vergelijkweergave.
//
// Extraheert de tekst van BEIDE documenten per pagina via pdf.js
// (getTextContent op het compare-eigen document uit compare-viewport.js),
// groepeert items in leesregels en draait de pure regel-diff uit
// text-diff.js over het hele document heen. Resultaat: een lijst
// {type, oldPage, newPage, oldText, newText}-records voor het tekstpaneel.
//
// Resultaten worden per (oldPath|newPath)-paar gecached; de tekstinhoud van
// een document verandert niet binnen een vergelijk-sessie.

import { getCompareDoc } from './compare-viewport.js';
import { groupItemsIntoLineObjs, normalizeLine } from './text-diff.js';

const _resultCache = new Map();
const _CACHE_MAX = 4;

async function _extractDocLines(filePath, generation, progress) {
  const doc = await getCompareDoc(filePath);
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (generation !== comparisonGeneration()) throw new DOMException('Comparison cancelled', 'AbortError');
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Viewport op schaal 1: de item-rects komen dan in dezelfde
    // pagina-weergaveruimte (oorsprong linksboven, schaal 1) terecht als de
    // annotatie-overlay — de arcering in CompareView vermenigvuldigt met
    // 1.5 × renderedZoom, exact zoals de pagina-bitmap zelf.
    const vp = page.getViewport({ scale: 1 });
    const items = tc.items
      .filter((it) => it.str !== undefined)
      .map((it) => {
        const tx = it.transform?.[4] ?? 0;
        const ty = it.transform?.[5] ?? 0;
        const h = it.height || Math.abs(it.transform?.[3] || 10);
        const w = it.width || 0;
        // Tekst-ruimte-rect (baseline linksonder) → viewport-rect linksboven,
        // via de viewport zodat ook geroteerde pagina's kloppen.
        const [vx1, vy1, vx2, vy2] = vp.convertToViewportRectangle([tx, ty, tx + w, ty + h]);
        return {
          str: it.str,
          x: tx,
          y: ty,
          height: h,
          rx: Math.min(vx1, vx2),
          ry: Math.min(vy1, vy2),
          rw: Math.abs(vx2 - vx1),
          rh: Math.abs(vy2 - vy1),
        };
      });
    // Kale paginanummer-regels ("4") wegfilteren: die verschuiven bij elke
    // herindeling van pagina's en vervuilen de lijst zonder inhoudelijke
    // betekenis.
    const lines = groupItemsIntoLineObjs(items).filter((l) => normalizeLine(l.text) !== String(p));
    pages.push({ page: p, lines });
    progress?.(p, doc.numPages);
    if (p % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return pages;
}

/**
 * Draai de tekstvergelijking tussen twee (in compare geopende) documenten.
 * @returns {Promise<Array>} diff-records (zie diffPageTexts).
 */
const workers = new Map();
let nextRequest = 0;
export async function runTextCompare(oldPath, newPath, onProgress) {
  if (!oldPath || !newPath) return [];
  const generation = comparisonGeneration();
  const oldBytes = getCachedPdfBytes(oldPath), newBytes = getCachedPdfBytes(newPath);
  const key = `${oldPath}|${newPath}`;
  const cached = _resultCache.get(key);
  if (cached?.oldBytes === oldBytes && cached?.newBytes === newBytes) return cached.changes;
  const [oldPages, newPages] = await Promise.all([
    _extractDocLines(oldPath, generation, (page, total) => onProgress?.(tr('readingOriginal', { page, total }))),
    _extractDocLines(newPath, generation, (page, total) => onProgress?.(tr('readingRevised', { page, total }))),
  ]);
  if (generation !== comparisonGeneration()) throw new DOMException('Comparison cancelled', 'AbortError');
  onProgress?.(tr('comparingText'));
  const changes = await new Promise((resolve, reject) => {
    const id = ++nextRequest;
    const worker = new Worker(new URL('./text-compare-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, value) => { workers.delete(id); worker.terminate(); error ? reject(error) : resolve(value); };
    workers.set(id, () => finish(new DOMException('Comparison cancelled', 'AbortError')));
    worker.onerror = event => finish(new Error(event.message || 'Comparison worker failed'));
    worker.onmessage = ({ data }) => { if (data.id === id) finish(data.error ? new Error(data.error) : null, data.changes); };
    worker.postMessage({ id, oldPages, newPages });
  });
  if (generation !== comparisonGeneration() || getCachedPdfBytes(oldPath) !== oldBytes || getCachedPdfBytes(newPath) !== newBytes) {
    throw new DOMException('Comparison source changed. Retry.', 'AbortError');
  }
  const result = changes.map(change => ({ ...change, source: 'text' }));
  _resultCache.set(key, { oldBytes, newBytes, changes: result });
  while (_resultCache.size > _CACHE_MAX) _resultCache.delete(_resultCache.keys().next().value);
  return result;
}
export function clearTextCompareCache() {
  for (const cancel of [...workers.values()]) cancel();
  _resultCache.clear();
}
onComparisonDispose(clearTextCompareCache);

export function comparisonTextResourceSnapshot() {
  return { results: _resultCache.size, workers: workers.size };
}
