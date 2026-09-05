// pages/client-reporting/profile.tsx — the client-facing rescore page.
//
// Funnel step 3 in Zach's flow: the client submits the Client Reporting Form (funnel page 1), lands
// on a confirmation page explaining the readiness stages (funnel page 2), and clicks through to here.
// This shows their current scores and their previous answers, takes edits, writes them to the COMPANY
// record, rescores inline, and hands them to funnel page 3 for tracking.
//
// Identity is the signed `?t=` token minted onto contact.rescore_token before the sequence sends.
// There is deliberately NO email-lookup fallback: "type any client's email to see their profile" is
// the hole the token exists to close. A bad link says so and stops.
//
// LRL brand: #171717 ground, #F8B932 gold, #05998C teal, Helvetica Neue. No em dashes in copy.

import { useCallback, useEffect, useState } from 'react';

type Field = {
  key: string; label: string; dataType: string; options?: string[];
  value: string | string[]; multi: boolean; money: boolean;
};
type Profile = {
  companyId: string; companyName: string; path: 'tech' | 'service' | 'both' | null;
  businessModel: { key: string; label: string; options: string[]; value: string };
  scores: { trl?: number; mrl?: number; crl?: number; churchill?: number; churchillSubstage?: string };
  fields: Field[];
};

const GOLD = '#F8B932';
const TEAL = '#05998C';
const INK = '#171717';
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

const DIMENSION_COPY: Record<string, { name: string; blurb: string }> = {
  trl: { name: 'TRL', blurb: 'Technology Readiness. How proven the technology itself is, from idea to proven in the field.' },
  mrl: { name: 'MRL', blurb: 'Manufacturing Readiness. How ready you are to make it repeatably and at volume.' },
  crl: { name: 'CRL', blurb: 'Commercial Readiness. How proven the demand is, from first conversations to repeat revenue.' },
  churchill: { name: 'Churchill Stage', blurb: 'The Churchill growth stage for service and operating businesses.' },
};

const shell: React.CSSProperties = {
  minHeight: '100vh', background: INK, color: '#fff', fontFamily: FONT,
  padding: '32px 20px 64px',
};
const wrap: React.CSSProperties = { maxWidth: 720, margin: '0 auto' };
const card: React.CSSProperties = {
  background: '#1f1f1f', border: '1px solid #303030', borderRadius: 14, padding: 20,
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#f2f2f2' };
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', borderRadius: 9, border: '1px solid #3a3a3a',
  background: '#141414', color: '#fff', fontSize: 15, fontFamily: FONT, boxSizing: 'border-box',
};

function ScoreTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: '1 1 120px', minWidth: 120, background: '#141414', border: `1px solid ${TEAL}44`,
      borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: TEAL, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#9a9a9a', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Scores({ scores, title }: { scores: Profile['scores']; title: string }) {
  const tiles: Array<[string, string, string | undefined]> = [];
  if (scores.trl != null) tiles.push(['TRL', String(scores.trl), 'of 9']);
  if (scores.mrl != null) tiles.push(['MRL', String(scores.mrl), 'of 10']);
  if (scores.crl != null) tiles.push(['CRL', String(scores.crl), 'of 9']);
  if (scores.churchill != null) tiles.push(['Churchill', String(scores.churchill), scores.churchillSubstage]);
  if (!tiles.length) {
    return (
      <div style={{ ...card, borderColor: '#3a3a3a' }}>
        <div style={{ fontSize: 14, color: '#c9c9c9' }}>
          You have not been scored yet. Fill in the questions below and we will score you now.
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9a9a9a',
        fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {tiles.map(([l, v, s]) => <ScoreTile key={l} label={l} value={v} sub={s} />)}
      </div>
    </div>
  );
}

/**
 * A dropdown is fine for "3" and unusable for a paragraph. `business_model`'s three options are each
 * a full sentence with examples (measured live: 200+ chars), and several scoring inputs are close
 * behind. Over this length the answers become radio cards that can wrap.
 */
const LONG_OPTION = 60;
const wantsRadios = (options: string[]) => options.some((o) => o.length > LONG_OPTION);

