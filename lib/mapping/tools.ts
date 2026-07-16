// lib/mapping/tools.ts — the registry of tools we can sync between, and their capabilities.
//
// Each tool declares its sync capability and its selectable objects. The mapping UI derives
// the allowed direction from the pairing: a mapping that touches a 'one-way-target' tool
// (e.g. Wix CMS) is locked to push (GHL → that tool); only GHL↔GHL is per-row two-way.
// Adding a future tool = one entry here, no UI changes.

export type SyncCapability = 'two-way' | 'one-way-target';

export interface ToolObject {
  id: string;
  label: string;
  icon: string; // Font Awesome 6 Solid glyph
}

export interface ToolDef {
  id: string; // 'ghl' | 'wix'
  label: string; // 'GoHighLevel'
  short: string; // 'GHL'
  icon: string; // group glyph
  tint: string; // chip background token
  fg: string; // chip foreground token
  sync: SyncCapability;
  /** Static objects for the tool (Wix objects are its CMS collections, loaded at runtime). */
  objects: ToolObject[];
}

export const TOOLS: Record<string, ToolDef> = {
  ghl: {
    id: 'ghl',
    label: 'GoHighLevel',
    short: 'GHL',
    icon: 'fa-bolt',
    tint: 'var(--accent-tint)',
    fg: 'var(--teal-700)',
    sync: 'two-way',
    objects: [
      { id: 'contact', label: 'Contact', icon: 'fa-user' },
      { id: 'business', label: 'Company', icon: 'fa-building' },
      { id: 'opportunity', label: 'Opportunity', icon: 'fa-handshake' },
    ],
  },
  wix: {
    id: 'wix',
    label: 'Wix CMS',
    short: 'Wix',
    icon: 'fa-globe',
    tint: 'var(--violet-100)',
    fg: 'var(--violet-700)',
    sync: 'one-way-target',
    // objects (CMS collections) are loaded at runtime from /api/wix/collections.
    objects: [],
  },
};

export function toolDef(id: string): ToolDef | undefined {
  return TOOLS[id];
}

/**
 * Scalar foreign-key links between GHL objects — how this account actually connects records
 * (the association *relation records* are empty; links live in scalar fields). The mapper
 * offers these as destinations too; traversal is encoded as "scalar:<on>:<field>".
 *   on='source' → the source record carries the target's id in <field> (one counterpart).
 *   on='target' → target records carry the source id in <field> (fan-out).
 */
export interface ScalarLink { source: string; target: string; field: string; on: 'source' | 'target' }
export const SCALAR_LINKS: ScalarLink[] = [
  { source: 'contact', target: 'business', field: 'businessId', on: 'source' },
  { source: 'business', target: 'contact', field: 'businessId', on: 'target' },
  { source: 'opportunity', target: 'contact', field: 'contactId', on: 'source' },
  { source: 'contact', target: 'opportunity', field: 'contactId', on: 'target' },
];
export function scalarLinksFrom(sourceObject: string): ScalarLink[] {
  return SCALAR_LINKS.filter((l) => l.source === sourceObject);
}

/** A pairing is one-way if EITHER side is a one-way-target tool. */
export function pairingIsOneWay(leftToolId: string, rightToolId: string): boolean {
  return TOOLS[leftToolId]?.sync === 'one-way-target' || TOOLS[rightToolId]?.sync === 'one-way-target';
}

/** Human label for an object within a tool (falls back to the raw id, e.g. a Wix collection id). */
export function objectLabel(toolId: string, objectId: string): string {
  return TOOLS[toolId]?.objects.find((o) => o.id === objectId)?.label ?? objectId;
}

export function objectIcon(toolId: string, objectId: string): string {
  return TOOLS[toolId]?.objects.find((o) => o.id === objectId)?.icon ?? (toolId === 'wix' ? 'fa-table-cells-large' : 'fa-cube');
}
