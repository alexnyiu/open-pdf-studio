export function classifyOcrGateAppPath(appPath) {
  const normalized = String(appPath).replaceAll('\\', '/');
  if (/\/target\/debug\//.test(normalized)) return 'debug';
  if (/\/target\/(?:[^/]+\/)?release\//.test(normalized) ||
      /\.app\/Contents\/MacOS\//.test(normalized) ||
      /\.AppImage$/i.test(normalized)) {
    return 'packaged-release';
  }
  return 'external';
}
