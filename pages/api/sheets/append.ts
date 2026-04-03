// pages/api/sheets/append.ts — Append row to grant reporting sheet
import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfig } from '@/lib/config';
import { sheets } from '@/lib/sheets';
import { ghlRequest } from '@/lib/ghl';
import { enrichAddress } from '@/lib/enrich';
import type {
  FieldMapping,
  GrantSheetMapping,
  ReportingPeriod,
  ContactOption,
  EnrichmentResult,
} from '@/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      contact_id,
      activity_name,
      activity_date,
      activity_type,
      activity_notes,
      activity_owner,
      program__grant_association,
      referral_type,
      referred_to_id,
    } = req.body;

    const config = await getConfig(true); // force refresh to pick up config changes

    // Fetch full contact data directly from GHL
    const contactResult = await fetchContact(contact_id);
    const contact = contactResult.contact;
    const customFields = contactResult.customFields;

    // Fetch referred-to contact if applicable
    let referredTo: ContactOption | null = null;
    let referredToCustomFields: Record<string, string> = {};
    if (referred_to_id) {
      const refResult = await fetchContact(referred_to_id);
      referredTo = refResult.contact;
      referredToCustomFields = refResult.customFields;
    }

    // Run enrichment (non-blocking concept, but we need results for sheet)
    let enrichment: EnrichmentResult = { county: null, geoDisadvantaged: null };
    try {
      enrichment = await enrichAddress(
        contact.address1,
        contact.city,
        contact.state,
        contact.postal_code
      );
    } catch (err) {
      console.warn('Enrichment failed, continuing without:', err);
    }

    const grantKeys = Array.isArray(program__grant_association)
      ? program__grant_association
      : [program__grant_association];

    const activity = {
      activity_name,
      activity_date,
      activity_type,
      activity_notes,
      activity_owner,
      program__grant_association: grantKeys,
      referral_type,
    };

    // Build a mapping from GHL grant keys to config grant names
    // GHL keys: "trusted_connector", "sbsh_10", etc.
    // Config names: "Trusted Connector", "SBSH 1.0", etc.
    const uniqueConfigGrants = Array.from(
      new Set(config.grantSheetMapping.map((m: GrantSheetMapping) => m.grant))
    ) as string[];

    const resolveGrantName = (ghlKey: string): string | null => {
      if (uniqueConfigGrants.includes(ghlKey)) return ghlKey;
      const normalized = ghlKey.toLowerCase().replace(/[\s.]+/g, '_');
      for (const configGrant of uniqueConfigGrants) {
        const configNormalized = configGrant.toLowerCase().replace(/[\s.]+/g, '_');
        if (normalized === configNormalized) return configGrant;
      }
      return null;
    };

    let appendCount = 0;
    const errors: string[] = [];
    const debug: string[] = [];

    debug.push(`Grant keys from form: ${JSON.stringify(grantKeys)}`);
    debug.push(`Activity type: ${activity_type}`);
    debug.push(`Activity date: ${activity_date}`);
    debug.push(`Config grants in sheet mapping: ${JSON.stringify(uniqueConfigGrants)}`);

    // For each selected grant, find matching sheet mappings
    for (const grantKey of grantKeys) {
      const grant = resolveGrantName(grantKey);
      debug.push(`Grant key "${grantKey}" resolved to: "${grant}"`);
      if (!grant) {
        errors.push(`No config mapping found for grant key: ${grantKey}`);
        continue;
      }

      const matchingSheets = config.grantSheetMapping.filter(
        (m: GrantSheetMapping) =>
          m.grant === grant &&
          m.activity_type_key === activity_type &&
          m.active
      );
      debug.push(`Matching sheet mappings for ${grant}/${activity_type}: ${matchingSheets.length}`);

      if (matchingSheets.length === 0) continue;

      // Get field mappings for this grant + activity type
      const fieldMappings = config.fieldMapping.filter(
        (fm: FieldMapping) =>
          fm.grant === grant &&
          (fm.activity_type_key === 'all' || fm.activity_type_key === activity_type)
      );

      // Find reporting periods for the activity date
      const matchingPeriods = config.reportingPeriods.filter(
        (rp: ReportingPeriod) =>
          rp.grant === grant &&
          rp.active &&
          activity_date >= rp.date_from &&
          activity_date <= rp.date_to
      );

      if (matchingPeriods.length === 0) {
        errors.push(`No active reporting period found for ${grant} on ${activity_date}`);
        continue;
      }

      // Build the row data
      const rowData = buildRow(
        activity,
        contact,
        customFields,
        referredTo,
        referredToCustomFields,
        fieldMappings,
        enrichment,
        grant,
        config
      );

      // Append to each matching tab
      for (const period of matchingPeriods) {
        try {
          await appendRowToSheet(
            period.sheet_id,
            period.tab_name,
            rowData,
            fieldMappings[0]?.header_row ?? 3
          );
          appendCount++;
        } catch (err: any) {
          errors.push(`Failed to append to ${period.tab_name}: ${err.message}`);
        }
      }
    }

    console.log('Sheet append debug:', debug.join(' | '));
    console.log('Sheet append result:', { appendCount, errors });

    res.status(200).json({
      success: true,
      appendCount,
      errors: errors.length > 0 ? errors : undefined,
      debug,
    });
  } catch (error: any) {
    console.error('Sheet append error:', error);
    res.status(500).json({ error: error.message ?? 'Sheet append failed' });
  }
}

