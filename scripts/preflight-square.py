#!/usr/bin/env python3
"""Preflight the Square credentials before the net-sales job spends time on npm ci.

Why this exists
---------------
Square reports both of its credential failure modes as ``category:
AUTHENTICATION_ERROR``, which makes a wrong location look exactly like a bad token:

    401 UNAUTHORIZED  "This request could not be authorized."
        -> the Bearer value is not a Square access token (e.g. a location id or an
           application id ended up in SQUARE_ACCESS_TOKEN)

    403 FORBIDDEN     "You have insufficient permissions to perform that action."
        -> the token is fine, but SQUARE_LOCATION_ID names a location this token
           cannot read (or the token lacks ORDERS_READ)

On 2026-09-01 that ambiguity cost four failed runs. This script resolves the token to a
merchant and asserts that SQUARE_LOCATION_ID is one of the locations the token can
actually read, then says so in plain language via a GitHub Actions error annotation.

Reads SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID from the environment. Never prints the
token: only its length and first four characters, which is enough to spot a swapped value.
Exit 0 on success, 1 on any misconfiguration.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

PROD_BASE = "https://connect.squareup.com"
SANDBOX_BASE = "https://connect.squareupsandbox.com"


def annotate(msg: str) -> None:
    """Emit a GitHub Actions error annotation, so it surfaces on the run summary."""
    print(f"::error::{msg}")


def get(base: str, path: str, token: str) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        base + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return e.code, raw.decode("utf-8", "replace")
    except Exception as e:  # network, DNS, timeout
        return 0, str(e)


def main() -> int:
    token = os.environ.get("SQUARE_ACCESS_TOKEN", "")
    want_loc = os.environ.get("SQUARE_LOCATION_ID", "")
    env = (os.environ.get("SQUARE_ENV") or "production").lower()
    base = SANDBOX_BASE if env == "sandbox" else PROD_BASE

    print("--- Square preflight ---")
    print(f"env      : {env}  ({base})")

    if not token:
        annotate("SQUARE_ACCESS_TOKEN is empty or not set on this job.")
        return 1
    if not want_loc:
        annotate("SQUARE_LOCATION_ID is empty or not set on this job.")
        return 1

    # Shape hints. A Square access token is a long EAAA... string; a location id is short
    # and starts with L; an application id starts with sq0idp-. Printing the length and a
    # four-character prefix identifies a swap without disclosing anything usable.
    print(f"token    : {len(token)} chars, starts {token[:4]!r}")
    print(f"location : {want_loc!r} ({len(want_loc)} chars)")

    if token.startswith("sq0idp-"):
        annotate(
            "SQUARE_ACCESS_TOKEN holds an application id (sq0idp-...), not an access "
            "token. The application id is not a credential this job uses anywhere."
        )
        return 1
    if len(token) < 24:
        annotate(
            f"SQUARE_ACCESS_TOKEN is only {len(token)} characters. A Square access token "
            "is much longer (typically 64, starting EAAA). A location id may have been "
            "pasted into the token secret."
        )
        return 1
    if token != token.strip():
        print("note     : token has leading/trailing whitespace (harmless, but tidy it up)")
        token = token.strip()

    status, body = get(base, "/v2/locations", token)
    print(f"GET /v2/locations -> HTTP {status}")

    if status == 401:
        annotate(
            "Square returned 401 UNAUTHORIZED: the value in SQUARE_ACCESS_TOKEN is not a "
            "valid access token for this environment. Check that the token secret holds "
            "the EAAA... production access token, not a location id or application id."
        )
        return 1
    if status == 403:
        annotate(
            "Square returned 403 FORBIDDEN on /v2/locations: the token authenticates but "
            "lacks read permission. Confirm it has MERCHANT_PROFILE_READ and ORDERS_READ."
        )
        return 1
    if status != 200:
        annotate(f"Square returned HTTP {status} on /v2/locations: {body}")
        return 1

    locations = body.get("locations", []) if isinstance(body, dict) else []
    if not locations:
        annotate("Square returned no locations for this token. Wrong Square account?")
        return 1

    print("token resolves to these locations:")
    for loc in locations:
        print(f"  {loc.get('id')}  {loc.get('name')}  tz={loc.get('timezone')}  {loc.get('status')}")

    ids = [loc.get("id") for loc in locations]
    if want_loc not in ids:
        annotate(
            f"SQUARE_LOCATION_ID {want_loc!r} is not one of the locations this token can "
            f"read ({', '.join(str(i) for i in ids)}). This is the configuration that "
            "produces a 403 FORBIDDEN on /v2/orders/search, which reads like an auth "
            "failure but is really a wrong location."
        )
        return 1

    named = next((loc.get("name") for loc in locations if loc.get("id") == want_loc), "?")
    print(f"preflight OK: will query {want_loc} ({named}) as merchant-authorised.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
