// lib/sync/reconcile.ts — the scheduled DOWN-sync sweep.
//
// Native GHL workflows are best-effort; THIS is the guarantee. It re-pushes every
// company's mirrored fields to all associated contacts and logs any drift it corrects.
// Run nightly / pre-reporting. Equality-guarded, so a clean run writes nothing.

import { GhlClient, ghl } from '../ghl/client';
import { CustomFieldCatalog, Contact } from '../ghl/types';
import { enumerateAllContacts } from '../ghl/contacts';
import type { FieldMapping } from '../mapping/types';
import { syncCompanyDown } from './downsync';
import { CompanySyncResult, ReconcileStats } from './types';

export interface ReconcileOptions {
  apply: boolean;
  client?: GhlClient;
  /** Called after each company is processed (for progress UIs / logs). */
  onCompany?: (result: CompanySyncResult) => void;
  /** Limit to specific company ids (else all companies that have contacts). */
  onlyCompanyIds?: string[];
}

export interface ReconcileReport {
  stats: ReconcileStats;
  /** companies whose contacts drifted (had at least one write). */
  changed: CompanySyncResult[];
}

/**
 * Group all contacts by businessId and re-push each company's mirrored state.
 * Reads all contacts once (light), then syncCompanyDown re-reads each contact's
 * custom fields (needed for the equality guard) and the company record once.
 */
export async function reconcileAll(
  mappings: FieldMapping[],
  catalogs: { business: CustomFieldCatalog; contact: CustomFieldCatalog },
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const client = opts.client ?? ghl();
  const stats: ReconcileStats = {
    companiesProcessed: 0,
    contactsProcessed: 0,
    contactsChanged: 0,
    fieldsWritten: 0,
    errors: [],
  };
  const changed: CompanySyncResult[] = [];

  // Group contacts by company.
  const byCompany = new Map<string, Contact[]>();
  const all = await enumerateAllContacts(client);
  for (const c of all) {
    if (!c.businessId) continue;
    if (opts.onlyCompanyIds && !opts.onlyCompanyIds.includes(c.businessId)) continue;
    const arr = byCompany.get(c.businessId) ?? [];
    arr.push(c);
    byCompany.set(c.businessId, arr);
  }

  for (const [companyId, contacts] of Array.from(byCompany.entries())) {
    try {
      const result = await syncCompanyDown(companyId, mappings, catalogs, {
        apply: opts.apply,
        client,
        contacts,
      });
      stats.companiesProcessed++;
      stats.contactsProcessed += result.results.length;
      let companyChanged = false;
      for (const r of result.results) {
        const wrote = r.written.length + (r.companyNameWritten ? 1 : 0);
        if (wrote > 0) { stats.contactsChanged++; stats.fieldsWritten += wrote; companyChanged = true; }
      }
      if (companyChanged) changed.push(result);
      opts.onCompany?.(result);
    } catch (e: any) {
      stats.errors.push({ companyId, message: e?.message ?? String(e) });
    }
  }

  return { stats, changed };
}
