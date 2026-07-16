// lib/nav/modules.ts — the single source of truth for the app's module nav.
//
// Shared by AppShell (standalone dark rail) and EmbeddedShell (GHL iframe tab bar) so the
// two never drift. Keep the set, order, icons, and "Soon" flags identical across shells.

export interface ModuleItem {
  id: string;
  label: string;
  icon: string; // Font Awesome 6 Solid glyph, e.g. "fa-gauge-high"
  href?: string;
  soon?: boolean;
}

export const MODULES: ModuleItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', soon: true },
  { id: 'mappings', label: 'Field Mappings', icon: 'fa-arrow-right-arrow-left', href: '/mappings' },
  { id: 'enrichment', label: 'Data Enrichment', icon: 'fa-wand-magic-sparkles', href: '/enrichment' },
  { id: 'wix-sync', label: 'Website Sync', icon: 'fa-globe', href: '/wix-sync' },
  { id: 'activity', label: 'Activity Reporting', icon: 'fa-clipboard-list', soon: true },
  { id: 'grants', label: 'Grant Reporting', icon: 'fa-file-invoice-dollar', soon: true },
  { id: 'settings', label: 'Settings', icon: 'fa-gear', soon: true },
];
