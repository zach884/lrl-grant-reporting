// pages/api/companies/[id]/contacts.ts — the company's people, to default the activity's attendees.
//
// Uses the association graph (contact links), which is the same roster the down-sync fans out over.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getAssociatedContactIds } from '@/lib/ghl/associations';
import { getContact } from '@/lib/ghl/contacts';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'company id required' });

  try {
    const ids = await getAssociatedContactIds(id);
    const contacts = (await Promise.all(ids.map((cid) => getContact(cid).catch(() => null))))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.id,
        email: c.email ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.status(200).json({ contacts });
  } catch (error: any) {
    console.error('Company contacts error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to load company contacts' });
  }
}
