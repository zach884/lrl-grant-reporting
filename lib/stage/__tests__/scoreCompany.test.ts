import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI client so scoreCompany makes no network call; classifyJson is controllable per test.
vi.mock('../../ai/anthropic', () => ({
  hasAnthropic: true,
  classifyJson: vi.fn(),
  SCORING_MODEL: 'test-scoring-model',
  CLASSIFIER_MODEL: 'test-classifier-model',
}));

import { classifyJson } from '../../ai/anthropic';
import {
  routePath,
  buildScoreSchema,
  buildScorePrompt,
  parseScoreResult,
  scoreCompany,
  type PriorAssessment,
} from '../scoreCompany';
import {
  buildInputBlob,
  inputsForDimensions,
  labelResolvingAccessor,
  PATH_DIMENSIONS,
} from '../companyInputs';
import type { CustomFieldCatalog } from '../../ghl/types';

const mockClassify = classifyJson as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mockClassify.mockReset());

const PRODUCT = 'Developing a new product, technology, or invention to bring to market. Most of my work is building, prototyping, validating, or commercializing something new.';
const SERVICE = 'Delivering or operating a service based business. Most of my work is serving customers today through a service, location, or established offering.';
const BOTH = "Both — I'm developing a new product AND running an ongoing service or location-based business.";

/** A field accessor backed by a plain map (prefixed keys). */
const fieldOf = (m: Record<string, unknown>) => (k: string) => m[k];

describe('routePath', () => {
  it('routes Product → tech, Service → service, Both → both', () => {
    expect(routePath(PRODUCT)).toBe('tech');
    expect(routePath(SERVICE)).toBe('service');
    expect(routePath(BOTH)).toBe('both');
  });
  it('routes the stored snake_case option KEYS (how the field actually persists)', () => {
    expect(routePath('developing_a_new_product_technology_or_invention_to_bring_to')).toBe('tech');
    expect(routePath('delivering_or_operating_a_service_based_business_most_of_my_')).toBe('service');
    expect(routePath('both_i_m_developing_a_new_product_and_running_an_ongoing_ser')).toBe('both');
  });
  it('accepts short tokens as a convenience', () => {
    expect(routePath('product')).toBe('tech');
    expect(routePath('Service')).toBe('service');
    expect(routePath('both')).toBe('both');
  });
  it('returns null for blank / unrecognized so the runner can skip', () => {
    expect(routePath('')).toBeNull();
    expect(routePath(null)).toBeNull();
    expect(routePath('something else entirely')).toBeNull();
  });
});

describe('companyInputs', () => {
  it('tech path pulls TRL/MRL/CRL inputs but not Churchill-only ones', () => {
    const keys = inputsForDimensions(PATH_DIMENSIONS.tech).map((i) => i.businessKey);
    expect(keys).toContain('business.tech_product_state'); // TRL
    expect(keys).toContain('business.mfg_method'); // MRL
    expect(keys).toContain('business.selling_stage'); // CRL
    expect(keys).not.toContain('business.owner_involvement'); // Churchill-only
  });
  it('service path pulls only Churchill inputs (+ shared context/revenue)', () => {
    const keys = inputsForDimensions(PATH_DIMENSIONS.service).map((i) => i.businessKey);
    expect(keys).toContain('business.owner_involvement');
    expect(keys).toContain('business.annual_revenue'); // shared crl+churchill
    expect(keys).not.toContain('business.tech_product_state');
  });
  it('labelResolvingAccessor maps option keys → labels (arrays too), passes non-option fields through', () => {
    const catalog: CustomFieldCatalog = {
      fields: [], folders: [], byId: {},
      byKey: {
        'business.tech_product_state': { id: '1', name: 'x', fieldKey: 'business.tech_product_state', dataType: 'SINGLE_OPTIONS', options: [{ key: 'lab_demo', label: 'Lab demo' }] },
        'business.independent_validation_company': { id: '2', name: 'y', fieldKey: 'business.independent_validation_company', dataType: 'MULTIPLE_OPTIONS', options: [{ key: 'fda', label: 'FDA clearance' }, { key: 'peer', label: 'Peer-reviewed' }] },
      },
    };
    const field = labelResolvingAccessor(fieldOf({
      'business.tech_product_state': 'lab_demo',
      'business.independent_validation_company': ['fda', 'peer'],
      'business.description': 'free text stays as-is',
    }), catalog);
    expect(field('business.tech_product_state')).toBe('Lab demo');
    expect(field('business.independent_validation_company')).toEqual(['FDA clearance', 'Peer-reviewed']);
    expect(field('business.description')).toBe('free text stays as-is');
  });

  it('buildInputBlob labels values, prefixes revenue with $, and drops blanks', () => {
    const blob = buildInputBlob(fieldOf({
      'business.name': 'Acme Robotics',
      'business.description': 'We build warehouse robots',
      'business.tech_product_state': 'Working prototype tested in the field',
      'business.annual_revenue': '250000',
      'business.patents': '', // blank → dropped
    }), PATH_DIMENSIONS.tech);
    expect(blob).toContain('Company: Acme Robotics');
    expect(blob).toContain('Current state of technology / product: Working prototype tested in the field');
    expect(blob).toContain('Annual revenue (last 12 months): $250000');
    expect(blob).not.toContain('Patents:');
  });
});

