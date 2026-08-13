# Stravon Management Platform — Project Instructions: Batch Read (StorageModule extension)

Scope of this document: batch-read only. Supplements PROJECT_INSTRUCTIONS_PHASE2.md (Phase 2 route contracts) and PROJECT_INSTRUCTIONS_PHASE4.md (rate limiting). Does not touch AuthModule, auth routes, or the existing shared storage/auth token bucket. Do not build auth-route batching from this doc — storage only.

Status: Not started. This document is the build contract before code is written, same role PROJECT_INSTRUCTIONS_PHASE2.md and PROJECT_INSTRUCTIONS_PHASE4.md served for their phases. Locked 12/8/2026.

## Why This Exists

Client apps (first: a rental platform) need to render pages with many images at once (e.g. a listing gallery). The existing `GET /v1/storage/files?key=` route handles one key per request. At entry tier's rate limits (2 req/s sustained, 5 burst), a 20-image gallery load takes several seconds of artificial waiting on top of actual download time — a real UX cost, not a hypothetical one. This route lets a client request many keys in one call instead of firing N parallel single reads.

## Design Confirmed

- **New route only. Existing five storage routes (create, complete, read, modify, delete) are unchanged** — this does not reopen or modify their contracts, confirmed against PROJECT_INSTRUCTIONS_PHASE2.md. Phase 2's "complete as of 1/8/2026" status applies to those five; this is additive scope layered on top, not a regression.
- **Auth is explicitly untouched.** The existing shared storage+auth token bucket (Phase 4, closed) is not modified, not split, not touched by this work. This route uses a **new, separate bucket** (`batchReadBucket`), additive alongside the existing one — not a replacement.
- **Max 50 keys per call**, hard limit enforced at the route, regardless of tier. Rejected with a 400-class error if exceeded.
- **Token cost: N tokens per call, N = number of keys requested** (not a flat 1-token cost). This is required — a flat cost per call would let a batch of 50 bypass rate limiting entirely relative to single reads. Charged against `batchReadBucket` only, not the existing shared bucket.
- **Partial failure is supported** at the key-resolution level. If some keys resolve and others don't (bad key, cross-project, deleted object), return partial results with per-key errors — do not fail the whole call for one bad key. A gallery should not go blank because one photo was deleted.
- **Partial serve is supported** at the rate-limit level (see "Token Bucket" below). If the batch requests more keys than the project currently has tokens for, serve as many as available tokens allow and return the remainder as per-key rate-limit errors — do not reject the whole call outright when partial capacity exists.
- **One permission check for the whole batch**, not per key. Same `project_id`/`permissions.storage.read` check as the existing `read()` route, applied once — per-key checks are redundant since prefix isolation is enforced independently (see below), and all keys in a batch belong to the same authenticated project.

## Route Contract

```
POST /v1/storage/files/batch-read
Header: x-api-key: <api_key>
Body: { keys: string[] }   (max 50 entries)
Response: {
  results: Array<
    { key: string, downloadUrl: string, publicUrl: string, filename: string }
    | { key: string, error: string }
  >
}
```

- Requires `permissions.storage.read`, same as the existing `read()` route. 403 if missing, checked once for the whole batch.
- 400 if `keys` is empty, missing, or exceeds 50 entries. **Validation happens before the rate-limit bucket check.** A request rejected at validation (empty array, >50 keys, missing body) never reaches the bucket — no tokens are consumed for a call that fails validation. Order: auth (401) → permission (403) → validation (400) → rate limit (429, see below) → key resolution.
- Each key in the array is resolved independently. A key outside the caller's own `project_id` prefix is **not** a 403 for the whole batch — it comes back as a per-key `{ key, error }` entry in `results`, same treatment as a key that doesn't exist. Prefix isolation is enforced silently per-key, not as a batch-level rejection.
- Order of `results` should match order of input `keys` (not guaranteed by any particular resolution order internally, but the response array is reordered to match input before returning).

## Token Bucket — `batchReadBucket`

Separate from the existing shared storage+auth bucket built in Phase 4. Same underlying mechanism (continuous refill, per-project, in-memory `Map`), reused via the existing `RateLimiterService` — not a new algorithm, a second bucket instance per project inside the same service.

| Tier | Batch burst | Sustained refill |
|---|---|---|
| entry | 10 | 2/s |
| starter | 25 | 6/s |
| growth | 50 | 15/s |
| scale | 100 | 30/s |

