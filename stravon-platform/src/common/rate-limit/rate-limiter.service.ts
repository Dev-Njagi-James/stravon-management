import { Injectable, BadRequestException } from '@nestjs/common';

export type RateLimitTier = 'entry' | 'starter' | 'growth' | 'scale';

export interface TierConfig {
  sustained: number; // tokens added per second
  burst: number; // max bucket capacity (tokens)
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface BatchReadLimitResult {
  consumed: number; // number of tokens actually consumed (0 = none available)
  retryAfterMs?: number; // present when consumed === 0
}

interface BucketState {
  tokens: number;
  lastRefill: number; // epoch ms
}

// Hardcoded per-tier params (per Phase 4 contract 5/8/2026).
// `sustained` is the continuous refill rate in tokens/sec;
// `burst` is the token bucket max size (burst capacity).
// This is the SHARED storage+auth bucket config — used by the existing
// single-token `consumeToken` path. Do NOT modify, rename, or re-purpose.
const TIER_CONFIG: Record<RateLimitTier, TierConfig> = {
  entry: { sustained: 2, burst: 5 },
  starter: { sustained: 5, burst: 15 },
  growth: { sustained: 15, burst: 40 },
  scale: { sustained: 30, burst: 80 },
};

// Hardcoded per-tier params for the BATCH READ bucket.
// Independent of the shared storage+auth bucket above — a separate bucket with
// its own tier-scaled burst/refill values, keyed per project_id the same way.
const BATCH_READ_TIER_CONFIG: Record<RateLimitTier, TierConfig> = {
  entry: { sustained: 2, burst: 10 },
  starter: { sustained: 6, burst: 25 },
  growth: { sustained: 15, burst: 50 },
  scale: { sustained: 30, burst: 100 },
};

@Injectable()
export class RateLimiterService {
  // In-memory only by design. No Redis, no persistence.
  // Resets to full on process restart / cold start — accepted tradeoff per Phase 4 contract.
  private readonly buckets = new Map<string, BucketState>();
  // Independent batch-read bucket, keyed per project_id the same way as `buckets`.
  private readonly batchReadBuckets = new Map<string, BucketState>();

  /**
   * Attempts to consume one token from the project's SHARED bucket.
   * Refills continuously based on elapsed time (standard token bucket, not fixed window).
   *
   * @param projectId - the project's bucket key
   * @param tier - one of entry / starter / growth / scale
   * @throws BadRequestException if tier is not a known tier value
   */
  consumeToken(projectId: string, tier: string): RateLimitResult {
    const config = TIER_CONFIG[tier as RateLimitTier];

    if (!config) {
      throw new BadRequestException(
        `Unknown rate limit tier: ${tier}. Expected one of: entry, starter, growth, scale.`,
      );
    }

    const now = Date.now();
    let bucket = this.buckets.get(projectId);

    if (!bucket) {
      // New bucket starts full at burst capacity (standard token bucket).
      bucket = { tokens: config.burst, lastRefill: now };
      this.buckets.set(projectId, bucket);
    } else {
      this.refill(bucket, config, now);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Not enough tokens: compute how long until at least 1 token is available.
    const tokensNeeded = 1 - bucket.tokens;
    const tokensPerMs = config.sustained / 1000;
    const retryAfterMs = Math.ceil(tokensNeeded / tokensPerMs);

    return { allowed: false, retryAfterMs };
  }

  /**
   * Consumes up to `requestedTokens` from the project's BATCH READ bucket.
   * This is the independent, per-project bucket for POST /v1/storage/files/batch-read.
   * Uses the same continuous-refill token bucket algorithm as the shared bucket,
   * with its own tier-scaled burst/refill values.
   *
   * Returns the number of tokens actually consumed (may be less than requested
   * when the bucket has fewer than requested available but more than zero) so
   * the caller can partially serve. When zero tokens are available, returns
   * consumed: 0 and the retryAfterMs until at least 1 token refills.
   *
   * @param projectId - the project's batch-read bucket key
   * @param tier - one of entry / starter / growth / scale
   * @param requestedTokens - number of tokens the caller would like to consume (>= 1)
   * @throws BadRequestException if tier is not a known tier value
   */
  consumeBatchTokens(
    projectId: string,
    tier: string,
    requestedTokens: number,
  ): BatchReadLimitResult {
    const config = BATCH_READ_TIER_CONFIG[tier as RateLimitTier];

    if (!config) {
      throw new BadRequestException(
        `Unknown rate limit tier: ${tier}. Expected one of: entry, starter, growth, scale.`,
      );
    }

    const now = Date.now();
    let bucket = this.batchReadBuckets.get(projectId);

    if (!bucket) {
      // New bucket starts full at burst capacity (standard token bucket).
      bucket = { tokens: config.burst, lastRefill: now };
      this.batchReadBuckets.set(projectId, bucket);
    } else {
      this.refill(bucket, config, now);
    }

    const available = bucket.tokens;
    if (available <= 0) {
      // Not enough tokens: compute how long until at least 1 token is available.
      const tokensNeeded = 1 - available;
      const tokensPerMs = config.sustained / 1000;
      const retryAfterMs = Math.ceil(tokensNeeded / tokensPerMs);
      return { consumed: 0, retryAfterMs };
    }

    const consumed = Math.min(available, requestedTokens);
    bucket.tokens -= consumed;

    // If we could not fully satisfy the request (partial serve), report how
    // long until the remaining tokens refill so the caller can surface a
    // retryAfterMs alongside the rate_limit_exceeded entries.
    if (consumed < requestedTokens) {
      const remainingNeeded = requestedTokens - consumed;
      const tokensPerMs = config.sustained / 1000;
      const retryAfterMs = Math.ceil(remainingNeeded / tokensPerMs);
      return { consumed, retryAfterMs };
    }

    return { consumed };
  }

  private refill(bucket: BucketState, config: TierConfig, now: number): void {
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensPerMs = config.sustained / 1000;
    const accrued = elapsedMs * tokensPerMs;

    bucket.tokens = Math.min(config.burst, bucket.tokens + accrued);
    bucket.lastRefill = now;
  }
}
