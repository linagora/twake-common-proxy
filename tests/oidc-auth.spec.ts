import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyPage } from './fixtures/klipy.js';
import { type RecordedRequest, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const ISSUER = 'https://sso.example.com/';
const CLIENT = { clientId: 'twake-common-proxy', clientSecret: 'proxy-secret' };

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let signingKey: Key;
let jwks: { keys: object[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] };
});

const accessToken = (claims: Record<string, unknown> = {}, key: Key = signingKey) =>
  new SignJWT({
    sub: 'alice',
    aud: 'twake-mail',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .sign(key);

interface SsoOptions {
  introspect?: (form: URLSearchParams, request: RecordedRequest) => Response;
  userinfo?: (token: string | undefined) => Response;
  down?: boolean;
}

const sso = ({ introspect, userinfo, down }: SsoOptions = {}) =>
  fakeUpstream((url, request) => {
    if (url.host !== 'sso.example.com') return json(klipyPage([]));
    if (down) return json({}, 500);
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json({
          issuer: ISSUER,
          jwks_uri: 'https://sso.example.com/oauth2/jwks',
          introspection_endpoint: 'https://sso.example.com/oauth2/introspect',
          userinfo_endpoint: 'https://sso.example.com/oauth2/userinfo',
        });
      case '/oauth2/jwks':
        return json(jwks);
      case '/oauth2/introspect':
        return introspect!(new URLSearchParams(request.body), request);
      case '/oauth2/userinfo':
        return userinfo!(request.headers.get('authorization')?.replace('Bearer ', ''));
    }
    return json({}, 404);
  });

const config = (provider: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) =>
  testConfig({ auth: { oidc: { providers: [{ issuer: ISSUER, ...provider }] }, ...auth } });

const search = (app: Awaited<ReturnType<typeof buildServer>>, token: string) =>
  app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(token) });

