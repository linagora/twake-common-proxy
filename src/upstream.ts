import type { z } from 'zod';

export type Fetch = typeof globalThis.fetch;

export const USER_AGENT = 'twake-common-proxy';

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    reason = `answered ${status}`,
  ) {
    super(`upstream ${reason}`);
  }
}

// A provider changing its format is a gateway failure, not a client error.
export const parseResponse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw new UpstreamError(502, 'answered in an unexpected shape');
  return result.data;
};

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
    return res.json().catch(() => {
      throw new UpstreamError(502, 'answered something other than JSON');
    });
  },
});

export type Upstream = ReturnType<typeof createUpstream>;
