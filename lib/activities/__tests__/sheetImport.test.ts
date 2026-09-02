// Row → activity rules for the historical spreadsheet import. Every threshold and default here was
// measured against the real sheets (docs/sprints/sheet-import.md), so these tests pin the
// measurements, not preferences.

import { describe, it, expect } from 'vitest';
import {
  planRow, dateConfidence, looksLikeIntake, isAiFailureText, judgeCompany,
  grantContractUrl, mentionsReferralOrIntro, type SheetRow,
} from '../sources/sheetImport';

const row = (over: Partial<SheetRow> = {}): SheetRow => ({
  source_slug: 'tc-cumulative',
  row: 47,
  business_name: 'Acme Widgets',
  owner_name: 'Jane Doe',
  email: 'jane@acme.test',
  date_added: '2026-01-28',
  notes: null,
  flags: { flag_one_on_one: true },
  ...over,
});

describe('dateConfidence', () => {
  it('trusts a row whose notes carry the appointment title', () => {
    // 136 of 375 TC rows look like this; the "|" separates title from commentary.
    expect(dateConfidence('Intake Meeting with Jay Mitchell | wants to expand')).toBe('exact');
  });
  it('treats a hand-written note as approximate', () => {
    expect(dateConfidence('Sent SCORE Startup Road Map')).toBe('approximate');
    expect(dateConfidence(null)).toBe('approximate');
  });
});

describe('looksLikeIntake', () => {
  it('reads the appointment title', () => {
    expect(looksLikeIntake('Intake Meeting with Robert Bulloch | ...')).toBe(true);
    expect(looksLikeIntake('intake call with the owner')).toBe(true);
  });
  it('does not fire on other assistance', () => {
    expect(looksLikeIntake(' Tyler Scott | Check-In with Lean Rocket')).toBe(false);
    expect(looksLikeIntake('Sent SCORE Startup Road Map')).toBe(false);
    expect(looksLikeIntake(null)).toBe(false);
  });
});

describe('isAiFailureText', () => {
  it('recognises the stored ChatGPT apology', () => {
    expect(isAiFailureText(
      'The provided text contains only blank line-item descriptions, with no substantive content to '
      + "determine the grant's purpose. Please supply the completed line-item descriptions.",
    )).toBe(true);
  });
  it('leaves a real reason alone', () => {
    expect(isAiFailureText('Work with attourney for provisional patent')).toBe(false);
    expect(isAiFailureText(null)).toBe(false);
  });
});

