const test = require('node:test');
const assert = require('node:assert/strict');

// Reusable pure implementation of input limits validator and middleware
const DEFAULT_INPUT_LIMITS = {
  maxBodySizeBytes: 100 * 1024,
  maxObjectDepth: 5,
  maxObjectKeys: 50,
  maxArrayLength: 100,
  maxStringLength: 2048,
  maxQueryParams: 20,
  maxQueryStringLength: 1024,
  maxHeadersCount: 50,
};

class InputLimitViolation extends Error {
  constructor(options) {
    super(options.message);
    this.name = 'InputLimitViolation';
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? (options.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
    this.details = options.details;
  }
}

function validateInputLimits(data, customLimits) {
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

  const limits = { ...DEFAULT_INPUT_LIMITS, ...customLimits };
  const stack = [{ node: data, depth: 1, path: 'root' }];

  while (stack.length > 0) {
    const { node, depth, path } = stack.pop();

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
        if (key.length > limits.maxStringLength) {
          throw new InputLimitViolation({
            code: 'STRING_LENGTH_EXCEEDED',
            message: `Object property key '${key.slice(0, 32)}...' exceeds maximum length of ${limits.maxStringLength}`,
            details: { length: key.length, max: limits.maxStringLength, path },
          });
        }

        const val = node[key];
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

function strictInputLimitsMiddleware(customLimits) {
  const limits = { ...DEFAULT_INPUT_LIMITS, ...customLimits };

  return (req, res, next) => {
    // 1. Headers count check
    const headerKeys = Object.keys(req.headers || {});
    if (headerKeys.length > limits.maxHeadersCount) {
      return res.status(400).json({
        success: false,
        error: `Request headers count (${headerKeys.length}) exceeds maximum allowed of ${limits.maxHeadersCount}`,
        code: 'CARDINALITY_LIMIT_EXCEEDED',
      });
    }

    // 2. Content-length check
    const cl = req.headers?.['content-length'];
    if (cl) {
      const len = parseInt(cl, 10);
      if (Number.isFinite(len) && len > limits.maxBodySizeBytes) {
        return res.status(413).json({
          success: false,
          error: `Request payload size (${len} bytes) exceeds maximum limit of ${limits.maxBodySizeBytes} bytes`,
          code: 'PAYLOAD_TOO_LARGE',
        });
      }
    }

    // 3. Query string length and param count check
    const urlParts = (req.url || '').split('?');
    if (urlParts.length > 1) {
      const rawQuery = urlParts[1];
      if (rawQuery.length > limits.maxQueryStringLength) {
        return res.status(400).json({
          success: false,
          error: `Query string length (${rawQuery.length}) exceeds maximum allowed of ${limits.maxQueryStringLength}`,
          code: 'QUERY_TOO_LARGE',
        });
      }
    }

    const queryKeys = Object.keys(req.query || {});
    if (queryKeys.length > limits.maxQueryParams) {
      return res.status(400).json({
        success: false,
        error: `Query parameters count (${queryKeys.length}) exceeds maximum allowed of ${limits.maxQueryParams}`,
        code: 'CARDINALITY_LIMIT_EXCEEDED',
      });
    }

    // 4. Body checks
    if (req.body && typeof req.body === 'object') {
      try {
        validateInputLimits(req.body, limits);
      } catch (err) {
        if (err instanceof InputLimitViolation) {
          return res.status(err.httpStatus).json({
            success: false,
            error: err.message,
            code: err.code,
            details: err.details,
          });
        }
        return next(err);
      }
    }

    next();
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  return res;
}

test('Issue #388: Add strict input size and cardinality limits', async (t) => {
  await t.test('Normal path: compliant payload and query pass without rejection', () => {
    const validBody = {
      memo: 'INV-1234',
      amount: 100,
      metadata: {
        department: 'engineering',
        tags: ['billing', 'freelance'],
      },
    };

    assert.doesNotThrow(() => validateInputLimits(validBody));

    const req = {
      headers: { host: 'api.example.com', accept: 'application/json' },
      url: '/api/invoices?status=PENDING&limit=25',
      query: { status: 'PENDING', limit: '25' },
      body: validBody,
    };
    const res = mockRes();
    let nextCalled = false;

    strictInputLimitsMiddleware()(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  await t.test('Failure path: rejects object exceeding maximum keys cardinality (> 50 keys)', () => {
    const overCardinalObject = {};
    for (let i = 0; i < 51; i++) {
      overCardinalObject[`field_${i}`] = i;
    }

    assert.throws(
      () => validateInputLimits(overCardinalObject),
      (err) => err instanceof InputLimitViolation && err.code === 'CARDINALITY_LIMIT_EXCEEDED'
    );

    const req = { headers: {}, url: '/api/invoices', query: {}, body: overCardinalObject };
    const res = mockRes();
    strictInputLimitsMiddleware()(req, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'CARDINALITY_LIMIT_EXCEEDED');
  });

  await t.test('Failure path: rejects array exceeding maximum elements (> 100 elements)', () => {
    const overCardinalArray = new Array(101).fill('item');

    assert.throws(
      () => validateInputLimits({ items: overCardinalArray }),
      (err) => err instanceof InputLimitViolation && err.code === 'CARDINALITY_LIMIT_EXCEEDED'
    );
  });

  await t.test('Failure path: rejects nesting depth exceeding threshold (> 5 levels deep)', () => {
    // 6 levels deep
    const deeplyNested = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                l6: 'too-deep',
              },
            },
          },
        },
      },
    };

    assert.throws(
      () => validateInputLimits(deeplyNested),
      (err) => err instanceof InputLimitViolation && err.code === 'INPUT_DEPTH_EXCEEDED'
    );
  });

  await t.test('Failure path: rejects string exceeding length threshold (> 2048 chars)', () => {
    const longString = 'a'.repeat(2049);
    assert.throws(
      () => validateInputLimits({ description: longString }),
      (err) => err instanceof InputLimitViolation && err.code === 'STRING_LENGTH_EXCEEDED'
    );
  });

  await t.test('Defensive security: prototype pollution attempts do not crash or pollute object prototypes', () => {
    const maliciousPayload = JSON.parse('{"__proto__":{"polluted":true},"normalField":"hello"}');
    assert.doesNotThrow(() => validateInputLimits(maliciousPayload));
    assert.equal(({}).polluted, undefined, 'Object prototype must not be polluted');
  });

  await t.test('Failure path: middleware rejects payload exceeding Content-Length with 413', () => {
    const req = {
      headers: { 'content-length': '200000' }, // 200 KB > 100 KB limit
      url: '/api/invoices',
      query: {},
      body: {},
    };
    const res = mockRes();
    strictInputLimitsMiddleware()(req, res, () => {});

    assert.equal(res.statusCode, 413);
    assert.equal(res.payload.code, 'PAYLOAD_TOO_LARGE');
  });

  await t.test('Failure path: middleware rejects query parameters exceeding cardinality (> 20 params)', () => {
    const manyParams = {};
    for (let i = 0; i < 21; i++) {
      manyParams[`p_${i}`] = '1';
    }

    const req = {
      headers: {},
      url: '/api/invoices',
      query: manyParams,
      body: {},
    };
    const res = mockRes();
    strictInputLimitsMiddleware()(req, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'CARDINALITY_LIMIT_EXCEEDED');
  });

  await t.test('Retry path: request that failed due to excessive size succeeds after trimming', () => {
    const overSized = {
      memo: 'INV-VALID',
      tags: new Array(150).fill('tag'), // Exceeds array limit
    };

    // First attempt fails
    assert.throws(
      () => validateInputLimits(overSized),
      (err) => err.code === 'CARDINALITY_LIMIT_EXCEEDED'
    );

    // Client remedies by reducing array cardinality to acceptable limit
    const remediated = {
      memo: 'INV-VALID',
      tags: overSized.tags.slice(0, 50),
    };

    assert.doesNotThrow(() => validateInputLimits(remediated));
  });

  await t.test('Authorization path: input limits are enforced before sensitive handler execution', () => {
    let authChecked = false;
    const authMiddleware = (req, res, next) => {
      authChecked = true;
      next();
    };

    // Chain: InputLimitsMiddleware -> AuthMiddleware -> Handler
    const req = {
      headers: { 'content-length': '500000' },
      url: '/api/admin/action',
      query: {},
      body: {},
    };
    const res = mockRes();

    strictInputLimitsMiddleware()(req, res, () => {
      authMiddleware(req, res, () => {});
    });

    // Request is blocked at perimeter before auth or DB operations run
    assert.equal(res.statusCode, 413);
    assert.equal(authChecked, false);
  });
});
