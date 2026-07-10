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

const BIG = Number.MAX_SAFE_INTEGER;

/** Shape + sort fields into GHL display order: by folder position, then field position.
 *  The UI groups by folder preserving this order, so folders + fields match GHL exactly. */
function shapeFields(cat: CustomFieldCatalog) {
  const folderById = new Map(cat.folders.map((f) => [f.id, f]));
  return cat.fields
    .filter((f) => f.fieldKey)
    .map((f) => {
      const folder = f.parentId ? folderById.get(f.parentId) : undefined;
      return {
        fieldKey: f.fieldKey,
        name: f.name,
        dataType: f.dataType,
        folder: folder?.name ?? null,
        options: f.options ?? null,
        folderPos: folder?.position ?? BIG,
        position: f.position ?? BIG,
      };
    })
    .sort(
      (a, b) =>
        a.folderPos - b.folderPos ||
        (a.folder ?? '~').localeCompare(b.folder ?? '~') ||
        a.position - b.position ||
        a.name.localeCompare(b.name),
    )
    .map(({ folderPos, position, ...rest }) => rest); // strip sort-only fields
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
