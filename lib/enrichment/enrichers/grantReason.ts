// lib/enrichment/enrichers/grantReason.ts — write `grant_reason` on a grant activity by reading the
// APPROVED LINE ITEMS already copied onto that activity.
//
// WHY AN ENRICHER RATHER THAN A FIELD COPY. The application asks the applicant to describe how they
// will use the funds, and `grant-headline-fields.md` proposed copying that answer across. Measured:
// only **17 of 64** contacts hold it. Zach, 2026-09-03: *"I am fine with an enricher over a reason for
// grant because reason for grant on the application won't always be completed or right. And if the
// line items on the grant change due to an amended agreement I want the grant activity to have the
// last version of the line items instead of the first."*
//
// The line items are the better source on every count:
//   - **coverage** — 54 of 64 grant activities carry them, against 17 for the application text
//   - **truth** — they are what was APPROVED and contractually agreed, not what was requested
//   - **currency** — an amended agreement changes the line items, so a reason derived from them
//     follows the amendment. A reason copied from the application is frozen at submission.
//
// The amendment case is handled by WHEN this runs, not by anything here: the enricher reads whatever
// the activity currently holds, so re-running it after the line items change yields the new reason.
// Which stage triggers the activity's field copy is what decides which version of the line items is
// on the record — see grant-headline-fields.md.
//
// ⚠️ This does NOT read `contact.please_do_into_detail…`. Two sources for one field is how a record
// ends up with a reason nobody can trace; the line items win, and the application text stays
// available on the contact for anyone who wants the applicant's own words.

import type { Provenance, RecordEnricher, RecordEnricherInput, RecordEnrichmentProposal } from '../types';
import { hasAnthropic, classifyJson, CLASSIFIER_MODEL } from '../../ai/anthropic';

export const GRANT_REASON_FIELD = 'grant_reason';
/** 10 line-item slots, each with an amount, category, description and vendor. */
const SLOTS = Array.from({ length: 10 }, (_, i) => i + 1);

export interface LineItem {
  slot: number;
  amount: number;
  category?: string;
  description?: string;
  vendor?: string;
}

/**
 * The line items actually on this record, padding removed.
 *
 * ⚠️ The form pads every unused slot rather than leaving it empty: measured on live, 49 of 64 grant
 * activities carry all ten slots and the tail reads `$0 / [n_a] / "N/A" / vendor "N/A"`. Feeding that
 * to a model invites it to invent a use for nothing, so a slot counts only when it has a POSITIVE
 * amount and a description that is not a placeholder.
 *
 * ⚠️ `expense_category_item_3` is expected to be empty on every record, and that is not this
 * enricher's bug: the contact field is keyed `expense_category_item3` (no underscore), so it
 * key-matches nothing and is dropped on every submission — the same failure mode as the bank-loan
 * field. Item 3 therefore arrives with an amount, description and vendor but no category, which is
 * still plenty to reason from. Fixing the drop belongs in the form adapter's alias map.
 */
export function readLineItems(field: (k: string) => unknown): LineItem[] {
  const out: LineItem[] = [];
  const str = (v: unknown) => {
    const s = String(v ?? '').trim();
    return s && !/^(n\/?a|none|null|-{1,2}|0)$/i.test(s) ? s : undefined;
  };
  for (const slot of SLOTS) {
    const amount = Number(field(`expense_amount_item_${slot}`) ?? 0);
    const description = str(field(`expense_description_item_${slot}`));
    // A padded slot is $0 with a placeholder description. Require real money AND a real description:
    // an amount alone says nothing about purpose, and a description alone was never funded.
    if (!Number.isFinite(amount) || amount <= 0 || !description) continue;
    const category = str(field(`expense_category_item_${slot}`));
    out.push({
      slot, amount, description,
      ...(category ? { category } : {}),
      ...(str(field(`expense_vendor_item_${slot}`)) ? { vendor: str(field(`expense_vendor_item_${slot}`)) } : {}),
    });
  }
  return out;
}

/**
 * A stable fingerprint of the line items a reason was derived FROM.
 *
 * ⚠️ THIS IS WHAT MAKES ZACH'S AMENDMENT REQUIREMENT REAL. He asked (2026-09-03) that *"if the line
 * items on the grant change due to an amended agreement I want the grant activity to have the last
 * version of the line items instead of the first."* The line items themselves follow an amendment —
 * the form re-copies them. But the derived REASON would not: a record that already has one is
 * skipped, so the first version's reason would outlive the items it described.
 *
 * Recording this fingerprint in the change log lets the runner tell the two cases apart:
 *   same fingerprint → the reason still describes the current items → skip, cost nothing
 *   different        → the agreement was amended → recompute
 *
 * Amount is included, so a re-negotiated figure on the same descriptions still counts as a change.
 * Order is normalised, so re-slotting the same items is NOT a change.
 */
