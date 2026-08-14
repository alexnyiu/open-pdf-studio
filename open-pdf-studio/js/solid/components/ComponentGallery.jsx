import { createEffect, createSignal } from 'solid-js';
import UiButton from './ui/UiButton.jsx';
import UiIconButton from './ui/UiIconButton.jsx';
import UiPanelHeader from './ui/UiPanelHeader.jsx';
import UiToolbarGroup from './ui/UiToolbarGroup.jsx';
import UiButtonStack from './ui/UiButtonStack.jsx';
import UiTab from './ui/UiTab.jsx';
import UiField from './ui/UiField.jsx';
import UiSegmentedControl from './ui/UiSegmentedControl.jsx';

const plusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>';
const collapseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 4v16M10 9l-2 3 2 3"/></svg>';

export default function ComponentGallery() {
  const [theme, setTheme] = createSignal('light');
  const [selectedTab, setSelectedTab] = createSignal('Overview');
  const [segmented, setSegmented] = createSignal('Compact');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('Interactive states are local to this gallery.');

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  const runBusyState = () => {
    setBusy(true);
    setMessage('Busy state preserves the button geometry.');
    window.setTimeout(() => {
      setBusy(false);
      setMessage('Busy state finished.');
    }, 850);
  };

  return (
    <main class="component-gallery">
      <header class="gallery-header">
        <div>
          <div class="gallery-kicker">Open PDF Studio · Phase 4</div>
          <h1>Reusable component gallery</h1>
          <p>Presentation primitives for the macOS-refined workspace. Document behavior stays with the existing owners.</p>
        </div>
        <div class="gallery-header-actions">
          <UiSegmentedControl
            label="Theme"
            value={theme()}
            items={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            onChange={setTheme}
          />
          <UiButton variant="secondary" label="Back to app" onClick={() => { window.location.href = './'; }} />
        </div>
      </header>

      <div class="gallery-content">
        <section class="gallery-section gallery-section-wide">
          <div class="gallery-section-heading"><div><h2>Buttons</h2><p>Four semantic variants, shared focus treatment, and explicit busy/disabled states.</p></div><span class="gallery-token">--ui-control-height</span></div>
          <div class="gallery-card button-gallery-card">
            <div class="gallery-row">
              <UiButton variant="primary" label="Primary action" onClick={() => setMessage('Primary action delegated to the gallery demo.')} />
              <UiButton variant="secondary" label="Secondary action" />
              <UiButton variant="quiet" label="Quiet action" />
              <UiButton variant="destructive" label="Destructive action" />
            </div>
            <div class="gallery-row">
              <UiButton variant="primary" size="compact" label="Compact" />
              <UiButton variant="secondary" size="comfortable" label="Comfortable" />
              <UiButton variant="primary" icon={plusIcon} label="With icon" />
              <UiButton variant="primary" busy={busy()} label={busy() ? 'Saving' : 'Try busy'} onClick={runBusyState} />
              <UiButton variant="secondary" disabled label="Disabled" />
            </div>
            <div class="gallery-message" role="status">{message()}</div>
          </div>
        </section>

        <div class="gallery-grid">
          <section class="gallery-section">
            <div class="gallery-section-heading"><div><h2>Icon buttons</h2><p>Every icon-only control has an accessible name.</p></div></div>
            <div class="gallery-card icon-gallery-card">
              <UiIconButton variant="quiet" icon={plusIcon} title="Add item" />
              <UiIconButton variant="secondary" icon={closeIcon} title="Close panel" />
              <UiIconButton variant="primary" icon={plusIcon} title="Create document" />
              <UiIconButton variant="destructive" icon={closeIcon} title="Delete item" />
            </div>
          </section>

          <section class="gallery-section">
            <div class="gallery-section-heading"><div><h2>Segmented control</h2><p>Selected state is not color-only.</p></div></div>
            <div class="gallery-card">
              <UiSegmentedControl label="Density" value={segmented()} items={[{ value: 'Compact', label: 'Compact' }, { value: 'Comfortable', label: 'Comfortable' }]} onChange={setSegmented} />
              <div class="gallery-message">Selected: {segmented()}</div>
            </div>
          </section>
        </div>

        <section class="gallery-section">
          <div class="gallery-section-heading"><div><h2>Panel header and toolbar group</h2><p>These are the first primitives used by the production ribbon and properties header.</p></div></div>
          <div class="gallery-card shell-gallery-card">
            <UiPanelHeader id="gallery-panel-header" title="Properties" collapseLabel="Collapse properties panel" collapseIcon={collapseIcon} onCollapse={() => setMessage('Panel collapse callback is isolated to the gallery.')} />
            <div class="gallery-toolbar-preview">
              <UiToolbarGroup label="Document">
                <UiButtonStack>
                  <UiButton variant="quiet" size="compact" icon={plusIcon} label="New" />
                  <UiButton variant="quiet" size="compact" icon={closeIcon} label="Close" />
                </UiButtonStack>
              </UiToolbarGroup>
              <UiToolbarGroup label="Selection">
                <UiButton variant="primary" icon={plusIcon} label="Select" />
              </UiToolbarGroup>
              <span class="ui-separator" role="separator" aria-orientation="vertical"></span>
              <UiTab label="Overview" active={selectedTab() === 'Overview'} onClick={() => setSelectedTab('Overview')} />
              <UiTab label="Details" active={selectedTab() === 'Details'} onClick={() => setSelectedTab('Details')} />
            </div>
          </div>
        </section>

        <section class="gallery-section">
          <div class="gallery-section-heading"><div><h2>Fields and state coverage</h2><p>Inputs carry their own labels, helper text, warning, error, disabled, and read-only states.</p></div></div>
          <div class="gallery-card field-gallery-card">
            <UiField label="Document name" value="TraceMonkey.pdf" helper="Read-only document identity" readOnly />
            <UiField label="Page number" type="number" value="1" min="1" step="1" />
            <UiField label="Scale" value="Unknown scale" state="warning" helper="Add a scale to enable measurements." />
            <UiField label="Required value" value="Needs attention" state="error" helper="This field needs a valid value." />
            <UiField label="Unavailable" value="Locked item" disabled />
          </div>
        </section>
      </div>
    </main>
  );
}
