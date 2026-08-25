const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

export function directionalPreloadPages(center, pageCount, direction = 1) {
  const forward = direction < 0 ? -1 : 1;
  return [center, center + forward, center + 2 * forward, center + 3 * forward, center - forward]
    .filter((page, index, pages) => page >= 1 && page <= pageCount && pages.indexOf(page) === index);
}

export function wholeDocumentPreloadPages(center, pageCount, visiblePages = []) {
  const pages = [center, ...visiblePages, ...Array.from({ length: pageCount }, (_, index) => index + 1)];
  return pages.filter((page, index) => Number.isInteger(page)
    && page >= 1 && page <= pageCount && pages.indexOf(page) === index);
}

export class PreloadResourceBudget {
  constructor({ maxPages, maxBytes, maxWorkMs }) {
    this.maxPages = maxPages;
    this.maxBytes = maxBytes;
    this.maxWorkMs = maxWorkMs;
    this.pages = 0;
    this.bytes = 0;
    this.workMs = 0;
  }

  record({ bytes = 0, elapsedMs = 0 } = {}) {
    this.pages += 1;
    this.bytes += Math.max(0, Number(bytes) || 0);
    this.workMs += Math.max(0, Number(elapsedMs) || 0);
    return this.limitReason();
  }

  limitReason() {
    if (this.pages >= this.maxPages) return 'pages';
    if (this.bytes >= this.maxBytes) return 'bytes';
    if (this.workMs >= this.maxWorkMs) return 'time';
    return null;
  }
}

export class BoundedPdfPreloadController {
  constructor({ load, beforeLoad = null, maxPages = 6, maxBytes = 24 * 1024 * 1024, isIdle = () => true, log = () => {} }) {
    this.load = load;
    this.beforeLoad = beforeLoad;
    this.maxPages = maxPages;
    this.maxBytes = maxBytes;
    this.isIdle = isIdle;
    this.log = log;
    this.entries = new Map();
    this.promises = new Map();
    this.generation = 0;
    this.task = Promise.resolve();
    this.protectedPages = new Set();
  }

  get(page) {
    const entry = this.entries.get(page);
    if (!entry) { this.log({ type: 'miss', page }); return null; }
    entry.used = now();
    this.log({ type: 'hit', page, bytes: entry.bytes });
    return entry.value;
  }

  delete(page) {
    return this.entries.delete(page);
  }

  schedule(pages, { protectedPages = [] } = {}) {
    const generation = ++this.generation;
    this.protectedPages = new Set(protectedPages);
    this.task = this.task.catch(() => {}).then(async () => {
      if (generation !== this.generation || !this.isIdle()) return;
      if (this.beforeLoad) await this.beforeLoad(pages);
      for (const page of pages) {
        if (generation !== this.generation) { this.log({ type: 'cancellation', page }); return; }
        if (!this.isIdle()) { this.log({ type: 'cancellation', page, reason: 'foreground-resumed' }); return; }
        await this._load(page, generation);
      }
    });
    return this.task;
  }

  async _load(page, generation) {
    if (this.entries.has(page)) { this.get(page); return; }
    if (this.promises.has(page)) { this.log({ type: 'deduplicated', page }); await this.promises.get(page); return; }
    const started = now();
    const pending = Promise.resolve(this.load(page)).then((result) => {
      if (generation !== this.generation || !result) return null;
      const value = result.value ?? result;
      const bytes = Math.max(0, Number(result.bytes) || 0);
      this.entries.set(page, { value, bytes, used: now() });
      this.log({ type: 'loaded', page, bytes, elapsedMs: now() - started });
      this._evict();
      return value;
    }).finally(() => this.promises.delete(page));
    this.promises.set(page, pending);
    await pending;
  }

  _evict() {
    const total = () => [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size > this.maxPages || total() > this.maxBytes) {
      const candidate = [...this.entries.entries()]
        .filter(([page]) => !this.protectedPages.has(page))
        .sort((left, right) => left[1].used - right[1].used)[0];
      if (!candidate) return;
      this.entries.delete(candidate[0]);
      this.log({ type: 'eviction', page: candidate[0], bytes: candidate[1].bytes });
    }
  }

  clear() {
    this.generation += 1;
    this.entries.clear();
    this.promises.clear();
  }
}