function Radios({ name, options, value, onChange }: {
  name: string; options: string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {options.map((opt) => {
        const on = value === opt;
        return (
          <label
            key={opt}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 13px', borderRadius: 10,
              border: `1px solid ${on ? GOLD : '#3a3a3a'}`, background: on ? '#241d0c' : '#141414',
              fontSize: 14, lineHeight: 1.5, color: '#e6e6e6', cursor: 'pointer' }}
          >
            <input type="radio" name={name} checked={on} onChange={() => onChange(opt)}
              style={{ marginTop: 3, accentColor: GOLD, flexShrink: 0 }} />
            <span>{opt}</span>
          </label>
        );
      })}
    </div>
  );
}

/** One question. Rendered from the GHL field's own dataType and option list, never a hardcoded form. */
function FieldInput({ field, value, onChange }: {
  field: Field; value: string | string[]; onChange: (v: string | string[]) => void;
}) {
  const t = field.dataType;

  if (field.multi && field.options?.length) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {field.options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <label key={opt} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 14,
              color: '#e6e6e6', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => onChange(on ? selected.filter((s) => s !== opt) : [...selected, opt])}
                style={{ marginTop: 3, accentColor: GOLD }}
              />
              <span>{opt}</span>
            </label>
          );
        })}
      </div>
    );
  }

  if (field.options?.length) {
    if (wantsRadios(field.options)) {
      return <Radios name={field.key} options={field.options} value={String(value ?? '')} onChange={onChange} />;
    }
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">Select an answer</option>
        {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }

  if (t === 'LARGE_TEXT' || t === 'TEXTAREA') {
    return (
      <textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} rows={4}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
    );
  }

  if (t === 'DATE') {
    return <input type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={inputStyle} />;
  }

  const numeric = t === 'NUMERICAL' || t === 'MONETORY' || t === 'MONETARY';
  return (
    <div style={{ position: 'relative' }}>
      {field.money && (
        <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)',
          color: '#9a9a9a', fontSize: 15 }}>$</span>
      )}
      <input
        type={numeric ? 'number' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, paddingLeft: field.money ? 26 : 13 }}
      />
    </div>
  );
}

