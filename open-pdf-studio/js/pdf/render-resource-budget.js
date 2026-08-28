import { calculateRenderResourceBudget } from './render-performance.js';
import { recordPerformancePeak } from './performance-metrics.js';

const resources = new Map();
let budget = calculateRenderResourceBudget(null);
let activeDocumentId = null;
let sequence = 0;
let overBudget = false;

const categoryLimit = (category) => {
  if (category === 'metadata') return budget.metadataBytes;
  if (category === 'native') return budget.nativePixmapBytes;
  return budget.javascriptBytes;
};

function totals() {
  const result = {
    javascript: 0,
    native: 0,
    metadata: 0,
    total: 0,
    active: { javascript: 0, native: 0, metadata: 0, total: 0 },
    inactive: { javascript: 0, native: 0, metadata: 0, total: 0 },
  };
  for (const resource of resources.values()) {
    result[resource.category] = (result[resource.category] || 0) + resource.bytes;
    result.total += resource.bytes;
    const group = resource.documentId === activeDocumentId ? result.active : result.inactive;
    group[resource.category] = (group[resource.category] || 0) + resource.bytes;
    group.total += resource.bytes;
  }
  return result;
}

function evictCategory(category) {
  const limit = categoryLimit(category);
  const activeLimit = limit * (Number(budget.activeDocumentShare) || 0.8);
  const inactiveLimit = limit - activeLimit;
  const evictGroup = (isActive, groupLimit) => {
    let used = [...resources.values()].reduce((sum, resource) => sum
      + (resource.category === category && (resource.documentId === activeDocumentId) === isActive
        ? resource.bytes : 0), 0);
    const candidates = [...resources.values()]
      .filter((resource) => resource.category === category
        && (resource.documentId === activeDocumentId) === isActive
        && !resource.protected?.())
      .sort((left, right) => left.touched - right.touched);
    for (const resource of candidates) {
      if (used <= groupLimit) break;
      resources.delete(resource.key);
      used -= resource.bytes;
      try { resource.release?.(); } catch {}
    }
  };
  evictGroup(false, inactiveLimit);
  evictGroup(true, activeLimit);
}

function enforce() {
  evictCategory('javascript');
  evictCategory('metadata');
  const current = totals();
  const activeShare = Number(budget.activeDocumentShare) || 0.8;
  overBudget = current.javascript > budget.javascriptBytes
    || current.metadata > budget.metadataBytes
    || current.active.javascript > budget.javascriptBytes * activeShare
    || current.inactive.javascript > budget.javascriptBytes * (1 - activeShare)
    || current.active.metadata > budget.metadataBytes * activeShare
    || current.inactive.metadata > budget.metadataBytes * (1 - activeShare);
  recordPerformancePeak('javascriptResourceBytes', current.javascript);
  recordPerformancePeak('metadataResourceBytes', current.metadata);
  recordPerformancePeak('trackedResourceBytes', current.total);
  recordPerformancePeak('trackedResourceCount', resources.size);
  return !overBudget;
}

export function configureRenderResourceBudget(nextBudget, documentId = activeDocumentId) {
  budget = nextBudget?.globalBytes ? nextBudget : calculateRenderResourceBudget(null);
  activeDocumentId = documentId || null;
  enforce();
  return renderResourceBudgetSnapshot();
}

export function setActiveRenderDocument(documentId) {
  activeDocumentId = documentId || null;
  enforce();
}

export function isActiveRenderDocument(documentId) {
  return Boolean(documentId) && documentId === activeDocumentId;
}

export function registerRenderResource({
  key,
  category = 'javascript',
  documentId = null,
  bytes = 0,
  protected: isProtected = null,
  release = null,
} = {}) {
  if (!key) throw new TypeError('Render resource requires a stable key');
  resources.delete(key);
  resources.set(key, {
    key,
    category: category === 'metadata' || category === 'native' ? category : 'javascript',
    documentId,
    bytes: Math.max(0, Number(bytes) || 0),
    protected: typeof isProtected === 'function' ? isProtected : null,
    release: typeof release === 'function' ? release : null,
    touched: ++sequence,
  });
  enforce();
  return resources.has(key);
}

export function touchRenderResource(key) {
  const resource = resources.get(key);
  if (resource) resource.touched = ++sequence;
  return Boolean(resource);
}

export function unregisterRenderResource(key) {
  return resources.delete(key);
}

export function clearRenderResourcesForDocument(documentId, { release = false } = {}) {
  for (const [key, resource] of resources) {
    if (resource.documentId !== documentId) continue;
    resources.delete(key);
    if (release) {
      try { resource.release?.(); } catch {}
    }
  }
}

export function backgroundRenderAdmissionAllowed() {
  return !overBudget;
}

export function renderResourceBudgetSnapshot() {
  const usage = totals();
  return Object.freeze({
    activeDocumentId,
    budget,
    usage: Object.freeze(usage),
    resourceCount: resources.size,
    overBudget,
  });
}

export function resetRenderResourceBudgetForTests() {
  resources.clear();
  budget = calculateRenderResourceBudget(null);
  activeDocumentId = null;
  sequence = 0;
  overBudget = false;
}
