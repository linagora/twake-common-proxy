import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyPage } from './fixtures/klipy.js';
import { SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const OTHER_TOKEN = 'o'.repeat(40);

describe('rate limiting', () => {
  it('limits each caller separately and tells them when to retry', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([])));
    const config = testConfig({
      auth: {
        services: [
          { name: 'backend', token: SERVICE_TOKEN },
          { name: 'other', token: OTHER_TOKEN },
        ],
      },
      rateLimit: { max: 2, windowSeconds: 60 },
    });
    const app = await buildServer({ config, fetch: upstream.fetch });
    const search = (token: string) =>
      app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(token) });

    await search(SERVICE_TOKEN);
    await search(SERVICE_TOKEN);
    const limited = await search(SERVICE_TOKEN);
    const other = await search(OTHER_TOKEN);

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(other.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(3);
  });

  it('limits each client address, so guessed tokens stop reaching the homeserver', async () => {
    const homeserver = fakeUpstream(() => json({ errcode: 'M_UNKNOWN_TOKEN' }, 401));
    const config = testConfig({
      server: { publicUrl: 'https://proxy.example.com', trustProxy: ['loopback'] },
      auth: { matrix: { homeservers: [{ serverName: 'example.com' }] } },
      rateLimit: { max: 100, maxPerIp: 2, windowSeconds: 60 },
    });
    const app = await buildServer({ config, fetch: homeserver.fetch });
    const guess = (ip: string) =>
      app.inject({
        url: '/v1/gif/search?q=cat',
        headers: { ...bearer(`guess-${Math.random()}`), 'x-forwarded-for': ip },
      });

    await guess('203.0.113.1');
    await guess('203.0.113.1');
    const limited = await guess('203.0.113.1');
    const otherClient = await guess('203.0.113.2');

    expect(limited.statusCode).toBe(429);
    expect(otherClient.statusCode).toBe(401);
    expect(homeserver.requests).toHaveLength(3);
  });

  it('limits media downloads per client address', async () => {
    const config = testConfig({ rateLimit: { max: 100, maxPerIp: 1, windowSeconds: 60 } });
    const app = await buildServer({ config, fetch: fakeUpstream(() => json({})).fetch });

    await app.inject({ url: '/v1/media/1/sig/target' });
    const limited = await app.inject({ url: '/v1/media/1/sig/target' });

    expect(limited.statusCode).toBe(429);
  });

  it('never limits health checks and metrics scrapes', async () => {
    const config = testConfig({ rateLimit: { max: 100, maxPerIp: 1, windowSeconds: 60 } });
    const app = await buildServer({ config, fetch: fakeUpstream(() => json({})).fetch });

    const codes = [];
    for (const url of ['/healthz', '/healthz', '/readyz', '/readyz', '/metrics', '/metrics']) {
      codes.push((await app.inject({ url })).statusCode);
    }

    expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
  });
});
