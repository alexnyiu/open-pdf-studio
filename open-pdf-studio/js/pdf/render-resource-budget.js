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

const emptyUsage = () => ({ javascript: 0, native: 0, metadata: 0, total: 0 });
let aggregate = emptyUsage();
const documentUsage = new Map();
function account(resource, direction) {
  let usage = documentUsage.get(resource.documentId);
  if (!usage) { usage = emptyUsage(); documentUsage.set(resource.documentId, usage); }
  const delta = resource.bytes * direction;
  usage[resource.category] += delta; usage.total += delta;
  aggregate[resource.category] += delta; aggregate.total += delta;
  if (usage.total === 0) documentUsage.delete(resource.documentId);
}
function removeResource(key) {
  const resource = resources.get(key);
  if (!resource) return false;
  resources.delete(key); account(resource, -1); return true;
}
function totals() {
  const active = { ...(documentUsage.get(activeDocumentId) || emptyUsage()) };
  const inactive = emptyUsage();
  for (const category of Object.keys(inactive)) inactive[category] = aggregate[category] - active[category];
  return { ...aggregate, active, inactive };
}
function evictCategory(category) {
  const limit = categoryLimit(category);
  const activeLimit = limit * (Number(budget.activeDocumentShare) || 0.8);
  const evictGroup = (isActive, groupLimit) => {
    const used = () => {
      const activeBytes = documentUsage.get(activeDocumentId)?.[category] || 0;
      return isActive ? activeBytes : aggregate[category] - activeBytes;
    };
    if (used() <= groupLimit) return;
    // Map order is the LRU order; no full-registry copy or sort per registration.
    for (const [key, resource] of resources) {
      if (used() <= groupLimit) break;
      if (resource.category !== category || (resource.documentId === activeDocumentId) !== isActive
          || resource.protected?.()) continue;
      removeResource(key);
      try { resource.release?.(); } catch {}
    }
  };
  evictGroup(false, limit - activeLimit);
  evictGroup(true, activeLimit);
}

function refreshPressure() {
  const current = totals();
  const activeShare = Number(budget.activeDocumentShare) || 0.8;
  overBudget = current.javascript > budget.javascriptBytes
    || current.native > budget.nativePixmapBytes
    || current.metadata > budget.metadataBytes
    || current.active.javascript > budget.javascriptBytes * activeShare
    || current.inactive.javascript > budget.javascriptBytes * (1 - activeShare)
    || current.active.native > budget.nativePixmapBytes * activeShare
    || current.inactive.native > budget.nativePixmapBytes * (1 - activeShare)
    || current.active.metadata > budget.metadataBytes * activeShare
    || current.inactive.metadata > budget.metadataBytes * (1 - activeShare);
  recordPerformancePeak('javascriptResourceBytes', current.javascript);
  recordPerformancePeak('nativeResourceBytes', current.native);
  recordPerformancePeak('metadataResourceBytes', current.metadata);
  recordPerformancePeak('trackedResourceBytes', current.total);
  recordPerformancePeak('trackedResourceCount', resources.size);
  return !overBudget;
}

function enforce() {
  evictCategory('javascript');
  evictCategory('native');
  evictCategory('metadata');
  return refreshPressure();
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
  removeResource(key);
  const resource = {
    key,
    category: category === 'metadata' || category === 'native' ? category : 'javascript',
    documentId,
    bytes: Math.max(0, Number(bytes) || 0),
    protected: typeof isProtected === 'function' ? isProtected : null,
    release: typeof release === 'function' ? release : null,
    touched: ++sequence,
  };
  resources.set(key, resource);
  account(resource, 1);
  enforce();
  return resources.has(key);
}

export function touchRenderResource(key) {
  const resource = resources.get(key);
  if (resource) { resource.touched = ++sequence; resources.delete(key); resources.set(key, resource); }
  return Boolean(resource);
}

export function unregisterRenderResource(key) {
  const removed = removeResource(key);
  refreshPressure();
  return removed;
}

export function clearRenderResourcesForDocument(documentId, { release = false } = {}) {
  for (const [key, resource] of resources) {
    if (resource.documentId !== documentId) continue;
    removeResource(key);
    if (release) {
      try { resource.release?.(); } catch {}
    }
  }
  refreshPressure();
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
  documentUsage.clear(); aggregate = emptyUsage();
  budget = calculateRenderResourceBudget(null);
  activeDocumentId = null;
  sequence = 0;
  overBudget = false;
}
