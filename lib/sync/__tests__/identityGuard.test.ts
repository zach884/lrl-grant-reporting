import { describe, it, expect } from 'vitest';
import {
  checkCompanyIdentity, normalizeCompanyName, normalizeDomain, namesLookAlike, tokenOverlap,
  editDistance,
} from '../identityGuard';

describe('normalizeDomain', () => {
  it('strips scheme, www, path and port', () => {
    expect(normalizeDomain('https://www.getveriti.com/pricing?x=1')).toBe('getveriti.com');
    expect(normalizeDomain('getveriti.com')).toBe('getveriti.com');
    expect(normalizeDomain('HTTP://GetVeriti.com:8080')).toBe('getveriti.com');
  });
  it('rejects values that are not domains', () => {
    // These appear in live data — 69 companies literally hold the string "undefined".
    expect(normalizeDomain('undefined')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('n/a')).toBeNull();
  });
});

describe('normalizeCompanyName', () => {
  it('drops legal suffixes, punctuation and case', () => {
    expect(normalizeCompanyName('Veriti, Inc.')).toBe('veriti');
    expect(normalizeCompanyName('ABODEE Llc')).toBe('abodee');
  });
  it('drops "formerly ..." parentheticals, which carry no identity', () => {
    expect(normalizeCompanyName('Burgess Institute for Entrepreneurship & Innovation (formerly Spartan Innovations)'))
      .toBe('burgess institute for entrepreneurship innovation');
  });
  it('strips possessives so they do not leave a stray token', () => {
    // The bug this guards: "Wildana's" → {wildana, s}, and the single letter dropped similarity
    // against "Touch&Taste by Wildana" below threshold, flagging an obvious match as a mismatch.
    expect(normalizeCompanyName("Wildana's Touch And Taste")).toBe('wildana touch taste');
    expect(normalizeCompanyName('Smiling Jim\u2019s Organic Seasonings')).toBe('smiling jim organic seasonings');
    expect(normalizeCompanyName("Jessie's Bookkeeping Solutions")).toBe('jessie bookkeeping solutions');
  });

  it('never returns empty for a name made only of noise words', () => {
    expect(normalizeCompanyName('The Company')).not.toBe('');
  });
});

describe('namesLookAlike', () => {
  it('matches on containment at a word boundary', () => {
    expect(namesLookAlike('acme', 'acme labs')).toBe(true);
    expect(namesLookAlike('acme labs', 'acme')).toBe(true);
  });
  it('does not match a mid-word prefix', () => {
    expect(namesLookAlike('acme', 'acmedical systems')).toBe(false);
  });
  it('is false when either side is empty', () => {
    expect(namesLookAlike('', 'acme')).toBe(false);
  });

  it('sees through reordering, which containment alone cannot', () => {
    const a = normalizeCompanyName("Wildana's Touch And Taste");
    const b = normalizeCompanyName('Touch&Taste by Wildana');
    expect(tokenOverlap(a, b)).toBeGreaterThanOrEqual(0.6);
    expect(namesLookAlike(a, b)).toBe(true);
  });

  it('KNOWN LIMITATION: a single distinctive token still matches by containment', () => {
    // "Bailey & Co" normalizes to just "bailey" — both "&" and "Co" are noise — so it contains-matches
    // "Bailey & Friends", and GHL holds both businesses. This is the cost of accepting prefix
    // extension, which is the common rename shape we DO want ("Motion Sync" → "Motion Sync
    // Technologies Inc"). Documented rather than fixed: tightening containment to require two tokens
    // would reject "Acme" → "Acme Labs" as well. The mitigation is elsewhere — a wrong match here can
    // only ever attach to a company the contact already belongs to, and genuine disagreements go to a
    // review queue instead of being decided automatically.
    const co = normalizeCompanyName('Bailey & Co');
    expect(co).toBe('bailey');
    expect(namesLookAlike(co, normalizeCompanyName('Bailey & Friends'))).toBe(true);
  });

  it('ignores spacing — the same name typed as one word or two', () => {
    // Real pairs from the TC sheet vs GHL, all previously sent to review for no good reason.
    const alike = (x: string, y: string) =>
      namesLookAlike(normalizeCompanyName(x), normalizeCompanyName(y));
    expect(alike('JonasPhotography', 'Jonas Photography LLC')).toBe(true);
    expect(alike('Chem Clean Treatment Services', 'ChemClean Treatment')).toBe(true);
    expect(alike('SwiftCutz Barbershop', 'Swift Cutz')).toBe(true);
  });

  it('tolerates a single typo in a long name', () => {
    // GHL holds "FiveOneSeven salo/spa" for the sheet's "FiveOneSeven Salon/Spa".
    expect(namesLookAlike(
      normalizeCompanyName('FiveOneSeven Salon/Spa'),
      normalizeCompanyName('FiveOneSeven salo/spa'),
    )).toBe(true);
    expect(editDistance('fiveonesevensalonspa', 'fiveonesevensalospa')).toBe(1);
  });

  it('still refuses the pairs that are genuinely different businesses', () => {
    const alike = (x: string, y: string) =>
      namesLookAlike(normalizeCompanyName(x), normalizeCompanyName(y));
    // These are the review cases the looser rules must NOT swallow.
    expect(alike("Jessie's Bookkeeping Solutions", 'Bailey & Co')).toBe(false);
    expect(alike('Free To Be', 'Enlighten Therapy and Wellbeing')).toBe(false);
    expect(alike('Sports Massage & Bodywork', 'Medical Massage and Rehabililation Therapy LLC')).toBe(false);
    expect(alike('Solution Consulting Team LLC', 'JENDAMARK USA, LLC')).toBe(false);
    expect(alike('Top Notch IHS', 'Kem Bushi')).toBe(false);
  });

  it('short squashed names are not matched by containment', () => {
    // Without the length floor, "bailey" would swallow anything starting with it.
    expect(namesLookAlike('bailey', 'baileyfriends')).toBe(false);
  });

  it('does not match two businesses that merely share a category word', () => {
    // The overlap floor does its job where containment does not apply.
    expect(namesLookAlike(
      normalizeCompanyName('Jackson Board Game Company'),
      normalizeCompanyName('Jackson Manufacturing Trade'),
    )).toBe(false);
  });
});

