import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticator, type Principal } from './auth.js';
import type { Config } from './config.js';
import { errorHandler, problem } from './errors.js';
import { createMediaSigner, mediaRoute } from './media.js';
import { createGifProvider, gifModule } from './modules/gif/index.js';
import { createUpstream, type Fetch } from './upstream.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface ServerDeps {
  config: Config;
  fetch?: Fetch;
}

export const buildServer = async ({
  config,
  fetch = globalThis.fetch,
}: ServerDeps): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    // Media links carry the base64url-encoded upstream URL as a path segment.
    routerOptions: { maxParamLength: 2048 },
  });
  const upstream = createUpstream(fetch, config.upstream);
  const authenticate = createAuthenticator(config.auth, upstream);
  const signer = createMediaSigner(config.media, config.server.publicUrl);
  const mediaHosts = new Set<string>();

  app.decorateRequest('principal', undefined as unknown as Principal);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'Not found'));

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        const principal = await authenticate(request.headers);
        if (!principal) return problem(reply, 401, 'Unauthorized');
        request.principal = principal;
      });

      await api.register(rateLimit, {
        hook: 'preHandler',
        max: config.rateLimit.max,
        timeWindow: config.rateLimit.windowSeconds * 1000,
        keyGenerator: (request) => `${request.principal.kind}:${request.principal.id}`,
        errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many requests' }),
      });

      const gif = config.modules.gif;
      if (gif?.enabled) {
        const provider = createGifProvider(gif, upstream);
        await api.register(gifModule, {
          prefix: '/gif',
          provider,
          ...(gif.proxyMedia && { proxyMediaUrl: signer.sign }),
        });
        if (gif.proxyMedia) provider.mediaHosts.forEach((h) => mediaHosts.add(h));
      }
    },
    { prefix: '/v1' },
  );

  await app.register(mediaRoute, {
    prefix: '/v1/media',
    signer,
    allowedHosts: mediaHosts,
    fetch,
    config,
  });

  return app;
};