describe('planRow', () => {
  it('turns a titled 1:1 row into an INTAKE with an exact date', () => {
    const p = planRow(row({ notes: 'Intake Meeting with Jane | new bakery' }));
    expect(p.activities).toHaveLength(1);
    expect(p.activities[0].activityType).toBe('intake');
    expect(p.activities[0].dateConfidence).toBe('exact');
    expect(p.activities[0].sourceRecordId).toBe('tc-cumulative:row-47:intake');
    expect(p.activities[0].values.modality).toBeUndefined(); // modality is a TA concept
  });

  it('turns an untitled 1:1 row into TECHNICAL ASSISTANCE, 1:1, approximate', () => {
    const p = planRow(row({ notes: 'Sent SCORE Startup Road Map' }));
    expect(p.activities[0].activityType).toBe('technical_assistance');
    expect(p.activities[0].values.modality).toBe('one_on_one');
    expect(p.activities[0].dateConfidence).toBe('approximate');
    expect(String(p.activities[0].values.activity_notes)).toContain('date approximate');
  });

  it('maps a group row to TA with modality=group', () => {
    // Group delivery is workshops, which live in Wix going forward — but a historical row has no
    // event to attach to, and TC's small-group KPI counts modality, so TA/group is the honest home.
    const p = planRow(row({ flags: { flag_group: true } }));
    expect(p.activities[0].activityType).toBe('technical_assistance');
    expect(p.activities[0].values.modality).toBe('group');
    expect(p.activities[0].sourceRecordId).toContain(':group');
  });

  it('emits TWO activities for a row carrying two service flags', () => {
    const p = planRow(row({ flags: { flag_one_on_one: true, flag_group: true } }));
    expect(p.activities).toHaveLength(2);
    const ids = p.activities.map((a) => a.sourceRecordId);
    expect(new Set(ids).size).toBe(2); // distinct keys, or one would overwrite the other
  });

  it('carries the referral reason onto a referral row', () => {
    const p = planRow(row({ flags: { flag_referral: true }, referral_reason: 'Needed a CPA' }));
    expect(p.activities[0].activityType).toBe('introduction_referral');
    expect(p.activities[0].values.referral_reason).toBe('Needed a CPA');
  });

  it('emits ONE referral per named target, with the counterparty', () => {
    // The bug this pins: four referral rows for Peabody Lane Books on one day carried no notes and
    // looked like a duplicated row, until the target columns were read. They were four different
    // partners, and the first apply collapsed them into one.
    const p = planRow(row({
      flags: { flag_referral: true },
      referral_capital_provider: 'Tanesia Greer (MWF)',
      referral_sb_partner: 'Shawn Prissle, SBDC',
      referral_reason: 'Capital access',
    }));
    expect(p.activities).toHaveLength(2);
    expect(p.activities.every((a) => a.activityType === 'introduction_referral')).toBe(true);
    expect(p.activities.map((a) => a.values.counterparty_name))
      .toEqual(['Tanesia Greer (MWF)', 'Shawn Prissle, SBDC']);
    expect(p.activities[0].values.referral_type).toEqual(['Capital Provider']);
    // No "Ecosystem Partner" option exists yet, so the SB-partner target types as Other but keeps
    // its name — see funder-field-trace.md §6.6.
    expect(p.activities[1].values.referral_type).toEqual(['Other']);
    expect(new Set(p.activities.map((a) => a.sourceRecordId)).size).toBe(2);
  });

  it('still records a referral that names no target', () => {
    const p = planRow(row({ flags: { flag_referral: true } }));
    expect(p.activities).toHaveLength(1);
    expect(p.activities[0].values.counterparty_name).toBeUndefined();
  });

  it('strips the stored AI apology out of the notes', () => {
    const apology = 'The input contains only blank line item descriptions with no completed items to '
      + 'reference. Please provide the completed line item descriptions.';
    const p = planRow(row({ notes: apology }));
    expect(String(p.activities[0].values.activity_notes)).not.toContain('blank line item');
  });

  it('skips a grant-only row rather than duplicating the pipeline', () => {
    const p = planRow(row({ flags: {}, grant_amount: 4000 }));
    expect(p.activities).toHaveLength(0);
    expect(p.skip).toMatch(/grant-only/);
  });

  it('skips the rows that identify nobody', () => {
    expect(planRow(row({ business_name: 'Unsure' })).skip).toBe('unusable-business-name');
    expect(planRow(row({ business_name: 'Unknown' })).skip).toBe('unusable-business-name');
    expect(planRow(row({ date_added: null })).skip).toBe('no-date');
  });

  it('keys every activity to its sheet and row, so a re-import is a noop', () => {
    const p = planRow(row({ row: 300, source_slug: 'sbsh-companies' }));
    expect(p.activities[0].sourceRecordId).toMatch(/^sbsh-companies:row-300/);
  });
});

describe('judgeCompany', () => {
  it('accepts a match', () => {
    expect(judgeCompany('Heart Flo Yoga', 'biz1', 'Heart Flo Yoga Co').kind).toBe('match');
  });

  it('accepts the possessive/reordered case the tokenizer used to fail', () => {
    // "Wildana's" once produced a stray {s} token and this scored as a mismatch.
    expect(judgeCompany("Wildana's Touch And Taste", 'biz1', 'Touch&Taste by Wildana').kind).toBe('match');
  });

  it('accepts a row that recorded the person instead of the business', () => {
    const v = judgeCompany('Carrie Joers - Self Employed', 'biz1', 'The Artful Eye, LLC', 'Carrie Joers');
    expect(v.kind).toBe('match');
  });

  it('sends a genuine disagreement to REVIEW rather than deciding it', () => {
    // Jessica Wade's primary is now Bailey & Co; the sheet names her former business. A fuzzy score
    // cannot tell that from a rename, so a person must.
    const v = judgeCompany("Jessie's Bookkeeping Solutions", 'biz1', 'Bailey & Co');
    expect(v.kind).toBe('review');
    expect(v.reason).toContain('rename or a different business');
  });

  it('asks for creation when the contact has no company at all', () => {
    expect(judgeCompany('The Frame Studios', null, null).kind).toBe('create');
  });
});

