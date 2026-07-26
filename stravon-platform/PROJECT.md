# Stravon Management Platform — Project Reference

This is the full context for this project. Read this before writing any code. See `STRUCTURE.md` for current build status and immediate next steps.

## What This Platform Is

A shared infrastructure-authority backend for Stravon Tech Labs. Client apps stop calling Cloudflare R2 or Clerk directly — they call this platform, and the platform calls those services on their behalf. This gives Stravon one place to control access, log every call, meter usage against pricing tiers, and add or remove services without touching client apps.

First consumer: an existing client app currently on Cloudinary and Supabase Auth, migrating to R2 and Clerk through this platform once Phases 1-5 are solid. Do not build for a hypothetical second client yet — the schema supports one (`project_id` on every table, `category` field distinguishing single-client vs. SaaS-tenant projects), but no code should assume a second project exists yet.

## Scope Boundary

**This build is scoped to Phase 0 and Phase 1 only.** Do not build Phase 2 onward (StorageModule, metering, rate limiting, migration, DataModule, Redis, row-level permissions) until explicitly instructed. If a task seems to require any of these, stop and flag it rather than building it.

## Stack (fixed — do not substitute)

- **Framework:** NestJS (TypeScript)
- **Database:** Supabase (Postgres) — a dedicated Supabase project for this platform, separate from any client app's own database
- **Hosting:** Render, free tier now → Starter ($7/mo) once the platform serves real user traffic
- **Auth provider being wrapped:** Clerk
- **Storage provider being wrapped:** Cloudflare R2 (Phase 2 — not built yet)
- **Repo:** GitHub, `stravon-management`, NestJS app nested inside `stravon-platform/`
- **Cache:** In-process memory cache only (permissions lookup). No Redis until Phase 6 (deferred).

## Architecture

**Core building blocks:**

- **Modules** — one per external service (`AuthModule`, `StorageModule` later, `DataModule` deferred). Each is independently removable; deleting one module's files should not break another module's code except through the shared guard/interceptor.
- **Guard** (`ApiKeyGuard`) — validates each incoming request's API key, resolves it to a `project_id`, checks that project's permissions before any handler runs. Written once, shared across every module.
- **Interceptor** (`CallLoggingInterceptor`) — logs every request (project, service, action, status, latency, bytes) after the guard passes, regardless of which module handled it. Written once, applied globally.
- **Adapters** — one per external provider (Clerk adapter, later R2 adapter). Client apps never see these directly.

## Database Schema

Platform database is a **dedicated Supabase project**, separate from any client app's own database. Never mix platform data with client app business data.

### `projects` table

| Column       | Type      | Notes                                            |
| ------------ | --------- | ------------------------------------------------ |
| project_id   | uuid, PK  |                                                  |
| name         | text      |                                                  |
| owner        | text      |                                                  |
| category     | text      | `'single_client'` or `'saas_tenant'`             |
| tier         | text      | `'entry'` / `'starter'` / `'growth'` / `'scale'` |
| permissions  | jsonb     | see Permissions Model below                      |
| api_key_hash | text      | store a hash, never the raw key                  |
| created_at   | timestamp | default now()                                    |

### `call_logs` table

| Column          | Type                | Notes                                           |
| --------------- | ------------------- | ----------------------------------------------- |
| project_id      | uuid, FK → projects |                                                 |
| service         | text                | `'storage'` / `'auth'` / `'db'`                 |
| action          | text                | `'read'` / `'create'` / `'modify'` / `'delete'` |
| status          | text                | `'success'` / `'error'`                         |
| latency_ms      | integer             |                                                 |
| bytes           | integer             | nullable, storage calls only                    |
| bytes_direction | text                | `'upload'` / `'download'`, nullable             |
| created_at      | timestamp           | default now()                                   |

`call_logs` is not just an audit trail — it's the source data for per-project storage metering (Phase 3) and usage numbers on a client app's own admin dashboard.

### `project_users` table

