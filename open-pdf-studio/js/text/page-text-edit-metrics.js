let placementReads = 0;
let placementWrites = 0;

export function recordPageTextEditPlacementRead() {
  placementReads += 1;
}

export function recordPageTextEditPlacementWrite() {
  placementWrites += 1;
}

export function pageTextEditPlacementMetrics() {
  return { reads: placementReads, writes: placementWrites };
}

export function resetPageTextEditPlacementMetrics() {
  placementReads = 0;
  placementWrites = 0;
}
