import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyPage } from './fixtures/klipy.js';
import { KLIPY_KEY, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const config = (homeservers: unknown[]) =>
  testConfig({
    auth: { matrix: { homeservers } },
    modules: { gif: { provider: 'klipy', providers: { klipy: { apiKey: KLIPY_KEY } } } },
  });

const example = { serverName: 'example.com', federationUrl: 'https://matrix.example.com' };
const other = { serverName: 'other.org', federationUrl: 'https://matrix.other.org' };

// Homeserver side of the Matrix OpenID flow: GET /_matrix/federation/v1/openid/userinfo.
const homeserver = (tokens: Record<string, string>) =>
  fakeUpstream((url) => {
    if (url.pathname === '/_matrix/federation/v1/openid/userinfo') {
      const sub = tokens[`${url.host} ${url.searchParams.get('access_token')}`];
      return sub
        ? json({ sub })
        : json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Access token unknown or expired' }, 401);
    }
    return json(klipyPage([]));
  });

const userinfoCalls = (requests: { url: URL }[]) =>
  requests.filter((r) => r.url.pathname.endsWith('/openid/userinfo'));

describe('Matrix OpenID tokens', () => {
  it('accepts a token the homeserver vouches for', async () => {
    const upstream = homeserver({ 'matrix.example.com good': '@alice:example.com' });
    const app = await buildServer({ config: config([example]), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('good') });

    expect(res.statusCode).toBe(200);
    expect(userinfoCalls(upstream.requests)[0]?.url.searchParams.get('access_token')).toBe('good');
  });

  it('rejects a token the homeserver does not know', async () => {
    const upstream = homeserver({});
    const app = await buildServer({ config: config([example]), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('stale') });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a user who does not belong to the homeserver that answered', async () => {
    const upstream = homeserver({ 'matrix.example.com evil': '@mallory:evil.net' });
    const app = await buildServer({ config: config([example]), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('evil') });

    expect(res.statusCode).toBe(401);
  });

  it('asks the homeserver named by the caller when several are configured', async () => {
    const upstream = homeserver({ 'matrix.other.org tok': '@bob:other.org' });
    const app = await buildServer({ config: config([example, other]), fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: { ...bearer('tok'), 'x-matrix-server-name': 'other.org' },
    });

    expect(res.statusCode).toBe(200);
    expect(userinfoCalls(upstream.requests).map((r) => r.url.host)).toEqual(['matrix.other.org']);
  });

  it('never contacts a homeserver that is not configured', async () => {
    const upstream = homeserver({});
    const app = await buildServer({ config: config([example, other]), fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: { ...bearer('tok'), 'x-matrix-server-name': 'attacker.example' },
    });

    expect(res.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('checks a token with the homeserver once, then reuses the answer', async () => {
    const upstream = homeserver({ 'matrix.example.com good': '@alice:example.com' });
    const app = await buildServer({ config: config([example]), fetch: upstream.fetch });

    await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('good') });
    await app.inject({ url: '/v1/gif/search?q=dog', headers: bearer('good') });

    expect(userinfoCalls(upstream.requests)).toHaveLength(1);
  });
});

describe('when the homeserver is down', () => {
  it('answers 503 instead of treating the user as logged out', async () => {
    const upstream = fakeUpstream(() => json({ errcode: 'M_UNKNOWN' }, 502));
    const app = await buildServer({ config: config([example]), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('good') });

    expect(res.statusCode).toBe(503);
  });
});
