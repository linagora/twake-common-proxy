import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Labels are route templates and status codes only, so no query or user can end up in a series.
export const createMetrics = () => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'tcp_http_requests_total',
    help: 'HTTP requests, by method, route template and status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const duration = new Histogram({
    name: 'tcp_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by route template',
    labelNames: ['route'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  return {
    registry,
    observe(method: string, route: string, status: number, seconds: number) {
      requests.labels(method, route, String(status)).inc();
      duration.labels(route).observe(seconds);
    },
  };
};
