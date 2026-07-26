# Phase 1 — Work Plan

Reference `PROJECT.md` for full spec, `STRUCTURE.md` for current status. This breaks Phase 1 into sequential tasks. Each task has a single deliverable and a verification step — don't start the next task until the current one verifies.

## Task 1 — ApiKeyGuard

**Build:** `src/common/guards/api-key.guard.ts`

- Reads API key from request header (define header name, e.g. `x-api-key`)
- Hashes the incoming key (same hash method used to produce `api_key_hash` at project creation)
- Looks up `projects` by `api_key_hash`
- On match: attaches `project_id` and `permissions` to the request object
- On no match: throws 401
- Does NOT check the specific action/permission yet — that's enforced per-route in Task 4, or as a second check inside this guard if you want it centralized (agent's implementation choice, flag if unsure)

**Verify:** unit test or manual call with a valid key (200-path reaches handler), invalid key (401), no key header (401).

**Depends on:** nothing — can start immediately, no Clerk needed yet.

## Task 2 — CallLoggingInterceptor

**Build:** `src/common/interceptors/call-logging.interceptor.ts`

- Applied globally in `main.ts` or `AppModule`, not per-module
- Wraps every request; runs after guard passes
- On response (success or error), inserts one row into `call_logs`: `project_id`, `service`, `action`, `status`, `latency_ms`
- Must not throw or block the response if the log insert itself fails — log the failure to console, don't crash the request

**Verify:** hit any route, confirm exactly one new row appears in `call_logs` with correct `project_id` and `latency_ms`. Force an error response, confirm a row is still logged with `status: error`.

**Depends on:** Task 1 (needs `project_id` attached to request by the guard).

## Task 3 — Clerk adapter

**Build:** `src/auth/adapters/clerk.adapter.ts`

- Wraps Clerk's backend SDK
- Exposes only the methods AuthModule needs: get user, create user, update user, delete user
- `CLERK_SECRET_KEY` is read here only — never passed to controllers, never logged, never in a response body
- No business logic beyond calling Clerk and returning/normalizing the result

**Verify:** call each adapter method directly (script or test), confirm it reaches Clerk and returns expected shape. Confirm secret key never appears in any log output.

**Depends on:** nothing structurally, but no reason to build before Task 1/2 exist since routes need the guard/interceptor wired first.

## Task 4 — Routes (`/v1/auth/*`)

**Build:** `src/auth/auth.controller.ts`, `src/auth/auth.module.ts`

- `GET /v1/auth/users/:id` → calls adapter, action = `read`
- `POST /v1/auth/users` → action = `create`
- `PATCH /v1/auth/users/:id` → action = `modify`
- `DELETE /v1/auth/users/:id` → action = `delete`
- Each route checks `request.permissions.auth` includes the mapped action → 403 if not (if not already handled in Task 1)
- `AuthModule` applies `ApiKeyGuard` (or confirms it's global) and uses the Clerk adapter — controller has no direct Clerk SDK usage
- **Ownership check via `project_users`:** `POST` creates the Clerk user, then inserts a row into `project_users` (`project_id`, `clerk_user_id`). `GET`/`PATCH`/`DELETE` must first query `project_users` to confirm the `clerk_user_id` in the URL belongs to the calling project's `project_id` — reject with 403/404 before calling the Clerk adapter if it doesn't match. This prevents one project from reading/modifying/deleting another project's user by guessing an id.

**Verify:** hit all four routes with a project that has full `auth` permissions (200s), then with a project whose `permissions.auth` is `[]` (403s). Additionally: create a user under Project A, then attempt `GET`/`PATCH`/`DELETE` on that same `clerk_user_id` using Project B's API key — confirm rejection.

**Depends on:** Tasks 1, 2, 3, and the `project_users` table existing (Phase 0).

## Task 5 — In-process permission cache

**Build:** cache layer inside or alongside `ApiKeyGuard`

- Cache `project_id → permissions` in memory, 60s TTL
- Guard checks cache first; falls back to Supabase query on miss or expiry, then repopulates cache
- No external cache service, no Redis

**Verify:** confirm via logging/breakpoint that a second request within 60s for the same project does not hit Supabase. Confirm a request after 60s does.

**Depends on:** Task 1 (modifies the guard).

## Task 6 — Timeout and no-retry handling on Clerk calls

**Build:** inside the Clerk adapter (Task 3)

- Every Clerk call wrapped with a 5s hard timeout
- On timeout or any Clerk error: return a clear error immediately, no retry logic anywhere in the call path

**Verify:** simulate a slow/failing Clerk response (mock or intentionally bad key), confirm the request fails fast (~5s max) with a clear error, and confirm `call_logs` still gets a row with `status: error` (Task 2 still fires).

**Depends on:** Task 3. Can be built as part of Task 3 directly rather than a separate pass — agent's choice, but must be done before Task 4 is considered complete.

## Definition of Done for Phase 1

All six tasks verified. Full round-trip check: valid API key → hits a `/v1/auth/*` route → Clerk adapter responds → `call_logs` gets exactly one row → response returned to caller. Run this for all four routes before declaring Phase 1 closed.

Do not start Phase 2 (StorageModule) work after this — stop and report Phase 1 complete.
