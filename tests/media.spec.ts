import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyHelloGif, klipyPage } from './fixtures/klipy.js';
import { SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const GIF_BYTES = Buffer.from('GIF89a-fake-bytes');

const media = (
  body: ConstructorParameters<typeof Response>[0],
  headers: Record<string, string>,
  status = 200,
) => new Response(body, { status, headers });

const klipyWithMedia = (respond: (url: URL) => Response) =>
  fakeUpstream((url) =>
    url.host === 'api.klipy.com' ? json(klipyPage([klipyHelloGif])) : respond(url),
  );

const searchAndPick = async (app: Awaited<ReturnType<typeof buildServer>>) => {
  const res = await app.inject({ url: '/v1/gif/search?q=hello', headers: bearer(SERVICE_TOKEN) });
  const proxied = new URL(res.json().results[0].media[0].url);
  return proxied;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('GIF media through the proxy', () => {
  it('hands out proxy URLs and streams the original file without caller data', async () => {
    const upstream = klipyWithMedia(() =>
      media(GIF_BYTES, { 'content-type': 'image/gif', 'content-length': `${GIF_BYTES.length}` }),
    );
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    const proxied = await searchAndPick(app);
    expect(proxied.origin).toBe('https://proxy.example.com');

    const res = await app.inject({
      url: proxied.pathname,
      headers: { 'user-agent': 'Firefox', 'x-forwarded-for': '203.0.113.7', cookie: 'a=b' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(GIF_BYTES);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const fetched = upstream.requests[1]!;
    expect(fetched.url.href).toBe(klipyHelloGif.file.hd.gif.url);
    expect(Object.fromEntries(fetched.headers)).toEqual({
      'user-agent': 'twake-common-proxy',
      accept: 'image/*,video/*',
    });
  });

  it('refuses a URL whose signature was tampered with', async () => {
    const upstream = klipyWithMedia(() => media(GIF_BYTES, { 'content-type': 'image/gif' }));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });
    const proxied = await searchAndPick(app);

    const [, , , exp, , target] = proxied.pathname.split('/');
    const res = await app.inject({ url: `/v1/media/${exp}/${'A'.repeat(43)}/${target}` });

    expect(res.statusCode).toBe(403);
    expect(upstream.requests).toHaveLength(1);
  });

  it('keeps a URL valid for at least the TTL, then refuses it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const upstream = klipyWithMedia(() => media(GIF_BYTES, { 'content-type': 'image/gif' }));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });
    const proxied = await searchAndPick(app);
    const issuedAt = Date.now();

    vi.setSystemTime(issuedAt + 3599 * 1000);
    const late = await app.inject({ url: proxied.pathname });
    vi.setSystemTime(issuedAt + 2 * 3600 * 1000 + 1000);
    const expired = await app.inject({ url: proxied.pathname });

    expect(late.statusCode).toBe(200);
    expect(expired.statusCode).toBe(403);
  });

  it('hands out the same URL for the same file across searches, so browsers reuse their cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1, 10, 0, 1));
    const upstream = klipyWithMedia(() => media(GIF_BYTES, { 'content-type': 'image/gif' }));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    const first = await searchAndPick(app);
    vi.setSystemTime(Date.UTC(2026, 0, 1, 10, 30, 0));
    const second = await searchAndPick(app);

    expect(second.href).toBe(first.href);
  });

  it('drops media the provider serves from a host outside its allowlist', async () => {
    const stray = {
      ...klipyHelloGif,
      slug: 'stray',
      file: { hd: { gif: { url: 'https://tracker.example/pixel.gif', size: 1 } } },
    };
    const upstream = fakeUpstream(() => json(klipyPage([klipyHelloGif, stray])));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    const res = await app.inject({ url: '/v1/gif/search?q=x', headers: bearer(SERVICE_TOKEN) });

    expect(res.json().results.map((g: { id: string }) => g.id)).toEqual(['hello-hi-662']);
  });

  it('refuses to relay anything that is not an image or video', async () => {
    const upstream = klipyWithMedia(() => media('<html>', { 'content-type': 'text/html' }));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });
    const proxied = await searchAndPick(app);

    const res = await app.inject({ url: proxied.pathname });

    expect(res.statusCode).toBe(502);
  });

  it('refuses files that declare a size above the limit', async () => {
    const big = Buffer.alloc(2048, 1);
    const upstream = klipyWithMedia(() =>
      media(big, { 'content-type': 'image/gif', 'content-length': '2048' }),
    );
    const config = testConfig({ media: { signingKey: 'k'.repeat(32), maxBytes: 1024 } });
    const app = await buildServer({ config, fetch: upstream.fetch });
    const proxied = await searchAndPick(app);

    const res = await app.inject({ url: proxied.pathname });

    expect(res.statusCode).toBe(502);
  });

  it('cuts off a file without a declared size once it passes the limit', async () => {
    const big = Buffer.alloc(4096, 1);
    const upstream = klipyWithMedia(() => media(big, { 'content-type': 'image/gif' }));
    const config = testConfig({ media: { signingKey: 'k'.repeat(32), maxBytes: 1024 } });
    const app = await buildServer({ config, fetch: upstream.fetch });
    const proxied = await searchAndPick(app);

    const res = await app.inject({ url: proxied.pathname }).catch(() => null);

    expect(res?.rawPayload.length ?? 0).toBeLessThan(big.length);
  });

  it('passes byte ranges through so video players can seek', async () => {
    const upstream = klipyWithMedia(() =>
      media(
        GIF_BYTES.subarray(0, 4),
        {
          'content-type': 'video/mp4',
          'content-range': `bytes 0-3/${GIF_BYTES.length}`,
          'content-length': '4',
        },
        206,
      ),
    );
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });
    const proxied = await searchAndPick(app);

    const res = await app.inject({ url: proxied.pathname, headers: { range: 'bytes=0-3' } });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-3/${GIF_BYTES.length}`);
    expect(upstream.requests[1]!.headers.get('range')).toBe('bytes=0-3');
  });
});
