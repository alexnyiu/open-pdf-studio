import { boundedDiff } from './bounded-diff.js';
// Pure tekst-diff-kern voor de vergelijkweergave.
//
// Geen DOM- of pdf.js-afhankelijkheden: dit bestand is ook direct vanuit Node
// te importeren (unittest: scripts/test-text-diff.mjs). De extractie van tekst
// uit de PDF's zit in text-compare.js; hier alleen het pure rekenwerk:
//
//   groupItemsIntoLines(items)  — tekst-items (x/y/str) → regels per pagina
//   diffPageTexts(oldPages, newPages) — regel-diff (Myers) over ALLE pagina's
//                                       heen, met paginanummers per verschil
//
// Regels worden vóór vergelijking genormaliseerd (witruimte samengevouwen,
// getrimd) zodat een andere spatiëring of regellengte-omloop binnen dezelfde
// regel geen vals verschil oplevert. Regels die na normalisatie leeg zijn
// tellen niet mee.

/** Witruimte-normalisatie: NBSP → spatie, reeksen samenvouwen, trimmen. */
export function normalizeLine(s) {
  return String(s || '').replace(/[\s ]+/g, ' ').trim();
}

/**
 * Groepeer pdf.js-achtige tekst-items in leesregels.
 * @param {Array<{str:string, x:number, y:number, height?:number}>} items
 *   y is de baseline in paginacoördinaten (oorsprong maakt niet uit, zolang
 *   consistent); items van dezelfde regel hebben (bijna) dezelfde y.
 * @returns {string[]} regels, in leesvolgorde (hoogste y eerst = bovenaan als
 *   y van onder naar boven loopt, zoals in PDF-ruimte).
 */
export function groupItemsIntoLines(items) {
  return groupItemsIntoLineObjs(items).map((l) => l.text);
}

/**
 * Als groupItemsIntoLines, maar met per regel ook de omsluitende rechthoek in
 * weergave-coördinaten. Items mogen optioneel rx/ry/rw/rh dragen (rect in
 * pagina-weergaveruimte, oorsprong linksboven, schaal 1); zonder die velden is
 * rect null. De rect voedt de tekst-diff-arcering op de pagina.
 * @returns {Array<{text:string, rect:{x:number,y:number,w:number,h:number}|null}>}
 */
export function groupItemsIntoLineObjs(items) {
  const segs = _groupLineSegs(items);
  return segs.map((seg) => {
    const text = normalizeLine(seg.map((s) => s.str).join(' '));
    let rect = null;
    for (const it of seg) {
      if (it.rw == null || it.rh == null) continue;
      const x1 = it.rx;
      const y1 = it.ry;
      const x2 = it.rx + it.rw;
      const y2 = it.ry + it.rh;
      if (!rect) rect = { x1, y1, x2, y2 };
      else {
        rect.x1 = Math.min(rect.x1, x1);
        rect.y1 = Math.min(rect.y1, y1);
        rect.x2 = Math.max(rect.x2, x2);
        rect.y2 = Math.max(rect.y2, y2);
      }
    }
    return {
      text,
      rect: rect ? { x: rect.x1, y: rect.y1, w: rect.x2 - rect.x1, h: rect.y2 - rect.y1 } : null,
    };
  }).filter((l) => l.text);
}

