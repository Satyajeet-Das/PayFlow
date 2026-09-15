// src/common/interceptors/user-scoped-cache.interceptor.ts
import { CacheInterceptor } from '@nestjs/cache-manager';
import { ExecutionContext, Injectable } from '@nestjs/common';

/**
 * UserScopedCacheInterceptor
 *
 * Prevents cross-user cache collisions on cached endpoints (e.g. financial dashboard).
 * Standard CacheInterceptor uses only the HTTP method + request URL as the cache key.
 * If two different users request `GET /api/v1/dashboard/summary`, they would share
 * the same Redis cache entry without user-scoping, causing severe data privacy leaks.
 *
 * This interceptor prefixes/suffixes the cache key with the authenticated user ID and role,
 * while safely falling back to 'anonymous' if no user session is present.
 */
@Injectable()
export class UserScopedCacheInterceptor extends CacheInterceptor {
  protected trackBy(context: ExecutionContext): string | undefined {
    const baseKey = super.trackBy(context);
    if (!baseKey) {
      return undefined;
    }

    const request = context.switchToHttp().getRequest();
    const userId = request?.user?.id ?? 'anonymous';
    const role = request?.user?.role ?? 'none';

    return `${baseKey}:role:${role}:user:${userId}`;
  }
}
