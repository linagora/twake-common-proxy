import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { klipyConfigSchema } from './modules/gif/providers/klipy.js';

type Env = Record<string, string | undefined>;

// Interpolation runs on parsed values, so numbers and booleans written as ${VAR} arrive as strings.
const int = z.coerce.number().int().positive();
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const gifModuleSchema = z
  .object({
    enabled: bool.default(true),
    provider: z.enum(['klipy']),
    proxyMedia: bool.default(true),
    providers: z.object({
      klipy: klipyConfigSchema.optional(),
    }),
  })
  .refine((gif) => gif.providers[gif.provider] !== undefined, {
    path: ['provider'],
    message: 'the selected provider has no entry under providers',
  });

const configSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: int.default(8080),
    publicUrl: z.url(),
    // Addresses or CIDRs of the reverse proxies in front of the service, so rate limits see
    // the client address. Also accepts proxy-addr names such as uniquelocal.
    trustProxy: z.array(z.string().min(1)).default([]),
    shutdownDelaySeconds: z.coerce.number().int().nonnegative().default(5),
  }),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  auth: z
    .object({
      matrix: z
        .object({
          homeservers: z
            .array(z.object({ serverName: z.string().min(1), federationUrl: z.url().optional() }))
            .default([]),
          tokenCacheSeconds: int.default(300),
        })
        .default({ homeservers: [], tokenCacheSeconds: 300 }),
      services: z
        .array(z.object({ name: z.string().min(1), token: z.string().min(32) }))
        .default([]),
    })
    .refine((auth) => auth.matrix.homeservers.length > 0 || auth.services.length > 0, {
      message: 'configure at least one Matrix homeserver or service token',
    }),
  cors: z.object({ origins: z.array(z.url()).default([]) }).default({ origins: [] }),
  rateLimit: z
    .object({ max: int.default(120), maxPerIp: int.default(1200), windowSeconds: int.default(60) })
    .default({ max: 120, maxPerIp: 1200, windowSeconds: 60 }),
  upstream: z
    .object({ timeoutMs: int.default(5000), userAgent: z.string().default('twake-common-proxy') })
    .default({ timeoutMs: 5000, userAgent: 'twake-common-proxy' }),
  media: z.object({
    signingKey: z.string().min(32),
    urlTtlSeconds: int.default(3600),
    maxBytes: int.default(20 * 1024 * 1024),
  }),
  modules: z.object({
    gif: gifModuleSchema.optional(),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type GifModuleConfig = z.infer<typeof gifModuleSchema>;

const interpolate = (value: unknown, env: Env): unknown => {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name: string, fallback?: string) => env[name] ?? fallback ?? '',
    );
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  }
  return value;
};

export const parseConfig = (raw: unknown): Config => {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
};

export const loadConfig = (path: string, env: Env = process.env): Config =>
  parseConfig(interpolate(parseYaml(readFileSync(path, 'utf8')), env));
