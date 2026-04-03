// pages/api/contacts/search.ts — GHL contact search endpoint
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest, GHL_LOCATION_ID } from '@/lib/ghl';
import type { ContactOption } from '@/types';

/** Capitalize first letter of each word */
function titleCase(str: string): string {
  if (!str) return '';
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = (req.query.q as string || '').trim();
  if (q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const data = await ghlRequest<any>({
      path: '/contacts/',
      params: {
        locationId: GHL_LOCATION_ID,
        query: q,
        limit: '10',
      },
    });

    const contacts: ContactOption[] = (data.contacts ?? []).map((c: any) => {
      const companyName = titleCase(c.companyName ?? '');
      const fullName = [titleCase(c.firstName ?? ''), titleCase(c.lastName ?? '')].filter(Boolean).join(' ');
      return {
        id: c.id,
        display: companyName || fullName || c.email || 'Unknown',
        company_name: companyName,
        full_name: fullName,
        email: c.email ?? '',
        phone: c.phone ?? '',
        address1: c.address1 ?? '',
        city: titleCase(c.city ?? ''),
        state: (c.state ?? '').toUpperCase(),
        postal_code: c.postalCode ?? '',
        minority_owned: '',
      };
    });

    res.status(200).json({ contacts });
  } catch (error: any) {
    console.error('Contact search error:', error);
    res.status(500).json({ error: error.message ?? 'Contact search failed' });
  }
}
