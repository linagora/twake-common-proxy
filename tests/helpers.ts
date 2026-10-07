import { parseConfig, type Config } from '../src/config.js';

export const SERVICE_TOKEN = 's'.repeat(40);
export const KLIPY_KEY = 'klipy-app-key';

export const testConfig = (overrides: Record<string, unknown> = {}): Config =>
  parseConfig({
    server: { publicUrl: 'https://proxy.example.com' },
    auth: { services: [{ name: 'backend', token: SERVICE_TOKEN }] },
    media: { signingKey: 'k'.repeat(32) },
    modules: {
      gif: { provider: 'klipy', providers: { klipy: { apiKey: KLIPY_KEY } } },
    },
    ...overrides,
  });

export interface RecordedRequest {
  url: URL;
  headers: Headers;
}

type Route = (url: URL) => Response | Promise<Response>;

// Stands in for the internet: every outbound request goes through here.
export const fakeUpstream = (route: Route) => {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return route(url);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
