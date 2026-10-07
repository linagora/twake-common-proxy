import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticator, type Principal } from './auth.js';
import type { Config } from './config.js';
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
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const upstream = createUpstream(fetch, config.upstream);
  const authenticate = createAuthenticator(config.auth, upstream);

  app.decorateRequest('principal', undefined as unknown as Principal);

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        const principal = await authenticate(request.headers);
        if (!principal) {
          return reply.code(401).type('application/problem+json').send({
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
          });
        }
        request.principal = principal;
      });

      const gif = config.modules.gif;
      if (gif?.enabled) {
        await api.register(gifModule, {
          prefix: '/gif',
          provider: createGifProvider(gif, upstream),
        });
      }
    },
    { prefix: '/v1' },
  );

  return app;
};
