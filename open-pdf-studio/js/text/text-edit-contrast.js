const HEX_COLOR = /^#([0-9a-f]{6})$/iu;

function normalizedHex(value, fallback) {
  const match = String(value || '').match(HEX_COLOR);
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(value) {
  const color = normalizedHex(value, '#000000');
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

export function colorContrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Preserve the canonical foreground while supplying a crisp editor-only backing. */
export function editableRunPresentation(foreground, background = '#ffffff', minimumContrast = 4.5) {
  const color = normalizedHex(foreground, '#000000');
  const surface = normalizedHex(background, '#ffffff');
  const contrastRatio = colorContrastRatio(color, surface);
  if (contrastRatio >= minimumContrast) {
    return {
      color,
      background: surface,
      contrastRatio,
      contrastAid: false,
      backingColor: null,
      textShadow: 'none',
    };
  }
  const backingColor = colorContrastRatio(color, '#000000') >= colorContrastRatio(color, '#ffffff')
    ? '#000000' : '#ffffff';
  return {
    color,
    background: surface,
    contrastRatio,
    contrastAid: true,
    backingColor,
    textShadow: 'none',
  };
}

export function documentNeedsContrastAid(document, background = '#ffffff') {
  return Boolean(document?.lines?.some((line) => line.runs.some((run) => (
    editableRunPresentation(run.color, background).contrastAid
  ))));
}
