// components/ActivityForm.tsx — the REFERRAL logger, and the back-up path for everything else.
//
// Two jobs (Zach, 2026-08-19):
//
//   1. REFERRALS ARE LOGGED HERE, on purpose. It is internal, so it can look the counterparty up
//      dynamically across the Resources directory, contacts and companies — which a GHL form cannot
//      do. This is the primary way a referral gets recorded, not a fallback.
//   2. Everything else is INGESTED from its real source (appointments, forms, Wix attendance,
//      pipeline stages), so for those this is the back-up: an offline meeting, a phone call, a
//      drop-in, a booking that never went through a GHL appointment link.
//
// The fields come from /api/activities/meta, which derives them from the LIVE catalog by folder, so
// a field added in GHL appears here with no front-end change.

import { useEffect, useMemo, useState } from 'react';
import CompanySearch, { type CompanyOption } from './CompanySearch';
import ReferralTargetPicker, { type ReferralTarget } from './ReferralTargetPicker';

interface MetaField {
  key: string;
  label: string;
  dataType: string;
  options: Array<{ key: string; label: string }>;
  required: boolean;
  prominent: boolean;
}
interface MetaType {
  key: string;
  label: string;
  core: MetaField[];
  fields: MetaField[];
  required: string[];
}
interface ContactOpt { id: string; name: string; email: string }

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--gray-500)' };
const input: React.CSSProperties = {
  width: '100%', border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)',
  padding: '9px 11px', fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font-body)',
};
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };

/** Core fields the form handles itself (or fills in for you) — never rendered as generic inputs. */
const HANDLED = new Set(['activity_date', 'activity_notes', 'activity_owner', 'activity_name']);

/** The referral picker owns this one — it writes the name, the kind and the record id together. */
const PICKER_OWNED = new Set(['counterparty_name']);

const today = () => new Date().toISOString().slice(0, 10);

