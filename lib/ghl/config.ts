// lib/ghl/config.ts — resolve which GHL sub-account (live vs sandbox) the client targets.
//
// Build-safety constraint (see project memory): the LIVE sub-account runs active
// reporting automations. Reads against live are safe; schema/write TESTS should target
// the sandbox. The target is env-driven so the same code promotes cleanly:
//
//   GHL_TARGET=live    (default) -> GHL_API_KEY        + GHL_LOCATION_ID
//   GHL_TARGET=sandbox           -> GHL_SANDBOX_API_KEY + GHL_SANDBOX_LOCATION_ID
//
// Private Integration tokens are PER sub-account and isolated (a sandbox PIT 403s on live).

export type GhlTarget = 'live' | 'sandbox';

export interface GhlConfig {
  target: GhlTarget;
  baseUrl: string;
  apiKey: string;
  locationId: string;
  apiVersion: string;
  userAgent: string;
}

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
const DEFAULT_API_VERSION = '2021-07-28';
// Cloudflare 1010-bans the default Python UA; Node fetch's UA works, but we set an
// explicit one everywhere for consistency with the reusable scripts.
const DEFAULT_USER_AGENT = 'lrl-ops-app/1.0';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env.local (see lib/ghl/config.ts for the target model).`,
    );
  }
  return v;
}

/**
 * Resolve config from the environment. Pass an explicit target to override
 * GHL_TARGET (useful in scripts/tests).
 */
export function getGhlConfig(target?: GhlTarget): GhlConfig {
  const resolved: GhlTarget =
    target ?? ((process.env.GHL_TARGET as GhlTarget) || 'live');

  const apiKey =
    resolved === 'sandbox'
      ? requireEnv('GHL_SANDBOX_API_KEY')
      : requireEnv('GHL_API_KEY');
  const locationId =
    resolved === 'sandbox'
      ? requireEnv('GHL_SANDBOX_LOCATION_ID')
      : requireEnv('GHL_LOCATION_ID');

  return {
    target: resolved,
    baseUrl: process.env.GHL_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
    locationId,
    apiVersion: process.env.GHL_API_VERSION || DEFAULT_API_VERSION,
    userAgent: process.env.GHL_USER_AGENT || DEFAULT_USER_AGENT,
  };
}
