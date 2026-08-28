const normalizedHeight = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

export function createThumbnailGeometry(pageCount, {
  heightForPage = () => 212,
  itemChromePx = 31,
  gapPx = 4,
} = {}) {
  const count = Math.max(0, Number(pageCount) || 0);
  const offsets = new Array(count + 1).fill(0);
  for (let pageNum = 1; pageNum <= count; pageNum += 1) {
    offsets[pageNum] = offsets[pageNum - 1]
      + normalizedHeight(heightForPage(pageNum), 212) + itemChromePx + gapPx;
  }
  const pageAtOffset = (offset) => {
    let low = 0;
    let high = count;
    const target = Math.max(0, Number(offset) || 0);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] <= target) low = middle + 1;
      else high = middle;
    }
    return Math.min(count, low + 1);
  };
  return Object.freeze({
    pageCount: count,
    totalHeight: offsets[count],
    pageTop: (pageNum) => offsets[Math.max(0, Math.min(count, Number(pageNum) - 1))],
    pageBottom: (pageNum) => offsets[Math.max(0, Math.min(count, Number(pageNum)))],
    window({ scrollTop = 0, viewportHeight = 0, overscanItems = 10, maxItems = 32 } = {}) {
      if (!count) return Object.freeze({ start: 1, end: 0, topSpacer: 0, bottomSpacer: 0, pages: [] });
      const first = pageAtOffset(scrollTop);
      const last = pageAtOffset(scrollTop + viewportHeight);
      let start = Math.max(1, first - overscanItems);
      let end = Math.min(count, last + overscanItems);
      if (end - start + 1 > maxItems) {
        const visibleCount = Math.max(1, last - first + 1);
        const room = Math.max(0, maxItems - visibleCount);
        const before = Math.min(first - 1, Math.floor(room / 2));
        start = first - before;
        end = Math.min(count, start + maxItems - 1);
        start = Math.max(1, end - maxItems + 1);
      }
      const pages = Array.from({ length: end - start + 1 }, (_, index) => start + index);
      return Object.freeze({
        start,
        end,
        pages,
        topSpacer: offsets[start - 1],
        bottomSpacer: offsets[count] - offsets[end],
      });
    },
  });
}
