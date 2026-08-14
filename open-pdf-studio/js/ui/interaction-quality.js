/*
 * Phase 8 shared interaction adapter.
 *
 * Older shell controls still own their behavior in plain JS or legacy Solid
 * components. This adapter gives title-based controls the same shortcut
 * tooltip and keyboard metadata as UiButton without moving their callbacks.
 */

const SHORTCUT_RE = /^(.*)\s+\(([^()]+)\)$/;

function hasShortcutToken(shortcut) {
  return /(?:Ctrl|Cmd|Control|Meta|Alt|Option|Shift|⌘|⌥|⇧|⌃)/i.test(shortcut);
}

function macShortcut(shortcut) {
  if (!/Mac|iPhone|iPad/i.test(navigator.platform || '')) return shortcut;
  return shortcut
    .replace(/\bCtrl\b/gi, '⌘')
    .replace(/\bCmd\b/gi, '⌘')
    .replace(/\bControl\b/gi, '⌘')
    .replace(/\bShift\b/gi, '⇧')
    .replace(/\bAlt\b|\bOption\b/gi, '⌥')
    .replace(/\+/g, '');
}

function ariaShortcut(shortcut) {
  const normalized = shortcut
    .replace(/\bCtrl\b/gi, 'Control')
    .replace(/\bCmd\b/gi, 'Meta')
    .replace(/\bOption\b/gi, 'Alt');
  if (!/Control\+|Meta\+|Alt\+|Shift\+/i.test(normalized)) return undefined;
  if (/^Control\+/i.test(normalized)) {
    return `${normalized} ${normalized.replace(/^Control/i, 'Meta')}`;
  }
  return normalized;
}

function decorateAccessibleName(element) {
  if (!(element instanceof HTMLElement)) return;
  if (!element.matches('button, [role="button"], input, select, textarea')) return;
  if (element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby')) return;
  if (element.textContent?.replace(/\s+/g, ' ').trim()) return;

  const title = element.getAttribute('title')?.trim();
  if (!title) return;
  const match = title.match(SHORTCUT_RE);
  const label = (match ? match[1] : title).trim();
  if (!label) return;
  element.setAttribute('aria-label', label);
  element.setAttribute('data-phase9-a11y', 'named-from-title');
}

function decorateTitle(element) {
  if (!(element instanceof HTMLElement)) return;
  decorateAccessibleName(element);

  const title = element.getAttribute('title')?.trim();
  if (!title) return;
  if (element.hasAttribute('data-ui-tooltip')) return;
  const match = title.match(SHORTCUT_RE);
  if (!match || !hasShortcutToken(match[2])) return;

  const label = match[1].trim();
  if (!label) return;

  element.setAttribute('data-ui-tooltip', label);
  element.setAttribute('data-ui-shortcut', macShortcut(match[2].trim()));
  if (!element.hasAttribute('aria-keyshortcuts')) {
    const shortcut = ariaShortcut(match[2].trim());
    if (shortcut) element.setAttribute('aria-keyshortcuts', shortcut);
  }
}

function decorateTree(root) {
  if (!root?.querySelectorAll) return;
  if (root.matches?.('[title]')) decorateTitle(root);
  root.querySelectorAll('[title]').forEach(decorateTitle);
}

export function installInteractionQuality(root = document.getElementById('app-root')) {
  if (!root || root.__phase8InteractionQuality) return () => {};

  decorateTree(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(node => decorateTree(node));
      } else if (record.type === 'attributes') {
        decorateTitle(record.target);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label'],
  });

  root.__phase8InteractionQuality = { observer };
  return () => {
    observer.disconnect();
    delete root.__phase8InteractionQuality;
  };
}
