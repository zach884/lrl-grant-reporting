import { describe, it, expect } from 'vitest';
import { fileUrls, firstFileUrl } from '../fileValue';

// The uuid-keyed shape below is copied from a real GHL form submission (2026-08-17 audit) —
// mishandling it meant every new expert's headshot and company logo silently never synced.
const FORM_UPLOAD = {
  'ced71d35-1d7a-48fa-89ec-400fa054d091': {
    meta: { name: 'headshot.jpg', extension: 'jpg', size: 91234 },
    url: 'https://services.leadconnectorhq.com/documents/download/ced71d35',
  },
};

describe('fileUrls', () => {
  it('reads a uuid-keyed map (the GHL form-upload shape)', () => {
    expect(fileUrls(FORM_UPLOAD)).toEqual([
      'https://services.leadconnectorhq.com/documents/download/ced71d35',
    ]);
  });

  it('reads every file from a multi-entry uuid-keyed map, in deterministic order', () => {
    const two = {
      'bbb-2': { url: 'https://x.test/second.png' },
      'aaa-1': { url: 'https://x.test/first.png' },
    };
    // Sorted by key, so repeated reads of the same record produce the same order (which is what
    // makes the modifier diff stable instead of churning add/remove every run).
    expect(fileUrls(two)).toEqual(['https://x.test/first.png', 'https://x.test/second.png']);
  });

  it('reads a bare url string', () => {
    expect(fileUrls('https://x.test/a.png')).toEqual(['https://x.test/a.png']);
  });

  it('reads an array of descriptors and an array of strings', () => {
    expect(fileUrls([{ url: 'https://x.test/a.png' }, { url: 'https://x.test/b.png' }])).toEqual([
      'https://x.test/a.png',
      'https://x.test/b.png',
    ]);
    expect(fileUrls(['https://x.test/a.png'])).toEqual(['https://x.test/a.png']);
  });

  it('reads a single descriptor object', () => {
    expect(fileUrls({ url: 'https://x.test/a.png', meta: { name: 'a' } })).toEqual(['https://x.test/a.png']);
  });

  it('dedupes repeated urls', () => {
    expect(fileUrls([{ url: 'https://x.test/a.png' }, 'https://x.test/a.png'])).toEqual([
      'https://x.test/a.png',
    ]);
  });

  it('returns [] for empty / non-url / unrecognized values', () => {
    expect(fileUrls(null)).toEqual([]);
    expect(fileUrls('')).toEqual([]);
    expect(fileUrls([])).toEqual([]);
    expect(fileUrls({})).toEqual([]);
    expect(fileUrls('not-a-url')).toEqual([]);
    expect(fileUrls({ 'uuid-a': { meta: { name: 'x' } } })).toEqual([]); // entry with no url
  });
});

describe('firstFileUrl', () => {
  it('takes the first url, or null', () => {
    expect(firstFileUrl(FORM_UPLOAD)).toBe('https://services.leadconnectorhq.com/documents/download/ced71d35');
    expect(firstFileUrl(null)).toBeNull();
  });
});
