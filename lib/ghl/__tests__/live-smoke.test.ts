// Opt-in live smoke test — READ-ONLY against the live GHL sub-account.
// Run with:  npm run test:live      (sets GHL_LIVE_SMOKE=1)
// Skipped in the normal `npm test` run so CI never hits the network / live data.
//
// It validates the layer against real response shapes: field catalog, company list,
// a company record's properties, and single-select key->label read normalization.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIVE = process.env.GHL_LIVE_SMOKE === '1';

// Minimal .env.local loader (no dotenv dep). Only fills vars not already set.
function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env.local — rely on ambient env */
  }
}

describe.skipIf(!LIVE)('GHL live smoke (read-only)', () => {
  beforeAll(loadEnvLocal);

  it('reads the business field catalog (81 fields, expected folders)', async () => {
    const { getBusinessFieldCatalog } = await import('../customFields');
    const cat = await getBusinessFieldCatalog();
    expect(cat.fields.length).toBeGreaterThanOrEqual(60);
    expect(cat.byKey['business.lara_id']).toBeTruthy();
    const folderNames = cat.folders.map((f) => f.name);
    expect(folderNames).toContain('Intake');
  });

  it('lists companies and reads one record with bare-key properties', async () => {
    const { listAllBusinesses, getBusinessRecord } = await import('../businesses');
    const list = await listAllBusinesses();
    expect(list.length).toBeGreaterThan(100);
    // Find a record that actually has custom properties.
    let found = null;
    for (const b of list.slice(0, 40)) {
      const rec = await getBusinessRecord(b.id);
      if (rec && Object.keys(rec.properties).length > 3) {
        found = rec;
        break;
      }
    }
    expect(found).toBeTruthy();
    // properties keys are BARE (no "business." prefix)
    expect(Object.keys(found!.properties).some((k) => k.startsWith('business.'))).toBe(false);
  });

  it('normalizes a stored single-select KEY back to its LABEL', async () => {
    const { getBusinessFieldCatalog } = await import('../customFields');
    const { getCustomField } = await import('../customFields');
    const { optionKeyToLabel } = await import('../coerce');
    const cat = await getBusinessFieldCatalog();
    const countyDef = cat.byKey['business.county'];
    expect(countyDef).toBeTruthy();
    // list endpoint options are flaky -> single-field GET for the authoritative options
    const full = await getCustomField(countyDef.id);
    const opts = full?.options ?? countyDef.options;
    if (opts && opts.length) {
      const label = optionKeyToLabel(opts[0].key, opts);
      expect(label).toBe(opts[0].label);
    }
  });
});
