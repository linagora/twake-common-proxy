import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { klipyHelloGif, klipyPage } from './fixtures/klipy.js';
import { KLIPY_KEY, SERVICE_TOKEN, bearer, fakeUpstream, json, testConfig } from './helpers.js';

const captureLogs = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), text: () => lines.join('') };
};

describe('GET /v1/modules', () => {
  it('tells clients which modules are on and how to attribute them', async () => {
    const app = await buildServer({
      config: testConfig(),
      fetch: fakeUpstream(() => json({})).fetch,
    });

    const res = await app.inject({ url: '/v1/modules', headers: bearer(SERVICE_TOKEN) });

    expect(res.json()).toEqual({
      modules: {
        gif: {
          provider: 'klipy',
          attribution: {
            name: 'KLIPY',
            url: 'https://klipy.com',
            searchPlaceholder: 'Search KLIPY',
          },
          mediaProxied: true,
        },
      },
    });
  });

  it('leaves out modules that are switched off', async () => {
    const config = testConfig({
      modules: {
        gif: { enabled: false, provider: 'klipy', providers: { klipy: { apiKey: KLIPY_KEY } } },
      },
    });
    const app = await buildServer({ config, fetch: fakeUpstream(() => json({})).fetch });

    const res = await app.inject({ url: '/v1/modules', headers: bearer(SERVICE_TOKEN) });

    expect(res.json()).toEqual({ modules: {} });
  });
});

describe('health and metrics', () => {
  it('answers liveness and readiness probes without credentials', async () => {
    const app = await buildServer({
      config: testConfig(),
      fetch: fakeUpstream(() => json({})).fetch,
    });

    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
  });

  it('counts requests by route template and status, never by query', async () => {
    const upstream = fakeUpstream(() => json(klipyPage([klipyHelloGif])));
    const app = await buildServer({ config: testConfig(), fetch: upstream.fetch });

    await app.inject({ url: '/v1/gif/search?q=private-words', headers: bearer(SERVICE_TOKEN) });
    const metrics = (await app.inject({ url: '/metrics' })).body;

    expect(metrics).toContain(
      'tcp_http_requests_total{method="GET",route="/v1/gif/search",status="200"} 1',
    );
    expect(metrics).not.toContain('private-words');
  });
});

describe('logs', () => {
  it('record each request without the query, the caller or their address', async () => {
    const logs = captureLogs();
    const upstream = fakeUpstream(() => json(klipyPage([klipyHelloGif])));
    const app = await buildServer({
      config: testConfig(),
      fetch: upstream.fetch,
      logger: logs.logger,
    });

    await app.inject({
      url: '/v1/gif/search?q=my-secret-query',
      headers: { ...bearer(SERVICE_TOKEN), 'user-agent': 'Firefox/140' },
      remoteAddress: '203.0.113.7',
    });

    const text = logs.text();
    expect(text).toContain('"route":"/v1/gif/search"');
    expect(text).toContain('"status":200');
    for (const secret of ['my-secret-query', SERVICE_TOKEN, '203.0.113.7', 'Firefox', 'backend']) {
      expect(text).not.toContain(secret);
    }
  });

  it('do not leak the provider API key when the provider fails', async () => {
    const logs = captureLogs();
    const upstream = fakeUpstream(() => {
      throw new TypeError(`fetch failed for https://api.klipy.com/api/v1/${KLIPY_KEY}/gifs/search`);
    });
    const app = await buildServer({
      config: testConfig(),
      fetch: upstream.fetch,
      logger: logs.logger,
    });

    const res = await app.inject({ url: '/v1/gif/search?q=cat', headers: bearer(SERVICE_TOKEN) });

    expect(res.statusCode).toBe(502);
    expect(logs.text()).not.toContain(KLIPY_KEY);
    expect(res.body).not.toContain(KLIPY_KEY);
  });
});
