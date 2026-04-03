// pages/api/sheets/test-append.ts — Test the full sheet append flow
import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfig } from '@/lib/config';
import { sheets } from '@/lib/sheets';
import { ghlRequest } from '@/lib/ghl';
import { enrichAddress } from '@/lib/enrich';
import type { GrantSheetMapping, ReportingPeriod } from '@/types';

const TEST_CONTACT_ID = 'GjJQGARB6tRUhHYi9RQm';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  try {
    // Step 1: Load config
    const config = await getConfig(true);
    results['config_loaded'] = {
      grants: config.grantSheetMapping.length,
      fields: config.fieldMapping.length,
      periods: config.reportingPeriods.length,
    };

    // Step 2: Check grant matching
    const testGrant = 'trusted_connector';
    const testType = 'intake';
    const testDate = '2026-04-03';

    const resolvedGrant = resolveGrantName(testGrant, config);
    results['grant_resolution'] = { input: testGrant, resolved: resolvedGrant };

    if (!resolvedGrant) {
      results['error'] = 'Could not resolve grant name';
      return res.status(200).json(results);
    }

    // Step 3: Check sheet mappings
    const matchingSheets = config.grantSheetMapping.filter(
      (m: GrantSheetMapping) =>
        m.grant === resolvedGrant && m.activity_type_key === testType && m.active
    );
    results['matching_sheets'] = matchingSheets;

    // Step 4: Check reporting periods
    const matchingPeriods = config.reportingPeriods.filter(
      (rp: ReportingPeriod) =>
        rp.grant === resolvedGrant &&
        rp.active &&
        testDate >= rp.date_from &&
        testDate <= rp.date_to
    );
    results['matching_periods'] = matchingPeriods;

    // Step 5: Check field mappings
    const fieldMappings = config.fieldMapping.filter(
      (fm: any) =>
        fm.grant === resolvedGrant &&
        (fm.activity_type_key === 'all' || fm.activity_type_key === testType)
    );
    results['field_mappings_count'] = fieldMappings.length;
    results['field_mappings'] = fieldMappings.map((fm: any) => ({
      col: fm.column_letter,
      source: fm.data_source,
      key: fm.field_key,
      condition: fm.write_condition,
    }));

    // Step 6: Fetch test contact
    let contact: any = null;
    try {
      const c = await ghlRequest<any>({ path: `/contacts/${TEST_CONTACT_ID}` });
      const raw = c.contact ?? c;
      contact = {
        company_name: raw.companyName ?? '',
        full_name: [raw.firstName ?? '', raw.lastName ?? ''].filter(Boolean).join(' '),
        email: raw.email ?? '',
        address1: raw.address1 ?? '',
        city: raw.city ?? '',
        state: raw.state ?? '',
        postal_code: raw.postalCode ?? '',
      };
      results['contact'] = contact;
    } catch (e: any) {
      results['contact_error'] = e.message;
    }

    // Step 7: Test enrichment
    if (contact) {
      try {
        const enrichment = await enrichAddress(contact.address1, contact.city, contact.state, contact.postal_code);
        results['enrichment'] = enrichment;
      } catch (e: any) {
        results['enrichment_error'] = e.message;
      }
    }

    // Step 8: Try a test sheet write (just append a test row to first matching tab)
    if (matchingPeriods.length > 0) {
      const period = matchingPeriods[0];
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: period.sheet_id,
          range: `'${period.tab_name}'!A:B`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [['TEST ROW - DELETE ME', 'Test from API']],
          },
        });
        results['test_write'] = { success: true, tab: period.tab_name };
      } catch (e: any) {
        results['test_write'] = { success: false, error: e.message };
      }
    }

  } catch (error: any) {
    results['fatal_error'] = error.message;
  }

  res.status(200).json(results);
}

function resolveGrantName(ghlKey: string, config: any): string | null {
  const uniqueGrants = Array.from(
    new Set(config.grantSheetMapping.map((m: GrantSheetMapping) => m.grant))
  ) as string[];

  if (uniqueGrants.includes(ghlKey)) return ghlKey;
  const normalized = ghlKey.toLowerCase().replace(/[\s.]+/g, '_');
  for (const configGrant of uniqueGrants) {
    const configNormalized = configGrant.toLowerCase().replace(/[\s.]+/g, '_');
    if (normalized === configNormalized) return configGrant;
  }
  return null;
}
