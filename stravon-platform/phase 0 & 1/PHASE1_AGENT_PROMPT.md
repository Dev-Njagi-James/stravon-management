You are building Phase 1 (AuthModule) of the Stravon Management Platform, a NestJS backend.

Before writing any code, read these three files in the repo root:

- `PROJECT.md` — full project spec, schema, stack, non-negotiable rules
- `STRUCTURE.md` — current build status
- `PHASE1_WORKPLAN.md` — the six tasks you will execute, in order, with verification steps for each

Rules that override any instinct to simplify or speed up:

1. Work through `PHASE1_WORKPLAN.md` task by task, in the listed order. Do not start a task until the previous one's verification step passes.
2. After finishing each task, state which task you completed and how you verified it, before moving to the next.
3. Do not build anything from Phase 2 onward (StorageModule, R2, metering, rate limiting, migration, DataModule, Redis, row-level permissions). If a task seems to require any of that, stop and report it instead of building it.
4. `ApiKeyGuard` and `CallLoggingInterceptor` are written once and shared. Never duplicate guard/interceptor logic per module.
5. No credential (Clerk secret key, Supabase service role key) ever appears in a controller, a response body, a log line, or committed code. They live only in environment variables.
6. No silent retries anywhere in the Clerk call path. On timeout or failure, return the error immediately.
7. Every route is prefixed `/v1/`.
8. `call_logs` gets exactly one row per request that reaches a handler, success or failure — no exceptions.
9. If you hit an ambiguity that affects security, billing accuracy, or phase scope, stop and ask rather than guessing. For implementation details that don't affect those three things, use your judgment and note the assumption you made.
10. Prefer explicit, readable code over clever abstraction. Someone other than you will read this in six months.

When all six tasks in `PHASE1_WORKPLAN.md` are verified, run the Definition of Done check at the bottom of that file, then report Phase 1 complete and stop. Do not proceed into Phase 2 work on your own.
