const DEFAULT_GAP = 40;
const DEFAULT_PADDING_TOP = 20;
const DEFAULT_PADDING_BOTTOM = 20;
const DEFAULT_SPREAD_GAP = 20;

function normalizedDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 612;
}

function normalizedRotation(value) {
  const rotation = ((Number(value) || 0) % 360 + 360) % 360;
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
}

export function pageGeometryEntries(dimensions, pageRotations = {}) {
  return (dimensions || []).map((dimension, index) => {
    let widthPt = normalizedDimension(dimension?.widthPt ?? dimension?.[0]);
    let heightPt = normalizedDimension(dimension?.heightPt ?? dimension?.[1]);
    const applicationRotation = normalizedRotation(pageRotations[index + 1]);
    if (applicationRotation === 90 || applicationRotation === 270) {
      [widthPt, heightPt] = [heightPt, widthPt];
    }
    return Object.freeze({ pageNum: index + 1, widthPt, heightPt, applicationRotation });
  });
}

export class PageGeometryIndex {
  constructor(entries, {
    pageGap = DEFAULT_GAP,
    paddingTop = DEFAULT_PADDING_TOP,
    paddingBottom = DEFAULT_PADDING_BOTTOM,
    spreadGap = DEFAULT_SPREAD_GAP,
  } = {}) {
    this.entries = (entries || []).map((entry, index) => Object.freeze({
      pageNum: Number(entry?.pageNum) || index + 1,
      widthPt: normalizedDimension(entry?.widthPt),
      heightPt: normalizedDimension(entry?.heightPt),
      applicationRotation: normalizedRotation(entry?.applicationRotation),
    }));
    this.byPage = new Map(this.entries.map((entry) => [entry.pageNum, entry]));
    this.pageGap = pageGap;
    this.paddingTop = paddingTop;
    this.paddingBottom = paddingBottom;
    this.spreadGap = spreadGap;
    this._rows = new Map();
    this._rowByPage = new Map();
  }

  rows(layout = 'continuous') {
    const mode = layout === 'book' ? 'book' : 'continuous';
    if (this._rows.has(mode)) return this._rows.get(mode);
    const rows = [];
    if (mode === 'book') {
      if (this.entries[0]) rows.push({ pages: [this.entries[0]] });
      for (let index = 1; index < this.entries.length; index += 2) {
        rows.push({ pages: this.entries.slice(index, index + 2) });
      }
    } else {
      for (const entry of this.entries) rows.push({ pages: [entry] });
    }
    let baseHeightBefore = 0;
    rows.forEach((row, rowIndex) => {
      row.index = rowIndex;
      row.heightPt = Math.max(...row.pages.map((page) => page.heightPt));
      row.baseHeightBefore = baseHeightBefore;
      for (const page of row.pages) this._rowByPage.set(`${mode}:${page.pageNum}`, row);
      baseHeightBefore += row.heightPt;
    });
    this._rows.set(mode, rows);
    return rows;
  }

  rowTop(row, scale) {
    return this.paddingTop + row.baseHeightBefore * scale + row.index * this.pageGap;
  }

  totalHeight(scale = 1, layout = 'continuous') {
    const rows = this.rows(layout);
    if (!rows.length) return 0;
    const last = rows[rows.length - 1];
    return this.rowTop(last, scale) + last.heightPt * scale + this.paddingBottom;
  }

  contentWidth(scale = 1, layout = 'continuous', minimumWidth = 0) {
    const widest = this.rows(layout).reduce((maximum, row) => {
      const width = row.pages.reduce((sum, page) => sum + page.widthPt * scale, 0)
        + Math.max(0, row.pages.length - 1) * this.spreadGap;
      return Math.max(maximum, width);
    }, 0);
    return Math.max(minimumWidth, widest + 40);
  }

  pageRect(pageNum, { scale = 1, layout = 'continuous', contentWidth = 0 } = {}) {
    const page = this.byPage.get(pageNum);
    if (!page) return null;
    this.rows(layout);
    const row = this._rowByPage.get(`${layout === 'book' ? 'book' : 'continuous'}:${pageNum}`);
    if (!row) return null;
    const width = page.widthPt * scale;
    const height = page.heightPt * scale;
    const resolvedContentWidth = this.contentWidth(scale, layout, contentWidth);
    let x = (resolvedContentWidth - width) / 2;
    if (layout === 'book') {
      const center = resolvedContentWidth / 2;
      const isRight = pageNum === 1 || pageNum % 2 === 1;
      x = isRight ? center + this.spreadGap / 2 : center - this.spreadGap / 2 - width;
    }
    return Object.freeze({
      pageNum,
      x,
      y: this.rowTop(row, scale),
      width,
      height,
      rowIndex: row.index,
    });
  }

  pageAtOffset(offset, { scale = 1, layout = 'continuous' } = {}) {
    const rows = this.rows(layout);
    if (!rows.length) return null;
    const target = Math.max(0, Number(offset) || 0);
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const row = rows[middle];
      const bottom = this.rowTop(row, scale) + row.heightPt * scale + this.pageGap;
      if (bottom < target) low = middle + 1;
      else high = middle;
    }
    return rows[low].pages[0]?.pageNum ?? null;
  }

  rowIndexAtOffset(offset, { scale = 1, layout = 'continuous' } = {}) {
    const rows = this.rows(layout);
    if (!rows.length) return -1;
    const target = Math.max(0, Number(offset) || 0);
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const row = rows[middle];
      const bottom = this.rowTop(row, scale) + row.heightPt * scale + this.pageGap;
      if (bottom < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  visiblePages({
    scrollTop = 0,
    viewportHeight = 0,
    scale = 1,
    layout = 'continuous',
    overscanPx = Math.max(0, viewportHeight * 2),
    overscanBeforePx = null,
    overscanAfterPx = null,
    maxPages = 9,
    protectedPages = [],
  } = {}) {
    const rows = this.rows(layout);
    const before = Math.max(0, Number(overscanBeforePx ?? overscanPx) || 0);
    const after = Math.max(0, Number(overscanAfterPx ?? overscanPx) || 0);
    const start = Math.max(0, scrollTop - before);
    const end = scrollTop + viewportHeight + after;
    const center = scrollTop + viewportHeight / 2;
    const candidates = [];
    const firstRow = this.rowIndexAtOffset(start, { scale, layout });
    for (let rowIndex = Math.max(0, firstRow); rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const top = this.rowTop(row, scale);
      const bottom = top + row.heightPt * scale;
      if (top > end) break;
      if (bottom < start) continue;
      for (const page of row.pages) {
        candidates.push({ pageNum: page.pageNum, distance: Math.abs((top + bottom) / 2 - center) });
      }
    }
    const limit = Math.max(1, maxPages);
    const protectedSet = new Set(protectedPages.filter((page) => this.byPage.has(page)));
    const selected = [...protectedSet].slice(0, limit);
    const nearby = candidates
      .sort((left, right) => left.distance - right.distance)
      .map((entry) => entry.pageNum)
      .filter((page) => !protectedSet.has(page));
    for (const page of nearby) {
      if (selected.length >= limit) break;
      selected.push(page);
    }
    return selected.sort((left, right) => left - right);
  }
}
