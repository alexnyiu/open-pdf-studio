function runAdvance(run) {
  const shaped = Number(run?.shaped?.advance);
  if (shaped > 0) return shaped;
  const geometry = Number(run?.geometry?.width);
  return geometry > 0 ? geometry : 0;
}

export function ownedTextEditLineTargets(record) {
  const richText = record?.richText;
  if (!record?.id || !richText?.region || !Array.isArray(richText.lines)) return [];
  const region = richText.region;
  return richText.lines.map((line, index) => {
    const sizes = line.runs.map((run) => Number(run.size)).filter((size) => size > 0);
    const fontSize = sizes.length ? Math.max(...sizes) : 12;
    const measuredWidth = line.runs.reduce((sum, run) => sum + runAdvance(run), 0);
    const width = measuredWidth > 0 ? measuredWidth : Math.max(Number(region.width) || 0, fontSize);
    const remaining = Math.max(0, (Number(region.width) || width) - width);
    const x = Number(region.x) + (line.alignment === 'right' ? remaining
      : line.alignment === 'center' ? remaining / 2 : 0);
    return {
      id: `${record.id}:line:${line.id || index}`,
      recordId: String(record.id),
      lineId: String(line.id || index),
      text: line.runs.map((run) => run.text).join(''),
      x,
      baseline: Number(line.baseline),
      width: Math.max(width, fontSize * 0.5),
      height: Math.max(fontSize * 1.2, 1),
      fontSize,
    };
  });
}
