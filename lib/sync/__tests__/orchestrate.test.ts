import { describe, it, expect, afterEach } from 'vitest';
import { useGenericEngine } from '../orchestrate';

const orig = process.env.SYNC_ENGINE_MODE;
afterEach(() => { if (orig === undefined) delete process.env.SYNC_ENGINE_MODE; else process.env.SYNC_ENGINE_MODE = orig; });

describe('useGenericEngine (cutover flag)', () => {
  it('defaults to the built-in engine when unset (shipping the code flips nothing)', () => {
    delete process.env.SYNC_ENGINE_MODE;
    expect(useGenericEngine()).toBe(false);
  });
  it('stays on the built-in engine for any value other than "generic"', () => {
    process.env.SYNC_ENGINE_MODE = 'builtin';
    expect(useGenericEngine()).toBe(false);
    process.env.SYNC_ENGINE_MODE = 'whatever';
    expect(useGenericEngine()).toBe(false);
  });
  it('switches to the generic engine only for "generic" (case-insensitive)', () => {
    process.env.SYNC_ENGINE_MODE = 'generic';
    expect(useGenericEngine()).toBe(true);
    process.env.SYNC_ENGINE_MODE = 'GENERIC';
    expect(useGenericEngine()).toBe(true);
  });
});