export function lineItemFingerprint(items: LineItem[]): string {
  const parts = items
    .map((i) => `${i.amount}|${(i.description ?? '').toLowerCase()}|${(i.category ?? '').toLowerCase()}`)
    .sort();
  // A short non-cryptographic digest — this only has to detect change, not resist anything.
  let h = 0;
  for (const ch of parts.join('~')) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `items:${items.length}:${(h >>> 0).toString(36)}`;
}

interface ReasonResult { reason: string; theme: string; confidence: 'High' | 'Medium' | 'Low' }

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description:
        'One or two sentences, past/neutral tense, naming what the grant funded. Grounded ONLY in the line items given. No dollar figures, no vendor names, no praise, no speculation about outcomes.',
    },
    theme: {
      type: 'string',
      description: 'Two to five words categorising the spend, e.g. "equipment and inventory" or "marketing and software".',
    },
    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
  },
  required: ['reason', 'theme', 'confidence'],
};

export const GRANT_REASON_SYSTEM_PROMPT =
  `You write the "reason for grant" on a Lean Rocket Lab direct-grant record, for a FUNDER to read ` +
  `in a compliance report. You are given the approved expense line items from the executed grant ` +
  `agreement — the amount, category, description and vendor for each.\n\n` +
  `Write one or two plain sentences saying what the grant funded, generalising across the line items ` +
  `rather than listing them.\n\n` +
  `RULES\n` +
  `  - Ground every claim in the line items. If they do not say it, do not write it.\n` +
  `  - No dollar amounts and no vendor names. The amounts are already fields on the record, and a ` +
  `funder does not want "spent $2,754 at Apple" in a narrative.\n` +
  `  - No outcomes or benefits. "Funded a point-of-sale system and grooming equipment" — NOT ` +
  `"which will help the business grow".\n` +
  `  - No praise, no marketing language, no mention of the applicant's worthiness.\n` +
  `  - Neutral, factual register. Start with a verb like "Funded" or "Supported".\n` +
  `  - If the items are thin or vague, say what little is supportable and set confidence Low. Never ` +
  `pad with invention.\n\n` +
  `CONFIDENCE\n` +
  `  High   - several items with clear descriptions and categories that agree on a purpose\n` +
  `  Medium - clear items but a mixed or unclear purpose\n` +
  `  Low    - one or two vague items, or descriptions that name a thing without a use\n\n` +
  `Return JSON only.`;

function renderItems(items: LineItem[]): string {
  return items
    .map((i) => `  - ${i.description}${i.category ? ` [category: ${i.category}]` : ''}${i.vendor ? ` (vendor: ${i.vendor})` : ''} — $${i.amount.toLocaleString('en-US')}`)
    .join('\n');
}

export const grantReasonEnricher: RecordEnricher = {
  name: 'grant-reason',
  description: 'Derive the reason for grant from a grant activity\u2019s approved expense line items (Claude). Gate is configurable (default: activity_type = grant AND grant_status \u2208 Agreement Executed / Receipts Received / Closed Won).',
  produces: [`custom_objects.activities.${GRANT_REASON_FIELD}`],

  async enrich(input: RecordEnricherInput): Promise<RecordEnrichmentProposal[]> {
    // Only grant activities have line items to read. Every other type returns [] rather than
    // erroring, so the enricher is safe to point at the whole object.
    if (String(input.field('activity_type') ?? '') !== 'grant') return [];
    if (!hasAnthropic) return [];

    const items = readLineItems(input.field);
    // 10 of the 64 grant activities carry no line items at all. Nothing to reason from, and a reason
    // invented from an empty list is worse than an empty field on a funder report.
    if (!items.length) return [];

    const total = items.reduce((s, i) => s + i.amount, 0);
    const result = await classifyJson<ReasonResult>({
      system: GRANT_REASON_SYSTEM_PROMPT,
      schema: SCHEMA,
      maxTokens: 400,
      user:
        `Approved line items (${items.length} item${items.length === 1 ? '' : 's'}, $${total.toLocaleString('en-US')} total):\n` +
        `${renderItems(items)}\n\nWrite the reason for grant.`,
    });
    if (!result?.reason?.trim()) return [];

    const provenance: Provenance = {
      method: 'ai',
      source: `${CLASSIFIER_MODEL} over ${items.length} approved line item(s) on the grant activity`,
      confidence: result.confidence === 'High' ? 0.9 : result.confidence === 'Medium' ? 0.6 : 0.3,
      timestamp: new Date().toISOString(),
      // The fingerprint is part of the rationale on purpose: the change log is queryable, so this is
      // how a later run knows whether the agreement has been amended since. See lineItemFingerprint.
      rationale: `${result.theme}; derived from the executed agreement's line items, not the application text${result.confidence === 'Low' ? ' — LOW confidence, verify' : ''} [${lineItemFingerprint(items)}]`,
    };
    return [{ fieldKey: GRANT_REASON_FIELD, value: result.reason.trim(), provenance }];
  },
};
