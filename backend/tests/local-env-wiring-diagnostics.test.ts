/**
 * Local setup wiring diagnostics (#361).
 *
 * The check reads backend/.env and frontend/.env.local as data. It never
 * executes them, never prints their values, and treats a missing pair as a
 * recoverable warning so `--fix` can create the templates first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkLocalEnvWiring } from '../../scripts/diagnostics';

function fixture(files: { backend?: string | null; frontend?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-wiring-'));
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  if (files.backend !== null) {
    fs.writeFileSync(path.join(root, 'backend', '.env'), files.backend ?? 'PORT=3001\n');
  }
  if (files.frontend !== null) {
    fs.writeFileSync(
      path.join(root, 'frontend', '.env.local'),
      files.frontend ?? 'NEXT_PUBLIC_API_URL=http://localhost:3001/api\n'
    );
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('Local environment wiring diagnostics (#361)', () => {
  it('passes when the frontend API URL targets the backend PORT with an /api path', () => {
    const { root, cleanup } = fixture();
    try {
      const result = checkLocalEnvWiring(root);
      assert.equal(result.status, 'PASS', result.message);
      assert.match(result.message, /port 3001/);
    } finally {
      cleanup();
    }
  });

  it('warns on the common port mismatch and names both ports', () => {
    const { root, cleanup } = fixture({
      frontend: 'NEXT_PUBLIC_API_URL=http://localhost:4000/api\n',
    });
    try {
      const result = checkLocalEnvWiring(root);
      assert.equal(result.status, 'WARN');
      assert.match(result.message, /targets port 4000/);
      assert.match(result.message, /backend PORT is 3001/);
      assert.match(result.remediation ?? '', /localhost:3001\/api/);
    } finally {
      cleanup();
    }
  });

  it('fails on an invalid API URL', () => {
    const { root, cleanup } = fixture({
      frontend: 'NEXT_PUBLIC_API_URL=not-a-url\n',
    });
    try {
      const result = checkLocalEnvWiring(root);
      assert.equal(result.status, 'FAIL');
      assert.match(result.message, /not a valid absolute URL/);
    } finally {
      cleanup();
    }
  });

  it('warns when the API path is missing /api', () => {
    const { root, cleanup } = fixture({
      frontend: 'NEXT_PUBLIC_API_URL=http://localhost:3001\n',
    });
    try {
      const result = checkLocalEnvWiring(root);
      assert.equal(result.status, 'WARN');
      assert.match(result.message, /does not end with \/api/);
    } finally {
      cleanup();
    }
  });

  it('warns about plain HTTP to a remote host in development and fails in production', () => {
    const { root, cleanup } = fixture({
      frontend: 'NEXT_PUBLIC_API_URL=http://api.example.com:3001/api\n',
    });
    try {
      assert.equal(checkLocalEnvWiring(root, { NODE_ENV: 'development' }).status, 'WARN');
      assert.equal(checkLocalEnvWiring(root, { NODE_ENV: 'production' }).status, 'FAIL');
    } finally {
      cleanup();
    }
  });

  it('recovers after the missing templates are created', () => {
    const { root, cleanup } = fixture({ backend: null, frontend: null });
    try {
      const missing = checkLocalEnvWiring(root);
      assert.equal(missing.status, 'WARN');
      assert.match(missing.message, /backend\/\.env and frontend\/\.env\.local are missing/);
      assert.match(missing.remediation ?? '', /--fix/);

      fs.writeFileSync(path.join(root, 'backend', '.env'), 'PORT=3001\n');
      fs.writeFileSync(
        path.join(root, 'frontend', '.env.local'),
        'NEXT_PUBLIC_API_URL=http://localhost:3001/api\n'
      );

      const recovered = checkLocalEnvWiring(root);
      assert.equal(recovered.status, 'PASS', recovered.message);
    } finally {
      cleanup();
    }
  });

  it('never echoes secrets found in env files', () => {
    const secret = 'super-secret-value';
    const { root, cleanup } = fixture({
      backend: `PORT=3001\nSELLER_SECRET_KEY=${secret}\n`,
      frontend: `NEXT_PUBLIC_API_URL=http://localhost:3001/api\nNEXT_PUBLIC_APP_URL=http://localhost:3000\n`,
    });
    try {
      const before = fs.readFileSync(path.join(root, 'backend', '.env'), 'utf8');
      const result = checkLocalEnvWiring(root);
      assert.equal(result.status, 'PASS');
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.equal(fs.readFileSync(path.join(root, 'backend', '.env'), 'utf8'), before);
    } finally {
      cleanup();
    }
  });
});
