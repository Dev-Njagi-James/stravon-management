import { SetMetadata } from '@nestjs/common';

export const SKIP_SHARED_RATE_LIMIT_KEY = 'skipSharedRateLimit';

/**
 * Marks a route so the global ApiKeyGuard skips consuming a token from the
 * SHARED storage+auth bucket for that request. The guard still performs API-key
 * auth (401) and any @RequirePermission check (403). The route is then
 * responsible for its own rate-limit enforcement (e.g. the batch-read route
 * checks the independent batchReadBucket after validating its body).
 *
 * Existing routes WITHOUT this decorator keep the exact current behavior.
 */
export const SkipSharedRateLimit = () =>
  SetMetadata(SKIP_SHARED_RATE_LIMIT_KEY, true);
