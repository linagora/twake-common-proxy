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

const klipy = (route: (path: string, url: URL) => unknown, status = 200) =>
  fakeUpstream((url) =>
    json(route(url.pathname.replace(`/api/v1/${KLIPY_KEY}/`, ''), url), status),
  );

describe('GET /v1/gif/trending', () => {
  it('returns trending GIFs for the requested page', async () => {
    const upstream = klipy(() => klipyPage([klipyHelloGif], 2, false));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/trending?cursor=2',
      headers: bearer(SERVICE_TOKEN),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: 'klipy',
      next: null,
      results: [{ id: 'hello-hi-662' }],
    });
    expect(upstream.requests[0]!.url.pathname).toBe(`/api/v1/${KLIPY_KEY}/gifs/trending`);
    expect(upstream.requests[0]!.url.searchParams.get('page')).toBe('2');
  });
});

describe('GET /v1/gif/categories', () => {
  it('lists categories with the query to run for each', async () => {
    const upstream = klipy(() => ({
      result: true,
      data: {
        locale: 'fr_FR',
        categories: [
          { category: 'smile', query: 'smile' },
          { category: 'high five', query: 'high five' },
        ],
      },
    }));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/categories?locale=fr-FR',
      headers: bearer(SERVICE_TOKEN),
    });

    expect(res.json()).toEqual({
      provider: 'klipy',
      attribution: { name: 'KLIPY', url: 'https://klipy.com', searchPlaceholder: 'Search KLIPY' },
      categories: [
        { name: 'smile', query: 'smile' },
        { name: 'high five', query: 'high five' },
      ],
    });
    expect(upstream.requests[0]!.url.pathname).toBe(`/api/v1/${KLIPY_KEY}/gifs/categories`);
    expect(upstream.requests[0]!.url.searchParams.get('locale')).toBe('fr_FR');
  });
});

describe('GET /v1/gif/autocomplete', () => {
  it('completes a partial query', async () => {
    const upstream = klipy(() => ({ result: true, data: ['hello', 'heart'] }));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({
      url: '/v1/gif/autocomplete?q=he%20y&limit=2',
      headers: bearer(SERVICE_TOKEN),
    });

    expect(res.json()).toEqual({ provider: 'klipy', suggestions: ['hello', 'heart'] });
    expect(upstream.requests[0]!.url.pathname).toBe(`/api/v1/${KLIPY_KEY}/autocomplete/he%20y`);
    expect(upstream.requests[0]!.url.searchParams.get('limit')).toBe('2');
  });
});

describe('errors', () => {
  it('rejects a search without a query', async () => {
    const upstream = klipy(() => klipyPage([]));
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(upstream.requests).toHaveLength(0);
  });

  it('reports a provider failure as a bad gateway without leaking provider details', async () => {
    const upstream = klipy(() => ({ result: false, message: `bad key ${KLIPY_KEY}` }), 500);
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(KLIPY_KEY);
  });

  it('reports the provider quota as temporarily unavailable', async () => {
    const upstream = klipy(() => ({ result: false }), 429);
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(503);
  });

  it('reports a provider that does not answer in time as a gateway timeout', async () => {
    const upstream = fakeUpstream(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const app = await buildServer({ config: directMedia, fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(504);
  });

  it('answers 404 for a module that is switched off', async () => {
    const config = testConfig({
      modules: {
        gif: { enabled: false, provider: 'klipy', providers: { klipy: { apiKey: KLIPY_KEY } } },
      },
    });
    const app = await buildServer({ config, fetch: klipy(() => klipyPage([])).fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(404);
  });
});
