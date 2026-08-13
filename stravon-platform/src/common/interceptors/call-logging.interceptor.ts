import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { SupabaseService, CallLogEntry } from '../supabase/supabase.service';
import { AuthenticatedRequest } from '../guards/api-key.guard';

interface PermissionMetadata {
  service: string;
  action: string;
}

@Injectable()
export class CallLoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const startTime = Date.now();

    const permissionMetadata = this.reflector.get<
      PermissionMetadata | undefined
    >('permission', context.getHandler());

    const service = permissionMetadata?.service ?? 'auth';
    const action = permissionMetadata?.action ?? 'unknown';

    return next.handle().pipe(
      tap(() => {
        const latencyMs = Date.now() - startTime;
        this.logCall(request, service, action, 'success', latencyMs).catch(
          (err: unknown) =>
            console.error('CallLoggingInterceptor: failed to log success', err),
        );
      }),
      catchError((error: unknown) => {
        const latencyMs = Date.now() - startTime;
        this.logCall(request, service, action, 'error', latencyMs).catch(
          (err: unknown) =>
            console.error('CallLoggingInterceptor: failed to log error', err),
        );
        return throwError(() => error);
      }),
    );
  }

  private async logCall(
    request: AuthenticatedRequest,
    service: string,
    action: string,
    status: 'success' | 'error',
    latencyMs: number,
  ): Promise<void> {
    if (request.skip_call_logging) {
      return;
    }

    if (!request.project_id) {
      return;
    }

    const insertBody: CallLogEntry = {
      project_id: request.project_id,
      service,
      action,
      status,
      latency_ms: latencyMs,
    };

    // Populate bytes/bytes_direction for storage routes
    if (request.storage_metadata) {
      if (request.storage_metadata.bytes !== undefined) {
        insertBody.bytes = request.storage_metadata.bytes;
      }
      if (request.storage_metadata.bytes_direction !== undefined) {
        insertBody.bytes_direction = request.storage_metadata.bytes_direction;
      }
      if (request.storage_metadata.key !== undefined) {
        insertBody.storage_key = request.storage_metadata.key;
      }
      // Batch-read rows carry the FULL requested-key array in storage_keys,
      // not a single storage_key. Present only on the batch-read route.
      if (request.storage_metadata.keys !== undefined) {
        insertBody.storage_keys = request.storage_metadata.keys;
      }
    }

    await this.supabaseService.insertCallLog(insertBody);
  }
}
