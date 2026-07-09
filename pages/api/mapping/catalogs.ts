// pages/api/mapping/catalogs.ts — field catalogs for the mapper dropdowns.
//
// Wraps getCatalogs() (10-min cached) into a UI-friendly shape: contact + business custom
// fields (with option lists + folder grouping) plus the standard scalar fields that are
// valid mapping targets but aren't in the custom-field catalogs.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import type { CustomFieldCatalog } from '@/lib/ghl/types';

// Kept in sync with lib/mapping/resolve.ts scalar sets (standard fields, not custom).
const CONTACT_SCALARS = ['companyName', 'firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode', 'country', 'website'];
const BUSINESS_SCALARS = ['name', 'email', 'phone', 'website', 'address', 'city', 'state', 'postalCode', 'country'];

function shapeFields(cat: CustomFieldCatalog) {
  const folderName = new Map(cat.folders.map((f) => [f.id, f.name]));
  return cat.fields
    .filter((f) => f.fieldKey)
    .map((f) => ({
      fieldKey: f.fieldKey,
      name: f.name,
      dataType: f.dataType,
      folder: f.parentId ? folderName.get(f.parentId) ?? null : null,
      options: f.options ?? null,
    }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const force = req.query.refresh === 'true';
    const { contact, business } = await getCatalogs({ force });
    res.status(200).json({
      contact: { scalars: CONTACT_SCALARS, fields: shapeFields(contact) },
      business: { scalars: BUSINESS_SCALARS, folders: business.folders, fields: shapeFields(business) },
    });
  } catch (error: any) {
    console.error('mapping/catalogs error:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to load catalogs' });
  }
}
