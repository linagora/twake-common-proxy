import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { UpstreamError } from './upstream.js';

export const problem = (reply: FastifyReply, status: number, title: string, detail?: string) =>
  reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail && { detail }) });

const isTimeout = (error: unknown) =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

// Provider errors are never echoed: their bodies and URLs can contain our API keys.
export const errorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  if (error instanceof ZodError) {
    const detail = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return problem(reply, 400, 'Invalid request', detail);
  }
  if (error instanceof UpstreamError) {
    return error.status === 429
      ? problem(reply, 503, 'Provider quota exhausted, retry later')
      : problem(reply, 502, 'Provider error');
  }
  if (isTimeout(error)) return problem(reply, 504, 'Provider timed out');
  if (error.statusCode && error.statusCode < 500) {
    return problem(reply, error.statusCode, error.message);
  }
  request.log.error({ err: { name: error.name, code: error.code } }, 'request failed');
  return problem(reply, 502, 'Provider error');
};
