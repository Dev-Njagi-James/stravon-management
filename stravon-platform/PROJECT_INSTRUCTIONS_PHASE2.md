# Stravon Management Platform — Project Instructions: Phase 2 (StorageModule)

Scope of this document: Phase 2 only. Supplements PROJECT_INSTRUCTIONS.md (Phase 0/1). Do not build Phase 3+ (metering, rate limiting) from this doc.

Status: All route contracts confirmed against running source and verified via direct E2E test scripts (test/ folder) against live R2 + Supabase, 31/7/2026. Previous `???` and `[ ]` placeholders resolved below.

## Design Confirmed

Zero-byte proxying. Render/Nest backend never touches file bytes. The backend issues presigned R2 URLs; the client (or client-app SDK) transfers bytes directly against R2/Cloudflare CDN. This is the cost-control mechanism — see Structure doc, "R2 Operations Cost Control," item 1.

**Confirmed constraint:** R2's presigned URLs sign `Content-Length` into the request (`X-Amz-SignedHeaders=content-length`). A PUT with a byte count different from the size declared at presign time is rejected by R2 with 403 before any bytes are written. This is enforced at the R2 layer, not the platform layer — the platform does not need to separately validate declared-vs-actual size at PUT time, because a mismatch cannot physically succeed.

## Route Contract (confirmed against src/storage/storage.controller.ts)

All routes require header `x-api-key: <api_key>`.

### POST /v1/storage/files (upload — create)

```
Body: { filename: string, contentType: string, fileSize?: number }
Response: { uploadUrl: string, publicUrl: string, key: string, uuid: string, filename: string }
```

`key` is server-generated as `{project_id}/uploads/{uuid}`. Client-supplied filename is never used as the storage key — only stored as R2 object metadata (`x-amz-meta-originalfilename`).

Byte-count capture method — **RESOLVED: Option A rejected. Completion-callback route adopted.**

`call_logs.bytes` is written at presign time using the client-declared `fileSize` (or `undefined`/null if omitted). This value is provisional and unverified until `/complete` is called — see "Known Gap" below.

### POST /v1/storage/files/complete (completion callback)

```
Body: { key: string }
Response: { verified: boolean, bytes: number }
```

Client calls this after the R2 PUT succeeds. Confirmed via E2E test: `bytes` returned matches actual R2 object content-length. Links to the original `call_logs` row by `project_id` + `storage_key` (not recency), preventing race conditions under concurrent uploads from the same project. Sets `skip_call_logging` to avoid a duplicate `call_logs` row for this call.

**Confirmed: `/complete` does not correct `call_logs.bytes` on the original `create` row after the fact** — the `create` row's `bytes` value remains whatever was declared at presign time. `/complete`'s own `{verified, bytes}` response is the authoritative check; it is not currently written back into the `create` row. (Flagged below as an open item — worth deciding whether this should update the original row or is fine as a separate signal.)

### GET /v1/storage/files (download — read)

```
Query param: ?key={key}   (NOT a path param — see note below)
Response: { downloadUrl: string, publicUrl: string, key: string, filename: string }
```

### PATCH /v1/storage/files (modify — replace)

```
Query param: ?key={key}
Body: { contentType: string, fileSize?: number }
Response: { uploadUrl: string, publicUrl: string, key: string, uuid: string, filename: string }
```

**Status: BUILT.** Confirmed via E2E test — PATCH returns the SAME key/uuid as the target (true in-place replace, not a new upload). Client PUTs new bytes to the returned `uploadUrl` exactly as with the create flow. Verified: old content is overwritten in place at the same R2 key; no orphaned duplicate object is left behind.

### DELETE /v1/storage/files (delete)

```
Query param: ?key={key}
Response: { success: boolean, key: string }
```

## Route Parameter Note — Express 5 / path-to-regexp v8