export default function ActivityForm({
  actor,
  onSaved,
}: {
  actor: { name?: string; email?: string };
  onSaved: (companyId: string) => void;
}) {
  const [meta, setMeta] = useState<MetaType[]>([]);
  const [metaError, setMetaError] = useState('');
  const [type, setType] = useState('');
  const [company, setCompany] = useState<CompanyOption | null>(null);
  const [contacts, setContacts] = useState<ContactOpt[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState<ReferralTarget | null>(null);
  // Bumped after a save so the picker clears its typed query too, not just its selection.
  const [pickerKey, setPickerKey] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({ activity_date: today() });
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; detail?: string[] } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/activities/meta');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to load form fields');
        setMeta(data.types ?? []);
        setType((data.types ?? [])[0]?.key ?? '');
      } catch (e: any) {
        setMetaError(e.message);
      }
    })();
  }, []);

  // The company's people default to "everyone", which is the common case for a small startup.
  useEffect(() => {
    setPicked([]);
    setContacts([]);
    if (!company) return;
    (async () => {
      const res = await fetch(`/api/companies/${company.id}/contacts`);
      const data = await res.json();
      const list: ContactOpt[] = data.contacts ?? [];
      setContacts(list);
      setPicked(list.map((c) => c.id));
    })();
  }, [company]);

  const active = useMemo(() => meta.find((t) => t.key === type), [meta, type]);
  const isReferral = type === 'introduction_referral';
  const hidden = (f: MetaField) => isReferral && PICKER_OWNED.has(f.key);
  const prominent = (active?.fields ?? []).filter((f) => f.prominent && !hidden(f));
  const rest = (active?.fields ?? []).filter((f) => !f.prominent && !hidden(f));
  const coreExtra = (active?.core ?? []).filter((f) => !HANDLED.has(f.key));

  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  function renderField(f: MetaField) {
    const v = values[f.key];
    const common = { id: f.key, style: input };
    return (
      <div key={f.key} style={field}>
        <label htmlFor={f.key} style={label}>
          {f.label}{f.required && <span style={{ color: 'var(--red-600, #b3261e)' }}> *</span>}
        </label>
        {f.dataType === 'SINGLE_OPTIONS' || f.dataType === 'RADIO' ? (
          <select {...common} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)}>
            <option value="">—</option>
            {f.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        ) : f.dataType === 'MULTIPLE_OPTIONS' || f.dataType === 'CHECKBOX' ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {f.options.map((o) => {
              const on = Array.isArray(v) && (v as string[]).includes(o.key);
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => {
                    const cur = Array.isArray(v) ? (v as string[]) : [];
                    set(f.key, on ? cur.filter((x) => x !== o.key) : [...cur, o.key]);
                  }}
                  style={{
                    padding: '6px 11px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--teal-700, #0f766e)' : 'var(--border-strong)'}`,
                    background: on ? 'var(--accent-tint, #e6f4f1)' : 'var(--surface)',
                    color: on ? 'var(--teal-700, #0f766e)' : 'var(--text)', fontWeight: on ? 600 : 400,
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        ) : f.dataType === 'LARGE_TEXT' ? (
          <textarea {...common} rows={3} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} />
        ) : (
          <input
            {...common}
            type={f.dataType === 'DATE' ? 'date' : f.dataType === 'NUMERICAL' ? 'number' : 'text'}
            value={String(v ?? '')}
            onChange={(e) => set(f.key, e.target.value)}
          />
        )}
      </div>
    );
  }

  const missing = (active?.required ?? []).filter((k) => {
    if (isReferral && PICKER_OWNED.has(k)) return !target; // the picker supplies counterparty_name
    const v = values[k];
    return v == null || v === '' || (Array.isArray(v) && v.length === 0);
  });
  const canSave = Boolean(company && type && values.activity_date) && missing.length === 0 && !saving;

  async function save() {
    if (!company) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch('/api/activities/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          companyId: company.id,
          contactIds: picked,
          // The counterparty is linked by ASSOCIATION, per kind — a contact, a company, or a
          // resource (the server also adds the company behind a resource when it knows it).
          referredTo:
            isReferral && target?.id && target.kind !== 'External'
              ? [{ kind: target.kind, recordId: target.id }]
              : [],
          values: {
            ...values,
            ...(isReferral && target
              ? {
                  counterparty_name: target.name,
                  counterparty_kind: target.kind,
                  ...(target.id ? { counterparty_id: target.id } : {}),
                }
              : {}),
          },
          actor,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, text: data.error ?? 'Failed to log activity', detail: data.errors });
        return;
      }
      // A saved record whose company link failed is NOT a success — it is invisible to reporting.
      const broken = (data.links ?? []).filter((l: any) => l.status === 'failed');
      const skipped = (data.skipped ?? []).map((s: any) => `${s.key}: ${s.reason}`);
      setResult(
        broken.length
          ? { ok: false, text: 'Saved, but a link failed — this activity may not show up in reporting.', detail: broken.map((b: any) => `${b.key}: ${b.reason}`) }
          : { ok: true, text: `Logged “${data.activityName}”.`, detail: skipped.length ? skipped : undefined },
      );
      if (!broken.length) {
        setValues({ activity_date: today() });
        setTarget(null);
        setPickerKey((k) => k + 1);
        onSaved(company.id);
      }
    } catch (e: any) {
      setResult({ ok: false, text: e.message ?? 'Failed to log activity' });
    } finally {
      setSaving(false);
    }
  }

  if (metaError) {
    return <div style={{ padding: 16, color: 'var(--red-600, #b3261e)', fontSize: 14 }}>Couldn’t load the form: {metaError}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={field}>
        <span style={label}>Company *</span>
        <CompanySearch value={company} onChange={setCompany} />
      </div>

      <div style={field}>
        <span style={label}>Activity type *</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {meta.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setType(t.key); setShowMore(false); }}
              style={{
                padding: '7px 13px', borderRadius: 999, fontSize: 13.5, cursor: 'pointer',
                border: `1px solid ${t.key === type ? 'var(--teal-700, #0f766e)' : 'var(--border-strong)'}`,
                background: t.key === type ? 'var(--accent-tint, #e6f4f1)' : 'var(--surface)',
                color: t.key === type ? 'var(--teal-700, #0f766e)' : 'var(--text)',
                fontWeight: t.key === type ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {contacts.length > 0 && (
        <div style={field}>
          <span style={label}>Who took part</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {contacts.map((c) => {
              const on = picked.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                  style={{
                    padding: '6px 11px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--teal-700, #0f766e)' : 'var(--border-strong)'}`,
                    background: on ? 'var(--accent-tint, #e6f4f1)' : 'var(--surface)',
                    color: on ? 'var(--teal-700, #0f766e)' : 'var(--text)', fontWeight: on ? 600 : 400,
                  }}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <div style={field}>
          <label htmlFor="activity_date" style={label}>Date *</label>
          <input
            id="activity_date"
            type="date"
            style={input}
            value={String(values.activity_date ?? '')}
            onChange={(e) => set('activity_date', e.target.value)}
          />
        </div>
        {prominent.map(renderField)}
      </div>

      {isReferral && (
        <div style={field}>
          <span style={label}>
            Referred to <span style={{ color: 'var(--red-600, #b3261e)' }}>*</span>
          </span>
          <ReferralTargetPicker key={pickerKey} value={target} onChange={setTarget} />
          <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>
            Searches the Resources directory, contacts and companies — or type any name.
          </span>
        </div>
      )}

      <div style={field}>
        <label htmlFor="activity_notes" style={label}>Notes</label>
        <textarea
          id="activity_notes"
          rows={3}
          style={input}
          value={String(values.activity_notes ?? '')}
          onChange={(e) => set('activity_notes', e.target.value)}
        />
      </div>

      {(rest.length > 0 || coreExtra.length > 0) && (
        <div>
          <button
            type="button"
            onClick={() => setShowMore((s) => !s)}
            style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: 'var(--gray-500)' }}
          >
            {showMore ? '− Fewer fields' : `+ More fields (${rest.length + coreExtra.length})`}
          </button>
          {showMore && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 12 }}>
              {[...rest, ...coreExtra].map(renderField)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          style={{
            padding: '10px 20px', borderRadius: 9, border: 0, fontSize: 14, fontWeight: 600,
            cursor: canSave ? 'pointer' : 'not-allowed', background: canSave ? 'var(--brand, #f8b932)' : 'var(--gray-150, #eceef1)',
            color: canSave ? 'var(--charcoal, #23272b)' : 'var(--gray-450, #98a1ab)',
          }}
        >
          {saving ? 'Logging…' : 'Log activity'}
        </button>
        {!company && <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>Pick a company first.</span>}
        {company && missing.length > 0 && (
          <span style={{ fontSize: 13, color: 'var(--gray-500)' }}>
            Still needed: {missing.map((k) => (PICKER_OWNED.has(k) ? 'Referred to' : active?.fields.find((f) => f.key === k)?.label ?? k)).join(', ')}
          </span>
        )}
      </div>

      {result && (
        <div style={{
          padding: '10px 13px', borderRadius: 9, fontSize: 13.5,
          background: result.ok ? 'var(--accent-tint, #e6f4f1)' : 'var(--brand-tint, #fdf3dd)',
          color: 'var(--text)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontWeight: 600 }}>{result.text}</div>
          {result.detail?.length ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {result.detail.map((d) => <li key={d}>{d}</li>)}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
