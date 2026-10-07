import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Upstream } from './upstream.js';

export interface Principal {
  kind: 'service' | 'matrix';
  id: string;
}

const MAX_CACHED_TOKENS = 10_000;

const digest = (value: string) => createHash('sha256').update(value).digest();

const bearerToken = (header: string | undefined): string | undefined =>
  header?.match(/^Bearer\s+(\S+)$/i)?.[1];

const userinfoSchema = z.object({ sub: z.string() });

// Matrix OpenID tokens (POST /_matrix/client/v3/user/{userId}/openid/request_token) prove
// who the user is without handing us their access token. The homeserver confirms them
// through its federation userinfo endpoint, the same flow Element Call's lk-jwt-service uses.
const createMatrixVerifier = (config: Config['auth']['matrix'], upstream: Upstream) => {
  const homeservers = new Map(
    config.homeservers.map((h) => [h.serverName, h.federationUrl ?? `https://${h.serverName}`]),
  );
  const cache = new Map<string, { principal: Principal; expiresAt: number }>();
  const ttlMs = config.tokenCacheSeconds * 1000;

  const remember = (key: string, principal: Principal) => {
    if (cache.size >= MAX_CACHED_TOKENS) cache.delete(cache.keys().next().value!);
    cache.set(key, { principal, expiresAt: Date.now() + ttlMs });
  };

  return async (token: string, requestedServer: string | undefined): Promise<Principal | null> => {
    const serverName =
      requestedServer ?? (homeservers.size === 1 ? homeservers.keys().next().value : undefined);
    const baseUrl = serverName && homeservers.get(serverName);
    if (!serverName || !baseUrl) return null;

    const key = digest(`${serverName}\n${token}`).toString('base64');
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.principal;
    cache.delete(key);

    const url = new URL('/_matrix/federation/v1/openid/userinfo', baseUrl);
    url.searchParams.set('access_token', token);
    let sub: string;
    try {
      sub = userinfoSchema.parse(await upstream.getJson(url)).sub;
    } catch {
      return null;
    }
    // A homeserver may only vouch for its own users.
    if (!sub.startsWith('@') || !sub.endsWith(`:${serverName}`)) return null;

    const principal: Principal = { kind: 'matrix', id: sub };
    remember(key, principal);
    return principal;
  };
};

export const createAuthenticator = (config: Config['auth'], upstream: Upstream) => {
  const services = config.services.map((s) => ({ name: s.name, digest: digest(s.token) }));
  const verifyMatrix = createMatrixVerifier(config.matrix, upstream);

  return async (headers: IncomingHttpHeaders): Promise<Principal | null> => {
    const token = bearerToken(headers.authorization);
    if (!token) return null;

    const tokenDigest = digest(token);
    const service = services.find((s) => timingSafeEqual(s.digest, tokenDigest));
    if (service) return { kind: 'service', id: service.name };

    const serverName = headers['x-matrix-server-name'];
    return verifyMatrix(token, typeof serverName === 'string' ? serverName : undefined);
  };
};
