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
});
