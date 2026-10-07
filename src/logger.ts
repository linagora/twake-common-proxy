import pino from 'pino';

export const createLogger = (level: string) =>
  pino({
    level,
    base: { service: 'twake-common-proxy' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });

export type Logger = pino.Logger;
