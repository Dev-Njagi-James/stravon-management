# Stravon Management Platform — Project Instructions: CDN (Cloudflare / R2 Custom Domain)

Scope of this document: CDN rollout only. Supplements PROJECT_INSTRUCTIONS.md (Phase 0/1), PROJECT_INSTRUCTIONS_PHASE2.md (Phase 2), PROJECT_INSTRUCTIONS_PHASE4.md (Phase 4). Do not build Phase 3 (metering) from this doc. Pinned as pre-Phase-6 gate per Structure doc; built ahead of Phase 3/5 per explicit reorder — Phase 3 remains the next backend-data phase after this closes.

Status: Not started. Domain (`stravontechlabs.com`) nameservers migrated to Cloudflare and confirmed active. This document is the build contract before code or dashboard config changes, same role PROJECT_INSTRUCTIONS_PHASE4.md served for Phase 4.

## Design Confirmed (from Structure doc, R2 Operations Cost Control section)

- R2 objects are served through a Cloudflare-proxied custom domain (`cdn.stravontechlabs.com`), not the raw R2 bucket URL. This is what puts Cloudflare's cache layer in the request path — reads against the raw R2 URL never touch the cache.
- Smart Tiered Cache enabled on the zone so repeat reads are served from Cloudflare's edge, not R2 origin. Goal: reduce Class B (read) operations against R2's monthly free-tier cap.
- `CacheControl: 'public, max-age=31536000, immutable'` set on every uploaded object so the edge and browser cache it permanently — one Class B read to populate cache, then zero further origin reads for that object under normal conditions.
- DNS: `cdn` record lives inside the existing `stravontechlabs.com` zone (Free plan does not support standalone subdomain zones — confirmed via Cloudflare dashboard, not assumed). Root domain and `www` (Vercel) remain DNS-only/unproxied; only `cdn` is proxied.

## Resolved Decision — Cache Invalidation (CLOSED)

**Problem:** `PATCH /v1/storage/files` (modify) performs a true in-place replace — same `key`, same `uuid`, same `publicUrl`. Combined with `immutable, max-age=31536000`, the edge has no reason to ever re-check origin for that URL. A `modify()` call is invisible to any cache that already has the old object, for up to a year. Same exposure applies to `delete()` — a deleted object may continue to serve from edge cache.

**Decision: Option A — purge-on-write.** Preserves the existing in-place-replace contract (already shipped in Phase 2 and SDK v1 — not renegotiated) and preserves the full caching benefit for the common case (objects that are never modified). Cost: one additional outbound call per modify/delete.

**Rejected alternatives:**
- Option B (modify generates a new key/uuid instead of true replace) — rejected. Breaks the already-shipped, E2E-verified Phase 2 contract and SDK v1's `modify()` behavior. Blast radius too large for the problem being solved.
- Option C (shorter max-age, drop `immutable`) — rejected. Undercuts the primary goal of this phase, which is reducing R2 Class B operations. Accepted only as a fallback if Option A proves unworkable during build.

**Implementation:** `modifyFile` and `deleteFile` handlers, after the R2 operation succeeds, call the Cloudflare cache-purge API for the exact object URL (`https://cdn.stravontechlabs.com/{key}`). Single-file purge (not full-zone purge) — do not purge the whole zone on every write, that defeats the caching benefit for every other object.

## New Infrastructure Required (flagged per execution rule 7)

- **Cloudflare API token, scoped to Cache Purge only**, for the zone `stravontechlabs.com`. Separate token from the R2-scoped token — do not reuse or widen scope of the existing R2 token. Store as `CLOUDFLARE_API_TOKEN` (or similarly named) env var, local `.env` + Render, same credential-handling pattern as `R2_ACCESS_KEY_ID` etc. Never in a repo.
- **Cloudflare Zone ID** for `stravontechlabs.com` — also needed by the purge API call, not a secret but stored as an env var (`CLOUDFLARE_ZONE_ID`) for consistency rather than hardcoded.

No new database, no new hosting provider, no new caching service beyond Cloudflare's own edge — consistent with execution rule 7.

## Build Steps

### 1. R2 Custom Domain (Cloudflare dashboard, no code)
- In the R2 bucket settings, add `cdn.stravontechlabs.com` as a Custom Domain.
- Cloudflare auto-creates the proxied DNS record inside the existing zone and provisions SSL. Confirm the record shows as Proxied (orange cloud) after creation — this differs from the A/CNAME records for the root domain and `www`, which stay DNS-only.

### 2. Smart Tiered Cache (Cloudflare dashboard, no code)
- Enable on the zone, scoped to the `cdn` hostname / R2 traffic.

### 3. Cache-Control header (code — R2 adapter)
- Add `CacheControl: 'public, max-age=31536000, immutable'` to the presign parameters in `createFile` and `modifyFile`. Do not add to `readFile` or `deleteFile` — nothing is being cached-in on those actions.

### 4. `publicUrl` generation (code — R2 adapter)
- Rebuild `publicUrl` to use `https://cdn.stravontechlabs.com/{key}` instead of the current raw R2/account-id URL. Applies everywhere `publicUrl` is constructed: `createFile`, `modifyFile`, and anywhere else it's returned (`completeUpload` response, if applicable — confirm against actual source before editing, do not assume every handler builds it the same way).

### 5. Cache purge on write (code — R2 adapter)
- `modifyFile`: after the R2 PUT-target presign succeeds and the object is confirmed replaced (i.e., at the same point the existing modify flow currently completes), call Cloudflare's purge-by-URL endpoint for `https://cdn.stravontechlabs.com/{key}`.
- `deleteFile`: after the R2 delete succeeds, same purge call for the same URL.
- No silent retry on purge failure, per execution rule 2. If purge fails, log it and return the normal success response for the underlying R2 operation — a failed purge is a cache-staleness risk, not a failed delete/modify, and should not block or roll back the operation that already succeeded against R2. Flag this behavior explicitly in code comments so it isn't mistaken for a swallowed error later.

## Explicitly Out of Scope

- Phase 3 (Metering) — do not begin aggregation work from this doc.
- Full-zone cache purge — single-URL purge only, per the invalidation decision above.
- Security/Performance one-click features surfaced in the Cloudflare dashboard (Bot Fight Mode, Client-side security, Speed optimizations, Leaked credentials mitigation) — unrelated to R2/CDN delivery, explicitly left off.
- Root domain / `www` proxying — stays DNS-only, unrelated to this phase, not to be changed here.
- Download-side cache metrics or reporting — not part of this build; if usage reporting on cache hit/miss becomes a future need, it is a Phase 3+ concern.

## Exit Criteria (confirm before closing)

- `cdn.stravontechlabs.com` resolves and serves R2 objects, proxied through Cloudflare, SSL valid.
- Smart Tiered Cache confirmed enabled on the zone.
- `Cache-Control` header confirmed present on newly uploaded objects (verify via response headers on a direct request, not assumed from code review alone).
- `publicUrl` in API responses confirmed pointing to the `cdn.stravontechlabs.com` domain, not the raw R2 URL, across create/modify (and complete, if applicable).
- Cache-purge verified end-to-end: upload an object, read it (populates edge cache), modify it, immediately re-read the same URL, confirm new content is returned — not stale. Repeat for delete: upload, read (cache populated), delete, immediately re-request, confirm object is gone (404/expected error), not served stale from edge.
- Verified via real terminal/browser requests against the live domain, not agent self-report, per established verification pattern.
- Root domain and `www` traffic confirmed unaffected — Vercel frontend still resolves and serves correctly through the same Cloudflare zone.
