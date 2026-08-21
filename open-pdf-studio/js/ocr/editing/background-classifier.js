import {
  SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD,
  SCANNED_TEXT_EDIT_MAX_ROUND_TRIP_ERROR_PX,
  SCANNED_TEXT_EDIT_MIN_BACKGROUND_COVERAGE,
  SCANNED_TEXT_EDIT_MIN_BACKGROUND_SAMPLES,
  SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE,
  SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION,
  SCANNED_TEXT_EDIT_REPAIRABLE_BACKGROUNDS,
} from '../contracts/scanned-text-edit-state.v1.js';

const MIN_BACKGROUND_SAMPLES = SCANNED_TEXT_EDIT_MIN_BACKGROUND_SAMPLES;
const MIN_BACKGROUND_COVERAGE = SCANNED_TEXT_EDIT_MIN_BACKGROUND_COVERAGE;

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average = mean(values)) {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function robustRange(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return percentile(sorted, 0.95) - percentile(sorted, 0.05);
}

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function saturation(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  return maximum === 0 ? 0 : (maximum - minimum) / maximum;
}

function solveThreeByThree(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) <= 1e-12) return [0, 0, mean(vector)];
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry < 4; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry < 4; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row) => row[3]);
}

function gradientMetrics(samples, width, height, luminanceAverage, luminanceVariance) {
  if (samples.length < 3) return { span: 0, explained: 0, residualStddev: 0 };
  let xx = 0;
  let xy = 0;
  let x1 = 0;
  let yy = 0;
  let y1 = 0;
  let xl = 0;
  let yl = 0;
  let l1 = 0;
  for (const sample of samples) {
    const x = width <= 1 ? 0 : sample.x / (width - 1);
    const y = height <= 1 ? 0 : sample.y / (height - 1);
    xx += x * x;
    xy += x * y;
    x1 += x;
    yy += y * y;
    y1 += y;
    xl += x * sample.luminance;
    yl += y * sample.luminance;
    l1 += sample.luminance;
  }
  const [a, b, c] = solveThreeByThree(
    [[xx, xy, x1], [xy, yy, y1], [x1, y1, samples.length]],
    [xl, yl, l1],
  );
  let residualVariance = 0;
  for (const sample of samples) {
    const x = width <= 1 ? 0 : sample.x / (width - 1);
    const y = height <= 1 ? 0 : sample.y / (height - 1);
    const residual = sample.luminance - (a * x + b * y + c);
    residualVariance += residual * residual;
  }
  residualVariance /= samples.length;
  const totalVariance = Math.max(0, luminanceVariance || standardDeviation(
    samples.map((sample) => sample.luminance),
    luminanceAverage,
  ) ** 2);
  return {
    span: Math.hypot(a, b),
    explained: totalVariance <= 1e-9 ? 0 : Math.max(0, Math.min(1, 1 - residualVariance / totalVariance)),
    residualStddev: Math.sqrt(residualVariance),
  };
}

function relativeRepairBounds(patch, approvedRegion) {
  const value = {
    x: approvedRegion.x - patch.originX,
    y: approvedRegion.y - patch.originY,
    width: approvedRegion.width,
    height: approvedRegion.height,
  };
  if (!Object.values(value).every(Number.isSafeInteger)
      || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
      || value.x + value.width > patch.widthPx || value.y + value.height > patch.heightPx) {
    throw new TypeError('The approved repair region must be contained by the classifier patch');
  }
  return value;
}

function outside(bounds, x, y) {
  return x < bounds.x || y < bounds.y
    || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height;
}

function classify(metrics) {
  if (metrics.sampleCount < MIN_BACKGROUND_SAMPLES
      || metrics.sampleCoverage < MIN_BACKGROUND_COVERAGE
      || metrics.opaqueFraction < SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION) return 'unknown';

  const maximumChannelRange = Math.max(...metrics.channelRobustRange);
  const lowChroma = metrics.colorBinCount <= 16 && metrics.saturationStddev <= 0.12;
  if (metrics.axisAlignedLineScore >= 0.48 && lowChroma
      && (metrics.strongEdgeDensity >= 0.008 || metrics.luminanceRobustRange >= 35)) {
    return 'table-line-art';
  }
  if (metrics.gradientSpan >= 16 && metrics.gradientExplainedVariance >= 0.82
      && metrics.gradientResidualStddev <= 9 && metrics.axisAlignedLineScore < 0.48) {
    return 'gradient';
  }
  if (maximumChannelRange <= 5 && metrics.luminanceStddev <= 2
      && metrics.edgeDensity <= 0.008 && metrics.gradientSpan < 8) {
    return 'flat';
  }
  if (maximumChannelRange <= 22 && metrics.luminanceStddev <= 6.5
      && metrics.edgeDensity <= 0.045 && metrics.strongEdgeDensity <= 0.008
      && metrics.gradientSpan < 14) {
    return 'near-flat';
  }
  if (metrics.colorBinCount >= 32 && metrics.luminanceStddev >= 16
      && (metrics.edgeDensity >= 0.08 || metrics.saturationStddev >= 0.14)) {
    return 'photographic';
  }
  if (metrics.luminanceStddev >= 4 || metrics.edgeDensity >= 0.025
      || maximumChannelRange >= 16) {
    return 'textured';
  }
  return 'unknown';
}

