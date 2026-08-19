import { describe, it, expect, beforeEach } from 'vitest';
import { labelFromFields, resolveRecordLabel, clearLabelCache } from '../label';

/** A get() over a plain map, mimicking RecordFields.get. */
const g = (o: Record<string, unknown>) => (k: string) => o[k];

describe('labelFromFields', () => {
  it('names a contact by first + last', () => {
    expect(labelFromFields('contact', g({ firstName: 'Emmett', lastName: 'Barrett' }))).toBe('Emmett Barrett');
  });

  it('falls back to email, then company, for a nameless contact', () => {
    expect(labelFromFields('contact', g({ email: 'e@x.io' }))).toBe('e@x.io');
    expect(labelFromFields('contact', g({ companyName: 'Barrett Solutions' }))).toBe('Barrett Solutions');
    expect(labelFromFields('contact', g({}))).toBeUndefined();
  });

  it('names a company', () => {
    expect(labelFromFields('business', g({ name: 'Fidelis Engineering Associates' }))).toBe('Fidelis Engineering Associates');
    // prefixed key also works, since object reads expose both
    expect(labelFromFields('business', g({ 'business.name': 'Acme' }))).toBe('Acme');
  });

  it('names a custom object by its own field, which is the GHL convention', () => {
    // custom_objects.resources stores the display name in `resources`
    expect(labelFromFields('custom_objects.resources', g({ resources: 'Centrepolis Accelerator' }))).toBe('Centrepolis Accelerator');
  });

  it('falls back to name/title for a custom object that does not follow the convention', () => {
    expect(labelFromFields('custom_objects.widgets', g({ title: 'Widget A' }))).toBe('Widget A');
    expect(labelFromFields('custom_objects.widgets', g({ name: 'Widget B' }))).toBe('Widget B');
  });

  it('collapses whitespace and truncates a runaway value', () => {
    expect(labelFromFields('business', g({ name: '  Acme   Robotics \n LLC ' }))).toBe('Acme Robotics LLC');
    const long = 'x'.repeat(400);
    const out = labelFromFields('business', g({ name: long }))!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns undefined rather than a junk label', () => {
    expect(labelFromFields('business', g({ name: '   ' }))).toBeUndefined();
    expect(labelFromFields('custom_objects.resources', g({}))).toBeUndefined();
  });
});

describe('resolveRecordLabel', () => {
  beforeEach(() => clearLabelCache());

  function countingClient(props: Record<string, unknown>) {
    let reads = 0;
    return {
      reads: () => reads,
      client: {
        locationId: 'LOC',
        async request({ path }: any) {
          reads += 1;
          if (String(path).startsWith('/contacts/')) {
            return { contact: { id: 'c1', firstName: 'Bill', lastName: 'Webster', customFields: [] } };
          }
          return { record: { properties: props } };
        },
      } as any,
    };
  }

  it('reads the record once and memoises the result', async () => {
    const { client, reads } = countingClient({ name: 'Fidelis Engineering Associates' });
    expect(await resolveRecordLabel('business', 'b1', client)).toBe('Fidelis Engineering Associates');
    expect(await resolveRecordLabel('business', 'b1', client)).toBe('Fidelis Engineering Associates');
    expect(await resolveRecordLabel('business', 'b1', client)).toBe('Fidelis Engineering Associates');
    expect(reads()).toBe(1); // a batch sweep must not re-read per event
  });

  it('never throws — an unresolvable record just has no label', async () => {
    const boom = { locationId: 'L', async request() { throw new Error('gone'); } } as any;
    await expect(resolveRecordLabel('business', 'missing', boom)).resolves.toBeUndefined();
  });

  it('caches the miss too, so a deleted record is not re-read on every event', async () => {
    let reads = 0;
    const boom = { locationId: 'L', async request() { reads += 1; throw new Error('gone'); } } as any;
    await resolveRecordLabel('business', 'missing', boom);
    await resolveRecordLabel('business', 'missing', boom);
    expect(reads).toBe(1);
  });

  it('returns undefined for a blank id without any I/O', async () => {
    const { client, reads } = countingClient({});
    expect(await resolveRecordLabel('business', '', client)).toBeUndefined();
    expect(reads()).toBe(0);
  });
});
