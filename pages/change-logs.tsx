// pages/change-logs.tsx — Change Logs: browse/search the change log (every change the app makes).
//
// Named "Change Logs" (not "Activity") to avoid confusion with GHL's Activity custom object.
// Server-rendered + URL-driven: filters live in the query string, so submitting the form re-runs
// getServerSideProps (no client fetch / loading states) and every view is a shareable link. Rows
// expand to show field diffs + rationale; CSV export honors the current filters.

import type { GetServerSideProps } from 'next';
import Shell from '@/components/shell/Shell';
import { queryChangeLog, distinctActors } from '@/lib/audit/query';
import type { ChangeLogFieldChange } from '@/lib/audit/types';

const LIMIT = 50;

interface Row {
  id: string; ts: string; app: string; objectType: string; recordId: string; recordLabel: string | null;
  actorKind: string; actorName: string; action: string; changes: ChangeLogFieldChange[] | null;
  method: string | null; confidence: number | null; rationale: string | null; trigger: string | null;
  runId: string | null; applied: boolean;
}
interface Props {
  rows: Row[]; hasMore: boolean; page: number; actors: Array<{ name: string; kind: string }>;
  f: { q: string; actorName: string; actorKind: string; applied: string; since: string; recordId: string; runId: string };
}

const SINCE_MS: Record<string, number> = { '1d': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };

export const getServerSideProps: GetServerSideProps<Props> = async ({ query }) => {
  const g = (k: string) => (typeof query[k] === 'string' ? (query[k] as string) : '');
  const f = { q: g('q'), actorName: g('actorName'), actorKind: g('actorKind'), applied: g('applied') || 'all', since: g('since') || '7d', recordId: g('recordId'), runId: g('runId') };
  const page = Math.max(parseInt(g('page') || '0', 10) || 0, 0);
  const since = SINCE_MS[f.since] ? new Date(Date.now() - SINCE_MS[f.since]).toISOString() : undefined;

  const [{ rows, hasMore }, actors] = await Promise.all([
    queryChangeLog({ q: f.q, actorName: f.actorName, actorKind: f.actorKind, applied: f.applied, recordId: f.recordId, runId: f.runId, since, limit: LIMIT, offset: page * LIMIT }),
    distinctActors(),
  ]);
  const serial: Row[] = rows.map((r) => ({
    id: r.id, ts: (r.ts as unknown as Date)?.toISOString?.() ?? String(r.ts), app: r.app, objectType: r.objectType,
    recordId: r.recordId, recordLabel: r.recordLabel, actorKind: r.actorKind, actorName: r.actorName, action: r.action,
    changes: r.changes ?? [], method: r.method, confidence: r.confidence, rationale: r.rationale, trigger: r.trigger,
    runId: r.runId, applied: r.applied,
  }));
  return { props: { rows: serial, hasMore, page, actors, f } };
};

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };
const inputBase: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--surface)', padding: '8px 11px', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' };
const eyebrow: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const ghostLink: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13, textDecoration: 'none' };

const actorTone = (kind: string) => ({ sync: { bg: 'var(--accent-tint)', fg: 'var(--teal-700)' }, enricher: { bg: 'var(--brand-tint)', fg: 'var(--yellow-700)' }, scorer: { bg: 'var(--violet-100, #ece9fd)', fg: 'var(--violet-700)' }, staff: { bg: 'var(--gray-150, #eceef1)', fg: 'var(--text)' } }[kind] ?? { bg: 'var(--gray-100)', fg: 'var(--gray-500)' });

function qs(f: Props['f'], over: Record<string, string | number>): string {
  const p = new URLSearchParams();
  const merged: Record<string, string | number> = { ...f, ...over };
  for (const [k, v] of Object.entries(merged)) { if (v !== '' && v != null && !(k === 'applied' && v === 'all')) p.set(k, String(v)); }
  return p.toString();
}

