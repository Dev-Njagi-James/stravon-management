import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

export interface AuthenticatedRequest extends Request {
  project_id: string;
  tier: string;
  permissions: Record<string, string[]>;
  storage_metadata?: {
    bytes?: number;
    bytes_direction?: 'upload' | 'download' | 'delete';
    key?: string;
  };
  skip_call_logging?: boolean;
}

interface CacheEntry {
  projectId: string;
  tier: string;
  permissions: Record<string, string[]>;
  expiresAt: number;
}

interface PermissionMetadata {
  service: string;
  action: string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 60_000;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly reflector: Reflector,
    private readonly rateLimiterService: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    const hash = createHash('sha256').update(apiKey).digest('hex');

    // Check cache first
    const cached = this.cache.get(hash);
    if (cached && Date.now() < cached.expiresAt) {
      request.project_id = cached.projectId;
      request.tier = cached.tier;
      request.permissions = cached.permissions;
      this.checkPermission(context, request);
      return this.checkRateLimit(request);
    }

    const { data, error } = await this.supabaseService.client
      .from('projects')
      .select('project_id, tier, permissions')
      .eq('api_key_hash', hash)
      .single();

    if (error || !data) {
      this.cache.delete(hash);
      throw new UnauthorizedException('Invalid API key');
    }

    const projectId = data.project_id as string;
    const tier = data.tier as string;
    const permissions = (data.permissions ?? {}) as Record<string, string[]>;

    // Populate cache
    this.cache.set(hash, {
      projectId,
      tier,
      permissions,
      expiresAt: Date.now() + this.ttlMs,
    });

    request.project_id = projectId;
    request.tier = tier;
    request.permissions = permissions;
    this.checkPermission(context, request);
    return this.checkRateLimit(request);
  }

  private checkPermission(
    context: ExecutionContext,
    request: AuthenticatedRequest,
  ): boolean {
    const permissionMetadata = this.reflector.get<
      PermissionMetadata | undefined
    >('permission', context.getHandler());

    if (!permissionMetadata) {
      // No @RequirePermission on this route — allow through
      return true;
    }

    const { service, action } = permissionMetadata;
    const allowedActions = request.permissions[service];

    if (!allowedActions || !allowedActions.includes(action)) {
      throw new ForbiddenException(
        `Missing required permission: ${service}.${action}`,
      );
    }

    return true;
  }

  private checkRateLimit(request: AuthenticatedRequest): boolean {
    const result = this.rateLimiterService.consumeToken(
      request.project_id,
      request.tier,
    );

    if (result.allowed) {
      return true;
    }

    const retryAfterSec = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    request.res?.setHeader('Retry-After', String(retryAfterSec));

    throw new HttpException(
      { error: 'rate_limit_exceeded', retryAfterMs: result.retryAfterMs },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
