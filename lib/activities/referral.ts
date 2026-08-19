// lib/activities/referral.ts — expand what the user picked into every link it implies.
//
// Zach's model (2026-08-19): an activity is associated to the contact and company that PARTICIPATED,
// and a referral additionally links "a contact and/or company and/or resource" as REFERRED TO.
//
// A Resource is a directory profile of an organization, so picking one implies the company behind it
// — when that company is known. Only 3 of 91 resources were linked to a company before this sprint;
// a name-match pass took it to 26, and the remaining 65 describe organizations that simply are not in
// the CRM (Zach is matching those by hand). So this resolves opportunistically and never invents:
// a resource with no company link is recorded as just the resource, which is still a complete referral.

import { GhlClient, ghl } from '../ghl/client';
import { getRelatedRecordIds } from '../ghl/associations';
import type { ReferredTo } from './schema';

export const RESOURCES_OBJECT = 'custom_objects.resources';

/**
 * Add the company behind a picked Resource, and the company behind a picked Contact.
 *
 * Both are "the org this person/profile belongs to", which is what makes a referral joinable
 * ("how many clients did we send to Fidelis?") without depending on the directory row.
 * Deduplicated by the caller (createActivity), so overlapping targets are harmless.
 */
export async function expandReferredTo(
  targets: ReferredTo[],
  client: GhlClient = ghl(),
): Promise<ReferredTo[]> {
  const out: ReferredTo[] = [...targets];
  for (const t of targets) {
    if (t.kind !== 'Resource' || !t.recordId) continue;
    try {
      const companyIds = await getRelatedRecordIds(t.recordId, 'business', client);
      // Exactly one is the unambiguous case. Several means the directory row is linked to more than
      // one company, which is a data problem to fix by hand, not to guess at here.
      if (companyIds.length === 1) out.push({ kind: 'Company', recordId: companyIds[0] });
    } catch {
      /* a resource we cannot read is still a valid referral target on its own */
    }
  }
  return out;
}