/**
 * Classify only the context pixels around the approved text-repair rectangle.
 * Text pixels inside the proposed repair are deliberately excluded.
 */
export function classifyScannedTextBackground({ patchBytes, patch, approvedRegion }) {
  if (!(patchBytes instanceof Uint8Array || patchBytes instanceof Uint8ClampedArray)
      || patchBytes.byteLength !== patch.widthPx * patch.heightPx * 4) {
    throw new TypeError('Background classification requires exact RGBA patch bytes');
  }
  const repair = relativeRepairBounds(patch, approvedRegion);
  const samples = [];
  const channels = [[], [], []];
  const luminances = [];
  const saturations = [];
  const colorBins = new Set();
  let opaque = 0;
  for (let y = 0; y < patch.heightPx; y += 1) {
    for (let x = 0; x < patch.widthPx; x += 1) {
      if (!outside(repair, x, y)) continue;
      const offset = (y * patch.widthPx + x) * 4;
      const red = patchBytes[offset];
      const green = patchBytes[offset + 1];
      const blue = patchBytes[offset + 2];
      const alpha = patchBytes[offset + 3];
      const light = luminance(red, green, blue);
      samples.push({ x, y, red, green, blue, alpha, luminance: light });
      channels[0].push(red);
      channels[1].push(green);
      channels[2].push(blue);
      luminances.push(light);
      saturations.push(saturation(red, green, blue));
      colorBins.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
      if (alpha === 255) opaque += 1;
    }
  }

  let edgePairs = 0;
  let edges = 0;
  let strongEdges = 0;
  const horizontalBoundaryStrong = Array.from({ length: Math.max(0, patch.heightPx - 1) }, () => [0, 0]);
  const verticalBoundaryStrong = Array.from({ length: Math.max(0, patch.widthPx - 1) }, () => [0, 0]);
  const lightAt = (x, y) => {
    const offset = (y * patch.widthPx + x) * 4;
    return luminance(patchBytes[offset], patchBytes[offset + 1], patchBytes[offset + 2]);
  };
  for (let y = 0; y < patch.heightPx; y += 1) {
    for (let x = 0; x < patch.widthPx; x += 1) {
      if (!outside(repair, x, y)) continue;
      const current = lightAt(x, y);
      if (x + 1 < patch.widthPx && outside(repair, x + 1, y)) {
        const difference = Math.abs(current - lightAt(x + 1, y));
        edgePairs += 1;
        verticalBoundaryStrong[x][1] += 1;
        if (difference >= 18) edges += 1;
        if (difference >= 45) {
          strongEdges += 1;
          verticalBoundaryStrong[x][0] += 1;
        }
      }
      if (y + 1 < patch.heightPx && outside(repair, x, y + 1)) {
        const difference = Math.abs(current - lightAt(x, y + 1));
        edgePairs += 1;
        horizontalBoundaryStrong[y][1] += 1;
        if (difference >= 18) edges += 1;
        if (difference >= 45) {
          strongEdges += 1;
          horizontalBoundaryStrong[y][0] += 1;
        }
      }
    }
  }
  const lineScores = [...horizontalBoundaryStrong, ...verticalBoundaryStrong]
    .filter(([, total]) => total >= 8)
    .map(([strong, total]) => strong / total);
  const luminanceAverage = mean(luminances);
  const luminanceStddev = standardDeviation(luminances, luminanceAverage);
  const gradient = gradientMetrics(
    samples,
    patch.widthPx,
    patch.heightPx,
    luminanceAverage,
    luminanceStddev ** 2,
  );
  const metrics = {
    sampleCount: samples.length,
    sampleCoverage: round(samples.length / Math.max(1, patch.widthPx * patch.heightPx)),
    meanRgb: channels.map((values) => round(mean(values), 3)),
    channelStddev: channels.map((values, index) => round(standardDeviation(values, mean(channels[index])), 3)),
    channelRobustRange: channels.map((values) => round(robustRange(values), 3)),
    luminanceStddev: round(luminanceStddev, 3),
    luminanceRobustRange: round(robustRange(luminances), 3),
    edgeDensity: round(edgePairs === 0 ? 0 : edges / edgePairs),
    strongEdgeDensity: round(edgePairs === 0 ? 0 : strongEdges / edgePairs),
    axisAlignedLineScore: round(lineScores.length === 0 ? 0 : Math.max(...lineScores)),
    colorBinCount: colorBins.size,
    saturationStddev: round(standardDeviation(saturations), 6),
    gradientSpan: round(gradient.span, 3),
    gradientExplainedVariance: round(gradient.explained),
    gradientResidualStddev: round(gradient.residualStddev, 3),
    opaqueFraction: round(samples.length === 0 ? 0 : opaque / samples.length),
  };
  return {
    classifier: 'deterministic-background-statistics',
    classifierVersion: 1,
    classification: classify(metrics),
    metrics,
  };
}