function buildRow(
  activity: any,
  contact: ContactOption,
  customFields: Record<string, string>,
  referredTo: ContactOption | null,
  referredToCustomFields: Record<string, string>,
  fieldMappings: FieldMapping[],
  enrichment: EnrichmentResult,
  grant: string,
  config: any
): Record<string, string> {
  const row: Record<string, string> = {};

  // Group field mappings by column letter
  const byColumn: Record<string, FieldMapping[]> = {};
  for (const fm of fieldMappings) {
    if (!byColumn[fm.column_letter]) byColumn[fm.column_letter] = [];
    byColumn[fm.column_letter].push(fm);
  }

  for (const [col, mappings] of Object.entries(byColumn)) {
    const values: string[] = [];

    for (const mapping of mappings) {
      if (!shouldWrite(mapping.write_condition, activity, grant, config)) continue;

      let value: string = '';

      switch (mapping.data_source) {
        case 'contact':
          value = getContactField(contact, customFields, mapping.field_key);
          break;
        case 'activity':
          value = activity[mapping.field_key] ?? mapping.field_key ?? '';
          break;
        case 'referred_to':
          if (referredTo) {
            value = getContactField(referredTo, referredToCustomFields, mapping.field_key);
          }
          break;
        case 'static':
          value = mapping.field_key;
          break;
        case 'computed':
          value = getComputedValue(mapping.field_key, enrichment);
          break;
      }

      if (value !== null && value !== undefined && value !== '') {
        values.push(String(value));
      }
    }

    if (values.length > 0) {
      row[col] = values.join(' / ');
    }
  }

  return row;
}

function getContactField(
  contact: ContactOption,
  customFields: Record<string, string>,
  fieldKey: string
): string {
  // Check standard fields first
  const standardFields: Record<string, string> = {
    company_name: contact.company_name,
    full_name: contact.full_name,
    email: contact.email,
    phone: contact.phone,
    address1: contact.address1,
    city: contact.city,
    state: contact.state,
    postal_code: contact.postal_code,
  };

  if (fieldKey in standardFields) {
    return standardFields[fieldKey] ?? '';
  }

  // Check custom fields
  return customFields[fieldKey] ?? '';
}

function getComputedValue(fieldKey: string, enrichment: EnrichmentResult): string {
  switch (fieldKey) {
    case 'census_county':
      return enrichment.county ?? '';
    case 'geo_disadvantaged_lookup':
    case 'arcgis_geo_disadvantaged':
      if (enrichment.geoDisadvantaged === null) return '';
      return enrichment.geoDisadvantaged ? 'TRUE' : 'FALSE';
    default:
      return '';
  }
}

