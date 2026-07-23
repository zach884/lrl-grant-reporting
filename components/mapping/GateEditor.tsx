// components/mapping/GateEditor.tsx — ONE shared gate editor reused by sync gates and enricher gates.
//
// A gate is always "a source field + what to do per value". Two render modes over that one shape:
//   • mode='action' — a value→action table (upsert / update / hide / skip). Used by the /wix-sync
//     "Gate & visibility" panel for a Wix set's status state machine.
//   • mode='list'   — a value multi-select (which values count). Used by /enrichment for an enricher's
//     status gate (runOn) and membership gate (anyOf).
//
// Candidate values come from the SELECTED field's live-catalog option labels (never hardcoded), unioned
// with any values already configured, plus a manual "add value" box for free-text/status fields whose
// option list the catalog doesn't return.

import { useMemo, useState } from 'react';
import SearchableFieldSelect, { type CatalogFieldOpt } from './SearchableFieldSelect';
import type { GateAction } from '@/lib/mapping/wixTypes';

export interface GateFieldOpt extends CatalogFieldOpt {
  options?: { key?: string; label: string }[] | null;
}

interface CommonProps {
  /** Contact/source field catalog for the field picker. */
  fields: GateFieldOpt[];
  scalars?: string[];
  /** Selected gate field key ('' = none). */
  field: string;
  onField: (key: string) => void;
  fieldLabel?: string;
  fieldPlaceholder?: string;
  disabled?: boolean;
}

type ActionProps = CommonProps & {
  mode: 'action';
  actions: Record<string, GateAction>;
  onActions: (next: Record<string, GateAction>) => void;
};

type ListProps = CommonProps & {
  mode: 'list';
  values: string[];
  onValues: (next: string[]) => void;
  /** Verb for the checkbox helper text, e.g. "run on" or "count as a member". */
  includeVerb?: string;
};

export type GateEditorProps = ActionProps | ListProps;

const ACTION_LABELS: { value: GateAction; label: string }[] = [
  { value: 'upsert', label: 'Create or update' },
  { value: 'update', label: 'Update only' },
  { value: 'hide', label: 'Hide' },
  { value: 'skip', label: 'Skip' },
];

const inputBase: React.CSSProperties = {
  border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)',
  padding: '8px 11px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)',
};
const label11: React.CSSProperties = {
  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, letterSpacing: '.09em',
  textTransform: 'uppercase', color: 'var(--gray-450)',
};

function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) { if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

export default function GateEditor(props: GateEditorProps) {
  const { fields, scalars = [], field, onField, fieldLabel = 'Gate field', fieldPlaceholder = '— choose field —', disabled } = props;
  const [newValue, setNewValue] = useState('');

  const selected = useMemo(() => fields.find((f) => f.fieldKey === field), [fields, field]);
  const optionLabels = useMemo(
    () => uniq((selected?.options ?? []).map((o) => (o?.label ?? '').trim()).filter(Boolean)),
    [selected],
  );

  const configured = props.mode === 'action' ? Object.keys(props.actions) : props.values;
  const candidates = useMemo(() => uniq([...optionLabels, ...configured]), [optionLabels, configured]);

  function addValue() {
    const v = newValue.trim();
    if (!v) return;
    if (props.mode === 'action') {
      if (!(v in props.actions)) props.onActions({ ...props.actions, [v]: 'skip' });
    } else if (!props.values.includes(v)) {
      props.onValues([...props.values, v]);
    }
    setNewValue('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={label11}>{fieldLabel}</span>
        <div style={{ maxWidth: 380 }}>
          <SearchableFieldSelect scalars={scalars} fields={fields} value={field} onChange={onField} disabled={disabled} placeholder={fieldPlaceholder} />
        </div>
      </div>

      {field ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={label11}>
            {props.mode === 'action' ? 'Value → action' : `Values that ${(props as ListProps).includeVerb ?? 'apply'}`}
          </span>

          {candidates.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--gray-450)' }}>
              No option values on this field — add the values you want to gate on below.
            </div>
          )}

          {props.mode === 'action'
            ? candidates.map((v) => (
                <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: '1 1 auto', fontSize: 13, color: 'var(--text)', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                  <span style={{ color: 'var(--gray-400)', fontSize: 12 }}>→</span>
                  <select
                    value={props.actions[v] ?? 'skip'} disabled={disabled}
                    onChange={(e) => props.onActions({ ...props.actions, [v]: e.target.value as GateAction })}
                    style={{ ...inputBase, width: 160, cursor: 'pointer' }}
                  >
                    {ACTION_LABELS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </div>
              ))
            : candidates.map((v) => {
                const on = (props as ListProps).values.includes(v);
                return (
                  <label key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text)', cursor: disabled ? 'default' : 'pointer' }}>
                    <input
                      type="checkbox" checked={on} disabled={disabled}
                      onChange={(e) => {
                        const cur = (props as ListProps).values;
                        (props as ListProps).onValues(e.target.checked ? uniq([...cur, v]) : cur.filter((x) => x !== v));
                      }}
                    />
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </label>
                );
              })}

          {/* manual add — for status/tag fields whose option list the catalog doesn't return */}
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <input
              value={newValue} disabled={disabled} placeholder="Add a value…"
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addValue(); } }}
              style={{ ...inputBase, flex: '0 1 220px' }}
            />
            <button type="button" disabled={disabled || !newValue.trim()} onClick={addValue}
              style={{ ...inputBase, cursor: 'pointer', fontWeight: 600, color: 'var(--text-secondary)', opacity: newValue.trim() ? 1 : 0.5 }}>
              <i className="fa-solid fa-plus" style={{ marginRight: 6, fontSize: 11 }} />Add
            </button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--gray-450)' }}>Pick a field to configure the gate.</div>
      )}
    </div>
  );
}
