export type Fetch = typeof globalThis.fetch;

export const USER_AGENT = 'twake-common-proxy';

export class UpstreamError extends Error {
  constructor(readonly status: number) {
    super(`upstream answered ${status}`);
  }
}

// Every outbound request is built here from scratch: nothing from the caller's request
// (IP, user agent, cookies, language, auth) can reach a provider.
export const createUpstream = (fetch: Fetch, { timeoutMs }: { timeoutMs: number }) => ({
  async getJson(url: URL): Promise<unknown> {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError(res.status);
    }
    return res.json();
  },
});

export type Upstream = ReturnType<typeof createUpstream>;
