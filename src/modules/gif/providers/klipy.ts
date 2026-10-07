import { z } from 'zod';

export const klipyConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.url().default('https://api.klipy.com'),
  contentFilter: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  mediaHosts: z
    .array(z.string().min(1))
    .default(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']),
});

export type KlipyConfig = z.infer<typeof klipyConfigSchema>;
