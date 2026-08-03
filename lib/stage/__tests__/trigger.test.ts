import { describe, it, expect } from 'vitest';
import { scoringInputChanged, SCORE_TRIGGER_KEYS, STAGE_SCORER_META } from '../trigger';

describe('SCORE_TRIGGER_KEYS', () => {
  it('includes business_model + the scoring inputs (bare keys), not the dropped revenue_stage', () => {
    expect(SCORE_TRIGGER_KEYS.has('business_model')).toBe(true);
    expect(SCORE_TRIGGER_KEYS.has('annual_revenue')).toBe(true);
    expect(SCORE_TRIGGER_KEYS.has('tech_product_state')).toBe(true);
    expect(SCORE_TRIGGER_KEYS.has('owner_involvement')).toBe(true);
    expect(SCORE_TRIGGER_KEYS.has('revenue_stage')).toBe(false); // dropped from the scorer
  });
});

describe('scoringInputChanged (real-time cost guard)', () => {
  it('fires when a scoring-relevant field changed', () => {
    expect(scoringInputChanged(['business_model'])).toBe(true);
    expect(scoringInputChanged(['logo', 'annual_revenue'])).toBe(true);
  });
  it('does not fire for unrelated field changes', () => {
    expect(scoringInputChanged(['logo', 'country', 'website'])).toBe(false);
    expect(scoringInputChanged([])).toBe(false);
  });
});

describe('STAGE_SCORER_META', () => {
  it('is a company-targeted enricher registered for the UI', () => {
    expect(STAGE_SCORER_META.name).toBe('client-stage-scorer');
    expect(STAGE_SCORER_META.target).toBe('company');
    expect(STAGE_SCORER_META.sourceObject).toBe('business');
    expect(STAGE_SCORER_META.produces).toContain('churchill_substage');
  });
});
