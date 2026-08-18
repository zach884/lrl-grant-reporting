import { describe, it, expect } from 'vitest';
import { shouldWriteDerived } from '../derived';
import { buildProposals } from '../enrichers/readinessTagger';

describe('shouldWriteDerived', () => {
  it('writes a derived field when one of its drivers is being written', () => {
    expect(shouldWriteDerived(['contact.service_areas'], ['contact.service_areas'])).toBe(true);
  });

  it('skips a derived field when NO driver is being written', () => {
    // The 67-writes-in-13-days case: tags identical, only the prose differs.
    expect(shouldWriteDerived(['contact.service_areas', 'contact.trl_stops'], [])).toBe(false);
    expect(shouldWriteDerived(['contact.service_areas'], ['contact.bio'])).toBe(false);
  });

  it('treats a non-derived proposal as always writable', () => {
    expect(shouldWriteDerived(undefined, [])).toBe(true);
    expect(shouldWriteDerived([], [])).toBe(true);
  });

  it('matches prefixed and bare field keys interchangeably', () => {
    expect(shouldWriteDerived(['custom_objects.resources.service_areas'], ['service_areas'])).toBe(true);
    expect(shouldWriteDerived(['service_areas'], ['custom_objects.resources.service_areas'])).toBe(true);
  });
});

describe('readinessTagger marks the rationale as derived', () => {
  it('tags readiness_rationale with its driver fields, and nothing else', () => {
    const proposals = buildProposals(['gtm'] as any, 'High', false, 'Strong GTM background.', 'ai');
    const rationale = proposals.find((p) => p.contactKey === 'contact.readiness_rationale');
    const serviceAreas = proposals.find((p) => p.contactKey === 'contact.service_areas');

    expect(rationale?.derivedFrom).toContain('contact.service_areas');
    expect(rationale?.derivedFrom).toContain('contact.trl_stops');
    // The structured outputs are the source of truth — they must NOT be derived.
    expect(serviceAreas?.derivedFrom).toBeUndefined();
  });
});