describe('checkCompanyIdentity', () => {
  it('passes when name and domain agree', () => {
    const r = checkCompanyIdentity({
      contactCompanyName: 'Veriti', contactWebsite: 'https://getveriti.com',
      companyName: 'Veriti, Inc.', companyWebsite: 'getveriti.com',
    });
    expect(r.verdict).toBe('match');
    expect(r.ok).toBe(true);
  });

  it('treats a shared domain with a different name as a RENAME and allows it', () => {
    // The real case: one company record legitimately renamed, contacts still on the old name.
    const r = checkCompanyIdentity({
      contactCompanyName: 'Spartan Innovations', contactWebsite: 'https://msufoundation.org',
      companyName: 'Burgess Institute for Entrepreneurship & Innovation', companyWebsite: 'msufoundation.org',
    });
    expect(r.verdict).toBe('renamed');
    expect(r.ok).toBe(true);
  });

  it('BLOCKS when the domains differ — the job-change case', () => {
    const r = checkCompanyIdentity({
      contactCompanyName: 'New Employer', contactWebsite: 'https://newemployer.com',
      companyName: 'Old Employer', companyWebsite: 'https://oldemployer.com',
    });
    expect(r.verdict).toBe('mismatch');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('different domains');
  });

  it('BLOCKS on differing names when neither side has a usable domain', () => {
    const r = checkCompanyIdentity({
      contactCompanyName: 'Grand Rapids SmartZone',
      companyName: 'Burgess Institute for Entrepreneurship & Innovation',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('different company names');
  });

  it('does not block on a differing name when the domains match', () => {
    const r = checkCompanyIdentity({
      contactCompanyName: 'GR SmartZone', contactWebsite: 'grsmartzone.org',
      companyName: 'Grand Rapids SmartZone LDFA', companyWebsite: 'https://www.grsmartzone.org/about',
    });
    expect(r.ok).toBe(true);
  });

  it('allows when the contact carries no identity to compare', () => {
    const r = checkCompanyIdentity({ companyName: 'Some Company', companyWebsite: 'x.com' });
    expect(r.verdict).toBe('no-evidence');
    expect(r.ok).toBe(true);
  });

  it('a junk website does not count as domain evidence, so it falls back to the name', () => {
    const r = checkCompanyIdentity({
      contactCompanyName: 'Acme Labs', contactWebsite: 'undefined',
      companyName: 'Acme', companyWebsite: 'undefined',
    });
    expect(r.ok).toBe(true);      // names look alike
    expect(r.contactDomain).toBeNull();
  });
});
