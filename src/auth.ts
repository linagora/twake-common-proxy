import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import {
  AuthUnavailableError,
  askIdentityProvider,
  createTokenCache,
  digest,
  type Principal,
} from './identity.js';
import { createOidcVerifier } from './oidc.js';
import type { Upstream } from './upstream.js';

const bearerToken = (header: string | undefined): string | undefined =>
  header?.match(/^Bearer\s+(\S+)$/i)?.[1];

const JWT = /^[\w-]+\.[\w-]+\.[\w-]*$/;

const userinfoSchema = z.object({ sub: z.string() });

// Matrix OpenID tokens (POST /_matrix/client/v3/user/{userId}/openid/request_token) prove
// who the user is without handing us their access token. The homeserver confirms them
// through its federation userinfo endpoint, the same flow Element Call's lk-jwt-service uses.
const createMatrixVerifier = (config: Config['auth']['matrix'], upstream: Upstream) => {
  const homeservers = new Map(
    config.homeservers.map((h) => [h.serverName, h.federationUrl ?? `https://${h.serverName}`]),
  );
  const cache = createTokenCache(config.tokenCacheSeconds);

  return async (token: string, requestedServer: string | undefined): Promise<Principal | null> => {
    const serverName =
      requestedServer ?? (homeservers.size === 1 ? homeservers.keys().next().value : undefined);
    const baseUrl = serverName && homeservers.get(serverName);
    if (!serverName || !baseUrl) return null;

    const cached = cache.get(serverName, token);
    if (cached) return cached;

    const url = new URL('/_matrix/federation/v1/openid/userinfo', baseUrl);
    url.searchParams.set('access_token', token);
    const parsed = userinfoSchema.safeParse(await askIdentityProvider(() => upstream.getJson(url)));
    if (!parsed.success) return null;
    const { sub } = parsed.data;
    // A homeserver may only vouch for its own users.
    if (!sub.startsWith('@') || !sub.endsWith(`:${serverName}`)) return null;

    const principal: Principal = { kind: 'matrix', id: sub };
    cache.set(serverName, token, principal);
    return principal;
  };
};

// Accepts the first verifier that recognises the token. If none does and one could not be
// reached, the caller gets a 503 rather than a 401, so clients do not drop a valid session.
const firstAccepted = async (checks: Promise<Principal | null>[]): Promise<Principal | null> => {
  const results = await Promise.allSettled(checks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }
  if (results.some((r) => r.status === 'rejected')) throw new AuthUnavailableError();
  return null;
};

const issuerOf = (token: string): string | undefined => {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
};

export const createAuthenticator = (config: Config['auth'], upstream: Upstream) => {
  const services = config.services.map((s) => ({ name: s.name, digest: digest(s.token) }));
  const verifyMatrix = createMatrixVerifier(config.matrix, upstream);
  const cache = createTokenCache(config.oidc.tokenCacheSeconds);
  const oidc = new Map(
    config.oidc.providers.map((p) => [p.issuer, createOidcVerifier(p, upstream, cache)]),
  );

  return async (headers: IncomingHttpHeaders): Promise<Principal | null> => {
    const token = bearerToken(headers.authorization);
    if (!token) return null;

    const tokenDigest = digest(token);
    const service = services.find((s) => timingSafeEqual(s.digest, tokenDigest));
    if (service) return { kind: 'service', id: service.name };

    if (JWT.test(token)) {
      const issuer = issuerOf(token);
      const provider = issuer === undefined ? undefined : oidc.get(issuer);
      return provider ? provider.verifyJwt(token) : null;
    }

    const serverName = headers['x-matrix-server-name'];
    if (typeof serverName === 'string') return verifyMatrix(token, serverName);
    return firstAccepted([
      verifyMatrix(token, undefined),
      ...[...oidc.values()].map((provider) => provider.verifyOpaque(token)),
    ]);
  };
};