// ── the corrections Zach called for on 9/2 ────────────────────────────────────────────────────────

const CONTRACT = 'https://services.leadconnectorhq.com/proposals/document/public/download-pdf?p=location/FgnVVv4smxyBNJKFZgJv/documents/69d7c920';

describe('grantContractUrl', () => {
  it('recognises an executed direct-grant agreement link', () => {
    expect(grantContractUrl(CONTRACT)).toBe(CONTRACT);
  });

  it('keeps only the link when the workflow appended its ChatGPT commentary', () => {
    const notes = `${CONTRACT} | The text states that descriptions of line items are used to create a direct grant agreement.`;
    expect(grantContractUrl(notes)).toBe(CONTRACT);
  });

  it('is not fooled by a meeting write-up that merely mentions a document', () => {
    expect(grantContractUrl('Sent her the grant agreement to sign | good call')).toBeNull();
    expect(grantContractUrl(null)).toBeNull();
  });
});

describe('dateConfidence, with a grant contract in the notes', () => {
  it('does NOT trust the pipe inside a contract note', () => {
    // The regression: `<contract url> | <ChatGPT commentary>` contains a pipe but names no
    // appointment, and a contract says nothing about when a meeting happened.
    const notes = `${CONTRACT} | The text states that line item descriptions are used…`;
    expect(notes).toContain('|');
    expect(dateConfidence(notes)).toBe('approximate');
  });

  it('still trusts a real appointment title', () => {
    expect(dateConfidence('Intake Meeting with Jay Mitchell | wants to expand')).toBe('exact');
  });
});

describe('mentionsReferralOrIntro', () => {
  it('fires on referrals made and introductions offered', () => {
    expect(mentionsReferralOrIntro('Referred her to Michigan Tribe, sent her our LLC blog')).toBe(true);
    expect(mentionsReferralOrIntro('Referring to SBDC Tech Team')).toBe(true);
    expect(mentionsReferralOrIntro('Will make the following referrals: SBDC Tech Team')).toBe(true);
    expect(mentionsReferralOrIntro('put him in touch with CEED Lending')).toBe(true);
  });

  it('does not fire on an accelerator cohort interview', () => {
    // "Great intro call with Aaron" is a screening, not a referral and not an intake. 37 sheet
    // records carry this phrasing — the one wording that would otherwise be mass-misclassified.
    expect(mentionsReferralOrIntro('Aaron | Sales and Marketing Accelerator Cohort Interview | Great intro call')).toBe(false);
  });

  it('does not fire on a grant contract note', () => {
    expect(mentionsReferralOrIntro(CONTRACT)).toBe(false);
  });

  it('is quiet on an ordinary write-up', () => {
    expect(mentionsReferralOrIntro('Reviewed her pricing and cash flow')).toBe(false);
    expect(mentionsReferralOrIntro(null)).toBe(false);
  });
});

describe('isAiFailureText, second shape', () => {
  it('rejects the model narrating its own prompt', () => {
    expect(isAiFailureText('The text states that descriptions of line items are used to create a direct grant agreement. It is instructed to be brief.')).toBe(true);
    expect(isAiFailureText('These instructions state that line item descriptions are used to draft a direct grant agreement for the client.')).toBe(true);
  });

  it('still accepts a genuine reason that happens to mention line items', () => {
    expect(isAiFailureText('Grant funds a new espresso machine and signage; line items cover equipment and install.')).toBe(false);
  });
});

describe('planRow, with a grant contract in the notes', () => {
  it('labels the link instead of pasting it, and drops the commentary', () => {
    const notes = `${CONTRACT} | The text states that descriptions of line items are used to create a direct grant agreement.`;
    const plan = planRow(row({ notes, grant_amount: 4000 }));
    const only = plan.activities[0];
    expect(only.activityType).toBe('technical_assistance');
    expect(only.dateConfidence).toBe('approximate');
    expect(only.values.activity_notes).toContain('Executed direct-grant agreement: ');
    expect(only.values.activity_notes).not.toContain('The text states');
    expect(only.values.activity_notes).toContain('date approximate');
  });
});
