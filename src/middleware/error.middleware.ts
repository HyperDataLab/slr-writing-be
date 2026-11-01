import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/errors/app-error.js';
import { createLogger } from '../config/logger.js';
import { env } from '../config/env.js';

const logger = createLogger('API');

export const errorHandler = (err: Error | AppError, req: Request, res: Response, _next: NextFunction) => {
  const context = {
    err,
    requestId: req.id,
    path: req.path,
    method: req.method,
    statusCode: err instanceof AppError ? err.statusCode : 500,
  };
  if (err instanceof AppError && err.statusCode < 500) {
    logger.warn(context, 'Client request rejected');
  } else {
    logger.error(context, 'Request error occurred');
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, requestId: req.id, ...(err.details === undefined ? {} : { details: err.details }) },
    });
  }

  // Malformed JSON and oversized bodies come from body-parser as plain errors with a status.
  const bodyError = err as Error & { type?: string; status?: number };
  if (bodyError.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON', requestId: req.id } });
  }
  if (bodyError.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large', requestId: req.id } });
  }

  // Other errors raised by Express itself for a request it cannot read, such as a malformed percent-escape in the URL
  // (`%ZZ`, status 400). These are the client's mistake, so answer 4xx with a generic message and keep the details out.
  if (typeof bodyError.status === 'number' && bodyError.status >= 400 && bodyError.status < 500) {
    return res.status(bodyError.status).json({
      success: false,
      error: { code: bodyError.status === 400 ? 'BAD_REQUEST' : 'CLIENT_ERROR', message: 'The request could not be read', requestId: req.id },
    });
  }

  const isDev = env.NODE_ENV === 'development';
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: isDev ? err.message : 'An unexpected error occurred. Please try again later.',
      requestId: req.id,
      ...(isDev ? { stack: err.stack } : {}),
    },
  });
};