describe('buildScoreSchema', () => {
  it('tech schema requires trl/mrl/crl + tech_rationale, no churchill', () => {
    const s = buildScoreSchema(PATH_DIMENSIONS.tech) as any;
    expect(s.required.sort()).toEqual(['crl', 'mrl', 'tech_rationale', 'trl']);
    expect(s.properties.churchill_score).toBeUndefined();
    // Structured outputs reject minimum/maximum on integers — bound lives in the description + clamp.
    expect(s.properties.trl).toMatchObject({ type: 'integer' });
    expect(s.properties.trl.minimum).toBeUndefined();
    expect(s.properties.trl.description).toContain('1-9');
    expect(s.properties.mrl.description).toContain('1-10');
  });
  it('service schema requires churchill fields only', () => {
    const s = buildScoreSchema(PATH_DIMENSIONS.service) as any;
    expect(s.required.sort()).toEqual(['churchill_score', 'churchill_substage', 'service_rationale']);
    expect(s.properties.trl).toBeUndefined();
    expect(s.properties.churchill_substage.enum).toEqual(['III-D', 'III-G', 'N/A']);
  });
  it('both schema requires every field', () => {
    const s = buildScoreSchema(PATH_DIMENSIONS.both) as any;
    expect(s.required).toEqual(expect.arrayContaining(['trl', 'mrl', 'crl', 'tech_rationale', 'churchill_score', 'churchill_substage', 'service_rationale']));
  });
});

describe('buildScorePrompt', () => {
  it('includes only the relevant scales + guidance for the tech path', () => {
    const { user } = buildScorePrompt({ path: 'tech', inputBlob: 'Company: X' });
    expect(user).toContain('Technology Readiness Level');
    expect(user).toContain('Manufacturing Readiness Level');
    expect(user).toContain('Commercial Readiness Level');
    expect(user).not.toContain('Churchill');
    expect(user).toContain('Client information:\nCompany: X');
  });
  it('service path includes Churchill only', () => {
    const { user } = buildScorePrompt({ path: 'service', inputBlob: 'Company: Y' });
    expect(user).toContain('Churchill');
    expect(user).not.toContain('Technology Readiness Level');
  });
  it('adds a Previous assessment block on re-score', () => {
    const prior: PriorAssessment = {
      trl: 4, mrl: 3, crl: 2, churchillStage: null, churchillSubstage: null,
      techRationale: 'prior tech note', serviceRationale: null, source: 'record',
    };
    const { user } = buildScorePrompt({ path: 'tech', inputBlob: 'Company: Z', prior });
    expect(user).toContain('Previous assessment');
    expect(user).toContain('TRL = 4');
    expect(user).toContain('prior tech note');
  });
});

describe('parseScoreResult', () => {
  it('clamps out-of-range integers and keeps only path fields', () => {
    const out = parseScoreResult({ trl: 99, mrl: 0, crl: 5, tech_rationale: 'ok' }, 'tech', 'm', false)!;
    expect(out.trl).toBe(9);
    expect(out.mrl).toBe(1);
    expect(out.crl).toBe(5);
    expect(out.churchillStage).toBeUndefined();
  });
  it('forces sub-stage to N/A unless the Churchill stage is exactly 3', () => {
    const notThree = parseScoreResult({ churchill_score: 2, churchill_substage: 'III-G', service_rationale: 'x' }, 'service', 'm', false)!;
    expect(notThree.churchillSubstage).toBe('N/A');
    const three = parseScoreResult({ churchill_score: 3, churchill_substage: 'III-G', service_rationale: 'x' }, 'service', 'm', false)!;
    expect(three.churchillSubstage).toBe('III-G');
  });
  it('returns null when a required score is missing/non-numeric', () => {
    expect(parseScoreResult({ mrl: 3, crl: 4, tech_rationale: 'x' }, 'tech', 'm', false)).toBeNull();
    expect(parseScoreResult(null, 'tech', 'm', false)).toBeNull();
  });
});

describe('scoreCompany', () => {
  it('scores via one consolidated call and marks rescore=false without a prior', async () => {
    mockClassify.mockResolvedValue({ trl: 4, mrl: 3, crl: 5, tech_rationale: 'note' });
    const out = await scoreCompany({
      field: fieldOf({ 'business.name': 'Acme', 'business.tech_product_state': 'lab demo' }),
      path: 'tech',
    });
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ path: 'tech', trl: 4, mrl: 3, crl: 5, rescore: false });
  });
  it('marks rescore=true when a prior is supplied', async () => {
    mockClassify.mockResolvedValue({ churchill_score: 3, churchill_substage: 'III-D', service_rationale: 'n' });
    const prior: PriorAssessment = { trl: null, mrl: null, crl: null, churchillStage: 2, churchillSubstage: 'N/A', techRationale: null, serviceRationale: null, source: 'contact-fields' };
    const out = await scoreCompany({ field: fieldOf({ 'business.owner_involvement': 'full time' }), path: 'service', prior });
    expect(out).toMatchObject({ path: 'service', churchillStage: 3, churchillSubstage: 'III-D', rescore: true });
  });
  it('returns null (no call) when there are no inputs to score from', async () => {
    const out = await scoreCompany({ field: fieldOf({}), path: 'tech' });
    expect(out).toBeNull();
    expect(mockClassify).not.toHaveBeenCalled();
  });
});
