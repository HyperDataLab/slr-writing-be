import type { RequestParamHandler } from 'express';
import { NotFoundError } from '../shared/errors/app-error.js';
import { hasUnstorableText } from '../shared/utils/storable.js';

const MAX_ID_LENGTH = 200;

/**
 * For `router.param('projectId', guardIdParam('Project not found', 'PROJECT_NOT_FOUND'))`.
 * An id with a NUL or a lone surrogate (for example `%00` in the URL) cannot match any row, but PostgreSQL rejects it
 * as a query value and the request would end in a 500. Answer it like any other id that does not exist.
 */
export const guardIdParam = (message: string, code: string): RequestParamHandler => (_req, _res, next, value) => {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || hasUnstorableText(value)) return next(new NotFoundError(message, code));
  return next();
};
