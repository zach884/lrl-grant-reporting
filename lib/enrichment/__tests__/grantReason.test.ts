// The grant-reason enricher's input rules. The AI call itself is not tested here — what IS tested is
// what reaches it, because the padding the form writes is the whole hazard: 49 of 64 grant activities
// carry all ten line-item slots and the tail reads "$0 / n_a / N/A", which would invite a model to
// invent a use for nothing.

import { describe, it, expect } from 'vitest';
import { readLineItems, grantReasonEnricher, GRANT_REASON_FIELD } from '../enrichers/grantReason';

/** A field-reader over a plain object, matching RecordEnricherInput.field. */
const reader = (o: Record<string, unknown>) => (k: string) => o[k];

/** The real shape from live: 5 funded items then 5 padded slots. */
const PINK_BEACH: Record<string, unknown> = {
  activity_type: 'grant',
  expense_amount_item_1: 300, expense_description_item_1: 'Bookkeeper',
  expense_category_item_1: 'expert_business_help', expense_vendor_item_1: 'Daugherty Business',
  expense_amount_item_2: 223, expense_description_item_2: 'Tattoo Machine',
  expense_category_item_2: 'technology_equipment_operational_equipment', expense_vendor_item_2: 'Dragonhawk Tattoo',
  // item 3 has no category on ANY live record — contact.expense_category_item3 is missing an
  // underscore, so it key-matches nothing and is dropped on every submission.
  expense_amount_item_3: 528, expense_description_item_3: 'PMU Education', expense_vendor_item_3: 'Tina Davies',
  expense_amount_item_4: 100, expense_description_item_4: 'Meta Ads',
  expense_category_item_4: 'other_necessary_growth_expenses', expense_vendor_item_4: 'Meta',
  expense_amount_item_5: 2754, expense_description_item_5: 'iMac Computer',
  expense_category_item_5: 'technology_equipment_hardware', expense_vendor_item_5: 'Apple',
  ...Object.fromEntries([6, 7, 8, 9, 10].flatMap((i) => [
    [`expense_amount_item_${i}`, 0],
    [`expense_description_item_${i}`, 'N/A'],
    [`expense_category_item_${i}`, 'n_a'],
    [`expense_vendor_item_${i}`, 'N/A'],
  ])),
};

