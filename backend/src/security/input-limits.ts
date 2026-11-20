/**
 * Strict Input Size and Cardinality Limits (#388).
 *
 * Enforces strict boundaries on incoming request payload size, JSON depth,
 * object key cardinality, array cardinality, string lengths, and query parameters.
 *
 * Defensive Design:
 *  - Stack-based AST traversal prevents Call Stack Overflow (CVE-class recursion attacks).
 *  - O(N) time complexity where N is the total number of nodes/properties.
 *  - O(D) space complexity where D <= MAX_OBJECT_DEPTH (strictly bounded).
 *  - Protects telemetry maps, JSON parsers, and DB queries against unbounded cardinality bursts.
 */

import { Request, Response, NextFunction } from 'express';
import { apiFailure } from '../types/api';

export interface InputLimits {
  /** Maximum allowable request body size in bytes (default 100 KB). */
  maxBodySizeBytes: number;
  /** Maximum allowable nesting depth for JSON objects/arrays (default 5). */
  maxObjectDepth: number;
  /** Maximum number of keys allowed in any single object (default 50). */
  maxObjectKeys: number;
  /** Maximum number of elements in any array (default 100). */
  maxArrayLength: number;
  /** Maximum length of any string primitive in payload (default 2048 chars). */
  maxStringLength: number;
  /** Maximum number of query parameters allowed (default 20). */
  maxQueryParams: number;
  /** Maximum byte/character length of the raw URL query string (default 1024 chars). */
  maxQueryStringLength: number;
  /** Maximum number of headers allowed on a request (default 50). */
  maxHeadersCount: number;
}

export const DEFAULT_INPUT_LIMITS: InputLimits = Object.freeze({
  maxBodySizeBytes: 100 * 1024,
  maxObjectDepth: 5,
  maxObjectKeys: 50,
  maxArrayLength: 100,
  maxStringLength: 2048,
  maxQueryParams: 20,
  maxQueryStringLength: 1024,
  maxHeadersCount: 50,
});

export type InputLimitViolationCode =
  | 'PAYLOAD_TOO_LARGE'
  | 'CARDINALITY_LIMIT_EXCEEDED'
  | 'INPUT_DEPTH_EXCEEDED'
  | 'STRING_LENGTH_EXCEEDED'
  | 'QUERY_TOO_LARGE';

export class InputLimitViolation extends Error {
  readonly code: InputLimitViolationCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: InputLimitViolationCode;
    message: string;
    httpStatus?: number;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = 'InputLimitViolation';
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? (options.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
    this.details = options.details;
  }
}

/**
 * Validates object depth, key cardinality, array lengths, and string bounds.
 * Uses an explicit iterative stack to guarantee O(N) runtime and O(D) memory without recursion.
 */
export function validateInputLimits(data: unknown, customLimits?: Partial<InputLimits>): void {
  if (data === null || data === undefined || typeof data !== 'object') {
    if (typeof data === 'string') {
      const maxStr = customLimits?.maxStringLength ?? DEFAULT_INPUT_LIMITS.maxStringLength;
      if (data.length > maxStr) {
        throw new InputLimitViolation({
          code: 'STRING_LENGTH_EXCEEDED',
          message: `String length ${data.length} exceeds maximum allowed of ${maxStr}`,
          details: { length: data.length, max: maxStr },
        });
      }
    }
    return;
  }

  const limits: InputLimits = { ...DEFAULT_INPUT_LIMITS, ...customLimits };

  // Explicit stack: [node, depth, path]
  const stack: Array<{ node: unknown; depth: number; path: string }> = [
    { node: data, depth: 1, path: 'root' },
  ];

  while (stack.length > 0) {
    const { node, depth, path } = stack.pop()!;

    if (depth > limits.maxObjectDepth) {
      throw new InputLimitViolation({
        code: 'INPUT_DEPTH_EXCEEDED',
        message: `Payload nesting depth at '${path}' exceeds maximum allowed depth of ${limits.maxObjectDepth}`,
        details: { depth, maxDepth: limits.maxObjectDepth, path },
      });
    }

    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) {
        throw new InputLimitViolation({
          code: 'CARDINALITY_LIMIT_EXCEEDED',
          message: `Array cardinality at '${path}' (${node.length} items) exceeds maximum allowed of ${limits.maxArrayLength}`,
          details: { length: node.length, max: limits.maxArrayLength, path },
        });
      }

      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          if (item.length > limits.maxStringLength) {
            throw new InputLimitViolation({
              code: 'STRING_LENGTH_EXCEEDED',
              message: `String at '${path}[${i}]' exceeds maximum length of ${limits.maxStringLength}`,
              details: { length: item.length, max: limits.maxStringLength, path: `${path}[${i}]` },
            });
          }
        } else if (item !== null && typeof item === 'object') {
          stack.push({ node: item, depth: depth + 1, path: `${path}[${i}]` });
        }
      }
    } else if (node !== null && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length > limits.maxObjectKeys) {
        throw new InputLimitViolation({
          code: 'CARDINALITY_LIMIT_EXCEEDED',
          message: `Object key cardinality at '${path}' (${keys.length} keys) exceeds maximum allowed of ${limits.maxObjectKeys}`,
          details: { keyCount: keys.length, maxKeys: limits.maxObjectKeys, path },
        });
      }

      for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }

        if (key.length > limits.maxStringLength) {
          throw new InputLimitViolation({
            code: 'STRING_LENGTH_EXCEEDED',
            message: `Object property key '${key.slice(0, 32)}...' exceeds maximum length of ${limits.maxStringLength}`,
            details: { length: key.length, max: limits.maxStringLength, path },
          });
        }

        const val = (node as Record<string, unknown>)[key];
        if (typeof val === 'string') {
          if (val.length > limits.maxStringLength) {
            throw new InputLimitViolation({
              code: 'STRING_LENGTH_EXCEEDED',
              message: `String property at '${path}.${key}' exceeds maximum length of ${limits.maxStringLength}`,
              details: { length: val.length, max: limits.maxStringLength, path: `${path}.${key}` },
            });
          }
        } else if (val !== null && typeof val === 'object') {
          stack.push({ node: val, depth: depth + 1, path: `${path}.${key}` });
        }
      }
    }
  }
}