describe('OIDC access tokens', () => {
  describe('signed JWTs', () => {
    it('accepts a token signed by the SSO without calling it per request', async () => {
      const upstream = sso();
      const app = await buildServer({ config: config(), fetch: upstream.fetch });

      const first = await search(app, await accessToken());
      const second = await search(app, await accessToken({ sub: 'bob' }));

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const ssoCalls = upstream.requests.filter((r) => r.url.host === 'sso.example.com');
      expect(ssoCalls.map((r) => r.url.pathname)).toEqual([
        '/.well-known/openid-configuration',
        '/oauth2/jwks',
      ]);
    });

    it('refuses a token signed by another key', async () => {
      const app = await buildServer({ config: config(), fetch: sso().fetch });
      const stranger = (await generateKeyPair('RS256')).privateKey;

      expect((await search(app, await accessToken({}, stranger))).statusCode).toBe(401);
    });

    it('refuses an expired token', async () => {
      const app = await buildServer({ config: config(), fetch: sso().fetch });

      const expired = await accessToken({ exp: Math.floor(Date.now() / 1000) - 60 });

      expect((await search(app, expired)).statusCode).toBe(401);
    });

    it('refuses a token from an issuer that is not configured', async () => {
      const app = await buildServer({ config: config(), fetch: sso().fetch });
      const token = await new SignJWT({ sub: 'alice' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://evil.example/')
        .setExpirationTime('5m')
        .sign(signingKey);

      expect((await search(app, token)).statusCode).toBe(401);
    });

    it('refuses an unsigned token', async () => {
      const app = await buildServer({ config: config(), fetch: sso().fetch });
      const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
      const unsigned = `${encode({ alg: 'none' })}.${encode({ iss: ISSUER, sub: 'alice', exp: 9999999999 })}.`;

      expect((await search(app, unsigned)).statusCode).toBe(401);
    });

    it('only accepts the configured audiences when some are set', async () => {
      const app = await buildServer({
        config: config({ audiences: ['twake-mail'] }),
        fetch: sso().fetch,
      });

      expect((await search(app, await accessToken({ aud: 'twake-mail' }))).statusCode).toBe(200);
      expect((await search(app, await accessToken({ aud: 'other-app' }))).statusCode).toBe(401);
    });
  });

  describe('opaque tokens', () => {
    it('checks them through introspection with the proxy client credentials, once per token', async () => {
      const upstream = sso({
        introspect: (form) =>
          json(
            form.get('token') === 'opaque-good'
              ? { active: true, sub: 'alice' }
              : { active: false },
          ),
      });
      const app = await buildServer({
        config: config({ introspection: CLIENT }),
        fetch: upstream.fetch,
      });

      const first = await search(app, 'opaque-good');
      const second = await search(app, 'opaque-good');
      const revoked = await search(app, 'opaque-revoked');

      expect([first.statusCode, second.statusCode, revoked.statusCode]).toEqual([200, 200, 401]);
      const calls = upstream.requests.filter((r) => r.url.pathname === '/oauth2/introspect');
      expect(calls).toHaveLength(2);
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.headers.get('authorization')).toBe(
        `Basic ${Buffer.from('twake-common-proxy:proxy-secret').toString('base64')}`,
      );
    });

    it('checks the audience of an introspected token when audiences are set', async () => {
      const upstream = sso({
        introspect: () => json({ active: true, sub: 'alice', client_id: 'other-app' }),
      });
      const app = await buildServer({
        config: config({ introspection: CLIENT, audiences: ['twake-mail'] }),
        fetch: upstream.fetch,
      });

      expect((await search(app, 'opaque-good')).statusCode).toBe(401);
    });

    it('falls back to userinfo without client credentials', async () => {
      const upstream = sso({
        userinfo: (token) => (token === 'opaque-good' ? json({ sub: 'alice' }) : json({}, 401)),
      });
      const app = await buildServer({ config: config(), fetch: upstream.fetch });

      expect((await search(app, 'opaque-good')).statusCode).toBe(200);
      expect((await search(app, 'opaque-bad')).statusCode).toBe(401);
    });

    it('refuses opaque tokens when audiences are set but it cannot introspect', async () => {
      const upstream = sso({ userinfo: () => json({ sub: 'alice' }) });
      const app = await buildServer({
        config: config({ audiences: ['twake-mail'] }),
        fetch: upstream.fetch,
      });

      expect((await search(app, 'opaque-good')).statusCode).toBe(401);
    });

    it('accepts both Matrix and OIDC opaque tokens when both are configured', async () => {
      const upstream = fakeUpstream((url, request) => {
        if (url.pathname === '/_matrix/federation/v1/openid/userinfo') {
          return url.searchParams.get('access_token') === 'matrix-token'
            ? json({ sub: '@alice:example.com' })
            : json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
        }
        return sso({
          userinfo: (token) => (token === 'oidc-token' ? json({ sub: 'alice' }) : json({}, 401)),
        }).fetch(url, request);
      });
      const app = await buildServer({
        config: config({}, { matrix: { homeservers: [{ serverName: 'example.com' }] } }),
        fetch: upstream.fetch,
      });

      expect((await search(app, 'matrix-token')).statusCode).toBe(200);
      expect((await search(app, 'oidc-token')).statusCode).toBe(200);
      expect((await search(app, 'neither')).statusCode).toBe(401);
    });
  });

  it('answers 503 when the SSO cannot be reached, instead of logging the user out', async () => {
    const app = await buildServer({ config: config(), fetch: sso({ down: true }).fetch });

    expect((await search(app, await accessToken())).statusCode).toBe(503);
    expect((await search(app, 'opaque')).statusCode).toBe(503);
  });

  it('sends the SSO nothing from the caller', async () => {
    const upstream = sso({ userinfo: () => json({ sub: 'alice' }) });
    const app = await buildServer({ config: config(), fetch: upstream.fetch });

    await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: { ...bearer('opaque'), 'user-agent': 'Firefox', 'x-forwarded-for': '203.0.113.7' },
    });

    const userinfo = upstream.requests.find((r) => r.url.pathname === '/oauth2/userinfo')!;
    expect(Object.fromEntries(userinfo.headers)).toEqual({
      'user-agent': 'twake-common-proxy',
      accept: 'application/json',
      authorization: 'Bearer opaque',
    });
  });
});
