import { createHash } from 'node:crypto';
import { UpstreamError } from './upstream.js';

export interface Principal {
  kind: 'service' | 'matrix' | 'oidc';
  id: string;
}

export class AuthUnavailableError extends Error {
  constructor() {
    super('identity provider could not verify the token');
  }
}

const MAX_CACHED_TOKENS = 10_000;

export const digest = (value: string) => createHash('sha256').update(value).digest();

// Remembers accepted tokens by hash, so a valid token costs one verification per TTL.
export const createTokenCache = (ttlSeconds: number) => {
  const cache = new Map<string, { principal: Principal; expiresAt: number }>();
  const keyOf = (scope: string, token: string) => digest(`${scope}\n${token}`).toString('base64');
  return {
    get(scope: string, token: string): Principal | undefined {
      const key = keyOf(scope, token);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.principal;
      cache.delete(key);
      return undefined;
    },
    set(scope: string, token: string, principal: Principal, expiresAt?: number) {
      if (cache.size >= MAX_CACHED_TOKENS) cache.delete(cache.keys().next().value!);
      const ttlEnd = Date.now() + ttlSeconds * 1000;
      cache.set(keyOf(scope, token), {
        principal,
        expiresAt: expiresAt === undefined ? ttlEnd : Math.min(ttlEnd, expiresAt),
      });
    },
  };
};

export type TokenCache = ReturnType<typeof createTokenCache>;

// The identity provider's 4xx means the token is bad; anything else means we cannot tell.
export const askIdentityProvider = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await call();
  } catch (error) {
    if (error instanceof UpstreamError && error.status >= 400 && error.status < 500) return null;
    throw new AuthUnavailableError();
  }
};
