import { z } from 'zod';
import type { Upstream } from '../../../upstream.js';
import type {
  Gif,
  GifFormat,
  GifMedia,
  GifPage,
  GifProvider,
  GifSize,
  PageRequest,
} from '../types.js';

export const klipyConfigSchema = z.object({
  apiKey: z.string().min(1),
  contentFilter: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
});

const API = 'https://api.klipy.com/';
const MEDIA_HOSTS = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'];

export type KlipyConfig = z.infer<typeof klipyConfigSchema>;

const SIZES: readonly GifSize[] = ['xs', 'sm', 'md', 'hd'];
const MIME: Record<GifFormat, string> = {
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const fileSchema = z.object({
  url: z.url(),
  width: z.number().optional(),
  height: z.number().optional(),
  size: z.number().optional(),
});

const itemSchema = z.object({
  slug: z.string(),
  title: z.string().default(''),
  blur_preview: z.string().optional(),
  file: z.record(z.string(), z.record(z.string(), fileSchema)).optional(),
});

const pageSchema = z.object({
  data: z.object({
    data: z.array(z.unknown()),
    current_page: z.number(),
    has_next: z.boolean(),
  }),
});

const categoriesSchema = z.object({
  data: z.object({
    categories: z.array(z.object({ category: z.string(), query: z.string() })),
  }),
});

const suggestionsSchema = z.object({ data: z.array(z.string()) });

const isSize = (s: string): s is GifSize => (SIZES as readonly string[]).includes(s);
const isFormat = (f: string): f is GifFormat => f in MIME;

// Ad items and anything else without media files are not GIFs we can show.
const toGif = (raw: unknown): Gif | null => {
  const item = itemSchema.safeParse(raw);
  if (!item.success || !item.data.file) return null;
  const media: GifMedia[] = [];
  for (const [size, formats] of Object.entries(item.data.file)) {
    if (!isSize(size)) continue;
    for (const [format, file] of Object.entries(formats)) {
      if (!isFormat(format)) continue;
      media.push({
        size,
        format,
        mime: MIME[format],
        url: file.url,
        width: file.width,
        height: file.height,
        bytes: file.size,
      });
    }
  }
  if (media.length === 0) return null;
  return {
    id: item.data.slug,
    title: item.data.title,
    blurPreview: item.data.blur_preview,
    media,
  };
};

export const createKlipyProvider = (config: KlipyConfig, upstream: Upstream): GifProvider => {
  const endpoint = (path: string, params: Record<string, string | undefined>): URL => {
    const url = new URL(`api/v1/${encodeURIComponent(config.apiKey)}/${path}`, API);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url;
  };

  // KLIPY's `locale` on content endpoints is a country code; fall back to the language.
  const country = (page: PageRequest) =>
    (page.locale?.region ?? page.locale?.language)?.toLowerCase();

  const fetchPage = async (
    path: string,
    params: Record<string, string | undefined>,
    page: PageRequest,
  ): Promise<GifPage> => {
    const body = pageSchema.parse(
      await upstream.getJson(
        endpoint(path, {
          ...params,
          page: page.cursor,
          per_page: page.limit?.toString(),
          locale: country(page),
          content_filter: config.contentFilter,
        }),
      ),
    );
    return {
      next: body.data.has_next ? String(body.data.current_page + 1) : null,
      results: body.data.data.map(toGif).filter((g): g is Gif => g !== null),
    };
  };

  return {
    name: 'klipy',
    attribution: { name: 'KLIPY', url: 'https://klipy.com', searchPlaceholder: 'Search KLIPY' },
    mediaHosts: MEDIA_HOSTS,
    search: (query, page) => fetchPage('gifs/search', { q: query }, page),
    trending: (page) => fetchPage('gifs/trending', {}, page),
    async categories(locale) {
      const body = categoriesSchema.parse(
        await upstream.getJson(
          endpoint('gifs/categories', {
            locale: locale?.region && `${locale.language}_${locale.region}`,
          }),
        ),
      );
      return body.data.categories.map((c) => ({ name: c.category, query: c.query }));
    },
    async autocomplete(query, limit) {
      const body = suggestionsSchema.parse(
        await upstream.getJson(
          endpoint(`autocomplete/${encodeURIComponent(query)}`, { limit: limit?.toString() }),
        ),
      );
      return body.data;
    },
  };
};