export default function ClientProfilePage() {
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ changed: string[]; scores: Profile['scores'] } | null>(null);

  const doneUrl = process.env.NEXT_PUBLIC_RESCORE_DONE_URL || '';

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('t');
    if (!t) { setError('This link is missing its access code. Please use the link from your email.'); setState('error'); return; }
    setToken(t);
    fetch(`/api/client-profile?t=${encodeURIComponent(t)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? 'Could not load your profile.');
        const p: Profile = j.profile;
        setProfile(p);
        const seed: Record<string, string | string[]> = {};
        for (const f of p.fields) seed[f.key] = f.value;
        if (!p.path) seed.business_model = p.businessModel.value;
        setValues(seed);
        setState('ready');
      })
      .catch((e) => { setError(e.message); setState('error'); });
  }, []);

  const save = useCallback(async () => {
    if (!token) return;
    setState('saving');
    setError(null);
    try {
      const r = await fetch('/api/client-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: token, values }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Could not save your answers.');
      const s = j.rescored?.scores ?? {};
      setResult({
        changed: j.changed ?? [],
        scores: {
          trl: s.trl, mrl: s.mrl, crl: s.crl,
          churchill: s.churchillStage, churchillSubstage: s.churchillSubstage,
        },
      });
      setState('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      setError(e.message);
      setState('ready');
    }
  }, [token, values]);

  if (state === 'loading') {
    return <div style={shell}><div style={{ ...wrap, color: '#9a9a9a' }}>Loading your profile...</div></div>;
  }

  if (state === 'error') {
    return (
      <div style={shell}>
        <div style={wrap}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Lean Rocket Lab</h1>
          <div style={{ ...card, marginTop: 18, borderColor: '#5a3030' }}>
            <p style={{ margin: 0, fontSize: 15, color: '#ffb4a6' }}>{error}</p>
            <p style={{ margin: '10px 0 0', fontSize: 14, color: '#9a9a9a' }}>
              If you think this is a mistake, reply to the email we sent and we will send you a fresh link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'done' && result) {
    const moved = result.changed.length;
    return (
      <div style={shell}>
        <div style={wrap}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Lean Rocket Lab</h1>
          <div style={{ ...card, marginTop: 18, borderColor: `${GOLD}66` }}>
            <div style={{ fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD, fontWeight: 700 }}>
              {moved ? 'Rescored' : 'Nothing changed'}
            </div>
            <h2 style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700 }}>
              {moved ? 'Thanks, your profile is updated.' : 'Thanks, your profile is confirmed.'}
            </h2>
            <p style={{ margin: 0, fontSize: 15, color: '#c9c9c9' }}>
              {moved
                ? `We updated ${moved} answer${moved === 1 ? '' : 's'} and rescored ${profile?.companyName || 'your company'}.`
                : `We did not find any changes, so ${profile?.companyName || 'your company'} keeps its current scores.`}
            </p>
          </div>
          <div style={{ marginTop: 18 }}>
            <Scores scores={moved ? result.scores : (profile?.scores ?? {})} title="Your readiness scores" />
          </div>
          {doneUrl && (
            <a href={doneUrl} style={{ display: 'inline-block', marginTop: 22, padding: '13px 22px', borderRadius: 10,
              background: GOLD, color: INK, fontSize: 15, fontWeight: 700, textDecoration: 'none' }}>
              Continue
            </a>
          )}
        </div>
      </div>
    );
  }

  if (!profile) return null;
  const needsModel = !profile.path;
  const dims = profile.path === 'service' ? ['churchill']
    : profile.path === 'tech' ? ['trl', 'mrl', 'crl']
    : ['trl', 'mrl', 'crl', 'churchill'];

  return (
    <div style={shell}>
      <div style={wrap}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Lean Rocket Lab</h1>
        <p style={{ margin: '6px 0 0', fontSize: 15, color: '#9a9a9a' }}>
          {profile.companyName ? `Readiness profile for ${profile.companyName}` : 'Your readiness profile'}
        </p>

        <div style={{ marginTop: 22 }}>
          <Scores scores={profile.scores} title="Where you are today" />
        </div>

        {!needsModel && (
          <div style={{ ...card, marginTop: 14, background: '#1a1a1a' }}>
            {dims.map((d) => (
              <div key={d} style={{ marginBottom: 8 }}>
                <span style={{ color: GOLD, fontWeight: 700, fontSize: 14 }}>{DIMENSION_COPY[d].name}. </span>
                <span style={{ fontSize: 14, color: '#c9c9c9' }}>{DIMENSION_COPY[d].blurb}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 26 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>Update your answers</h2>
          <p style={{ margin: '0 0 18px', fontSize: 14, color: '#9a9a9a' }}>
            These are the answers we have on file. Change anything that has moved and we will rescore you right away.
            Leave the rest alone.
          </p>

          {needsModel && (
            <div style={{ ...card, marginBottom: 16 }}>
              <label style={labelStyle}>{profile.businessModel.label}</label>
              <p style={{ margin: '-4px 0 10px', fontSize: 13, color: '#9a9a9a' }}>
                We need this one before we can score you. It decides which readiness scale fits your business.
              </p>
              <Radios
                name="business_model"
                options={profile.businessModel.options}
                value={String(values.business_model ?? '')}
                onChange={(v) => setValues((prev) => ({ ...prev, business_model: v }))}
              />
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {profile.fields.map((f) => (
              <div key={f.key} style={card}>
                <label style={labelStyle}>{f.label}</label>
                <FieldInput
                  field={f}
                  value={values[f.key] ?? (f.multi ? [] : '')}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                />
              </div>
            ))}
          </div>

          {error && <div style={{ marginTop: 14, color: '#ffb4a6', fontSize: 14 }}>{error}</div>}

          <button
            onClick={save}
            disabled={state === 'saving' || (needsModel && !values.business_model)}
            style={{ marginTop: 22, width: '100%', padding: '15px 22px', borderRadius: 11, border: 'none',
              background: state === 'saving' ? '#6b5217' : GOLD, color: INK, fontSize: 16, fontWeight: 700,
              cursor: state === 'saving' ? 'default' : 'pointer' }}
          >
            {state === 'saving' ? 'Scoring...' : 'Save and rescore me'}
          </button>
          <p style={{ margin: '12px 0 0', fontSize: 13, color: '#7a7a7a', textAlign: 'center' }}>
            Your answers go straight to your Lean Rocket Lab company record. Nothing is shared outside the Lab.
          </p>
        </div>
      </div>
    </div>
  );
}
