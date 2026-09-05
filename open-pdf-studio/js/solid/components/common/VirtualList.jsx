import { For, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { createListGeometry, preserveListAnchor } from '../../../ui/panels/list-geometry.js';

// Variable-height rows, stable keyed DOM, and one retained keyboard-focus row.
// The parent supplies the existing scroll container and presentation.
export default function VirtualList(props) {
  const heights = new Map();
  const [heightRevision, setHeightRevision] = createSignal(0);
  const [viewport, setViewport] = createSignal({ top: 0, height: 0 });
  const [focusedKey, setFocusedKey] = createSignal(null);
  let frame = 0;
  let previousLayout;
  let resizeObserver;
  let root;
  let focusWithin = false;
  let navigation = 0;
  const layout = createMemo(() => {
    heightRevision();
    const next = createListGeometry(props.items || [], props.keyFor,
      (item, key) => heights.get(key) ?? props.estimateHeight?.(item) ?? 56);
    for (const key of heights.keys()) if (!next.indices.has(key)) heights.delete(key);
    return next;
  });
  const updateViewport = () => {
    const element = props.scrollElement();
    if (element) setViewport({ top: Math.max(0, element.scrollTop - (root?.offsetTop || 0)), height: element.clientHeight });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
  };
  const mountedKeys = createMemo(() => {
    const current = layout(), view = viewport();
    const start = Math.max(0, current.indexAt(view.top) - 6);
    const end = Math.min(current.keys.length, current.indexAt(view.top + view.height) + 7);
    const keys = view.height > 0 ? current.keys.slice(start, end) : [];
    const focus = focusedKey();
    if (focus && current.indices.has(focus) && !keys.includes(focus)) keys.push(focus);
    return keys;
  });
  const focusRow = index => {
    const current = layout();
    const target = Math.max(0, Math.min(current.keys.length - 1, index));
    if (!current.keys.length) return;
    const key = current.keys[target];
    setFocusedKey(key);
    const element = props.scrollElement();
    if (element) {
      const origin = root?.offsetTop || 0;
      const top = origin + current.offsets[target], bottom = origin + current.offsets[target + 1];
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, bottom - element.clientHeight);
      updateViewport();
    }
    const request = ++navigation;
    queueMicrotask(() => {
      if (request !== navigation) return;
      [...(root?.querySelectorAll('[data-virtual-key]') || [])]
        .find(row => row.dataset.virtualKey === key)?.focus({ preventScroll: true });
    });
  };
  createEffect(() => {
    const current = layout();
    const element = props.scrollElement();
    const previous = previousLayout;
    previousLayout = current;
    const top = element?.scrollTop || 0;
    const origin = root?.offsetTop || 0;
    const desired = origin + preserveListAnchor(previous, current, Math.max(0, top - origin));
    const request = navigation;
    const focus = untrack(focusedKey);
    const removedFocus = focus && !current.indices.has(focus);
    const oldFocusIndex = previous?.indices.get(focus) ?? 0;
    if (removedFocus) setFocusedKey(current.keys[Math.min(oldFocusIndex, current.keys.length - 1)] ?? null);
    queueMicrotask(() => {
      if (request !== navigation) return;
      if (element && previous && element.scrollTop === top) element.scrollTop = desired;
      updateViewport();
      if (removedFocus && focusWithin) focusRow(oldFocusIndex);
    });
  });
  onMount(() => {
    const element = props.scrollElement();
    updateViewport();
    element?.addEventListener('scroll', schedule, { passive: true });
    const containerObserver = new ResizeObserver(() => {
      // Width changes can wrap previously measured rows.
      const width = element?.clientWidth || 0;
      if (width !== containerObserver.lastWidth) {
        containerObserver.lastWidth = width;
        heights.clear(); setHeightRevision(value => value + 1);
      }
      schedule();
    });
    if (element) containerObserver.observe(element);
    resizeObserver = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.dataset.virtualKey;
        const height = entry.borderBoxSize?.[0]?.blockSize || entry.target.getBoundingClientRect().height;
        if (height > 0 && heights.get(key) !== height) { heights.set(key, height); changed = true; }
      }
      if (changed) setHeightRevision(value => value + 1);
    });
    root.querySelectorAll('[data-virtual-key]').forEach(row => resizeObserver.observe(row));
    onCleanup(() => {
      element?.removeEventListener('scroll', schedule);
      containerObserver.disconnect(); resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      navigation++;
    });
  });
  return <div ref={root} role="list" style={{ position: 'relative', height: `${layout().totalHeight}px`, 'overflow-anchor': 'none' }}
    onFocusIn={() => { focusWithin = true; }}
    onFocusOut={event => { if (event.relatedTarget && !root.contains(event.relatedTarget)) focusWithin = false; }}>
    <For each={mountedKeys()}>{key => {
      const index = () => layout().indices.get(key);
      const item = () => layout().items[index()];
      let row;
      onMount(() => resizeObserver?.observe(row));
      onCleanup(() => resizeObserver?.unobserve(row));
      return <div role="listitem" aria-posinset={index() + 1} aria-setsize={layout().items.length}
        style={{ position: 'absolute', top: `${layout().offsets[index()]}px`, left: '0', right: '0' }}>
        <div ref={row} data-virtual-key={key} role="button"
          tabIndex={(focusedKey() || layout().keys[0]) === key ? 0 : -1}
          aria-label={props.labelFor?.(item())}
          aria-pressed={props.selected?.(item())}
          aria-expanded={props.expanded?.(item())}
          style={{ display: 'flow-root' }}
          onFocus={() => setFocusedKey(key)}
          onClick={event => props.onActivate?.(item(), event)}
          onKeyDown={event => {
            const offset = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
            if (offset || ['Home', 'End'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation();
              focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? layout().keys.length - 1 : index() + offset);
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault(); event.stopPropagation(); props.onActivate?.(item(), event);
            }
          }}>
          {props.children(item, index)}
        </div>
      </div>;
    }}</For>
  </div>;
}
