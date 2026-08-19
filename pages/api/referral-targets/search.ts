// pages/api/referral-targets/search.ts — "who was this client referred to?", across all three kinds.
//
// Zach, 2026-08-19: referrals are logged in THIS app rather than a GHL form precisely because it is
// internal and can look the counterparty up dynamically. A referral counterparty is rarely someone
// at the client's own company — it is a mentor, a capital provider, or one of the 91 records in the
// Resources directory, which is literally the list of orgs LRL refers clients to.
//
// So one search spans:
//   • Resources — the TAP/resource directory (published only)
//   • Companies — other companies in the CRM
//   • Contacts  — individual people (mentors, providers)
//
// Free text is always allowed too: the form lets you type a name that matches nothing here, because
// not every counterparty is in the CRM and a referral is still worth logging.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ghl } from '@/lib/ghl/client';
import { listAllBusinesses } from '@/lib/ghl/businesses';
import { normalizeName } from '@/lib/dedup/normalize';

export type TargetKind = 'Resource' | 'Company' | 'Contact';

export interface ReferralTarget {
  kind: TargetKind;
  id: string;
  name: string;
  /** Category, company name, email — whatever disambiguates two similar names. */
  subtitle?: string;
}

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; resources: ReferralTarget[]; companies: ReferralTarget[] } | null = null;

async function loadCached() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const client = ghl();
  const [resData, businesses] = await Promise.all([
    client.request<any>({
      method: 'POST',
      path: '/objects/custom_objects.resources/records/search',
      autoLocation: false,
      body: { locationId: client.locationId, query: '', page: 1, pageLimit: 100, searchAfter: [] },
    }).catch(() => ({ records: [] })),
    listAllBusinesses(client).catch(() => []),
  ]);

  const resources: ReferralTarget[] = (resData.records ?? [])
    .map((r: any) => {
      const p = r.properties ?? {};
      return {
        kind: 'Resource' as const,
        id: r.id,
        name: String(p.resources ?? p.name ?? '').trim(),
        subtitle: [p.category, p.sub_category].filter(Boolean).join(' · ') || undefined,
      };
    })
    .filter((r: ReferralTarget) => r.name);

  const companies: ReferralTarget[] = businesses
    .filter((b) => b.id && b.name)
    .map((b) => ({ kind: 'Company' as const, id: b.id, name: b.name }));

  cache = { at: Date.now(), resources, companies };
  return cache;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(200).json({ targets: [] });

  try {
    const needle = normalizeName(q);
    const { resources, companies } = await loadCached();

    const match = (rows: ReferralTarget[]) =>
      rows
        .map((r) => ({ r, at: normalizeName(r.name).indexOf(needle) }))
        .filter((x) => x.at >= 0)
        .sort((a, b) => a.at - b.at || a.r.name.localeCompare(b.r.name))
        .map((x) => x.r);

    // Contacts are searched server-side by GHL (there are ~1,200; enumerating them here would be silly).
    const client = ghl();
    const contactData = await client
      .request<any>({ path: '/contacts/', params: { locationId: client.locationId, query: q, limit: '8' } })
      .catch(() => ({ contacts: [] }));
    const contacts: ReferralTarget[] = (contactData.contacts ?? []).map((c: any) => ({
      kind: 'Contact' as const,
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.id,
      subtitle: c.companyName || c.email || undefined,
    }));

    // Resources first: they are the curated directory, so a hit there is the most likely intent.
    const targets = [...match(resources).slice(0, 8), ...contacts.slice(0, 6), ...match(companies).slice(0, 6)];
    res.status(200).json({ targets });
  } catch (error: any) {
    console.error('Referral target search error:', error);
    res.status(500).json({ error: error.message ?? 'Search failed' });
  }
}
