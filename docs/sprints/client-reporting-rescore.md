# Client Reporting rescore funnel + app authentication

Opened 2026-09-04 (Zach, reporting season). Two things that turned out to be one thing: the
client-facing rescore funnel, and the fact that shipping it publishes an app that currently has no
authentication.

## 1. The flow Zach specified

```
GHL email sequence (3-drip, contacts tagged `client`)
  -> funnel page 1   Client Reporting Form  (GHL form ed03BbRGWrc6Ugtwr9JB)
  -> funnel page 2   confirmation + what TRL/MRL/CRL/Churchill mean + CTA "Get re-scored"
  -> APP  /client-reporting/profile         current scores + prior answers, editable
  -> writes to the COMPANY record, rescores inline, tags the contact
  -> funnel page 3   thank-you (GHL tracking)     + Aiden's email fires off the tag
```

Page 1 already exists and already ingests: webhook #3 (`/api/form-sync?formId=...`) turns each
submission into a `metrics` activity. **This sprint does not touch that path.** It adds the rescore
half after it.

## 2. Why the rescore form is an app page and not a GHL form

**GHL forms are contact-scoped and cannot read or write a company or custom-object record.** A GHL
rescore form could only show the contact's own last answers (possibly stale relative to the company)
and could only write contact fields, waiting on the up-sync to carry them up.

The app page reads the **company record** — the authoritative scoring input per
`docs/sprints/scoring-enricher-kickoff.md` — writes straight back to it, and calls
`runStageScoreTrigger` inline, so the client sees the new score before closing the tab. This is the
"right-object capture" thread from Sprint D arriving early, and it means the rescore adds **no new
two-way synced field**, which is the 2026-08-27 incident's lesson.

## 3. The fields — 18 inputs, routed

Source of truth is `lib/stage/companyInputs.ts`. Do not re-list them anywhere else.

`business.business_model` routes the path (`routePath`), and `PATH_DIMENSIONS` decides which inputs
are shown:

| Path | Dimensions | Inputs shown |
|---|---|---|
| `tech` | TRL, MRL, CRL | the 2 context + 3 TRL + 2 MRL + 3 CRL + revenue = **11** |
| `service` | Churchill | the 2 context + revenue + 7 Churchill = **10** |
| `both` | all four | **18** |

`inputsForDimensions(dims)` already returns exactly this, in declaration order. The page renders what
it returns and nothing else, so adding a scoring input later changes the form automatically.

**A company with no `business_model` cannot be routed.** `routePath` returns null and the scorer skips
it. The page handles this as a first question rather than an error: ask the business model, then show
the routed set.

## 4. Identity — signed tokens, not a raw contact id

Rejected: `?cid={{contact.id}}`. It works, and GHL merges it happily, but it makes
`/api/client-profile` an endpoint that returns any company given an id, and there is no expiry and no
way to revoke a leaked link.

**Chosen: an HMAC-signed token, minted ahead of the send and stored on the contact.**

```
payload = { c: contactId, b: businessId, exp: unix }
token   = base64url(payload) + "." + base64url(HMAC-SHA256(payload, CLIENT_LINK_SECRET))
```

- Bound to **both** the contact and the company, so a token cannot be edited to read another company
  and cannot drift if the contact is later re-pointed to a different employer.
- Expires. Reporting season plus slack = **90 days** default.
- Revocable in bulk by rotating `CLIENT_LINK_SECRET`.
- Costs Zach nothing extra to wire: it lives on the contact as `contact.rescore_token` and merges into
  the email and the form redirect exactly like `{{contact.id}}` would.

`scripts-ts/mint-rescore-links.ts` mints for every contact tagged `client` (dry-run -> review ->
apply, per the house rule). It creates the `rescore_token` contact field if absent.

Residual risk, named rather than hidden: the link is still a **bearer capability**. Anyone the client
forwards it to can see and edit that company's profile until it expires. That is the same risk model
as every survey link and it is accepted deliberately.

## 5. The security finding this sprint is really about

Measured 2026-09-04 from outside the network, anonymous, no header:

```
200  GET https://lrl-grant-reporting.vercel.app/api/companies/search?q=...
200  GET https://lrl-grant-reporting.vercel.app/api/mapping/list
200  GET https://lrl-grant-reporting.vercel.app/api/enrichers
```

- **7 of 49 API routes check anything.** Only the webhook receivers verify `x-webhook-secret`.
  The other 42 are open, including `/api/mapping/apply`, `/api/activities/create|update|delete` and
  `/api/contacts/search`.
