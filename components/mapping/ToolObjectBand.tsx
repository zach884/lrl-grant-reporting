// components/mapping/ToolObjectBand.tsx — the source/destination tool+object selector band
// above the field table. Each side shows a tinted tool chip + object; the center shows the
// derived sync direction (two-way ⇄, or one-way → with a lock for Wix). A side is a grouped
// picker (GHL objects + Wix collections) when an onChange is passed, else a static chip.

import { useEffect, useRef, useState } from 'react';
import { TOOLS, objectIcon, objectLabel, pairingIsOneWay, type ToolDef } from '@/lib/mapping/tools';

export interface SideRef { tool: string; object: string }

function chipColors(toolId: string): { tint: string; fg: string } {
  const t = TOOLS[toolId];
  return { tint: t?.tint ?? 'var(--gray-100)', fg: t?.fg ?? 'var(--gray-500)' };
}

function Chip({ side, wixCollections }: { side: SideRef; wixCollections: { id: string; displayName: string }[] }) {
  const c = chipColors(side.tool);
  const label = side.tool === 'wix'
    ? (wixCollections.find((w) => w.id === side.object)?.displayName ?? (side.object || 'Choose collection'))
    : objectLabel(side.tool, side.object);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
      <span style={{ width: 40, height: 40, borderRadius: 10, background: c.tint, color: c.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flex: 'none' }}>
        <i className={`fa-solid ${side.tool === 'wix' ? 'fa-table-cells-large' : objectIcon(side.tool, side.object)}`} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: c.fg }}>{TOOLS[side.tool]?.label ?? side.tool}</span>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
    </span>
  );
}

function Picker({ side, onChange, wixCollections }: { side: SideRef; onChange: (s: SideRef) => void; wixCollections: { id: string; displayName: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const ghl = TOOLS.ghl;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="lrl-focus" onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '8px 12px', cursor: 'pointer' }}>
        <Chip side={side} wixCollections={wixCollections} />
        <i className="fa-solid fa-chevron-down" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--gray-400)' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 260, zIndex: 900, background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 12px 32px rgba(0,0,0,.16))', overflow: 'hidden', maxHeight: 360, overflowY: 'auto' }}>
          {[ghl, TOOLS.wix].map((tool: ToolDef) => {
            const objs = tool.id === 'wix' ? wixCollections.map((w) => ({ id: w.id, label: w.displayName, icon: 'fa-table-cells-large' })) : tool.objects;
            return (
              <div key={tool.id}>
                <div style={{ padding: '8px 14px 4px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: tool.fg, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <i className={`fa-solid ${tool.icon}`} /> {tool.label} <span style={{ color: 'var(--gray-400)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· {tool.sync === 'two-way' ? 'two-way' : 'one-way target'}</span>
                </div>
                {objs.length === 0 && <div style={{ padding: '6px 14px 10px', fontSize: 12, color: 'var(--gray-450)' }}>No collections (connect Wix).</div>}
                {objs.map((o) => {
                  const active = side.tool === tool.id && side.object === o.id;
                  return (
                    <button key={o.id} type="button" onClick={() => { onChange({ tool: tool.id, object: o.id }); setOpen(false); }}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: 13, fontFamily: 'var(--font-body)', background: active ? 'var(--accent-tint)' : 'transparent', color: active ? 'var(--teal-700)' : 'var(--text)' }}>
                      <i className={`fa-solid ${o.icon}`} style={{ width: 16, textAlign: 'center', color: 'var(--gray-400)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                      {active && <i className="fa-solid fa-check" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--teal-600)' }} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ToolObjectBand({
  source, target, wixCollections = [], onChangeSource, onChangeTarget,
}: {
  source: SideRef;
  target: SideRef;
  wixCollections?: { id: string; displayName: string }[];
  onChangeSource?: (s: SideRef) => void;
  onChangeTarget?: (s: SideRef) => void;
}) {
  const oneWay = pairingIsOneWay(source.tool, target.tool);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 18, alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '16px 20px', marginBottom: 16 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--gray-450)', marginBottom: 6 }}>Source</div>
        {onChangeSource ? <Picker side={source} onChange={onChangeSource} wixCollections={wixCollections} /> : <Chip side={source} wixCollections={wixCollections} />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '0 6px' }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', background: oneWay ? 'var(--brand-tint)' : 'var(--accent-tint)', color: oneWay ? 'var(--yellow-700)' : 'var(--teal-700)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
          <i className={`fa-solid ${oneWay ? 'fa-arrow-right-long' : 'fa-right-left'}`} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{oneWay ? 'One-way sync' : 'Two-way sync'}</span>
        <span style={{ fontSize: 10.5, color: 'var(--gray-450)', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          {oneWay ? <><i className="fa-solid fa-lock" style={{ fontSize: 9 }} /> Locked to GHL → destination</> : 'Per-field direction'}
        </span>
      </div>

      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--gray-450)', marginBottom: 6, textAlign: 'right' }}>Destination</div>
        {onChangeTarget ? <Picker side={target} onChange={onChangeTarget} wixCollections={wixCollections} /> : <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Chip side={target} wixCollections={wixCollections} /></div>}
      </div>
    </div>
  );
}
