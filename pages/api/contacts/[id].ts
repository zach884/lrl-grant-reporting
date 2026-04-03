// pages/api/contacts/[id].ts — Fetch single GHL contact by ID
import type { NextApiRequest, NextApiResponse } from 'next';
import { ghlRequest } from '@/lib/ghl';
import type { ContactOption } from '@/types';

function titleCase(str: string): string {
  if (!str) return '';
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const contactId = req.query.id as string;
  if (!contactId) {
    return res.status(400).json({ error: 'Contact ID required' });
  }

  try {
    const c = await ghlRequest<any>({
      path: `/contacts/${contactId}`,
    });

    const contact = c.contact ?? c;
    const companyName = titleCase(contact.companyName ?? '');
    const fullName = [titleCase(contact.firstName ?? ''), titleCase(contact.lastName ?? '')].filter(Boolean).join(' ');

    // Extract custom fields into a map keyed by field key
    const customFieldMap: Record<string, string> = {};
    if (Array.isArray(contact.customFields)) {
      for (const cf of contact.customFields) {
        customFieldMap[cf.id] = cf.value ?? '';
      }
    }

    const result: ContactOption = {
      id: contact.id,
      display: companyName || fullName || contact.email || 'Unknown',
      company_name: companyName,
      full_name: fullName,
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      address1: contact.address1 ?? '',
      city: titleCase(contact.city ?? ''),
      state: (contact.state ?? '').toUpperCase(),
      postal_code: contact.postalCode ?? '',
      minority_owned: customFieldMap['my_company_is_a_minority_owned_business_radio'] ?? '',
    };

    res.status(200).json({ contact: result, customFields: customFieldMap });
  } catch (error: any) {
    console.error('Contact fetch error:', error);
    res.status(500).json({ error: error.message ?? 'Contact fetch failed' });
  }
}