describe('readLineItems', () => {
  it('keeps the funded items and drops every padded slot', () => {
    const items = readLineItems(reader(PINK_BEACH));
    expect(items.map((i) => i.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(items.map((i) => i.description)).toEqual([
      'Bookkeeper', 'Tattoo Machine', 'PMU Education', 'Meta Ads', 'iMac Computer',
    ]);
  });

  it('keeps item 3 even though its category is missing', () => {
    // The dropped category must not cost us the item: amount + description + vendor is plenty to
    // reason from, and item 3 is empty on every live record.
    const three = readLineItems(reader(PINK_BEACH)).find((i) => i.slot === 3)!;
    expect(three.description).toBe('PMU Education');
    expect(three.amount).toBe(528);
    expect(three.category).toBeUndefined();
    expect(three.vendor).toBe('Tina Davies');
  });

  it('requires real money AND a real description', () => {
    // An amount with no description says nothing about purpose; a description with no money was
    // never funded. Either alone is not a line item.
    expect(readLineItems(reader({ expense_amount_item_1: 500 }))).toEqual([]);
    expect(readLineItems(reader({ expense_description_item_1: 'Laptop' }))).toEqual([]);
    expect(readLineItems(reader({ expense_amount_item_1: 0, expense_description_item_1: 'Laptop' }))).toEqual([]);
  });

  it('treats the placeholder spellings as padding, not as descriptions', () => {
    for (const p of ['N/A', 'n/a', 'NA', 'none', '-', '--', '0']) {
      expect(readLineItems(reader({ expense_amount_item_1: 100, expense_description_item_1: p }))).toEqual([]);
    }
  });

  it('ignores a negative or unparseable amount', () => {
    expect(readLineItems(reader({ expense_amount_item_1: -50, expense_description_item_1: 'Refund' }))).toEqual([]);
    expect(readLineItems(reader({ expense_amount_item_1: 'abc', expense_description_item_1: 'Laptop' }))).toEqual([]);
  });

  it('reads all ten slots, not just the first few', () => {
    const wide = Object.fromEntries([1, 5, 10].flatMap((i) => [
      [`expense_amount_item_${i}`, 100 * i],
      [`expense_description_item_${i}`, `Item ${i}`],
    ]));
    expect(readLineItems(reader(wide)).map((i) => i.slot)).toEqual([1, 5, 10]);
  });
});

describe('grantReasonEnricher', () => {
  it('produces only grant_reason, as a prefixed field key like every other record enricher', () => {
    expect(grantReasonEnricher.produces).toEqual([`custom_objects.activities.${GRANT_REASON_FIELD}`]);
  });

  it('skips a non-grant activity without erroring', async () => {
    // Safe to point at the whole object: an intake or metrics record has no line items and must not
    // be given a grant reason.
    for (const type of ['intake', 'metrics', 'technical_assistance', '']) {
      expect(await grantReasonEnricher.enrich({
        objectKey: 'custom_objects.activities', recordId: 'r1', catalog: {} as any,
        field: reader({ ...PINK_BEACH, activity_type: type }),
      })).toEqual([]);
    }
  });

  it('skips a grant with no line items rather than inventing a reason', async () => {
    // 10 of the 64 live grant activities carry none. An invented reason is worse than an empty field
    // on a funder report.
    expect(await grantReasonEnricher.enrich({
      objectKey: 'custom_objects.activities', recordId: 'r1', catalog: {} as any,
      field: reader({ activity_type: 'grant' }),
    })).toEqual([]);
  });

  it('skips a grant whose every slot is padding', async () => {
    const padded = Object.fromEntries([1, 2, 3].flatMap((i) => [
      [`expense_amount_item_${i}`, 0], [`expense_description_item_${i}`, 'N/A'],
    ]));
    expect(await grantReasonEnricher.enrich({
      objectKey: 'custom_objects.activities', recordId: 'r1', catalog: {} as any,
      field: reader({ activity_type: 'grant', ...padded }),
    })).toEqual([]);
  });
});

// ── the GATE ──────────────────────────────────────────────────────────────────────────────────────
// Zach, 2026-09-04: *"Can we set this up as a gated sync? I think that is a perfect way to make sure
// the configuration is good."* So WHEN it runs is config, and these pin the shipped default.

import { defaultEnricherConfig } from '../configStore';
import { evaluateGate, activeGroups } from '../gate';
import { defaultRecordEnrichers } from '../index';

const GATE = () => defaultEnricherConfig('grant-reason', 'custom_objects.activities');
/** Read a record's fields the way the runner does, by prefixed or bare key. */
const gateReader = (o: Record<string, unknown>) => (k: string) => o[k.replace('custom_objects.activities.', '')];

describe('the grant-reason gate', () => {
  it('is registered, so /enrichment lists it and its gate is editable', () => {
    const entry = defaultRecordEnrichers.find((e) => e.enricher.name === 'grant-reason');
    expect(entry).toBeDefined();
    expect(entry!.sourceObject).toBe('custom_objects.activities');
  });

  it('ships enabled, with two ANDed filters', () => {
    const g = GATE();
    expect(g.enabled).toBe(true);
    expect(g.combine).toBe('AND');
    const groups = activeGroups(g);
    expect(groups).toHaveLength(1);
    expect(groups[0].filters.map((f) => f.field)).toEqual([
      'custom_objects.activities.activity_type',
      'custom_objects.activities.grant_status',
    ]);
  });

  it('runs an executed grant, whether the record stores the KEY or the LABEL', () => {
    // GHL stores the option key (`closed_won`) while a person sees the label (`Closed Won`).
    // Measured 2026-09-04: all 64 live records store keys, and a label-vs-key compare matched NONE
    // of them — silently, because a gate that never passes just looks like no work to do.
    for (const status of ['agreement_executed', 'receipts_received', 'closed_won',
                          'Agreement Executed', 'Receipts Received', 'Closed Won']) {
      expect(evaluateGate(gateReader({ activity_type: 'grant', grant_status: status }), GATE()).run).toBe(true);
    }
  });

  it('holds a grant back until the agreement is executed', () => {
    // Before execution the line items are a PROPOSAL. A reason derived from them would describe what
    // was asked for, not what was funded — and would then be frozen by fill-empty semantics.
    for (const s of ['application_complete', 'Application Complete']) {
      const d = evaluateGate(gateReader({ activity_type: 'grant', grant_status: s }), GATE());
      expect(d.run).toBe(false);
      expect(d.reason).toMatch(/grant_status/);
    }
  });

  it('never runs on a declined application', () => {
    // Closed Lost has line items but was never funded. "Funded …" would be a false statement on a
    // funder-visible record.
    for (const s of ['closed_lost', 'Closed Lost']) {
      expect(evaluateGate(gateReader({ activity_type: 'grant', grant_status: s }), GATE()).run).toBe(false);
    }
  });

  it('never runs on a non-grant activity', () => {
    for (const t of ['intake', 'metrics', 'technical_assistance', 'introduction_referral']) {
      expect(evaluateGate(gateReader({ activity_type: t, grant_status: 'Closed Won' }), GATE()).run).toBe(false);
    }
  });

  it('holds back a grant with no status rather than assuming it is executed', () => {
    // Measured: grant_status is 62/64 populated, so 2 records have none. An absent status is not
    // evidence of execution.
    expect(evaluateGate(gateReader({ activity_type: 'grant' }), GATE()).run).toBe(false);
  });

  it('still refuses a non-grant even if someone widens the gate', () => {
    // Defence in depth: the gate is editable in the UI, so the enricher re-checks the type in code.
    // A person removing the activity_type filter must not be able to give an intake a grant reason.
    const widened = { ...GATE(), groups: [] };
    expect(evaluateGate(gateReader({ activity_type: 'intake' }), widened).run).toBe(true);
    // …and the enricher itself still declines — asserted in the enricher suite above.
  });
});
