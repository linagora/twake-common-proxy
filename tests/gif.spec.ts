import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyHelloGif, klipyPage } from './fixtures/klipy.js';
import { KLIPY_KEY, SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const directMedia = testConfig({
  modules: {
    gif: {
      provider: 'klipy',
      proxyMedia: false,
      providers: { klipy: { apiKey: KLIPY_KEY } },
    },
  },
});

describe('GET /v1/gif/search', () => {
  it('returns KLIPY results in the normalized shape', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([klipyHelloGif])));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/search?q=hello',
      headers: bearer(SERVICE_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: 'klipy',
      attribution: {
        name: 'KLIPY',
        url: 'https://klipy.com',
        searchPlaceholder: 'Search KLIPY',
      },
      next: '2',
      results: [
        {
          id: 'hello-hi-662',
          title: 'Hello',
          blurPreview: 'data:image/jpeg;base64,AAAA',
          media: [
            {
              size: 'hd',
              format: 'gif',
              mime: 'image/gif',
              url: klipyHelloGif.file.hd.gif.url,
              width: 498,
              height: 498,
              bytes: 4001918,
            },
            {
              size: 'hd',
              format: 'mp4',
              mime: 'video/mp4',
              url: klipyHelloGif.file.hd.mp4.url,
              bytes: 119294,
            },
            {
              size: 'sm',
              format: 'webp',
              mime: 'image/webp',
              url: klipyHelloGif.file.sm.webp.url,
              width: 220,
              height: 220,
              bytes: 80118,
            },
            {
              size: 'sm',
              format: 'jpg',
              mime: 'image/jpeg',
              url: klipyHelloGif.file.sm.jpg.url,
              bytes: 8560,
            },
          ],
        },
      ],
    });
  });

  it('calls KLIPY search with the app key, query, paging and content filter', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([], 3, false)));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/search?q=good%20morning&limit=10&cursor=3&locale=fr-FR',
      headers: bearer(SERVICE_TOKEN),
    });

    expect(res.json()).toMatchObject({ next: null, results: [] });
    const call = upstream.requests[0]!;
    expect(call.url.origin + call.url.pathname).toBe(
      `https://api.klipy.com/api/v1/${KLIPY_KEY}/gifs/search`,
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      q: 'good morning',
      page: '3',
      per_page: '10',
      locale: 'fr',
      content_filter: 'medium',
    });
  });
});
