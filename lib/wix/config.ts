// lib/wix/config.ts — resolve Wix connector config + auth from the environment.
//
// Auth model (Zach's choice): a Wix OAuth APP using the Client Credentials flow —
//   POST https://www.wixapis.com/oauth2/token
//   { grant_type:'client_credentials', client_id, client_secret, instance_id }
//   -> { access_token, token_type, expires_in }
// then `Authorization: Bearer <access_token>` on Data/Media API calls. The app is installed
// on the LRL site, so `instance_id` scopes the token to that site.
//
// Escape hatch: if WIX_API_TOKEN is set we use it directly as a static bearer (a Wix API key
// + wix-site-id header) — handy for local probing before the OAuth app exists.
//
// Mirrors lib/ghl/config.ts: resolve from env, throw a descriptive error on missing vars,
// allow base-url/version overrides.

export interface WixConfig {
  baseUrl: string;
  tokenUrl: string;
  siteId: string;
  userAgent: string;
  /** OAuth client-credentials (undefined when using a static token). */
  clientId?: string;
  clientSecret?: string;
  instanceId?: string;
  /** Static bearer override (skips OAuth entirely). */
  staticToken?: string;
}

const DEFAULT_BASE_URL = 'https://www.wixapis.com';
const DEFAULT_TOKEN_URL = 'https://www.wixapis.com/oauth2/token';
const DEFAULT_USER_AGENT = 'lrl-ops-app/1.0';

/** True when enough Wix credentials are present to make authenticated calls. */
export const hasWix = Boolean(
  process.env.WIX_API_TOKEN ||
    (process.env.WIX_OAUTH_CLIENT_ID && process.env.WIX_OAUTH_CLIENT_SECRET && process.env.WIX_APP_INSTANCE_ID),
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it in .env.local (see lib/wix/config.ts for the Wix auth model).`,
    );
  }
  return v;
}

export function getWixConfig(): WixConfig {
  const base: Omit<WixConfig, 'clientId' | 'clientSecret' | 'instanceId' | 'staticToken'> = {
    baseUrl: process.env.WIX_BASE_URL || DEFAULT_BASE_URL,
    tokenUrl: process.env.WIX_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
    siteId: requireEnv('WIX_SITE_ID'),
    userAgent: process.env.WIX_USER_AGENT || DEFAULT_USER_AGENT,
  };

  // Static token path (local/dev or API-key auth).
  if (process.env.WIX_API_TOKEN) {
    return { ...base, staticToken: process.env.WIX_API_TOKEN };
  }

  // OAuth app (client credentials).
  return {
    ...base,
    clientId: requireEnv('WIX_OAUTH_CLIENT_ID'),
    clientSecret: requireEnv('WIX_OAUTH_CLIENT_SECRET'),
    instanceId: requireEnv('WIX_APP_INSTANCE_ID'),
  };
}
