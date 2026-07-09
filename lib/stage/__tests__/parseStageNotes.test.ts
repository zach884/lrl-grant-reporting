import { describe, it, expect } from 'vitest';
import { parseNote, groupEvents, eventsFromNotes, isScoringNote } from '../parseStageNotes';

// Real captured note bodies (Michael / GmgPFACRKpCViRXk9gB4), lightly HTML-wrapped.
const serviceInitial = {
  id: 'n1', dateAdded: '2026-06-23T11:43:01.927Z',
  body: '<p>Stage Scoring — Service Path</p><p>Churchill Stage = 1</p><p>The company is in Stage 1 Existence...</p><p>Sub-Stage = N/A</p><p>Sub-stage not applicable for Stage 1.</p>',
};
const techRescore = {
  id: 'n2', dateAdded: '2026-07-08T11:53:39.999Z',
  body: 'Stage Scoring — Tech Path (Re-Score)\n\nTRL: 0 → 7\nAdvanced to prototype in operational environment.\n\nMRL: 0 → 1\nManufacturing implications identified.\n\nCRL: 0 → 4\nEarly customer trials.',
};
const serviceRescore = {
  id: 'n3', dateAdded: '2026-07-08T11:53:43.363Z',
  body: 'Stage Scoring — Service Path (Re-Score)\n\nChurchill Stage: 1 → 1\nRemains in Stage 1 Existence.\n\nSub-Stage: N/A → N/A\nSub-stage not applicable.',
};

describe('parseNote', () => {
  it('parses an initial Service note (= N form)', () => {
    const p = parseNote(serviceInitial.body, serviceInitial.dateAdded);
    expect(p.path).toBe('service');
    expect(p.isRescore).toBe(false);
    expect(p.churchill).toBe(1);
    expect(p.substage).toBe('N/A');
    expect(p.trl).toBeNull();
  });
  it('parses a re-score Tech note (A → B form, takes B)', () => {
    const p = parseNote(techRescore.body, techRescore.dateAdded);
    expect(p.path).toBe('tech');
    expect(p.isRescore).toBe(true);
    expect(p.trl).toBe(7);
    expect(p.mrl).toBe(1);
    expect(p.crl).toBe(4);
    expect(p.churchill).toBeNull();
  });
  it('parses a re-score Service note churchill 1 → 1', () => {
    const p = parseNote(serviceRescore.body, serviceRescore.dateAdded);
    expect(p.churchill).toBe(1);
    expect(p.substage).toBe('N/A');
  });
});

describe('isScoringNote', () => {
  it('recognizes scoring notes and rejects others', () => {
    expect(isScoringNote(serviceInitial.body)).toBe(true);
    expect(isScoringNote('<p>Called the owner, left a voicemail.</p>')).toBe(false);
  });
});

describe('eventsFromNotes (grouping + labels)', () => {
  const events = eventsFromNotes([serviceInitial, techRescore, serviceRescore]);

  it('produces 2 events: initial (alone) + rescore-cluster', () => {
    expect(events).toHaveLength(2);
  });
  it('event 1 = Initial (Service only), churchill from = form', () => {
    expect(events[0].snapshotKind).toBe('Initial');
    expect(events[0].churchill).toBe(1);
    expect(events[0].trl).toBeNull();
    expect(events[0].date).toBe(serviceInitial.dateAdded);
  });
  it('event 2 = Current, merges Service+Tech notes in the cluster', () => {
    const cur = events[1];
    expect(cur.snapshotKind).toBe('Current');
    expect(cur.churchill).toBe(1); // from service rescore note
    expect(cur.trl).toBe(7);       // from tech rescore note
    expect(cur.mrl).toBe(1);
    expect(cur.crl).toBe(4);
    expect(cur.noteIds.sort()).toEqual(['n2', 'n3']);
  });
});

describe('single-event contact', () => {
  it('labels a lone event Current', () => {
    const events = eventsFromNotes([serviceInitial]);
    expect(events).toHaveLength(1);
    expect(events[0].snapshotKind).toBe('Current');
  });
});
