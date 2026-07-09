// lib/stage/parseStageNotes.ts — parse LRL "Stage Scoring" contact notes into a dated
// re-score timeline (pure, unit-tested). The scoring workflow writes, per run, up to two
// notes:
//   - "Stage Scoring — Service Path[ (Re-Score)]"  -> Churchill Stage + Sub-Stage
//   - "Stage Scoring — Tech Path[ (Re-Score)]"     -> TRL, MRL, CRL
// Values appear as "X = N" (first score) or "X: A → B" (re-score; take B).
// Notes from the same run cluster within seconds; we group them into events.

export type ScorePath = 'service' | 'tech' | 'unknown';

export interface ParsedNote {
  date: string;            // ISO (note dateAdded)
  path: ScorePath;
  isRescore: boolean;
  churchill?: number | null;
  substage?: string | null;
  trl?: number | null;
  mrl?: number | null;
  crl?: number | null;
  rationale: string;       // cleaned note text
}

export type SnapshotKind = 'Initial' | 'Rescore' | 'Current';

export interface StageEvent {
  date: string;
  churchill: number | null;
  substage: string | null;
  trl: number | null;
  mrl: number | null;
  crl: number | null;
  rationale: string;
  snapshotKind: SnapshotKind;
  noteIds: string[];
}

/** Strip HTML tags + decode the handful of entities GHL note bodies use. */
export function stripHtml(html: string): string {
  return (html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function isScoringNote(body: string): boolean {
  const t = body || '';
  return /stage scoring/i.test(t) || /churchill stage/i.test(t) || /\bTRL\b/.test(t);
}

/** The value that a metric line resolves to: for "A → B" take B; for "= N" take N. */
function finalValue(line: string): string | null {
  if (line == null) return null;
  let v = line.trim();
  const arrow = v.split(/→|-\>|—>/);           // handle unicode + ascii arrows
  if (arrow.length > 1) v = arrow[arrow.length - 1];
  return v.trim() || null;
}

/** Capture the value expression that follows `label :` or `label =`. */
function captureMetric(text: string, label: string): string | null {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*([^\\n\\r]+)', 'i');
  const m = text.match(re);
  return m ? finalValue(m[1]) : null;
}

function toInt(v: string | null): number | null {
  if (v == null) return null;
  const m = String(v).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

export function parseNote(body: string, dateAdded: string, _id?: string): ParsedNote {
  const text = stripHtml(body);
  const path: ScorePath = /tech path/i.test(text)
    ? 'tech'
    : /service path/i.test(text)
      ? 'service'
      : /\bTRL\b|\bMRL\b|\bCRL\b/.test(text)
        ? 'tech'
        : /churchill/i.test(text)
          ? 'service'
          : 'unknown';
  const isRescore = /re-?score/i.test(text);
  const substageRaw = captureMetric(text, 'Sub-Stage') ?? captureMetric(text, 'Substage') ?? captureMetric(text, 'Sub Stage');
  return {
    date: dateAdded,
    path,
    isRescore,
    churchill: toInt(captureMetric(text, 'Churchill Stage')),
    substage: substageRaw && !/^n\/?a$/i.test(substageRaw) ? substageRaw : (substageRaw ? 'N/A' : null),
    trl: toInt(captureMetric(text, 'TRL')),
    mrl: toInt(captureMetric(text, 'MRL')),
    crl: toInt(captureMetric(text, 'CRL')),
    rationale: text,
  };
}

const CLUSTER_MS = 15 * 60 * 1000; // notes within 15 min = one scoring run

function firstNonNull<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null) return v as T;
  return null;
}

/**
 * Group parsed notes (any order) into dated scoring events, merging the Service + Tech
 * notes of one run, and label each Initial / Rescore / Current.
 */
export function groupEvents(notes: ParsedNote[]): StageEvent[] {
  const sorted = [...notes].sort((a, b) => a.date.localeCompare(b.date));
  const clusters: ParsedNote[][] = [];
  for (const n of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(new Date(n.date).getTime() - new Date(last[0].date).getTime()) <= CLUSTER_MS) {
      last.push(n);
    } else {
      clusters.push([n]);
    }
  }

  const events: StageEvent[] = clusters.map((cluster) => {
    const svc = cluster.find((n) => n.path === 'service');
    const tech = cluster.find((n) => n.path === 'tech');
    const any = cluster;
    return {
      date: cluster[0].date,
      churchill: firstNonNull(svc?.churchill, ...any.map((n) => n.churchill)),
      substage: firstNonNull(svc?.substage, ...any.map((n) => n.substage)),
      trl: firstNonNull(tech?.trl, ...any.map((n) => n.trl)),
      mrl: firstNonNull(tech?.mrl, ...any.map((n) => n.mrl)),
      crl: firstNonNull(tech?.crl, ...any.map((n) => n.crl)),
      rationale: cluster.map((n) => n.rationale).join('\n\n---\n\n'),
      snapshotKind: 'Rescore' as SnapshotKind,
      noteIds: [],
    };
  });

  // Label: earliest = Initial, latest = Current, middle = Rescore. Single event = Current.
  events.forEach((e, i) => {
    if (events.length === 1) e.snapshotKind = 'Current';
    else if (i === 0) e.snapshotKind = 'Initial';
    else if (i === events.length - 1) e.snapshotKind = 'Current';
    else e.snapshotKind = 'Rescore';
  });
  return events;
}

/** Convenience: raw notes ({body,dateAdded,id}) -> scoring events. */
export function eventsFromNotes(
  notes: Array<{ id?: string; body?: string; dateAdded?: string }>,
): StageEvent[] {
  const parsed: ParsedNote[] = [];
  const idsByDate: Record<string, string[]> = {};
  for (const n of notes) {
    if (!n.body || !n.dateAdded || !isScoringNote(n.body)) continue;
    parsed.push(parseNote(n.body, n.dateAdded, n.id));
    (idsByDate[n.dateAdded] ??= []).push(n.id ?? '');
  }
  const events = groupEvents(parsed);
  // attach note ids that fall in each event's cluster window
  for (const e of events) {
    for (const [d, ids] of Object.entries(idsByDate)) {
      if (Math.abs(new Date(d).getTime() - new Date(e.date).getTime()) <= CLUSTER_MS) e.noteIds.push(...ids.filter(Boolean));
    }
  }
  return events;
}