- **`lib/auth.ts` is not authentication.** `parseGHLContext` reads `user_role` from the query string.
  `?user_role=admin` is an admin. It was built to *display* identity inside the GHL iframe.
- Vercel SSO is on but scoped `all_except_custom_domains`, which is why the webhooks work with no
  bypass header — and why the production alias is open to everyone.

This was already true. The funnel is what converts "obscure" into "published to every client we have",
so it is a **prerequisite of this sprint, not a follow-up**.

### Chosen staff auth, and why not the textbook answer

The correct GHL answer is the **SSO handshake**: the embedded page asks GHL for encrypted user data
over `postMessage` and decrypts it with the location's SSO key. It is cryptographic and gives real
per-user attribution.

It needs a **GHL Marketplace developer app**, and there isn't one — the location runs on
`GHL_API_KEY`, and there is no SSO key in the environment. Standing one up is a separate errand with
an admin dependency, and Zoom is already blocked on exactly that kind of dependency. So:

**Signed httpOnly session cookie, bootstrapped from the existing `ADMIN_SECRET`, enforced by
default-deny middleware.** One hour, closes all 42 holes, does not block the GHL embed
(`SameSite=None; Secure`, so the cookie survives the cross-site iframe).

Honest downside: a shared credential, so change-log attribution stays as weak as it is today. It is
not *worse* than today, and today the internet can call `/api/mapping/apply`. The middleware is
structured so the SSO handshake later replaces one function rather than the layer.

### Default deny

`middleware.ts` denies everything not on this list:

| Path | Who enforces | How |
|---|---|---|
| `/api/form-sync`, `/api/sync/up`, `/api/wix-sync`, `/api/appointment-sync`, `/api/opportunity-sync`, `/api/resource-sync`, `/api/readiness-tag` | the handler (unchanged) | `x-webhook-secret` |
| `/api/client-profile` | the handler | signed client token |
| `/client-reporting/*` | the page + its API | signed client token |
| `/staff-login`, `/api/staff/login` | n/a | the login itself |
| `/_next/*`, `/favicon.ico`, `/fonts/*` | n/a | static |
| **everything else** | middleware | staff session cookie; HTML -> 302 `/staff-login`, API -> 401 |

Webhook routes are allowlisted rather than re-checked in middleware **on purpose**: they already
enforce, they are live and load-bearing during reporting season, and two different secret env vars are
in play (`SYNC_WEBHOOK_SECRET`, `WIX_SYNC_WEBHOOK_SECRET`). Re-implementing that check one layer up is
how you take a webhook down at 2am for no gain.

No GitHub Actions workflow calls the app over HTTP (checked), so middleware cannot break a nightly.

## 6. Write path

On submit the page sends only the fields the client **changed**.

1. Verify the token; take `contactId` and `businessId` from the payload, never from the request body.
2. Re-read the company record. Diff the submitted values against current. Unchanged -> drop.
3. `setBusinessFields(businessId, changed, catalogByKey)` — which goes through `applyObjectWrite`, so
   modifier fields diff correctly and every write is verified by read-back. Never hand-roll a write.
4. `runStageScoreTrigger(businessId, { apply: true, force: true })`. `force` because the client just
   told us the inputs are current even if the fingerprint happens to match.
5. Tag the contact `rescore-submitted` — this is Aiden's email trigger.
6. Return the new scores; the page reveals them, then redirects to `RESCORE_DONE_URL` (funnel page 3).

**A resubmit with no edits must report `noop` and must not create a second stage record.** The
existing machinery already does this (equality guard + `getCompanyStageContext` upserting today's
record); the acceptance test is to prove it rather than assume it.

## 7. Acceptance

1. Anonymous `GET /api/mapping/list` returns **401**, from outside the network.
2. A valid token loads the right company; an edited token (any byte) returns 401; an expired one 401.
3. The routed field set matches `inputsForDimensions` for a tech company, a service company and a
   `both` company.
4. Changing one input writes exactly one field, produces one new/updated stage record, and the change
   log shows it.
5. Resubmitting unchanged writes **nothing** and creates no second record.
6. The GHL embed still works for staff after one login.
7. `npx tsc --noEmit` and `npm test` clean.

## 8. What Zach wires by hand (the app cannot do it — see `ghl-workflow-automation-limits`)

Filled in with real values at the end of the build, in `PROJECT_STATE.md`.