Maps a Clerk user record to the project that owns it. Without this, any project's API key could read/update/delete any other project's user by guessing a Clerk `user_id` — there is no ownership boundary otherwise.

| Column        | Type                | Notes                                                                                               |
| ------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| id            | uuid, PK            | default gen_random_uuid()                                                                           |
| project_id    | uuid, FK → projects | which project owns this user                                                                        |
| clerk_user_id | text                | Clerk's own user id                                                                                 |
| app_metadata  | jsonb, nullable     | per-project extra fields (role, tier, custom access levels) — never touches Clerk's own user object |
| created_at    | timestamp           | default now()                                                                                       |

Unique constraint on `(project_id, clerk_user_id)` — one mapping per user per project.

Every Phase 1 user route (`GET/POST/PATCH/DELETE /v1/auth/users/:id`) must check this table: does the `clerk_user_id` in the request belong to the `project_id` resolved from the API key? If not, reject (403/404) — do not trust the URL param alone.

## Permissions Model

Stored as JSONB on `projects.permissions`. Not a separate relational table — unnecessary overhead at current scale.

```json
{
  "storage": ["read", "create", "modify", "delete"],
  "auth": ["read"],
  "db": []
}
```

| Service    | Read               | Create        | Modify              | Delete        |
| ---------- | ------------------ | ------------- | ------------------- | ------------- |
| Storage    | Download/view file | Upload file   | Replace/rename file | Delete file   |
| Auth       | Read user data     | Create user   | Update user profile | Delete user   |
| DB (later) | Query record       | Insert record | Update record       | Delete record |

**Do not build row-level (authenticated vs. non-authenticated user) granularity** — that's deferred until a second project's requirements demand it.

Match verb semantics per service — Read/Create/Modify/Delete mean different concrete operations for Storage vs. Auth vs. DB. Don't reuse Storage's file-upload logic as a template for Auth's user-creation logic; they're structurally different even though the verb is the same.

## Phase 1 — AuthModule (current build target)

1. **`ApiKeyGuard`**: reads API key from request header → hashes it → looks up `projects` by `api_key_hash` → attaches `project_id`/`permissions` to the request. 401 on no match. 403 if the requested action isn't in `permissions.auth`.
2. **`CallLoggingInterceptor`**: wraps every request. After the handler completes (success or error), inserts one row into `call_logs`. Applied globally, not per-module.
3. **Clerk adapter**: wraps Clerk's backend SDK. Never expose Clerk's SDK or secret key outside this adapter.
4. **Routes**, all under `/v1/auth/*`:
   - `GET /v1/auth/users/:id` → `read`
   - `POST /v1/auth/users` → `create`
   - `PATCH /v1/auth/users/:id` → `modify`
   - `DELETE /v1/auth/users/:id` → `delete`
   - `POST` inserts a `project_users` row (`project_id`, `clerk_user_id`) alongside the Clerk create call. `GET`/`PATCH`/`DELETE` must first confirm the `clerk_user_id` in the URL belongs to the calling project's `project_id` via `project_users` — reject with 403/404 if it doesn't.
5. **In-process permission cache**: cache each project's `permissions` in memory, TTL 60s. No external cache service.
6. **Timeouts/failure handling**: 5s hard timeout on every Clerk call. On timeout or error, return a clear error immediately — no retries.

## Non-Negotiable Rules

1. **No credential ever leaves the backend.** Clerk's secret key and R2's scoped token live only in environment variables on the hosting platform. Never in a repo, response body, or log. Only Clerk's publishable key is safe to expose to any frontend.
2. **No silent retries on upstream failures.** If Clerk or R2 fails or times out, return the error to the caller immediately.
3. **Every route is versioned.** `/v1/...` from the first route, no exceptions. Breaking changes ship as `/v2/...` alongside a still-working `/v1/...`.
4. **The guard and interceptor are shared, not duplicated per module.**
5. **`call_logs` gets exactly one row per request that reaches a handler**, success or failure. It's the metering system's only data source.
6. **Don't build ahead of the current phase.** Flag Phase 2+ work instead of building it speculatively.
7. **Don't introduce infrastructure not already decided.** No new database, no new hosting provider, no caching service beyond the in-process memory cache. Flag it if something seems to need new infra.
8. **Match permissions verb semantics per service** (see table above).

