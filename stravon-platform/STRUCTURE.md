# Stravon Management Platform — Structure

Last updated: 2026-07-16

This file tracks **where the project is right now** and **where it's going next**. Read `PROJECT.md` first for full context; this file is the status layer on top of it.

## Where We Are: Phase 0 — Setup

| Item                                                                        | Status                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| NestJS project initialized                                                  | Done                                                |
| Repo pushed to GitHub (`stravon-management`, nested at `stravon-platform/`) | Done                                                |
| Render Web Service, Root Directory set to `stravon-platform`                | Done                                                |
| Empty app deployed, live at `stravon-management.onrender.com`               | Done                                                |
| Supabase project created                                                    | Done                                                |
| `projects` table (renamed from `projects_table`)                            | Done                                                |
| `call_logs` table created, FK to `projects` confirmed                       | Done                                                |
| `project_users` table created (maps Clerk user → owning project)            | Open — new item, added for user-ownership isolation |
| `SUPABASE_URL` set (local + Render)                                         | Done                                                |
| `SUPABASE_SERVICE_ROLE_KEY` set (local + Render)                            | Done                                                |
| `.gitignore` excludes `.env*`                                               | Open — currently only `.env`, missing the wildcard  |
| `CLERK_SECRET_KEY` set (local + Render)                                     | Done                                                |
| `CLERK_PUBLISHABLE_KEY` set (local + Render)                                | Done                                                |

### Open item: `.gitignore` wildcard

Current line is `.env`, which only matches that exact filename. Any variant (`.env.local`, `.env.production`, etc.) would get committed to GitHub, including whatever secrets they hold. Change to `.env*`, commit, push. This is the last item blocking Phase 0 close-out.

### Phase 0 close-out condition

Phase 0 is complete once the `.gitignore` fix above is pushed. Table naming is resolved, Supabase and Clerk credentials are in place (local + Render). No other blockers remain.

## Where We're Going: Phase 1 — AuthModule

Build order:

1. **`ApiKeyGuard`** — reads API key from request header, hashes it, looks up `projects` by `api_key_hash`, attaches `project_id` + `permissions` to the request object. 401 if no match. 403 if the requested action isn't in `permissions.auth`.
2. **`CallLoggingInterceptor`** — applied globally (not per-module). After every request completes (success or error), inserts one row into `call_logs` with `project_id`, `service`, `action`, `status`, `latency_ms`.
3. **Clerk adapter** — wraps Clerk's backend SDK. Secret key never leaves this adapter.
4. **Routes** under `/v1/auth/*`:
   - `GET /v1/auth/users/:id` → `read`
   - `POST /v1/auth/users` → `create`
   - `PATCH /v1/auth/users/:id` → `modify`
   - `DELETE /v1/auth/users/:id` → `delete`
   - `POST` also inserts into `project_users`. `GET`/`PATCH`/`DELETE` must verify the `clerk_user_id` belongs to the calling project via `project_users` before proceeding.
5. **In-process permission cache** — 60s TTL, in-memory only, no Redis.
6. **Timeout/failure handling** — 5s hard timeout on every Clerk call, no retries, immediate error return on failure.

## After Phase 1

Not started, not to be built until explicitly instructed:

- Phase 2 — StorageModule (Cloudflare R2)
- Phase 3 — Metering against pricing tiers
- Phase 4 — Rate limiting
- Phase 5 — Migrate the first client app onto the platform
- Phase 6 (deferred) — DataModule / Redis
- Phase 7 (deferred) — Row-level permission granularity

See `PROJECT.md` for full phase rationale and dependencies.
