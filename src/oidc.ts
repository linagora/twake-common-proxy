import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import {
  AuthUnavailableError,
  askIdentityProvider,
  type Principal,
  type TokenCache,
} from './identity.js';
import { parseResponse, type Upstream } from './upstream.js';

type ProviderConfig = Config['auth']['oidc']['providers'][number];

const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
const JWKS_REFRESH_MS = 60_000;

const discoverySchema = z.object({
  jwks_uri: z.url(),
  introspection_endpoint: z.url().optional(),
  userinfo_endpoint: z.url().optional(),
});
const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });
const introspectionSchema = z.object({
  active: z.boolean(),
  sub: z.string().optional(),
  client_id: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  exp: z.number().optional(),
});
const userinfoSchema = z.object({ sub: z.string() });

type Discovery = z.infer<typeof discoverySchema>;

// Verifies access tokens from one OIDC provider: signed JWTs locally against its published
// keys, opaque tokens through introspection when the proxy has client credentials, otherwise
// through userinfo (which proves the user but cannot check which app the token was issued to).
export const createOidcVerifier = (
  config: ProviderConfig,
  upstream: Upstream,
  cache: TokenCache,
) => {
  const discoveryUrl = new URL(
    config.discoveryUrl ?? `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
  );
  const principal = (sub: string): Principal => ({ kind: 'oidc', id: `${sub}@${config.issuer}` });
  const audienceAllowed = (...candidates: (string | string[] | undefined)[]) =>
    config.audiences.length === 0 ||
    candidates.flat().some((c) => c !== undefined && config.audiences.includes(c));

  let discovery: Promise<Discovery> | undefined;
  const discover = () => {
    discovery ??= upstream
      .getJson(discoveryUrl)
      .then((body) => parseResponse(discoverySchema, body))
      .catch((error: unknown) => {
        discovery = undefined;
        throw error;
      });
    return discovery.catch(() => {
      throw new AuthUnavailableError();
    });
  };

  let keys: ReturnType<typeof createLocalJWKSet> | undefined;
  let keysFetchedAt = 0;
  const loadKeys = async () => {
    const { jwks_uri } = await discover();
    const body = parseResponse(
      jwksSchema,
      await upstream.getJson(new URL(jwks_uri)).catch(() => {
        throw new AuthUnavailableError();
      }),
    );
    keys = createLocalJWKSet(body as JSONWebKeySet);
    keysFetchedAt = Date.now();
    return keys;
  };

  const verify = async (token: string, keySet: ReturnType<typeof createLocalJWKSet>) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      algorithms: ALGORITHMS,
      ...(config.audiences.length > 0 && { audience: config.audiences }),
    });
    return payload.sub ? principal(payload.sub) : null;
  };

  return {
    async verifyJwt(token: string): Promise<Principal | null> {
      try {
        return await verify(token, keys ?? (await loadKeys()));
      } catch (error) {
        // The provider rotated its keys since we fetched them.
        if (
          error instanceof errors.JWKSNoMatchingKey &&
          Date.now() - keysFetchedAt > JWKS_REFRESH_MS
        ) {
          return verify(token, await loadKeys()).catch(() => null);
        }
        if (error instanceof AuthUnavailableError) throw error;
        return null;
      }
    },

    async verifyOpaque(token: string): Promise<Principal | null> {
      const cached = cache.get(config.issuer, token);
      if (cached) return cached;
      const { introspection_endpoint, userinfo_endpoint } = await discover();

      if (config.introspection && introspection_endpoint) {
        const { clientId, clientSecret } = config.introspection;
        const credentials = Buffer.from(
          `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
        ).toString('base64');
        const body = await askIdentityProvider(() =>
          upstream.getJson(new URL(introspection_endpoint), {
            authorization: `Basic ${credentials}`,
            form: new URLSearchParams({ token, token_type_hint: 'access_token' }),
          }),
        );
        const result = introspectionSchema.safeParse(body);
        if (!result.success || !result.data.active || !result.data.sub) return null;
        if (!audienceAllowed(result.data.client_id, result.data.aud)) return null;
        const accepted = principal(result.data.sub);
        const expiresAt = result.data.exp === undefined ? undefined : result.data.exp * 1000;
        cache.set(config.issuer, token, accepted, expiresAt);
        return accepted;
      }

      if (!userinfo_endpoint || config.audiences.length > 0) return null;
      const body = await askIdentityProvider(() =>
        upstream.getJson(new URL(userinfo_endpoint), { authorization: `Bearer ${token}` }),
      );
      const result = userinfoSchema.safeParse(body);
      if (!result.success) return null;
      const accepted = principal(result.data.sub);
      cache.set(config.issuer, token, accepted);
      return accepted;
    },
  };
};
