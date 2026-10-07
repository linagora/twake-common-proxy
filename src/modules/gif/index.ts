import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { GifModuleConfig } from '../../config.js';
import type { Upstream } from '../../upstream.js';
import { createKlipyProvider } from './providers/klipy.js';
import type { Gif, GifPage, GifProvider, Locale, PageRequest } from './types.js';

export const createGifProvider = (config: GifModuleConfig, upstream: Upstream): GifProvider => {
  switch (config.provider) {
    case 'klipy':
      return createKlipyProvider(config.providers.klipy!, upstream);
  }
};

const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(?:[-_][a-z]{2})?$/i)
  .transform((value): Locale => {
    const [language, region] = value.split(/[-_]/);
    return { language: language!.toLowerCase(), ...(region && { region: region.toUpperCase() }) };
  });

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  locale: localeSchema.optional(),
});

const searchQuery = pageQuery.extend({ q: z.string().trim().min(1).max(100) });

const page = (q: z.infer<typeof pageQuery>): PageRequest => ({
  ...(q.limit !== undefined && { limit: q.limit }),
  ...(q.cursor !== undefined && { cursor: q.cursor }),
  ...(q.locale !== undefined && { locale: q.locale }),
});

export interface GifModuleOptions {
  provider: GifProvider;
  // Rewrites a provider media URL into one served by the proxy; absent when media goes direct.
  proxyMediaUrl?: (url: string) => string;
}

export const gifModule: FastifyPluginAsync<GifModuleOptions> = async (
  app,
  { provider, proxyMediaUrl },
) => {
  const mediaHosts = new Set(provider.mediaHosts);
  const isProviderMedia = (url: string) => {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && mediaHosts.has(hostname);
  };

  const present = (gif: Gif): Gif | null => {
    const media = gif.media
      .filter((m) => isProviderMedia(m.url))
      .map((m) => (proxyMediaUrl ? { ...m, url: proxyMediaUrl(m.url) } : m));
    return media.length > 0 ? { ...gif, media } : null;
  };

  const respond = async (pending: Promise<GifPage>) => {
    const { next, results } = await pending;
    return {
      provider: provider.name,
      attribution: provider.attribution,
      next,
      results: results.map(present).filter((g): g is Gif => g !== null),
    };
  };

  app.get('/search', async (request) => {
    const query = searchQuery.parse(request.query);
    return respond(provider.search(query.q, page(query)));
  });
};
