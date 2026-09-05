const quarterTurn = (rotation) => {
  const angle = ((Number(rotation) || 0) % 360 + 360) % 360;
  if (![0, 90, 180, 270].includes(angle)) throw new RangeError('Tile rotation must be a quarter turn');
  return angle;
};

/** Map a region in the rotated page's top-left coordinate system to native coordinates. */
export function unrotatedTileRegion(plan, pageWidthPt, pageHeightPt, rotation) {
  const { regionXpt: x, regionYpt: y, regionWpt: w, regionHpt: h } = plan;
  switch (quarterTurn(rotation)) {
    case 90: return { x: y, y: pageWidthPt - x - w, width: h, height: w };
    case 180: return { x: pageWidthPt - x - w, y: pageHeightPt - y - h, width: w, height: h };
    case 270: return { x: pageHeightPt - y - h, y: x, width: h, height: w };
    default: return { x, y, width: w, height: h };
  }
}

/** Rotate one bounded RGBA tile without allocating a whole-page raster. */
export function rotateTileRgba(pixels, width, height, rotation) {
  const angle = quarterTurn(rotation);
  if (pixels.byteLength !== width * height * 4) throw new RangeError('Invalid RGBA tile dimensions');
  if (!angle) return { pixels, width, height };
  const outputWidth = angle === 180 ? width : height;
  const outputHeight = angle === 180 ? height : width;
  const output = new Uint8ClampedArray(pixels.byteLength);
  const source = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
  const target = new Uint32Array(output.buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const destination = angle === 90 ? x * outputWidth + height - 1 - y
        : angle === 180 ? (height - 1 - y) * outputWidth + width - 1 - x
          : (width - 1 - x) * outputWidth + y;
      target[destination] = source[y * width + x];
    }
  }
  return { pixels: output, width: outputWidth, height: outputHeight };
}
