import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Config } from './config.js';
import type { Fetch } from './upstream.js';

const ALLOWED_TYPES = new Set([
  'image/gif',
  'image/webp',
  'image/jpeg',
  'image/png',
  'video/mp4',
  'video/webm',
]);
const RANGE = /^bytes=\d*-\d*$/;

// Proxied media URLs carry their own expiry and an HMAC over it and the upstream URL, so the
// media route needs no caller authentication (img and video tags cannot send a bearer token)
// and cannot be used to fetch anything we did not hand out.
export const createMediaSigner = (config: Config['media'], publicUrl: string) => {
  const base = publicUrl.replace(/\/+$/, '');
  const mac = (exp: string, url: string) =>
    createHmac('sha256', config.signingKey).update(`${exp}:${url}`).digest();

  return {
    sign(url: string): string {
      const exp = String(Math.floor(Date.now() / 1000) + config.urlTtlSeconds);
      const sig = mac(exp, url).toString('base64url');
      return `${base}/v1/media/${exp}/${sig}/${Buffer.from(url).toString('base64url')}`;
    },
    verify(exp: string, sig: string, target: string): { url: URL; expiresAt: number } | null {
      const expiresAt = Number(exp);
      if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= Date.now()) return null;
      const url = Buffer.from(target, 'base64url').toString();
      const expected = mac(exp, url);
      const given = Buffer.from(sig, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      return { url: new URL(url), expiresAt };
    },
  };
};

export type MediaSigner = ReturnType<typeof createMediaSigner>;

const capped = (maxBytes: number) => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      done(seen > maxBytes ? new Error('media exceeds size limit') : null, chunk);
    },
  });
};

const problem = (reply: FastifyReply, status: number, title: string) =>
  reply.code(status).type('application/problem+json').send({ type: 'about:blank', title, status });

export interface MediaRouteOptions {
  signer: MediaSigner;
  allowedHosts: ReadonlySet<string>;
  fetch: Fetch;
  config: Config;
}

export const mediaRoute: FastifyPluginAsync<MediaRouteOptions> = async (
  app,
  { signer, allowedHosts, fetch, config },
) => {
  app.get<{ Params: { exp: string; sig: string; target: string } }>(
    '/:exp/:sig/:target',
    async (request, reply) => {
      const { exp, sig, target } = request.params;
      const verified = signer.verify(exp, sig, target);
      if (!verified) return problem(reply, 403, 'Invalid or expired media link');
      const { url, expiresAt } = verified;
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
        return problem(reply, 403, 'Media host not allowed');
      }

      const headers: Record<string, string> = {
        'user-agent': config.upstream.userAgent,
        accept: 'image/*,video/*',
      };
      const range = request.headers.range;
      if (range && RANGE.test(range)) headers.range = range;

      let upstream: Response;
      try {
        upstream = await fetch(url, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(config.upstream.timeoutMs),
        });
      } catch {
        return problem(reply, 502, 'Media fetch failed');
      }

      const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const length = Number(upstream.headers.get('content-length') ?? NaN);
      if (
        (upstream.status !== 200 && upstream.status !== 206) ||
        !upstream.body ||
        !type ||
        !ALLOWED_TYPES.has(type) ||
        length > config.media.maxBytes
      ) {
        await upstream.body?.cancel();
        return problem(reply, 502, 'Media not available');
      }

      const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
      reply
        .code(upstream.status)
        .header('content-type', type)
        .header('cache-control', `private, max-age=${maxAge}`)
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('accept-ranges', 'bytes');
      if (Number.isFinite(length)) reply.header('content-length', length);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) reply.header('content-range', contentRange);

      const body = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
      const out = capped(config.media.maxBytes);
      pipeline(body, out, () => {});
      return reply.send(out);
    },
  );
};
