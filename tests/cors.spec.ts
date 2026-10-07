import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyHelloGif, klipyPage } from './fixtures/klipy.js';
import { SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const CHAT = 'https://chat.example.com';

const corsApp = async () => {
  const upstream = fakeUpstream((url) =>
    url.host === 'api.klipy.com'
      ? json(klipyPage([klipyHelloGif]))
      : new Response('GIF', { headers: { 'content-type': 'image/gif' } }),
  );
  const app = await buildServer({
    config: testConfig({ cors: { origins: [CHAT] } }),
    fetch: upstream.fetch,
  });
  return { app, upstream };
};

describe('browser access', () => {
  it('answers the preflight of an allowed web app without asking for a token', async () => {
    const { app } = await corsApp();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/gif/search?q=cat',
      headers: {
        origin: CHAT,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, x-matrix-server-name',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CHAT);
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers['access-control-allow-headers']).toContain('x-matrix-server-name');
  });

  it('lets an allowed web app read search results and download media', async () => {
    const { app } = await corsApp();

    const search = await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: { ...bearer(SERVICE_TOKEN), origin: CHAT },
    });
    const media = await app.inject({
      url: new URL(search.json().results[0].media[0].url).pathname,
      headers: { origin: CHAT },
    });

    expect(search.headers['access-control-allow-origin']).toBe(CHAT);
    expect(media.headers['access-control-allow-origin']).toBe(CHAT);
  });

  it('lets the web app read a 401, so it can fetch a fresh token', async () => {
    const { app } = await corsApp();

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: { origin: CHAT } });

    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(CHAT);
  });

  it('gives other origins no access', async () => {
    const { app } = await corsApp();

    const res = await app.inject({
      url: '/v1/gif/search?q=cat',
      headers: { ...bearer(SERVICE_TOKEN), origin: 'https://evil.example' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
