// lib/square/config.ts — resolve Square API config from the environment.
//
// Square uses a Bearer access token (create a Production access token in the
// Square Developer console; it has full read access to your own account). We only
// ever READ orders, so ORDERS_READ is the only scope this feature needs.
//
//   SQUARE_ACCESS_TOKEN  (required) — Production access token
//   SQUARE_LOCATION_ID   (required) — the Cafe Fuel location id
//   SQUARE_ENV           production | sandbox  (default production)
//   SQUARE_VERSION       optional Square-Version header; omit to use the token's
//                        default version (safest — never an invalid-version error)
//   SQUARE_TIMEZONE      IANA tz for month bucketing (default America/Detroit)

export interface SquareConfig {
  baseUrl: string;
  accessToken: string;
  locationId: string;
  version?: string;
  timezone: string;
}

const PROD_BASE = 'https://connect.squareup.com';
const SANDBOX_BASE = 'https://connect.squareupsandbox.com';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Add it to .env.local (see lib/square/config.ts).`,
    );
  }
  return v;
}

export function getSquareConfig(): SquareConfig {
  const env = (process.env.SQUARE_ENV || 'production').toLowerCase();
  return {
    baseUrl: env === 'sandbox' ? SANDBOX_BASE : PROD_BASE,
    accessToken: requireEnv('SQUARE_ACCESS_TOKEN'),
    locationId: requireEnv('SQUARE_LOCATION_ID'),
    version: process.env.SQUARE_VERSION || undefined,
    timezone: process.env.SQUARE_TIMEZONE || 'America/Detroit',
  };
}
