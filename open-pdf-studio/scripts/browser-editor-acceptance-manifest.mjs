import { REQUIRED_BROWSER_ACCEPTANCE_SUITES } from './ocr-release-hardening-policy.mjs';

export const BROWSER_EDITOR_ACCEPTANCE_CONTRACT =
  'open-pdf-studio.browser-editor-acceptance';
export const BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION = 2;

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateBrowserEditorAcceptanceManifest(manifest, { expectedHead } = {}) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['browser acceptance manifest must be an object'];
  }
  if (manifest.contract !== BROWSER_EDITOR_ACCEPTANCE_CONTRACT) {
    issues.push('browser acceptance manifest contract is invalid');
  }
  if (manifest.schemaVersion !== BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION) {
    issues.push(`browser acceptance schemaVersion must be ${BROWSER_EDITOR_ACCEPTANCE_SCHEMA_VERSION}`);
  }
  if (!manifest.head || (expectedHead && manifest.head !== expectedHead)) {
    issues.push('browser acceptance HEAD does not match the aggregate');
  }
  if (manifest.status !== 'PASS') issues.push('browser acceptance status is not PASS');
  if (!validTimestamp(manifest.startedAt) || !validTimestamp(manifest.completedAt)
      || Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
    issues.push('browser acceptance timestamps are missing or invalid');
  }
  if (!Array.isArray(manifest.suites)) {
    issues.push('browser acceptance suites must be an array');
    return issues;
  }
  const entries = new Map();
  for (const suite of manifest.suites) {
    if (!suite?.name || entries.has(suite.name)) {
      issues.push(`browser acceptance suite entry is missing or duplicate: ${suite?.name || 'unknown'}`);
      continue;
    }
    entries.set(suite.name, suite);
  }
  if (manifest.suites.length !== REQUIRED_BROWSER_ACCEPTANCE_SUITES.length) {
    issues.push('browser acceptance suite set is not exact');
  }
  for (const name of REQUIRED_BROWSER_ACCEPTANCE_SUITES) {
    const suite = entries.get(name);
    if (!suite) {
      issues.push(`required browser acceptance suite is missing: ${name}`);
      continue;
    }
    if (suite.command !== `npm run ${name}`) issues.push(`${name} command is invalid`);
    if (!Number.isInteger(suite.code) || suite.code !== 0 || suite.signal != null
        || suite.status !== 'PASS') {
      issues.push(`${name} did not pass in browser acceptance`);
    }
    if (!validTimestamp(suite.startedAt) || !validTimestamp(suite.completedAt)
        || Date.parse(suite.completedAt) < Date.parse(suite.startedAt)) {
      issues.push(`${name} timestamps are missing or invalid`);
    }
  }
  for (const name of entries.keys()) {
    if (!REQUIRED_BROWSER_ACCEPTANCE_SUITES.includes(name)) {
      issues.push(`unexpected browser acceptance suite: ${name}`);
    }
  }
  return issues;
}