function shouldWrite(
  condition: string,
  activity: any,
  grant: string,
  config: any
): boolean {
  if (!condition || condition === 'always') return true;
  if (condition === 'blank') return false;
  if (condition === 'phase2') return false;
  if (condition === 'boolean_field') return true;

  if (condition.startsWith('if_activity_type:')) {
    const types = condition.replace('if_activity_type:', '').split(',');
    return types.includes(activity.activity_type);
  }

  if (condition.startsWith('if_grant_reporting_label:')) {
    const targetLabel = condition.replace('if_grant_reporting_label:', '');
    // Look up the grant_reporting_label from referral_type_grant_mapping
    const mapping = config.referralTypeGrantMapping.find(
      (m: any) =>
        m.referral_type_key === activity.referral_type && m.grant === grant
    );
    return mapping?.grant_reporting_label === targetLabel;
  }

  return true;
}

async function appendRowToSheet(
  sheetId: string,
  tabName: string,
  rowData: Record<string, string>,
  headerRow: number
): Promise<void> {
  const maxCol = getMaxColumn(Object.keys(rowData));
  const rowArray = columnLettersToArray(rowData, maxCol);

  // Find the first empty row after the header by reading column A
  const dataStartRow = headerRow + 1;
  const scanRange = `'${tabName}'!A${dataStartRow}:A`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: scanRange,
  });

  // Count non-empty rows from the top
  const values = existing.data.values ?? [];
  let nextRow = dataStartRow;
  for (let i = 0; i < values.length; i++) {
    if (values[i] && values[i][0] && String(values[i][0]).trim() !== '') {
      nextRow = dataStartRow + i + 1;
    }
  }

  // Write to the specific row
  const writeRange = `'${tabName}'!A${nextRow}:${maxCol}${nextRow}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: writeRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [rowArray],
    },
  });
}

/** Convert column letter to number (A=1, B=2, ... Z=26, AA=27) */
function colToNum(col: string): number {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

/** Convert number to column letter */
function numToCol(num: number): string {
  let col = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    col = String.fromCharCode(65 + mod) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
}

/** Get the highest column letter from an array */
function getMaxColumn(columns: string[]): string {
  let max = 0;
  for (const col of columns) {
    const num = colToNum(col);
    if (num > max) max = num;
  }
  return numToCol(max);
}

/** Convert column-letter-keyed object to ordered array */
function columnLettersToArray(rowData: Record<string, string>, maxCol: string): string[] {
  const maxNum = colToNum(maxCol);
  const arr: string[] = [];
  for (let i = 1; i <= maxNum; i++) {
    const col = numToCol(i);
    arr.push(rowData[col] ?? '');
  }
  return arr;
}

/** Fetch a contact directly from GHL and return normalized data */
function titleCase(str: string): string {
  if (!str) return '';
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchContact(contactId: string): Promise<{ contact: ContactOption; customFields: Record<string, string> }> {
  const c = await ghlRequest<any>({ path: `/contacts/${contactId}` });
  const raw = c.contact ?? c;
  const companyName = titleCase(raw.companyName ?? '');
  const fullName = [titleCase(raw.firstName ?? ''), titleCase(raw.lastName ?? '')].filter(Boolean).join(' ');

  const customFieldMap: Record<string, string> = {};
  if (Array.isArray(raw.customFields)) {
    for (const cf of raw.customFields) {
      customFieldMap[cf.id] = cf.value ?? '';
    }
  }

  return {
    contact: {
      id: raw.id,
      display: companyName || fullName || raw.email || 'Unknown',
      company_name: companyName,
      full_name: fullName,
      email: raw.email ?? '',
      phone: raw.phone ?? '',
      address1: raw.address1 ?? '',
      city: titleCase(raw.city ?? ''),
      state: (raw.state ?? '').toUpperCase(),
      postal_code: raw.postalCode ?? '',
      minority_owned: customFieldMap['my_company_is_a_minority_owned_business_radio'] ?? '',
    },
    customFields: customFieldMap,
  };
}
