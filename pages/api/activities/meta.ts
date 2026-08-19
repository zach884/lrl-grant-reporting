// pages/api/activities/meta.ts — the form's shape, straight off the live field catalog.
//
// The UI renders whatever this returns, so a field added to a GHL folder appears in the form with no
// front-end change (and no second copy of the field list to drift out of sync).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { ACTIVITIES_OBJECT, activityFieldSet, bareKey, staffLoggedTypes } from '@/lib/activities/schema';
import type { CustomFieldDef } from '@/lib/ghl/types';

export interface MetaField {
  key: string;
  label: string;
  dataType: string;
  options: Array<{ key: string; label: string }>;
  required: boolean;
  prominent: boolean;
}

const toField = (f: CustomFieldDef, required: string[], prominent: string[]): MetaField => ({
  key: bareKey(f),
  label: f.name,
  dataType: f.dataType,
  options: f.options ?? [],
  required: required.includes(bareKey(f)),
  prominent: prominent.includes(bareKey(f)),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const catalog = await getCatalog(ACTIVITIES_OBJECT);
    const types = staffLoggedTypes().map((t) => {
      const set = activityFieldSet(catalog, t.key);
      const prominentKeys = set.prominent.map(bareKey);
      return {
        key: t.key,
        label: t.label,
        core: set.core.map((f) => toField(f, [], [])),
        fields: set.typeFields.map((f) => toField(f, set.required, prominentKeys)),
        required: set.required,
      };
    });
    res.status(200).json({ types });
  } catch (error: any) {
    console.error('Activity meta error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to load activity metadata' });
  }
}