function component(id, value, weight) {
  const normalized = round(Math.max(0, Math.min(1, value)));
  return { id, value: normalized, weight, contribution: round(normalized * weight) };
}

function reason(code, message, evidence) {
  return { code, message, evidence };
}

export function scoreScannedTextEditEligibility({ classification, metrics }, geometry) {
  const backgroundValues = {
    flat: 1,
    'near-flat': 0.9,
    textured: 0.25,
    photographic: 0,
    'table-line-art': 0,
    gradient: 0.05,
    unknown: 0,
  };
  const components = [
    component('background-safety', backgroundValues[classification] ?? 0, 0.5),
    component('geometry-confidence', geometry.confidence, 0.3),
    component('context-sufficiency', Math.min(1,
      metrics.sampleCount / MIN_BACKGROUND_SAMPLES,
      metrics.sampleCoverage / MIN_BACKGROUND_COVERAGE,
      metrics.opaqueFraction,
    ), 0.1),
    component('boundary-stability', Math.max(0,
      1 - metrics.edgeDensity * 4 - metrics.strongEdgeDensity * 6 - metrics.axisAlignedLineScore * 0.25,
    ), 0.1),
  ];
  const score = round(components.reduce((sum, entry) => sum + entry.contribution, 0));
  const rejectionReasons = [];
  if (!SCANNED_TEXT_EDIT_REPAIRABLE_BACKGROUNDS.includes(classification)) {
    rejectionReasons.push(reason(
      'BACKGROUND_NOT_REPAIRABLE',
      'Only flat and near-flat scanned backgrounds are repairable in this phase.',
      `classification=${classification}`,
    ));
  }
  if (geometry.confidence < SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE) {
    rejectionReasons.push(reason(
      'GEOMETRY_CONFIDENCE_LOW',
      'Canonical OCR geometry confidence is below the repair threshold.',
      `confidence=${geometry.confidence}; required>=${SCANNED_TEXT_EDIT_MIN_GEOMETRY_CONFIDENCE}`,
    ));
  }
  if (geometry.clipped) {
    rejectionReasons.push(reason(
      'GEOMETRY_CLIPPED',
      'The approved repair rectangle or its required classifier context crosses the source-raster boundary.',
      'clipped=true',
    ));
  }
  if (geometry.roundTripMaxErrorPx > SCANNED_TEXT_EDIT_MAX_ROUND_TRIP_ERROR_PX) {
    rejectionReasons.push(reason(
      'TRANSFORM_ROUND_TRIP_EXCEEDED',
      'The canonical source transform does not round-trip within tolerance.',
      `roundTripMaxErrorPx=${geometry.roundTripMaxErrorPx}; required<=${SCANNED_TEXT_EDIT_MAX_ROUND_TRIP_ERROR_PX}`,
    ));
  }
  if (metrics.sampleCount < MIN_BACKGROUND_SAMPLES || metrics.sampleCoverage < MIN_BACKGROUND_COVERAGE) {
    rejectionReasons.push(reason(
      'INSUFFICIENT_BACKGROUND_CONTEXT',
      'The classifier does not have enough context pixels outside the text repair rectangle.',
      `samples=${metrics.sampleCount}; coverage=${metrics.sampleCoverage}; requiredSamples>=${MIN_BACKGROUND_SAMPLES}; requiredCoverage>=${MIN_BACKGROUND_COVERAGE}`,
    ));
  }
  if (metrics.opaqueFraction < SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION) {
    rejectionReasons.push(reason(
      'NON_OPAQUE_BACKGROUND',
      'Transparent or partially transparent scan context is not repairable.',
      `opaqueFraction=${metrics.opaqueFraction}; required>=${SCANNED_TEXT_EDIT_MIN_OPAQUE_FRACTION}`,
    ));
  }
  if (score < SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD) {
    rejectionReasons.push(reason(
      'ELIGIBILITY_SCORE_BELOW_THRESHOLD',
      'The explainable eligibility score is below the repair threshold.',
      `score=${score}; required>=${SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD}`,
    ));
  }
  return {
    score,
    threshold: SCANNED_TEXT_EDIT_ELIGIBILITY_THRESHOLD,
    eligible: rejectionReasons.length === 0,
    components,
    rejectionReasons,
  };
}

export const SCANNED_TEXT_BACKGROUND_MIN_SAMPLES = MIN_BACKGROUND_SAMPLES;
export const SCANNED_TEXT_BACKGROUND_MIN_COVERAGE = MIN_BACKGROUND_COVERAGE;
