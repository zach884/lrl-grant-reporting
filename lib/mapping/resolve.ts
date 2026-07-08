// lib/mapping/resolve.ts — annotate + validate mappings against the live catalogs.
//
// The sync engine (milestone #3) and the future admin UI both consume ResolvedFieldMapping:
// each row is enriched with both sides' data types and flagged for problems (missing field,
// unwritable target type, option-type mismatch) so nothing silently misbehaves at sync time.

import type { CustomFieldCatalog } from '../ghl/types';
import { isUnwritable, isCreateOnly } from '../ghl/coerce';
import type {
  FieldMapping,
  MappingIssue,
  ResolvedFieldMapping,
} from './types';

// Scalars that aren't in the custom-field catalogs but are valid mapping targets.
const CONTACT_SCALARS = new Set(['companyName', 'firstName', 'lastName', 'email', 'phone', 'city', 'state', 'postalCode']);
const BUSINESS_SCALARS = new Set(['name', 'email', 'phone', 'website', 'address', 'city', 'state', 'postalCode', 'country']);

const OPTION_TYPES = new Set(['SINGLE_OPTIONS', 'RADIO']);

export function resolveMapping(
  m: FieldMapping,
  contactCatalog: CustomFieldCatalog,
  businessCatalog: CustomFieldCatalog,
): ResolvedFieldMapping {
  const cDef = contactCatalog.byKey[m.contactKey];
  const bDef = businessCatalog.byKey[m.businessKey];

  const contactExists = !!cDef || CONTACT_SCALARS.has(m.contactKey);
  const businessExists = !!bDef || BUSINESS_SCALARS.has(m.businessKey);
  const businessDataType = bDef?.dataType;
  const businessCreateOnly = bDef ? isCreateOnly(bDef.dataType) : false;
  const businessWritable = bDef
    ? !isUnwritable(bDef.dataType) && !businessCreateOnly // writable on UPDATE
    : businessExists; // scalars writable
  const optionType =
    !!cDef && !!bDef && OPTION_TYPES.has(cDef.dataType) && OPTION_TYPES.has(bDef.dataType);

  const issues: MappingIssue[] = [];
  const add = (level: MappingIssue['level'], message: string) =>
    issues.push({ level, contactKey: m.contactKey, businessKey: m.businessKey, message });

  if (!contactExists) add('error', `Contact field "${m.contactKey}" not found in the live catalog.`);
  if (!businessExists) add('error', `Company field "${m.businessKey}" not found in the live catalog.`);
  if (bDef && isUnwritable(bDef.dataType)) {
    add('error', `Company field is ${bDef.dataType} — cannot be written via the API. Maintain in the UI or remodel as SINGLE_OPTIONS/TEXT.`);
  }
  if (businessCreateOnly) {
    add('warning', `Company field is ${bDef!.dataType} — settable ONLY at company creation (intake), immutable via update sync. For existing companies maintain in the UI.`);
  }
  if (cDef && bDef && OPTION_TYPES.has(cDef.dataType) !== OPTION_TYPES.has(bDef.dataType)) {
    add('warning', `Type mismatch: contact ${cDef.dataType} vs company ${bDef.dataType} — option key/label handling may not apply cleanly.`);
  }
  if ((m.direction === 'down' || m.direction === 'both') && !m.mirrorDown && m.contactKey !== m.businessKey) {
    // informational: down-sync writes to contacts even if not in the "mirror subset"
  }

  return {
    ...m,
    contactDataType: cDef?.dataType,
    businessDataType,
    contactName: cDef?.name,
    businessName: bDef?.name,
    contactExists,
    businessExists,
    businessWritable,
    businessCreateOnly,
    optionType,
    issues,
  };
}

export function resolveMappings(
  mappings: FieldMapping[],
  contactCatalog: CustomFieldCatalog,
  businessCatalog: CustomFieldCatalog,
): ResolvedFieldMapping[] {
  return mappings.map((m) => resolveMapping(m, contactCatalog, businessCatalog));
}

/** All issues across a resolved set, plus duplicate-target detection. */
export function collectIssues(resolved: ResolvedFieldMapping[]): MappingIssue[] {
  const issues: MappingIssue[] = resolved.flatMap((r) => r.issues);
  const seenBusiness = new Map<string, number>();
  for (const r of resolved) {
    if (!r.enabled && r.enabled !== undefined) continue;
    seenBusiness.set(r.businessKey, (seenBusiness.get(r.businessKey) ?? 0) + 1);
  }
  for (const [key, count] of Array.from(seenBusiness.entries())) {
    if (count > 1) {
      issues.push({
        level: 'error',
        contactKey: '(multiple)',
        businessKey: key,
        message: `Company field "${key}" is targeted by ${count} mappings — pick one source of truth.`,
      });
    }
  }
  return issues;
}
