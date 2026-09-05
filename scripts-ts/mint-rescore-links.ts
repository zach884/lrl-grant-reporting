// scripts-ts/mint-rescore-links.ts — mint one signed rescore link per client contact.
//
// WHY A TOKEN AND NOT `?cid={{contact.id}}`. GHL can merge a field but cannot compute an HMAC, so the
// signature has to be minted here, ahead of the send, and parked somewhere GHL can merge it from.
// That is `contact.rescore_token`. The payoff: /api/client-profile takes the company id from the
// SIGNED payload, so it can never be turned into "return any company by id", the link expires, and
// rotating CLIENT_LINK_SECRET revokes every outstanding link at once.
//
//   npx vite-node scripts-ts/mint-rescore-links.ts                 # dry run
//   npx vite-node scripts-ts/mint-rescore-links.ts --apply
//   npx vite-node scripts-ts/mint-rescore-links.ts --apply --tag client --ttl 90
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { enumerateAllContacts, setContactCustomFields } from '../lib/ghl/contacts';
import { getContactFieldCatalog, createLocationField } from '../lib/ghl/customFields';
import { mintClientToken } from '../lib/security/clientToken';

const APPLY = process.argv.includes('--apply');
const argOf = (flag: string, dflt: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TAG = argOf('--tag', 'client').toLowerCase();
const TTL_DAYS = Number(argOf('--ttl', '90'));
const FIELD_NAME = 'Rescore Token';
const BARE_KEY = 'rescore_token';

// Local dev reads .env.local; in CI the secrets arrive as real env vars and the file does not exist.
// An unguarded readFileSync ENOENTs the whole run before it starts (the trap that kept
// nightly-activities red for weeks).
function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) */ }
}

async function main() {
  env();
  process.env.GHL_TARGET = 'live';
  if (!process.env.CLIENT_LINK_SECRET) {
    console.error('CLIENT_LINK_SECRET is not set. Generate one and put it in .env.local AND Vercel:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
    process.exit(1);
  }
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  // 1. The field the token lives in.
  let cat = await getContactFieldCatalog(c);
  let def = cat.byKey[`contact.${BARE_KEY}`] ?? cat.byKey[BARE_KEY];
  if (!def) {
    console.log(`contact.${BARE_KEY} does not exist.`);
    if (!APPLY) {
      console.log(`  would create: "${FIELD_NAME}" (TEXT) on the contact model\n`);
    } else {
      const created = await createLocationField({ model: 'contact', name: FIELD_NAME, dataType: 'TEXT' }, c);
      console.log(`  created: ${created?.fieldKey} id=${created?.id}`);
      cat = await getContactFieldCatalog(c);
      def = cat.byKey[`contact.${BARE_KEY}`] ?? cat.byKey[BARE_KEY];
      if (!def) {
        // GHL derives the fieldKey from the NAME, so it may not be the key we assumed. Say so loudly
        // rather than writing tokens into a field nothing reads.
        console.error(`  created the field but could not find contact.${BARE_KEY} in the catalog.`);
        console.error('  Check the key GHL assigned and re-run. Keys GHL has:',
          Object.keys(cat.byKey).filter((k) => k.includes('rescore')).join(', ') || '(none)');
        process.exit(1);
      }
    }
  } else {
    console.log(`field ok: ${def.fieldKey} [${(def as any).dataType}] id=${def.id}\n`);
  }

  // 2. Who gets a link.
  const all = await enumerateAllContacts(c);
  const tagged = all.filter((x) => (x.tags ?? []).some((t) => t.toLowerCase() === TAG));
  const linkable = tagged.filter((x) => x.businessId);
  const orphans = tagged.filter((x) => !x.businessId);

  console.log(`contacts total          ${all.length}`);
  console.log(`tagged "${TAG}"${' '.repeat(Math.max(1, 16 - TAG.length))}${tagged.length}`);
  console.log(`with a company          ${linkable.length}`);
  console.log(`NO company (skipped)    ${orphans.length}\n`);

  // Named, never silently dropped — an unlinked contact gets an email with a dead button otherwise.
  if (orphans.length) {
    console.log('Skipped, no associated company. Link these in GHL before the sequence sends:');
    for (const o of orphans) console.log(`  - ${[o.firstName, o.lastName].filter(Boolean).join(' ') || o.id}  ${o.email ?? ''}`);
    console.log('');
  }

  if (!APPLY) {
    const sample = linkable[0];
    if (sample) {
      const t = await mintClientToken(sample.id, sample.businessId!, TTL_DAYS);
      console.log(`sample token (${sample.email ?? sample.id}):\n  ${t}\n  length ${t.length}\n`);
    }
    console.log(`would write ${linkable.length} tokens, ttl ${TTL_DAYS} days. Re-run with --apply.`);
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const contact of linkable) {
    try {
      const token = await mintClientToken(contact.id, contact.businessId!, TTL_DAYS);
      await setContactCustomFields(contact.id, [{ id: def!.id, value: token }], c);
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok}/${linkable.length}`);
    } catch (e: any) {
      failed.push(`${contact.email ?? contact.id}: ${e?.message ?? e}`);
    }
    // GHL bulk loops 429 at ~0.12s spacing. 0.3s plus the client's own backoff.
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\nwrote ${ok}/${linkable.length} tokens (ttl ${TTL_DAYS} days).`);
  if (failed.length) {
    console.log(`FAILED ${failed.length}:`);
    for (const f of failed) console.log(`  - ${f}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
