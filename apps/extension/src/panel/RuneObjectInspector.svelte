<script module lang="ts">
  import type {
    JsonValue,
    RuneObjectFieldKind,
    RuneObjectSummary,
    SourceLocation
  } from '../shared/protocol';

  export interface RuneObjectFieldInspection {
    kind: RuneObjectFieldKind;
    source: SourceLocation;
    value: JsonValue;
  }

  export interface RuneObjectInspection {
    id: string;
    name: string;
    file: string;
    source: SourceLocation;
    ownerComponentId: string | null;
    fields: Record<string, RuneObjectFieldInspection>;
    totalFields: number;
    truncated: boolean;
  }
</script>

<script lang="ts">
  interface Props {
    objects: RuneObjectSummary[];
    inspections?: Record<string, RuneObjectInspection>;
    loadingIds?: string[];
    oninspect: (object: RuneObjectSummary) => void;
    onopenSource: (source: SourceLocation) => void;
    onselect?: (object: RuneObjectSummary) => void;
  }

  const MAX_RENDERED_OBJECTS = 250;
  const MAX_RENDERED_FIELDS = 64;
  const MAX_VALUE_CHARACTERS = 4_000;

  let {
    objects,
    inspections = {},
    loadingIds = [],
    oninspect,
    onopenSource,
    onselect
  }: Props = $props();

  let selectedObjectId = $state<string | null>(null);

  const visibleObjects = $derived(objects.slice(0, MAX_RENDERED_OBJECTS));
  const omittedObjectCount = $derived(Math.max(0, objects.length - visibleObjects.length));
  const loading = $derived(new Set(loadingIds));
  const selectedObject = $derived(
    visibleObjects.find((object) => object.id === selectedObjectId) ?? visibleObjects[0] ?? null
  );
  const selectedInspection = $derived(
    selectedObject ? ownInspection(inspections, selectedObject.id) : null
  );
  const visibleFields = $derived(
    selectedObject?.fields.slice(0, MAX_RENDERED_FIELDS) ?? []
  );

  function selectObject(object: RuneObjectSummary): void {
    selectedObjectId = object.id;
    onselect?.(object);
  }

  function ownInspection(
    values: Record<string, RuneObjectInspection>,
    id: string
  ): RuneObjectInspection | null {
    const descriptor = Object.getOwnPropertyDescriptor(values, id);
    return descriptor?.value ?? null;
  }

  function inspectedField(
    inspection: RuneObjectInspection | null,
    name: string
  ): RuneObjectFieldInspection | null {
    if (!inspection) return null;
    const descriptor = Object.getOwnPropertyDescriptor(inspection.fields, name);
    return descriptor?.value ?? null;
  }

  function formatValue(value: RuneObjectFieldInspection['value']): string {
    let formatted: string;
    try {
      formatted = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      formatted = '[Value could not be displayed]';
    }
    if (formatted.length <= MAX_VALUE_CHARACTERS) return formatted;
    return `${formatted.slice(0, MAX_VALUE_CHARACTERS)}\n… ${formatted.length - MAX_VALUE_CHARACTERS} more characters`;
  }

  function shortFile(file: string): string {
    const normalized = file.replaceAll('\\', '/');
    const sourceIndex = normalized.lastIndexOf('/src/');
    if (sourceIndex >= 0) return normalized.slice(sourceIndex + 1);
    const segments = normalized.split('/').filter(Boolean);
    return segments.slice(-3).join('/') || file;
  }

  function instanceSuffix(id: string): string {
    const suffix = id.split(':').at(-1) ?? id;
    return suffix.length > 10 ? suffix.slice(-10) : suffix;
  }
</script>

