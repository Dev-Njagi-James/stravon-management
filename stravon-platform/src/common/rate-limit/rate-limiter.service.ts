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

interface BucketState {
  tokens: number;
  lastRefill: number; // epoch ms
}

// Hardcoded per-tier params (per Phase 4 contract 5/8/2026).
// `sustained` is the continuous refill rate in tokens/sec;
// `burst` is the token bucket max size (burst capacity).
const TIER_CONFIG: Record<RateLimitTier, TierConfig> = {
  entry: { sustained: 2, burst: 5 },
  starter: { sustained: 5, burst: 15 },
  growth: { sustained: 15, burst: 40 },
  scale: { sustained: 30, burst: 80 },
};

@Injectable()
export class RateLimiterService {
  // In-memory only by design. No Redis, no persistence.
  // Resets to full on process restart / cold start — accepted tradeoff per Phase 4 contract.
  private readonly buckets = new Map<string, BucketState>();

  /**
   * Attempts to consume one token from the project's bucket.
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

  private refill(bucket: BucketState, config: TierConfig, now: number): void {
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensPerMs = config.sustained / 1000;
    const accrued = elapsedMs * tokensPerMs;

    bucket.tokens = Math.min(config.burst, bucket.tokens + accrued);
    bucket.lastRefill = now;
  }
}
