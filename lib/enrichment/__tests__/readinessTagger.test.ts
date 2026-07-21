import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI client so no network call happens; classifyJson is controllable per test.
vi.mock('../../ai/anthropic', () => ({
  hasAnthropic: true,
  classifyJson: vi.fn(),
  CLASSIFIER_MODEL: 'claude-haiku-4-5',
}));

import { classifyJson } from '../../ai/anthropic';
import {
  readinessTagger,
  rederiveProposals,
  passesMembershipGate,
  deriveProfileText,
  buildProposals,
} from '../enrichers/readinessTagger';
import type { ContactEnricherInput } from '../types';
import type { Contact, CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

const mockClassify = classifyJson as unknown as ReturnType<typeof vi.fn>;

/** Build a tiny catalog + contact where custom fields are keyed by fieldKey. */
function makeInput(fields: Record<string, unknown>): ContactEnricherInput {
  const defs: CustomFieldDef[] = Object.keys(fields).map((key, i) => ({
    id: `id_${i}`,
    name: key,
    fieldKey: key,
    dataType: 'TEXT',
  }));
  const byKey: Record<string, CustomFieldDef> = {};
  const byId: Record<string, CustomFieldDef> = {};
  for (const d of defs) { byKey[d.fieldKey] = d; byId[d.id] = d; }
  const catalog: CustomFieldCatalog = { fields: defs, folders: [], byKey, byId };
  const contact: Contact = {
    id: 'contact_1',
    firstName: 'Sam',
    lastName: 'Coach',
    customFields: defs.map((d) => ({ id: d.id, value: fields[d.fieldKey] })),
  };
  return {
    contact,
    contactCatalog: catalog,
    field: (key) => {
      const d = byKey[key] ?? byId[key];
      return d ? fields[d.fieldKey] : undefined;
    },
  };
}

beforeEach(() => mockClassify.mockReset());

describe('passesMembershipGate', () => {
  it('passes for Team or EIR (array or string), fails for Board-only / empty', () => {
    expect(passesMembershipGate(['Team'])).toBe(true);
    expect(passesMembershipGate(['EIR', 'Board'])).toBe(true);
    expect(passesMembershipGate('Team, Board')).toBe(true);
    expect(passesMembershipGate(['Board'])).toBe(false);
    expect(passesMembershipGate([])).toBe(false);
    expect(passesMembershipGate(undefined)).toBe(false);
  });
});

describe('readinessTagger.enrich', () => {
  it('skips Board-only contacts (membership gate) — no AI call', async () => {
    const out = await readinessTagger.enrich(makeInput({
      'contact.website_team_tags': ['Board'],
      'contact.job_title': 'Advisor',
    }));
    expect(out).toEqual([]);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('classifies a Team/EIR contact and derives the 7 fields', async () => {
    mockClassify.mockResolvedValue({
      serviceTags: ['gtm', 'market', 'nonsense'], // 'nonsense' should be dropped
      confidence: 'High',
      verify: false,
      rationale: 'GTM + market research background',
    });
    const out = await readinessTagger.enrich(makeInput({
      'contact.website_team_tags': ['EIR'],
      'contact.job_title': 'Fractional GTM exec',
      'contact.biowho_you_are': 'Go-to-market for deep tech.',
    }));

    const byKey = Object.fromEntries(out.map((p) => [p.contactKey, p.value]));
    expect(byKey['contact.service_areas']).toEqual(['Go-to-Market Strategy', 'Market Research']);
    expect(byKey['contact.crl_stops']).toEqual(['1', '2', '3', '7', '9']); // gtm (2,3,7,9) ∪ market (1,2)
    expect(byKey['contact.mrl_stops']).toEqual([]);
    expect(byKey['contact.readiness_confidence']).toBe('High');
    expect(byKey['contact.readiness_rationale']).toContain('GTM + market research');
    expect(out[0].provenance.source).toBe('anthropic');
    expect(out[0].provenance.confidence).toBe(0.9);
  });

  it('flags verify rows in the rationale', async () => {
    mockClassify.mockResolvedValue({ serviceTags: ['sales'], confidence: 'Low', verify: true, rationale: 'inferred from role' });
    const out = await readinessTagger.enrich(makeInput({
      'contact.website_team_tags': ['Team'],
      'contact.job_title': 'EIR',
    }));
    const rationale = out.find((p) => p.contactKey === 'contact.readiness_rationale')?.value as string;
    expect(rationale.startsWith('VERIFY')).toBe(true);
  });

  it('no coachable specialty → records confidence + rationale only (no placement fields)', async () => {
    mockClassify.mockResolvedValue({ serviceTags: [], confidence: 'Low', verify: true, rationale: 'admin role, no specialty' });
    const out = await readinessTagger.enrich(makeInput({ 'contact.website_team_tags': ['Team'], 'contact.job_title': 'Member Services' }));
    const keys = out.map((p) => p.contactKey).sort();
    expect(keys).toEqual(['contact.readiness_confidence', 'contact.readiness_rationale']);
    expect(out.find((p) => p.contactKey === 'contact.service_areas')).toBeUndefined();
    expect(out.find((p) => p.contactKey === 'contact.readiness_rationale')!.value).toContain('VERIFY');
  });

  it('drops invalid-only tags to the no-specialty path', async () => {
    mockClassify.mockResolvedValue({ serviceTags: ['nonsense'], confidence: 'Low', verify: true, rationale: 'x' });
    const out = await readinessTagger.enrich(makeInput({ 'contact.website_team_tags': ['Team'], 'contact.job_title': 'X' }));
    expect(out.map((p) => p.contactKey).sort()).toEqual(['contact.readiness_confidence', 'contact.readiness_rationale']);
  });
});

describe('rederiveProposals (no LLM)', () => {
  it('re-derives the 4 stop fields from existing service_areas labels', () => {
    const out = rederiveProposals(makeInput({
      'contact.website_team_tags': ['Team'],
      'contact.service_areas': ['Go-to-Market Strategy', 'Contract Manufacturing'],
    }));
    const byKey = Object.fromEntries(out.map((p) => [p.contactKey, p.value]));
    expect(byKey['contact.mrl_stops']).toEqual(['5', '6']); // cm
    expect(byKey['contact.crl_stops']).toEqual(['2', '3', '7', '9']); // gtm
    expect(out.every((p) => p.provenance.method === 'computed')).toBe(true);
    // does NOT touch service_areas / confidence / rationale
    expect(byKey['contact.service_areas']).toBeUndefined();
  });

  it('returns [] when the gate fails or no service_areas', () => {
    expect(rederiveProposals(makeInput({ 'contact.website_team_tags': ['Board'], 'contact.service_areas': ['Go-to-Market Strategy'] }))).toEqual([]);
    expect(rederiveProposals(makeInput({ 'contact.website_team_tags': ['Team'] }))).toEqual([]);
  });
});

describe('deriveProfileText', () => {
  it('assembles a labeled blob from name + profile fields, skipping empties', () => {
    const input = makeInput({
      'contact.website_team_tags': ['Team'],
      'contact.job_title': 'Patent attorney',
      'contact.biowho_you_are': '',
      'contact.linkedin': 'https://linkedin.com/in/x',
    });
    const text = deriveProfileText(input.contact, input.contactCatalog);
    expect(text).toContain('Name: Sam Coach');
    expect(text).toContain('Job title: Patent attorney');
    expect(text).toContain('LinkedIn: https://linkedin.com/in/x');
    expect(text).not.toContain('Bio:');
  });
});

describe('buildProposals', () => {
  it('produces 7 proposals with computed provenance for the given method', () => {
    const out = buildProposals(['ip', 'legal'], 'Medium', false, 'IP + contracts', 'ai');
    expect(out).toHaveLength(7);
    expect(out.every((p) => p.provenance.confidence === 0.6)).toBe(true);
  });
  it('returns [] for no tags', () => {
    expect(buildProposals([], 'Low', false, 'x', 'ai')).toEqual([]);
  });
});