<section class="rune-inspector" aria-label="Rune object inspector">
  <header class="rune-heading">
    <div>
      <h2>Rune objects</h2>
      <p>Class and module state compiled from <code>.svelte.ts</code> and <code>.svelte.js</code>.</p>
    </div>
    <span class="object-total">{objects.length}</span>
  </header>

  {#if visibleObjects.length === 0}
    <div class="empty-state">
      <strong>No rune-backed objects captured</strong>
      <span>Instances appear here when an instrumented class is constructed.</span>
    </div>
  {:else}
    <div class="rune-workspace">
      <div class="object-list" role="listbox" aria-label="Rune-backed object instances">
        {#each visibleObjects as object (object.id)}
          <button
            type="button"
            class="object-row"
            class:selected={selectedObject?.id === object.id}
            role="option"
            aria-selected={selectedObject?.id === object.id}
            onclick={() => selectObject(object)}
          >
            <span class="object-row-main">
              <strong>{object.name}</strong>
              <code>#{instanceSuffix(object.id)}</code>
            </span>
            <span class="object-row-meta">
              <span title={object.file}>{shortFile(object.file)}:{object.source.line}</span>
              <span>{object.totalFields} field{object.totalFields === 1 ? '' : 's'}</span>
            </span>
          </button>
        {/each}

        {#if omittedObjectCount > 0}
          <p class="omitted-note">
            {omittedObjectCount} more object{omittedObjectCount === 1 ? '' : 's'} omitted from this view.
          </p>
        {/if}
      </div>

      {#if selectedObject}
        <article class="object-detail" aria-label={`${selectedObject.name} rune fields`}>
          <header class="detail-heading">
            <div class="detail-identity">
              <span class="class-mark" aria-hidden="true">C</span>
              <div>
                <h3>{selectedObject.name}</h3>
                <button
                  type="button"
                  class="source-link"
                  title={selectedObject.source.file}
                  onclick={() => onopenSource(selectedObject.source)}
                >
                  {shortFile(selectedObject.source.file)}:{selectedObject.source.line}
                </button>
              </div>
            </div>
            <button
              type="button"
              class="inspect-button"
              disabled={loading.has(selectedObject.id)}
              onclick={() => oninspect(selectedObject)}
            >
              {#if loading.has(selectedObject.id)}
                Loading…
              {:else if selectedInspection}
                Refresh values
              {:else}
                Inspect values
              {/if}
            </button>
          </header>

          <div class="capture-note" class:loaded={Boolean(selectedInspection)} aria-live="polite">
            {#if selectedInspection}
              Values are a bounded point-in-time capture. Refresh to read them again.
            {:else}
              Field names are metadata only. Values stay unread until you inspect this instance.
            {/if}
          </div>

          <div class="field-table" role="table" aria-label="Rune-backed fields">
            <div class="field-header" role="row">
              <span role="columnheader">Field</span>
              <span role="columnheader">Value</span>
            </div>

            {#each visibleFields as field (field.name)}
              {@const resolved = inspectedField(selectedInspection, field.name)}
              <div class="field-row" role="row">
                <div class="field-name" role="cell">
                  <div>
                    <code>{field.name}</code>
                    <span class:derived={field.kind === 'derived'}>{field.kind}</span>
                  </div>
                  <button
                    type="button"
                    title={field.source.file}
                    onclick={() => onopenSource(field.source)}
                  >
                    line {field.source.line}
                  </button>
                </div>
                <div class="field-value" class:pending={!resolved} role="cell">
                  {#if resolved}
                    <pre>{formatValue(resolved.value)}</pre>
                  {:else}
                    <span>Not loaded</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if selectedObject.truncated || selectedObject.totalFields > visibleFields.length}
            <p class="truncation-note">
              Showing {visibleFields.length} of {selectedObject.totalFields} fields. Capture limits protect page performance.
            </p>
          {/if}
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
  .rune-inspector {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    height: 100%;
    color: var(--text, #e7e9ee);
    background: var(--bg, #101116);
    font-size: 13px;
  }

  .rune-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 58px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line, #292c35);
    background: var(--surface, #15171d);
  }

  .rune-heading h2,
  .detail-heading h3 {
    margin: 0;
    color: var(--text, #e7e9ee);
    font-size: 14px;
    line-height: 1.35;
  }

  .rune-heading p {
    margin: 3px 0 0;
    color: var(--muted, #a0a5b1);
    font-size: 12px;
    line-height: 1.4;
  }

  .rune-heading code,
  .object-row code,
  .field-name code,
  .source-link,
  .field-name button,
  .field-value pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .object-total {
    display: grid;
    flex: 0 0 auto;
    min-width: 28px;
    height: 24px;
    place-items: center;
    padding: 0 7px;
    border: 1px solid #383c47;
    border-radius: 4px;
    color: #c8ccd4;
    background: var(--surface-2, #1a1c24);
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .empty-state {
    display: grid;
    place-content: center;
    gap: 5px;
    min-height: 220px;
    padding: 24px;
    color: var(--muted, #a0a5b1);
    text-align: center;
  }

  .empty-state strong {
    color: #d9dce3;
    font-size: 14px;
  }

  .empty-state span {
    max-width: 420px;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .rune-workspace {
    display: grid;
    grid-template-columns: minmax(205px, 31%) minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }

  .object-list {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 6px 0 16px;
    border-right: 1px solid var(--line, #292c35);
    background: #121319;
    scrollbar-gutter: stable;
  }

  .object-row {
    display: grid;
    gap: 5px;
    width: 100%;
    min-height: 55px;
    padding: 8px 11px;
    border-left: 2px solid transparent;
    color: #cdd0d8;
    background: transparent;
    text-align: left;
    cursor: pointer;
    content-visibility: auto;
    contain-intrinsic-size: auto 55px;
  }

  .object-row:hover {
    background: var(--surface-2, #1a1c24);
  }

  .object-row.selected {
    border-left-color: var(--orange, #ff5b3d);
    background: #242027;
  }

  .object-row:focus-visible,
  .source-link:focus-visible,
  .inspect-button:focus-visible,
  .field-name button:focus-visible {
    outline: 2px solid var(--blue, #64a8ff);
    outline-offset: -2px;
  }

  .object-row-main,
  .object-row-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    gap: 8px;
  }

  .object-row-main strong {
    min-width: 0;
    overflow: hidden;
    color: #eceef2;
    font: 650 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .object-row-main code {
    flex: 0 0 auto;
    color: #777d89;
    font-size: 11px;
  }

  .object-row-meta {
    color: var(--muted, #a0a5b1);
    font-size: 11.5px;
  }

  .object-row-meta span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .object-row-meta span:last-child {
    flex: 0 0 auto;
  }

  .omitted-note,
  .truncation-note {
    margin: 0;
    padding: 9px 11px;
    color: #8e949f;
    font-size: 11.5px;
    line-height: 1.45;
  }

  .object-detail {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: #14161c;
    scrollbar-gutter: stable;
  }

  .detail-heading {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 62px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line, #292c35);
    background: rgba(21, 23, 29, .97);
  }

  .detail-identity {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 9px;
  }

  .detail-identity > div {
    min-width: 0;
  }

  .class-mark {
    display: grid;
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 1px solid #754235;
    border-radius: 5px;
    color: #ff9d8b;
    background: #2a1c19;
    font: 700 13px ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .detail-heading h3 {
    max-width: 100%;
    overflow: hidden;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-link,
  .field-name button {
    max-width: 100%;
    padding: 0;
    overflow: hidden;
    border: 0;
    color: #9ca2ae;
    background: transparent;
    font-size: 11.5px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .source-link:hover,
  .field-name button:hover {
    color: #c5cad3;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .inspect-button {
    flex: 0 0 auto;
    min-height: 31px;
    padding: 0 10px;
    border: 1px solid #634239;
    border-radius: 4px;
    color: #ffb3a5;
    background: #2a1e1b;
    font-size: 12px;
    cursor: pointer;
  }

  .inspect-button:hover:not(:disabled) {
    border-color: #865244;
    background: #34221e;
  }

  .inspect-button:disabled {
    color: #8b807e;
    cursor: wait;
  }

  .capture-note {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line, #292c35);
    color: #b8a177;
    background: #211b13;
    font-size: 12px;
    line-height: 1.45;
  }

  .capture-note.loaded {
    color: #88b99f;
    background: #152019;
  }

  .field-table {
    min-width: 0;
  }

  .field-header,
  .field-row {
    display: grid;
    grid-template-columns: minmax(145px, 32%) minmax(0, 1fr);
  }

  .field-header {
    position: sticky;
    top: 62px;
    z-index: 1;
    min-height: 32px;
    align-items: center;
    border-bottom: 1px solid var(--line, #292c35);
    color: #9096a2;
    background: #17191f;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: .03em;
    text-transform: uppercase;
  }

  .field-header span,
  .field-row > div {
    padding: 8px 11px;
  }

  .field-header span:first-child,
  .field-name {
    border-right: 1px solid var(--line, #292c35);
  }

  .field-row {
    min-height: 54px;
    border-bottom: 1px solid rgba(41, 44, 53, .72);
    content-visibility: auto;
    contain-intrinsic-size: auto 54px;
  }

  .field-row:hover {
    background: #191c23;
  }

  .field-name {
    display: grid;
    align-content: start;
    gap: 4px;
    min-width: 0;
  }

  .field-name > div {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 6px;
  }

  .field-name code {
    min-width: 0;
    overflow: hidden;
    color: #e0c0ba;
    font-size: 12.5px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .field-name span {
    flex: 0 0 auto;
    padding: 1px 5px;
    border-radius: 3px;
    color: #ff9f8d;
    background: rgba(255, 91, 61, .11);
    font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .field-name span.derived {
    color: #c6a8f0;
    background: rgba(181, 140, 255, .11);
  }

  .field-name button {
    justify-self: start;
  }

  .field-value {
    min-width: 0;
  }

  .field-value pre {
    max-height: 220px;
    margin: 0;
    overflow: auto;
    color: #c9cdd5;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .field-value.pending {
    display: flex;
    align-items: center;
    color: #777d89;
    font-size: 12px;
  }

  .truncation-note {
    border-bottom: 1px solid var(--line, #292c35);
    color: #c1a775;
    background: #1e1a13;
  }

  @media (max-width: 620px) {
    .rune-workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(150px, 32%) minmax(0, 1fr);
    }

    .object-list {
      border-right: 0;
      border-bottom: 1px solid var(--line, #292c35);
    }

    .field-header,
    .field-row {
      grid-template-columns: minmax(125px, 38%) minmax(0, 1fr);
    }
  }
</style>
