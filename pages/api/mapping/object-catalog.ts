// pages/api/mapping/object-catalog.ts — field catalog for ANY GHL object (?object=<key>),
// shaped like /api/mapping/catalogs (scalars + folder-ordered fields) for the mapper dropdowns.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { shapeFields } from './catalogs';

// Standard (non-custom) scalar fields per object that are valid mapping targets.
const SCALARS: Record<string, string[]> = {
  contact: ['companyName', 'firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode', 'country', 'website'],
  business: ['name', 'email', 'phone', 'website', 'address', 'city', 'state', 'postalCode', 'country'],
  opportunity: ['name', 'status', 'monetaryValue'],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const object = typeof req.query.object === 'string' ? req.query.object : '';
  if (!object) return res.status(400).json({ error: 'object (objectKey) is required' });
  try {
    const catalog = await getCatalog(object, { force: req.query.refresh === 'true' });
    res.status(200).json({ object, scalars: SCALARS[object] ?? [], fields: shapeFields(catalog) });
  } catch (error: any) {
    console.error('mapping/object-catalog error:', error);
    res.status(500).json({ error: error?.message ?? 'failed to load object catalog' });
  }
}
