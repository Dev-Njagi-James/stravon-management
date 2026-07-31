import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';

export interface AuthenticatedRequest extends Request {
  project_id: string;
  permissions: Record<string, string[]>;
  storage_metadata?: {
    bytes?: number;
    bytes_direction?: 'upload' | 'download';
    key?: string;
  };
  skip_call_logging?: boolean;
}

interface CacheEntry {
  projectId: string;
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
      request.permissions = cached.permissions;
      return this.checkPermission(context, request);
    }

    const { data, error } = await this.supabaseService.client
      .from('projects')
      .select('project_id, permissions')
      .eq('api_key_hash', hash)
      .single();

    if (error || !data) {
      this.cache.delete(hash);
      throw new UnauthorizedException('Invalid API key');
    }

    const projectId = data.project_id as string;
    const permissions = (data.permissions ?? {}) as Record<string, string[]>;

    // Populate cache
    this.cache.set(hash, {
      projectId,
      permissions,
      expiresAt: Date.now() + this.ttlMs,
    });

    request.project_id = projectId;
    request.permissions = permissions;
    return this.checkPermission(context, request);
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
}
