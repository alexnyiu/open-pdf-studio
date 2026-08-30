export function planPostRestoreRequiredPages({
  visiblePages = [],
  changedPages = [],
  pageCount = Number.MAX_SAFE_INTEGER,
} = {}) {
  const maximum = Math.max(0, Number(pageCount) || 0);
  return Object.freeze([...new Set([...visiblePages, ...changedPages].map(Number)
    .filter((pageNum) => Number.isSafeInteger(pageNum)
      && pageNum > 0 && pageNum <= maximum))]
    .sort((left, right) => left - right));
}

export async function awaitRequiredPageRenders(requiredPages, schedulePage) {
  const pages = [...new Set((requiredPages || []).map(Number)
    .filter((page) => Number.isInteger(page) && page > 0))];
  const results = await Promise.all(pages.map(async (pageNum) => ({
    pageNum,
    scheduled: await schedulePage(pageNum),
  })));
  const completedPages = results
    .filter(({ scheduled }) => scheduled?.status === 'complete' && scheduled.value?.ready === true)
    .map(({ pageNum }) => pageNum);
  return Object.freeze({
    requiredPages: Object.freeze(pages),
    completedPages: Object.freeze(completedPages),
    ready: completedPages.length === pages.length,
    results: Object.freeze(results),
  });
}
