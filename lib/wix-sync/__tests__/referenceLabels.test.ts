// Item 6: the four labels that were silently dropping references on the Team sync.
//   Local → LOCAL                                casing → the resolver handles it
//   Sales and Marketing → Sales and Marketing Accelerator   different name → valueMap
//   i4.0 Accelerator → Industry 4.0 Accelerator             different name → valueMap
//   Manufacturing Tech → Manufacturing                      different name → valueMap

import { describe, it, expect } from 'vitest';
import { applyValueMap } from '../sync';
import { resolveReferenceIds } from '../../wix/collections';

/** A Wix client serving one referenced collection, recording how many queries it received. */
function refClient(values: string[]) {
  let queries = 0;
  const client = {
    request: async ({ path, body }: any) => {
      if (path === '/wix-data/v2/items/query') {
        queries += 1;
        return { dataItems: values.map((v, i) => ({ data: { _id: `id${i}`, title_fld: v } })) };
      }
      return {};
    },
  } as any;
  return { client, queries: () => queries };
}

const PROGRAMS = ['Industry 4.0 Accelerator', 'Lean Rocket Lab', 'Co-Working', 'ManuTech Incubator', 'LOCAL', 'Sales and Marketing Accelerator'];

describe('resolveReferenceIds — case-insensitive matching', () => {
  it('matches GHL "Local" to Wix "LOCAL" (the casing bug)', async () => {
    const { client } = refClient(PROGRAMS);
    const r = await resolveReferenceIds('Programs', 'title_fld', ['Local'], client);
    expect(r.ids).toEqual(['id4']);
    expect(r.unmatched).toEqual([]);
  });

  it('still matches an exact label', async () => {
    const { client } = refClient(PROGRAMS);
    const r = await resolveReferenceIds('Programs', 'title_fld', ['ManuTech Incubator'], client);
    expect(r.ids).toEqual(['id3']);
  });

  it('tolerates surrounding and collapsed whitespace', async () => {
    const { client } = refClient(PROGRAMS);
    const r = await resolveReferenceIds('Programs', 'title_fld', ['  lean   rocket lab '], client);
    expect(r.ids).toEqual(['id1']);
  });

  it('reports a genuinely different NAME as unmatched (needs a valueMap, not casing)', async () => {
    const { client } = refClient(PROGRAMS);
    const r = await resolveReferenceIds('Programs', 'title_fld', ['i4.0 Accelerator', 'Sales and Marketing'], client);
    expect(r.ids).toEqual([]);
    expect(r.unmatched).toEqual(['i4.0 Accelerator', 'Sales and Marketing']);
  });

  it('reads the collection ONCE regardless of label count', async () => {
    // The old implementation issued one filtered query per label.
    const { client, queries } = refClient(PROGRAMS);
    await resolveReferenceIds('Programs', 'title_fld', ['Local', 'ManuTech Incubator', 'Co-Working'], client);
    expect(queries()).toBe(1);
  });

  it('dedupes when two labels resolve to the same item', async () => {
    const { client } = refClient(PROGRAMS);
    const r = await resolveReferenceIds('Programs', 'title_fld', ['LOCAL', 'local'], client);
    expect(r.ids).toEqual(['id4']);
  });
});

describe('applyValueMap', () => {
  const TEAM_PROGRAM_MAP = {
    'Sales and Marketing': 'Sales and Marketing Accelerator',
    'i4.0 Accelerator': 'Industry 4.0 Accelerator',
  };

  it('rewrites each element of a multi-select array, leaving others alone', () => {
    const out = applyValueMap(['Sales and Marketing', 'ManuTech Incubator'], TEAM_PROGRAM_MAP);
    expect(out).toEqual(['Sales and Marketing Accelerator', 'ManuTech Incubator']);
  });

  it('rewrites a scalar', () => {
    expect(applyValueMap('i4.0 Accelerator', TEAM_PROGRAM_MAP)).toBe('Industry 4.0 Accelerator');
  });

  it('matches keys case- and whitespace-insensitively', () => {
    expect(applyValueMap('sales   and marketing', TEAM_PROGRAM_MAP)).toBe('Sales and Marketing Accelerator');
  });

  it('is a pass-through with no map, and for null', () => {
    expect(applyValueMap(['a', 'b'], undefined)).toEqual(['a', 'b']);
    expect(applyValueMap(null, TEAM_PROGRAM_MAP)).toBeNull();
  });

  it('resolves Emmett\'s actual values end to end', async () => {
    // programs ["Sales and Marketing","ManuTech Incubator"] · collectives ["Lean Startup","Manufacturing Tech"]
    const progs = applyValueMap(['Sales and Marketing', 'ManuTech Incubator'], TEAM_PROGRAM_MAP) as string[];
    const { client } = refClient(PROGRAMS);
    const rp = await resolveReferenceIds('Programs', 'title_fld', progs, client);
    expect(rp.unmatched).toEqual([]);
    expect(rp.ids).toHaveLength(2);

    const colls = applyValueMap(['Lean Startup', 'Manufacturing Tech'], { 'Manufacturing Tech': 'Manufacturing' }) as string[];
    const { client: c2 } = refClient(['Lean Startup', 'Manufacturing', 'Mainstreet']);
    const rc = await resolveReferenceIds('Collectives', 'title_fld', colls, c2);
    expect(rc.unmatched).toEqual([]);
    expect(rc.ids).toHaveLength(2);
  });
});