// Interne regel-segmentatie: sorteert op y (aflopend) en x, en knipt op
// baseline-sprongen. Retourneert arrays van items per regel (x-gesorteerd).
function _groupLineSegs(items) {
  const its = (items || []).filter((it) => it && it.str && normalizeLine(it.str));
  if (!its.length) return [];
  // Sorteer op y (aflopend: PDF-y loopt omhoog → bovenste regel eerst), dan x.
  const sorted = its.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let cur = [];
  let curY = null;
  for (const it of sorted) {
    const tol = Math.max(2, (it.height || 10) * 0.5);
    if (curY === null || Math.abs(it.y - curY) <= tol) {
      cur.push(it);
      // Loop mee met de regel (licht schuine baselines blijven één regel).
      curY = curY === null ? it.y : (curY + it.y) / 2;
    } else {
      lines.push(cur);
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.map((seg) => seg.sort((a, b) => a.x - b.x));
}

// Vergelijkings-sleutel: alle spaties eruit. De pdf.js-tekstextractie splitst
// items op net iets andere plekken per document ("aansprakelijkheid" vs
// "a ansprakelijkheid") — inhoudelijk identieke regels zouden anders als
// gewijzigd verschijnen. Twee regels die alleen in spatiëring verschillen
// gelden als gelijk (dat dekt meteen de eis "alleen-witruimte → geen
// verschil").
function lineKey(s) {
  return normalizeLine(s).replace(/ /g, '');
}

// ── Myers O(ND) regel-diff ────────────────────────────────────────────────
// Retourneert een lijst ops: {op:'eq'|'del'|'ins', oldIdx?, newIdx?}
const myersDiff = boundedDiff;

/**
 * Vergelijk twee documenten op regelniveau, over paginagrenzen heen.
 *
 * @param {Array<{page:number, lines:string[]}>} oldPages
 * @param {Array<{page:number, lines:string[]}>} newPages
 * @returns {Array<{type:'added'|'removed'|'modified', oldPage:number|null,
 *   newPage:number|null, oldText:string, newText:string}>}
 *
 * Tekst mag tussen versies naar een andere pagina schuiven: de diff draait
 * over de aaneengeschakelde regels van het hele document; het paginanummer
 * per regel reist mee als tag. Een aaneengesloten blok verwijderde regels
 * direct gevolgd door toegevoegde regels wordt als 'modified' (oud → nieuw)
 * gerapporteerd; losse blokken als 'removed'/'added'.
 */
export function diffPageTexts(oldPages, newPages) {
  // Regels mogen kale strings zijn óf {text, rect}-objecten (met rect in
  // weergave-coördinaten, zie groupItemsIntoLineObjs). De rect reist mee als
  // metadata zodat een verschil op de pagina gearceerd kan worden.
  const flat = (pages) => {
    const lines = [];
    const keys = [];
    const tags = [];
    const rects = [];
    for (const p of pages || []) {
      for (const raw of p.lines || []) {
        const text = typeof raw === 'string' ? raw : (raw?.text || '');
        const n = normalizeLine(text);
        if (!n) continue;
        lines.push(n);
        keys.push(lineKey(n));
        tags.push(p.page);
        rects.push(typeof raw === 'object' && raw?.rect ? raw.rect : null);
      }
    }
    return { lines, keys, tags, rects };
  };
  const A = flat(oldPages);
  const B = flat(newPages);
  // Diff op de spatie-gestripte sleutel; de leesbare regel blijft de weergave.
  const ops = myersDiff(A.keys, B.keys);

  // Groepeer aaneengesloten del/ins-runs (gescheiden door 'eq') tot records.
  const changes = [];
  let dels = [];
  let inss = [];
  const flush = () => {
    if (!dels.length && !inss.length) return;
    const oldText = dels.map((i) => A.lines[i]).join('\n');
    const newText = inss.map((i) => B.lines[i]).join('\n');
    const oldPage = dels.length ? A.tags[dels[0]] : null;
    const newPage = inss.length ? B.tags[inss[0]] : null;
    // Per gediffde regel de bron-rect (incl. pagina) meenemen voor de arcering.
    const collectRects = (idxs, S) => idxs
      .filter((i) => S.rects[i])
      .map((i) => ({ page: S.tags[i], ...S.rects[i] }));
    const oldRects = collectRects(dels, A);
    const newRects = collectRects(inss, B);
    if (dels.length && inss.length) {
      changes.push({ type: 'modified', oldPage, newPage, oldText, newText, oldRects, newRects });
    } else if (dels.length) {
      changes.push({ type: 'removed', oldPage, newPage, oldText, newText: '', oldRects, newRects: [] });
    } else {
      changes.push({ type: 'added', oldPage, newPage, oldText: '', newText, oldRects: [], newRects });
    }
    dels = [];
    inss = [];
  };
  for (const op of ops) {
    if (op.op === 'eq') flush();
    else if (op.op === 'del') dels.push(op.oldIdx);
    else inss.push(op.newIdx);
  }
  flush();
  if (ops.partial) for (const change of changes) change.partial = true;
  return changes;
}

/**
 * Woord-niveau verfijning voor een 'modified' record: markeert welke woorden
 * verschillen. Retourneert {oldParts, newParts} met parts = [{text, changed}].
 * Gebruikt door de UI om binnen een gewijzigde regel de verschillen te
 * accentueren.
 */
export function diffWords(oldText, newText) {
  const aw = normalizeLine(oldText).split(' ').filter(Boolean);
  const bw = normalizeLine(newText).split(' ').filter(Boolean);
  const ops = myersDiff(aw, bw);
  const oldParts = [];
  const newParts = [];
  const push = (arr, text, changed) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += ' ' + text;
    else arr.push({ text, changed });
  };
  for (const op of ops) {
    if (op.op === 'eq') {
      push(oldParts, aw[op.oldIdx], false);
      push(newParts, bw[op.newIdx], false);
    } else if (op.op === 'del') {
      push(oldParts, aw[op.oldIdx], true);
    } else {
      push(newParts, bw[op.newIdx], true);
    }
  }
  return { oldParts, newParts, partial: !!ops.partial };
}

/** Complete presentation data in the worker; rendering must not rerun diff work. */
export function diffPageTextsForPresentation(oldPages, newPages) {
  return diffPageTexts(oldPages, newPages).map(change => {
    if (change.type !== 'modified') return change;
    // A coarse region has no proven word alignment. Keep it visibly coarse.
    const words = change.partial ? {
      oldParts: [{ text: change.oldText, changed: true }],
      newParts: [{ text: change.newText, changed: true }],
      partial: true,
    } : diffWords(change.oldText, change.newText);
    return { ...change, words, partial: !!change.partial || words.partial };
  });
}