## Credential Storage

- Cloudflare R2: bucket-scoped API token only, never the global account key.
- Clerk: secret key stays server-side only; publishable key is the sole Clerk credential any client-facing code ever sees.
- Both stored as encrypted environment variables on the hosting platform (Render) — never committed to a repo, never stored in Supabase.
- `.gitignore` must exclude `.env*` (wildcard) in every repo touching this platform.
- Rotate both keys once live — any key present during early testing should be treated as potentially exposed.

## Hosting

| Component              | Where                                                     | Notes                                                                  |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| NestJS backend         | Render (free tier now → Starter $7/mo at upgrade trigger) | Always-on eventually — client apps depend on this synchronously        |
| Platform database      | Supabase (free tier)                                      | Separate project from any client app's own Supabase instance           |
| File storage (Phase 2) | Cloudflare R2                                             | Single bucket, prefix-isolated per project                             |
| Client app frontend    | Vercel (separate deployment)                              | Calls the platform backend via API key — never calls R2/Clerk directly |

**Render free tier limits:** 750 free instance-hours/month, 100GB outbound bandwidth/month shared across workspace. Free web services spin down after 15 min inactivity (30-60s cold start on next request). Exceeding limits suspends free services until next calendar month — no charge unless a payment method is on file and bandwidth is exceeded.

**Upgrade trigger:** move to Render Starter ($7/mo) the moment the platform serves real user traffic through the migrated client app — not tied to revenue.

## Full Build Phases (reference — only Phase 0/1 in scope now)

| Phase        | Scope                                                                                                  | Depends On                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 0            | Schema finalized, Supabase project created, secrets set, empty app deployed                            | —                                                               |
| 1            | AuthModule: guard, Clerk adapter, `/v1/auth/*`, call logging                                           | Phase 0                                                         |
| 2            | StorageModule: R2 adapter, prefix isolation, `/v1/storage/*`, byte + direction logging                 | Phase 0, reuses Phase 1's guard/interceptor                     |
| 3            | Metering: sum `call_logs.bytes` per project against pricing tiers, 80/90/100% thresholds, overage calc | Phase 2                                                         |
| 4            | Rate limiting: per-project token bucket scaled by tier                                                 | Phase 1-2                                                       |
| 5            | In-process permission cache added to the guard                                                         | Phase 1                                                         |
| 6            | Migrate the first client app off Cloudinary and Supabase Auth                                          | Phases 1-5 complete and tested                                  |
| 7            | Upgrade Render to Starter tier                                                                         | Triggered by real user traffic, independent of phase completion |
| 8 (deferred) | DataModule — Railway Postgres/Redis for client-managed databases and real caching                      | Not started until a project needs it                            |
| 9 (deferred) | Row-level permission granularity                                                                       | Only when a second project requires it                          |

Phases 1 and 2 can build in parallel once Phase 0 is locked — they share the guard/interceptor but touch different adapters. Phase 6 does not start before 1-5 are solid — the platform's only production client depends on metering and rate limiting already working correctly.

## Tenant Model

Single active project today (`category: single_client`), but the schema and permissions model are multi-tenant from day one. The pricing structure (Entry/Starter/Growth/Scale) is already built around per-client billing — the platform is built to serve additional projects, including SaaS-style multi-tenant products, without a schema rewrite when the next client is onboarded.

## Working Style

- Flag ambiguity rather than guessing silently when it affects security, billing accuracy, or phase scope. Proceed on judgment for implementation details that don't affect those three things.
- Prefer explicit code over clever abstraction. This platform will be read and extended by a small team — optimize for someone else understanding it in six months, not for minimizing line count.
- Every module should be independently removable.
