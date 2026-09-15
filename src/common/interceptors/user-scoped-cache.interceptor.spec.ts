// src/common/interceptors/user-scoped-cache.interceptor.spec.ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserScopedCacheInterceptor } from './user-scoped-cache.interceptor';

describe('UserScopedCacheInterceptor', () => {
  let interceptor: UserScopedCacheInterceptor;
  let reflector: Reflector;
  let mockCacheManager: any;

  beforeEach(() => {
    reflector = new Reflector();
    mockCacheManager = {
      get: jest.fn(),
      set: jest.fn(),
    };
    interceptor = new UserScopedCacheInterceptor(mockCacheManager, reflector);
  });

  const createMockContext = (url: string, user?: { id: string; role: string }): ExecutionContext => {
    const mockRequest = {
      url,
      method: 'GET',
      user,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should include user ID and role in cache key for authenticated users', () => {
    const context = createMockContext('/api/v1/dashboard/summary', {
      id: 'usr_123',
      role: 'VIEWER',
    });

    // Mock super.trackBy return value
    jest.spyOn(Object.getPrototypeOf(UserScopedCacheInterceptor.prototype), 'trackBy').mockReturnValue('/api/v1/dashboard/summary');

    const cacheKey = (interceptor as any).trackBy(context);
    expect(cacheKey).toBe('/api/v1/dashboard/summary:role:VIEWER:user:usr_123');
  });

  it('should fall back to anonymous and none role if user is undefined', () => {
    const context = createMockContext('/api/v1/dashboard/summary', undefined);

    jest.spyOn(Object.getPrototypeOf(UserScopedCacheInterceptor.prototype), 'trackBy').mockReturnValue('/api/v1/dashboard/summary');

    const cacheKey = (interceptor as any).trackBy(context);
    expect(cacheKey).toBe('/api/v1/dashboard/summary:role:none:user:anonymous');
  });

  it('should return undefined if base trackBy returns undefined', () => {
    const context = createMockContext('/api/v1/dashboard/summary', {
      id: 'usr_123',
      role: 'ADMIN',
    });

    jest.spyOn(Object.getPrototypeOf(UserScopedCacheInterceptor.prototype), 'trackBy').mockReturnValue(undefined);

    const cacheKey = (interceptor as any).trackBy(context);
    expect(cacheKey).toBeUndefined();
  });

  it('should produce distinct cache keys for different users requesting the same endpoint', () => {
    const userAContext = createMockContext('/api/v1/dashboard/summary', {
      id: 'usr_alice',
      role: 'VIEWER',
    });
    const userBContext = createMockContext('/api/v1/dashboard/summary', {
      id: 'usr_bob',
      role: 'VIEWER',
    });

    jest.spyOn(Object.getPrototypeOf(UserScopedCacheInterceptor.prototype), 'trackBy').mockReturnValue('/api/v1/dashboard/summary');

    const keyAlice = (interceptor as any).trackBy(userAContext);
    const keyBob = (interceptor as any).trackBy(userBContext);

    expect(keyAlice).not.toBe(keyBob);
    expect(keyAlice).toBe('/api/v1/dashboard/summary:role:VIEWER:user:usr_alice');
    expect(keyBob).toBe('/api/v1/dashboard/summary:role:VIEWER:user:usr_bob');
  });
});