export default function ChangeLogsPage({ rows, hasMore, page, actors, f }: Props) {
  return (
    <Shell active="change-logs" breadcrumb="Change Logs" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ marginBottom: 16 }}>
          <span style={eyebrow}>Change history</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: '7px 0 6px', color: 'var(--text)' }}>Change Logs</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: '76ch' }}>
            Every change the app makes to a connected system — which record, which fields (before → after), which sync / enricher / scorer, and why. Filter, search, and export for review or audit.
          </p>
        </div>

        {/* Filters (GET form → server re-renders) */}
        <form method="GET" action="/change-logs" style={{ ...card, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px', minWidth: 200 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)' }}>Search (record, field, rationale, value)</span>
            <input name="q" defaultValue={f.q} placeholder="e.g. country, Litty Fit, churchill…" style={inputBase} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)' }}>Actor</span>
            <select name="actorName" defaultValue={f.actorName} style={{ ...inputBase, minWidth: 150 }}>
              <option value="">All actors</option>
              {actors.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.kind})</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)' }}>Type</span>
            <select name="actorKind" defaultValue={f.actorKind} style={{ ...inputBase }}>
              <option value="">All</option><option value="sync">Sync</option><option value="enricher">Enricher</option><option value="scorer">Scorer</option><option value="staff">Staff</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)' }}>Applied</span>
            <select name="applied" defaultValue={f.applied} style={inputBase}>
              <option value="all">All</option><option value="applied">Applied</option><option value="dryrun">Dry-run</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray-500)' }}>Since</span>
            <select name="since" defaultValue={f.since} style={inputBase}>
              <option value="1d">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="all">All time</option>
            </select>
          </label>
          {f.recordId && <input type="hidden" name="recordId" value={f.recordId} />}
          {f.runId && <input type="hidden" name="runId" value={f.runId} />}
          <button type="submit" style={primaryBtn}><i className="fa-solid fa-filter" /> Apply</button>
          <a href="/change-logs" style={ghostLink}>Reset</a>
          <a href={`/api/change-logs/list?${qs(f, { format: 'csv' })}`} style={ghostLink}><i className="fa-solid fa-file-csv" /> Export CSV</a>
        </form>

        {(f.recordId || f.runId) && (
          <div style={{ fontSize: 12.5, color: 'var(--gray-600)', marginBottom: 10 }}>
            Filtered to {f.recordId ? <>record <code>{f.recordId}</code></> : <>run <code>{f.runId}</code></>}. <a href="/change-logs">clear</a>
          </div>
        )}

        <div style={{ fontSize: 12.5, color: 'var(--gray-450)', marginBottom: 8 }}>
          {rows.length === 0 ? 'No change logs for these filters.' : `Showing ${page * LIMIT + 1}–${page * LIMIT + rows.length}${hasMore ? '' : ' (end)'}`}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => {
            const tone = actorTone(r.actorKind);
            return (
              <details key={r.id} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <summary style={{ padding: '11px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', listStyle: 'none' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gray-500)', minWidth: 150 }}>{new Date(r.ts).toLocaleString()}</span>
                  <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: tone.fg, background: tone.bg, borderRadius: 999, padding: '2px 8px' }}>{r.actorName}</span>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{r.action} <b>{r.objectType.replace('custom_objects.', '')}</b>{r.recordLabel ? ` · ${r.recordLabel}` : ''}</span>
                  <span style={{ fontSize: 12, color: 'var(--gray-500)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(r.changes ?? []).map((c) => c.field).join(', ')}
                  </span>
                  {!r.applied && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gray-450)', border: '1px solid var(--border-strong)', borderRadius: 999, padding: '1px 7px' }}>DRY-RUN</span>}
                </summary>
                <div style={{ padding: '4px 14px 14px', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0' }}>
                    <tbody>
                      {(r.changes ?? []).map((c, i) => (
                        <tr key={i} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                          <td style={{ padding: '5px 8px 5px 0', fontFamily: 'var(--font-mono)', color: 'var(--teal-700)', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{c.field}</td>
                          <td style={{ padding: '5px 0', color: 'var(--text)' }}>
                            {c.from !== undefined && <><span style={{ color: 'var(--gray-450)' }}>{JSON.stringify(c.from)}</span> → </>}
                            <b>{JSON.stringify(c.to)}</b>
                            {c.source && <span style={{ fontSize: 11, color: 'var(--gray-450)', marginLeft: 8 }}>{c.source}{c.confidence != null ? ` · ${Math.round(c.confidence * 100)}%` : ''}</span>}
                            {c.rationale && <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 2 }}>{c.rationale}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.rationale && <div style={{ fontSize: 12.5, color: 'var(--gray-600)', whiteSpace: 'pre-wrap', background: 'var(--gray-50, #fafafa)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>{r.rationale}</div>}
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--gray-500)' }}>
                    <span>app: <b>{r.app}</b></span>
                    <a href={`/change-logs?${qs(f, { recordId: r.recordId, runId: '', page: 0 })}`}>record: <code>{r.recordId}</code></a>
                    {r.trigger && <span>trigger: {r.trigger}</span>}
                    {r.runId && <a href={`/change-logs?${qs(f, { runId: r.runId, recordId: '', page: 0 })}`}>run: <code>{r.runId.slice(0, 8)}</code></a>}
                    {r.method && <span>method: {r.method}</span>}
                  </div>
                </div>
              </details>
            );
          })}
        </div>

        {/* Pagination */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
          {page > 0 && <a href={`/change-logs?${qs(f, { page: page - 1 })}`} style={ghostLink}><i className="fa-solid fa-chevron-left" /> Newer</a>}
          {hasMore && <a href={`/change-logs?${qs(f, { page: page + 1 })}`} style={ghostLink}>Older <i className="fa-solid fa-chevron-right" /></a>}
        </div>
      </div>
    </Shell>
  );
}
