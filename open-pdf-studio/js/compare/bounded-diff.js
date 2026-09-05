/** Linear-space LCS between stable unique anchors. Work is capped per request. */
export function boundedDiff(a, b, { maxWork = 4_000_000 } = {}) {
  const ops = [];
  let work = 0;
  function coarse(lo, hi, start, end) {
    ops.partial = true;
    for (let i = lo; i < hi; i++) ops.push({ op: 'del', oldIdx: i });
    for (let j = start; j < end; j++) ops.push({ op: 'ins', newIdx: j });
  }
  function lengths(lo, hi, start, end, reverse) {
    const row = new Uint32Array(end - start + 1);
    for (let i = 0; i < hi - lo; i++) {
      let diagonal = 0;
      for (let j = 1; j <= end - start; j++) {
        const previous = row[j];
        row[j] = a[reverse ? hi - 1 - i : lo + i] === b[reverse ? end - j : start + j - 1]
          ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = previous;
      }
    }
    return row;
  }
  function region(lo, hi, start, end) {
    while (lo < hi && start < end && a[lo] === b[start]) ops.push({ op: 'eq', oldIdx: lo++, newIdx: start++ });
    let suffix = 0;
    while (lo < hi - suffix && start < end - suffix && a[hi - suffix - 1] === b[end - suffix - 1]) suffix++;
    const h = hi - suffix, e = end - suffix;
    if (lo === h) { for (let j = start; j < e; j++) ops.push({ op: 'ins', newIdx: j }); }
    else if (start === e) { for (let i = lo; i < h; i++) ops.push({ op: 'del', oldIdx: i }); }
    else if (h - lo === 1) {
      const match = b.indexOf(a[lo], start);
      if (match < 0 || match >= e) {
        ops.push({ op: 'del', oldIdx: lo });
        for (let j = start; j < e; j++) ops.push({ op: 'ins', newIdx: j });
      } else {
        for (let j = start; j < match; j++) ops.push({ op: 'ins', newIdx: j });
        ops.push({ op: 'eq', oldIdx: lo, newIdx: match });
        for (let j = match + 1; j < e; j++) ops.push({ op: 'ins', newIdx: j });
      }
    } else if ((work += (h - lo) * (e - start)) > maxWork) coarse(lo, h, start, e);
    else {
      const mid = (lo + h) >>> 1;
      let left = lengths(lo, mid, start, e, false), right = lengths(mid, h, start, e, true);
      let split = 0, best = -1;
      for (let j = 0; j <= e - start; j++) {
        const score = left[j] + right[e - start - j];
        if (score > best) { best = score; split = j; }
      }
      left = right = null;
      region(lo, mid, start, start + split); region(mid, h, start + split, e);
    }
    for (let i = 0; i < suffix; i++) ops.push({ op: 'eq', oldIdx: h + i, newIdx: e + i });
  }
  const unique = values => {
    const map = new Map();
    values.forEach((value, i) => map.set(value, map.has(value) ? -1 : i));
    return map;
  };
  const A = unique(a), B = unique(b), pairs = [];
  for (const [value, i] of A) if (i >= 0 && B.get(value) >= 0) pairs.push([i, B.get(value)]);
  pairs.sort((x, y) => x[0] - y[0]);
  const tails = [], previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid; }
    if (lo) previous[i] = tails[lo - 1]; tails[lo] = i;
  });
  const anchors = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) anchors.push(pairs[i]);
  anchors.reverse();
  let lo = 0, start = 0;
  for (const [i, j] of anchors) { region(lo, i, start, j); ops.push({ op: 'eq', oldIdx: i, newIdx: j }); lo = i + 1; start = j + 1; }
  region(lo, a.length, start, b.length);
  return ops;
}
