// components/mapping/MappingTable.tsx — spreadsheet-style editor for one sync's field map.
//
// Presentational: holds no fetch state. Parent passes rows + catalogs + onChange. Each row
// pairs a Source (contact) field with a Destination (company) field, a sync direction, an
// enabled toggle, a note, and shows any server-computed validation issues.

import { useMemo } from 'react';
import type { MappingIssue, SyncDirection } from '@/lib/mapping/types';

export interface CatalogFieldOpt {
  fieldKey: string;
  name: string;
  dataType: string;
  folder?: string | null;
}
export interface MapperCatalogs {
  contact: { scalars: string[]; fields: CatalogFieldOpt[] };
  business: { scalars: string[]; folders: { id: string; name: string }[]; fields: CatalogFieldOpt[] };
}
export interface EditableRow {
  contactKey: string;
  businessKey: string;
  direction: SyncDirection;
  mirrorDown: boolean;
  enabled?: boolean;
  note?: string;
  holdValues?: string[];
  transform?: 'countryCode';
  issues?: MappingIssue[];
}

const inputCls =
  'w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-[#f8b932] focus:outline-none focus:ring-1 focus:ring-[#f8b932]';

/** Build <option>s for a side, grouping custom fields and guaranteeing the current value
 *  is selectable even if it's not in the live catalog (so bad rows are visible, not hidden). */
function FieldOptions({
  scalars,
  fields,
  groupByFolder,
  current,
}: {
  scalars: string[];
  fields: CatalogFieldOpt[];
  groupByFolder: boolean;
  current: string;
}) {
  const known = new Set<string>([...scalars, ...fields.map((f) => f.fieldKey)]);
  const groups = useMemo(() => {
    if (!groupByFolder) return null;
    const byFolder = new Map<string, CatalogFieldOpt[]>();
    for (const f of fields) {
      const k = f.folder || 'Other';
      if (!byFolder.has(k)) byFolder.set(k, []);
      byFolder.get(k)!.push(f);
    }
    return Array.from(byFolder.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [fields, groupByFolder]);

  return (
    <>
      <option value="">— choose field —</option>
      {current && !known.has(current) && (
        <option value={current}>{current} (not in catalog)</option>
      )}
      <optgroup label="Standard fields">
        {scalars.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </optgroup>
      {groups
        ? groups.map(([folder, fs]) => (
            <optgroup key={folder} label={folder}>
              {fs.map((f) => (
                <option key={f.fieldKey} value={f.fieldKey}>{f.name} — {f.fieldKey}</option>
              ))}
            </optgroup>
          ))
        : (
            <optgroup label="Custom fields">
              {fields.map((f) => (
                <option key={f.fieldKey} value={f.fieldKey}>{f.name} — {f.fieldKey}</option>
              ))}
            </optgroup>
          )}
    </>
  );
}

export default function MappingTable({
  rows,
  catalogs,
  disabled,
  onChange,
}: {
  rows: EditableRow[];
  catalogs: MapperCatalogs;
  disabled?: boolean;
  onChange: (rows: EditableRow[]) => void;
}) {
  function update(i: number, patch: Partial<EditableRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...rows, { contactKey: '', businessKey: '', direction: 'both', mirrorDown: false }]);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="py-2 pr-3 font-medium">Source — Contact</th>
            <th className="py-2 pr-3 font-medium">Destination — Company</th>
            <th className="py-2 pr-3 font-medium">Direction</th>
            <th className="py-2 pr-3 font-medium">On</th>
            <th className="py-2 pr-3 font-medium">Note</th>
            <th className="py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const hasError = r.issues?.some((x) => x.level === 'error');
            const hasWarn = r.issues?.some((x) => x.level === 'warning');
            return (
              <tr key={i} className="border-b border-gray-100 align-top">
                <td className="py-2 pr-3">
                  <select
                    className={inputCls}
                    disabled={disabled}
                    value={r.contactKey}
                    onChange={(e) => update(i, { contactKey: e.target.value })}
                  >
                    <FieldOptions scalars={catalogs.contact.scalars} fields={catalogs.contact.fields} groupByFolder={false} current={r.contactKey} />
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <select
                    className={inputCls}
                    disabled={disabled}
                    value={r.businessKey}
                    onChange={(e) => update(i, { businessKey: e.target.value })}
                  >
                    <FieldOptions scalars={catalogs.business.scalars} fields={catalogs.business.fields} groupByFolder current={r.businessKey} />
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <select
                    className={inputCls}
                    disabled={disabled}
                    value={r.direction}
                    onChange={(e) => update(i, { direction: e.target.value as SyncDirection })}
                  >
                    <option value="up">up → company</option>
                    <option value="down">down → contacts</option>
                    <option value="both">both</option>
                  </select>
                </td>
                <td className="py-2 pr-3 text-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-[#f8b932] focus:ring-[#f8b932]"
                    disabled={disabled}
                    checked={r.enabled !== false}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                    title={r.enabled === false ? 'Disabled — kept but not synced' : 'Enabled'}
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="text"
                    className={inputCls}
                    disabled={disabled}
                    value={r.note ?? ''}
                    placeholder="optional"
                    onChange={(e) => update(i, { note: e.target.value })}
                  />
                  {(hasError || hasWarn) && (
                    <ul className="mt-1 space-y-0.5">
                      {r.issues!.map((x, j) => (
                        <li key={j} className={x.level === 'error' ? 'text-xs text-red-600' : 'text-xs text-amber-600'}>
                          {x.level === 'error' ? '⛔ ' : '⚠️ '}{x.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-40"
                    disabled={disabled}
                    onClick={() => remove(i)}
                    title="Remove row"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-sm text-gray-400">
                No mappings yet. Add a row or use “Auto-suggest”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <button
        type="button"
        className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        disabled={disabled}
        onClick={add}
      >
        + Add row
      </button>
    </div>
  );
}
