import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { createAuthenticator } from './auth.js';
import type { Config } from './config.js';
import { errorHandler, problem } from './errors.js';
import type { Principal } from './identity.js';
import { createLogger, type Logger } from './logger.js';
import { createMediaSigner, mediaRoute } from './media.js';
import { createMetrics } from './metrics.js';
import { createGifProvider, gifModule } from './modules/gif/index.js';
import type { Attribution } from './modules/gif/types.js';
import { createUpstream, type Fetch } from './upstream.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
  interface FastifyInstance {
    // Fails readiness while still serving, so the load balancer drops the pod before close().
    drain(): void;
  }
}

export interface ServerDeps {
  config: Config;
  fetch?: Fetch;
  logger?: Logger;
}

interface ModuleInfo {
  provider: string;
  attribution: Attribution;
  mediaProxied: boolean;
}

export const buildServer = async ({
  config,
  fetch = globalThis.fetch,
  logger = createLogger(config.logLevel),
}: ServerDeps): Promise<FastifyInstance> => {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Fastify's request logs include the URL, and so the user's search query.
    logController: new LogController({ disableRequestLogging: true }),
    // Media links carry the base64url-encoded upstream URL as a path segment.
    routerOptions: { maxParamLength: 2048 },
    trustProxy: config.server.trustProxy,
  });
  const upstream = createUpstream(fetch, config.upstream);
  const authenticate = createAuthenticator(config.auth, upstream);
  const signer = createMediaSigner(config.media, config.server.publicUrl);
  const metrics = createMetrics();
  const mediaHosts = new Set<string>();
  const modules: Record<string, ModuleInfo> = {};

  let draining = false;
  app.decorate('drain', () => {
    draining = true;
  });
  app.decorateRequest('principal', undefined as unknown as Principal);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, 'Not found'));

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const seconds = reply.elapsedTime / 1000;
    metrics.observe(request.method, route, reply.statusCode, seconds);
    request.log.info(
      {
        method: request.method,
        route,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  // Registered at the root so preflights answer before the /v1 auth hook asks for a token.
  await app.register(cors, {
    origin: config.cors.origins,
    methods: ['GET'],
    maxAge: 600,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) =>
    draining ? problem(reply, 503, 'Shutting down') : { status: 'ok' },
  );
  app.get('/metrics', async (_request, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );

  const timeWindow = config.rateLimit.windowSeconds * 1000;
  await app.register(rateLimit, { global: false, timeWindow });
  // createRateLimit, unlike rateLimit(), lets two limiters run on the same request.
  const limitBy = (max: number, keyGenerator: (request: FastifyRequest) => string) => {
    const check = app.createRateLimit({ max, keyGenerator });
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const limit = await check(request);
      if (limit.isAllowed || !limit.isExceeded) return;
      reply.header('retry-after', limit.ttlInSeconds);
      return problem(reply, 429, 'Too many requests');
    };
  };

  await app.register(async (limited) => {
    // Runs before authentication, so guessed tokens and replayed media links are capped too.
    limited.addHook(
      'onRequest',
      limitBy(config.rateLimit.maxPerIp, (request) => `ip:${request.ip}`),
    );

    await limited.register(
      async (api) => {
        api.addHook('onRequest', async (request, reply) => {
          const principal = await authenticate(request.headers);
          if (!principal) return problem(reply, 401, 'Unauthorized');
          request.principal = principal;
        });
        api.addHook(
          'preHandler',
          limitBy(
            config.rateLimit.max,
            (request) => `${request.principal.kind}:${request.principal.id}`,
          ),
        );

        const gif = config.modules.gif;
        if (gif?.enabled) {
          const provider = createGifProvider(gif, upstream);
          await api.register(gifModule, {
            prefix: '/gif',
            provider,
            ...(gif.proxyMedia && { proxyMediaUrl: signer.sign }),
          });
          if (gif.proxyMedia) provider.mediaHosts.forEach((h) => mediaHosts.add(h));
          modules.gif = {
            provider: provider.name,
            attribution: provider.attribution,
            mediaProxied: gif.proxyMedia,
          };
        }

        api.get('/modules', async () => ({ modules }));
      },
      { prefix: '/v1' },
    );

    await limited.register(mediaRoute, {
      prefix: '/v1/media',
      signer,
      allowedHosts: mediaHosts,
      fetch,
      config,
    });
  });

  return app;
};
