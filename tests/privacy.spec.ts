import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyHelloGif, klipyPage } from './fixtures/klipy.js';
import { SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

describe('what reaches the provider', () => {
  it('sends only a fixed user agent and accept header, nothing from the caller', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([klipyHelloGif])));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: {
        ...bearer(SERVICE_TOKEN),
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
        'x-forwarded-for': '203.0.113.7',
        forwarded: 'for=203.0.113.7',
        'accept-language': 'fr-FR,fr;q=0.9',
        cookie: 'session=abc',
        'x-matrix-user': '@alice:example.com',
      },
      remoteAddress: '203.0.113.7',
    });

    const call = upstream.requests[0]!;
    expect(Object.fromEntries(call.headers)).toEqual({
      'user-agent': 'twake-common-proxy',
      accept: 'application/json',
    });
    expect(call.url.searchParams.has('customer_id')).toBe(false);
    expect(call.url.href).not.toContain('203.0.113.7');
    expect(call.url.href).not.toContain(SERVICE_TOKEN);
  });
});

describe('who may call the proxy', () => {
  it('rejects requests without a token', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([])));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown service token', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([])));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer('x'.repeat(40)) });

    expect(res.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });
});