/**
 * Strict Input Size and Cardinality Middleware for Express.
 */
export function strictInputLimitsMiddleware(customLimits?: Partial<InputLimits>) {
  const limits: InputLimits = { ...DEFAULT_INPUT_LIMITS, ...customLimits };

  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Enforce Header Cardinality
    const headerKeys = Object.keys(req.headers || {});
    if (headerKeys.length > limits.maxHeadersCount) {
      return res.status(400).json(
        apiFailure(`Request headers count (${headerKeys.length}) exceeds maximum allowed of ${limits.maxHeadersCount}`, {
          code: 'CARDINALITY_LIMIT_EXCEEDED',
          correlationId: req.correlationId,
          details: { count: headerKeys.length, max: limits.maxHeadersCount },
        })
      );
    }

    // 2. Enforce Content-Length before body parsing if present
    const contentLengthHeader = req.header('content-length');
    if (contentLengthHeader) {
      const len = parseInt(contentLengthHeader, 10);
      if (Number.isFinite(len) && len > limits.maxBodySizeBytes) {
        return res.status(413).json(
          apiFailure(`Request payload size (${len} bytes) exceeds maximum limit of ${limits.maxBodySizeBytes} bytes`, {
            code: 'PAYLOAD_TOO_LARGE',
            correlationId: req.correlationId,
            details: { sizeBytes: len, maxSizeBytes: limits.maxBodySizeBytes },
          })
        );
      }
    }

    // 3. Enforce Query String Cardinality & Length
    const urlParts = (req.url || '').split('?');
    if (urlParts.length > 1) {
      const rawQuery = urlParts[1];
      if (rawQuery.length > limits.maxQueryStringLength) {
        return res.status(400).json(
          apiFailure(`Query string length (${rawQuery.length}) exceeds maximum allowed of ${limits.maxQueryStringLength}`, {
            code: 'QUERY_TOO_LARGE',
            correlationId: req.correlationId,
            details: { length: rawQuery.length, max: limits.maxQueryStringLength },
          })
        );
      }
    }

    const queryParams = Object.keys(req.query || {});
    if (queryParams.length > limits.maxQueryParams) {
      return res.status(400).json(
        apiFailure(`Query parameters count (${queryParams.length}) exceeds maximum allowed of ${limits.maxQueryParams}`, {
          code: 'CARDINALITY_LIMIT_EXCEEDED',
          correlationId: req.correlationId,
          details: { count: queryParams.length, max: limits.maxQueryParams },
        })
      );
    }

    // 4. Enforce Deep Body Cardinality, Depth & Length if body is parsed
    if (req.body && typeof req.body === 'object') {
      try {
        validateInputLimits(req.body, limits);
      } catch (err) {
        if (err instanceof InputLimitViolation) {
          return res.status(err.httpStatus).json(
            apiFailure(err.message, {
              code: err.code,
              correlationId: req.correlationId,
              details: err.details,
            })
          );
        }
        return next(err);
      }
    }

    next();
  };
}