**Partial-serve model — confirmed.** Cost per call = number of keys requested, but the bucket is not all-or-nothing. If a project has fewer available tokens than keys requested, the route serves as many keys as available tokens allow (consuming all remaining tokens) and returns the rest of the requested keys as per-key errors, `{ key, error: "rate_limit_exceeded" }`, each carrying no individual `retryAfterMs` — a batch-level `retryAfterMs` is included once at the top of the response instead (see response shape below) so the client knows when the bucket will have refilled enough for the remainder.

Updated response shape to carry this:

```
Response: {
  results: Array<
    { key: string, downloadUrl: string, publicUrl: string, filename: string }
    | { key: string, error: string }
  >,
  retryAfterMs?: number   // present only if one or more keys were rate-limited; ms until enough tokens exist for at least one more key
}
```

Example: entry tier (10 burst, currently full) receives a 20-key batch. First 10 keys resolve normally (or fail with `not_found`/`cross_project` if invalid — resolution errors and rate-limit errors are both just `{ key, error }` entries, distinguished by the error string). Remaining 10 keys come back as `{ key, error: "rate_limit_exceeded" }`. Top-level `retryAfterMs` tells the client how long until the next chunk can be requested.

No batch call is ever rejected outright for insufficient tokens as long as at least one key can be served from current tokens. **Confirmed, 12/8/2026: if the bucket has zero tokens at call time, the route returns HTTP 429** — same shape as the existing single-read throttle (`{ error: "rate_limit_exceeded", retryAfterMs: number }`, `Retry-After` header set), no `results` body. This is the only case that behaves like a true rejection; every other case (1+ keys served) returns 200 with the `results`/`retryAfterMs` shape above.

`call_logs` row for a batch call that included any rate-limited keys: `status: 'throttled'` if zero keys were served, `status: 'success'` if at least one key was served (partial throttling within an otherwise-successful call is not a call-level failure — same principle as partial key-resolution failure below).

## Schema Change Required

`call_logs.storage_key` (`text`) cannot hold multiple keys. Add:

```
storage_keys   jsonb   nullable   — used only by batch-read rows; array of keys requested
```

`storage_key` (singular) remains null on batch-read rows; `storage_keys` (plural) remains null on all other action rows. Confirm actual current `call_logs` schema via Supabase directly before writing migration code — do not assume the column set from this document alone, same verification discipline used for the Phase 4 `status` column check.

One `call_logs` row per batch call, not one per key. `action: 'read'`, `bytes: null` (same as existing single-read behavior — nothing transferred, no content-length claim at this step), `storage_keys` populated with the full requested-key array (not just the served subset). `status: 'success'` if at least one key was served, whether due to per-key resolution errors or partial rate-limiting on the rest; `status: 'throttled'` only if zero keys were served due to rate limiting; `status: 'error'` reserved for failures of the batch request itself (bad auth, missing permission, malformed body/validation failure).

## Explicitly Out of Scope

- Auth-route batching — not requested, not built.
- Any modification to the existing shared storage+auth bucket — untouched.
- Any modification to the five existing storage routes (create, complete, read, modify, delete) — untouched, contracts unchanged.
- Batch-write, batch-modify, batch-delete — not requested. Read only.
- Client-side caching of returned `downloadUrl`s — separate, later concern if needed.
- Per-key rate limiting — one bucket check for the batch, not per key (the per-key partial-serve outcome is a consequence of one batch-level check, not N individual checks).

## Exit Criteria

- Route returns correct partial results for a batch containing a mix of valid, cross-project, and nonexistent keys — verified via real terminal test, not agent self-report.
- 50-key limit enforced, 51+ rejected with 400, no tokens consumed on that rejection.
- `batchReadBucket` confirmed independent of the existing shared bucket — a project that exhausts its `batchReadBucket` can still make single storage reads and auth calls without interruption, and vice versa.
- Token cost confirmed proportional to key count, not flat per call.
- Partial-serve confirmed: a batch exceeding available tokens serves the affordable subset and returns per-key rate-limit errors plus a top-level `retryAfterMs` for the rest, rather than rejecting the whole call.
- Zero-token batch confirmed to return 429 (not 200-with-all-errors), per the locked decision above.
- `call_logs` row confirmed populated with `storage_keys` array, `storage_key` null, for a real batch call — checked against raw Supabase export. `status` values (`success`/`throttled`/`error`) confirmed correct across a served batch, a partially-throttled batch, and a fully-throttled batch.
- Tier-scaled burst/refill confirmed for at least two tiers via live burst test (same pattern as Phase 4's entry-tier-only burst test — do not let this ship with only one tier exercised, unlike the current open item on Phase 4's starter/growth/scale gap).