**Confirmed platform-wide:** GET, PATCH, and DELETE all use `@Query('key')`, not `:key` path params. This was required because Express 5's `path-to-regexp` v8 changed wildcard/multi-segment matching semantics — a key like `{project_id}/uploads/{uuid}` contains `/` and cannot be matched as a single `:key` path segment under the new library version. This is a fixed, confirmed pattern across all storage routes — do not revert to path params in any future route on this module.

## Prefix Isolation (unchanged from Structure doc)

All keys forced to `{project_id}/uploads/{filename}` server-side. Client-supplied paths never used as-is. project_id resolved from ApiKeyGuard, not from client input. Cross-project access confirmed rejected (403) via E2E test.

## Logging

Every route above still produces exactly one call_logs row via the shared CallLoggingInterceptor.

**Fixed 1/8/2026 — all four storage actions now populate `storage_key` correctly.**

The interceptor reads `bytes`, `bytes_direction`, and `storage_key` from `request.storage_metadata`, which each handler must set before the interceptor fires — the interceptor does not compute these values itself (confirmed against `src/common/interceptors/call-logging.interceptor.ts`). `readFile`, `modifyFile`, and `deleteFile` originally omitted `key` from that object; only `createFile` set it. Fixed by adding `key` to each handler's `storage_metadata` assignment. `deleteFile` also now sets `bytes_direction: 'delete'` (no CHECK constraint on this column in Supabase — confirmed safe).

Verified via a single-key lifecycle test (create → read → modify → delete, log_id 45–48): the same key is now traceable across all four `call_logs` rows.

| Action | `bytes` | `bytes_direction` | `storage_key` |
|---|---|---|---|
| create | populated (client-declared at presign time, unverified) | 'upload' | populated |
| modify (PATCH) | populated | 'upload' | populated |
| read (download) | null (by design — see below) | 'download' | populated |
| delete | null (by design — see below) | 'delete' | populated |

**`bytes` remaining null on read and delete is accepted, not a gap.** Nothing is transferred or declared by the client at those steps — a presigned GET/DELETE carries no content-length claim to log. If accurate download-byte metering becomes necessary for Phase 3 billing, that requires a separate completion-callback pattern for downloads (mirroring `/complete` for uploads), since the only place that number exists is in R2's response headers on the direct client-to-R2 GET, which never touches this backend. Not built, not decided as needed — flagged only.

## Confirmed Failure-Mode Behavior (tested 31/7/2026)

**Abandoned upload** (POST called, presigned URL never used, R2 never written to): `call_logs` records a `create` row with `status: success` and `bytes` equal to the client-declared value — indistinguishable from a real upload by looking at `call_logs` alone. R2 has nothing at that key. Confirmed reproducible.

**Orphaned upload** (POST called, PUT to R2 succeeds, `/complete` never called): R2 has a real object. `call_logs` row remains whatever was declared at presign time, never corrected, since only `/complete` performs verification and nothing currently forces a client to call it. Confirmed reproducible.

**Not possible:** a PUT succeeding with a byte count different from what was declared at presign time — R2's signed `Content-Length` header blocks this structurally with a 403.

**Known longer-term gap, unchanged from prior status:** no mechanism currently tracks "presigned but never completed" uploads. Quiet drift between R2 and `call_logs` is possible whenever a client skips or fails to reach `/complete`. Not in scope for Phase 2 — flagged for a future phase.

## Open Items

1. `/complete` does not write its verified `bytes` back into the original `create` row — decide if this should happen before Phase 3 metering.
2. No mechanism tracks abandoned/orphaned uploads for reconciliation — deferred, not Phase 2 scope.
3. Leftover test projects (`test-projecta`, `test-projectb`) in production `projects` table — flagged for deletion, unrelated to route contracts.
4. Download-side `bytes` metering (if needed for Phase 3 billing) requires a separate completion-callback pattern — not built, not yet decided as necessary.

Phase 2 is complete as of 1/8/2026. This document reflects the actual current codebase and E2E-verified behavior. Supersedes all prior `???`/`[ ]` placeholders.
