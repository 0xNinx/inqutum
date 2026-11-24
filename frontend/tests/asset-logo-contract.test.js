const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ASSET_LOGO_COPY,
  normalizeAssetCode,
  resolveAssetLogoViewModel,
} = require('../lib/asset-logo-contract');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'AssetLogo.tsx'), 'utf8');
const USDC = {
  code: 'USDC',
  name: 'USD Coin',
  logo: 'https://assets.example.com/usdc.png',
};

test('success: a known asset renders its own logo, name and code', () => {
  const view = resolveAssetLogoViewModel('usdc', { asset: USDC, size: 24 });
  assert.equal(view.kind, 'logo');
  assert.equal(view.isValid, true);
  assert.equal(view.code, 'USDC');
  assert.equal(view.assetCode, 'USDC');
  assert.equal(view.name, 'USD Coin');
  assert.equal(view.logo, USDC.logo);
  assert.equal(view.imageSize, 20);
  assert.equal(view.containerSize, 24);
  assert.equal(view.label, 'USDC');
  assert.equal(view.degraded, false);
});

test('success: showName=false keeps the logo but hides the label', () => {
  const view = resolveAssetLogoViewModel('XLM', { asset: USDC, showName: false });
  assert.equal(view.kind, 'fallback');
  const valid = resolveAssetLogoViewModel('USDC', { asset: USDC, showName: false });
  assert.equal(valid.kind, 'logo');
  assert.equal(valid.label, null);
  assert.equal(valid.showName, false);
});

test('validation: missing or non-string codes resolve to a safe placeholder', () => {
  for (const code of [undefined, null, '', '   ', 42, {}, []]) {
    const view = resolveAssetLogoViewModel(code, { asset: USDC });
    assert.equal(view.kind, 'fallback');
    assert.equal(view.reasonCode, 'INVALID_ASSET_CODE');
    assert.equal(view.fallbackText, ASSET_LOGO_COPY.unknownCode);
    assert.equal(view.logo, null);
    assert.equal(view.degraded, true);
  }
  assert.equal(normalizeAssetCode('  usdc '), 'USDC');
  assert.equal(normalizeAssetCode(null), '');
});

test('validation: an asset that does not match the requested code is never shown', () => {
  const view = resolveAssetLogoViewModel('USDT', { asset: USDC });
  assert.equal(view.kind, 'fallback');
  assert.equal(view.reasonCode, 'ASSET_NOT_FOUND');
  assert.equal(view.fallbackText, 'USDT');
  assert.equal(view.logo, null);
});

test('degraded dependency: a missing or unsafe logo falls back to readable code text', () => {
  for (const logo of [undefined, '', '   ', '/local.png', 'javascript:alert(1)', 42]) {
    const view = resolveAssetLogoViewModel('USDC', { asset: { ...USDC, logo } });
    assert.equal(view.kind, 'fallback');
    assert.equal(view.reasonCode, 'ASSET_NOT_FOUND');
    assert.equal(view.logo, null);
    assert.equal(view.fallbackText, 'USDC');
    assert.equal(view.recoveryAction, ASSET_LOGO_COPY.logoRecovery);
  }
  const incomplete = resolveAssetLogoViewModel('USDC', { asset: { code: 'USDC', logo: USDC.logo } });
  assert.equal(incomplete.kind, 'fallback');
  assert.equal(incomplete.degraded, true);
});

test('validation: display size is clamped and image dimensions stay positive', () => {
  for (const size of [0, -10, 1, NaN, Infinity, '24', null]) {
    const view = resolveAssetLogoViewModel('USDC', { asset: USDC, size });
    assert.ok(view.containerSize >= 8 && view.containerSize <= 256);
    assert.ok(view.imageSize >= 1 && view.imageSize < view.containerSize);
    assert.equal(Number.isInteger(view.containerSize), true);
  }
  const clamped = resolveAssetLogoViewModel('USDC', { asset: USDC, size: 999 });
  assert.equal(clamped.containerSize, 256);
  assert.equal(clamped.imageSize, 252);
});

test('component: the logo and fallback both come from the view contract', () => {
  assert.match(source, /resolveAssetLogoViewModel\(code, \{ asset, size, showName \}\)/);
  assert.match(source, /normalizeAssetCode\(code\)/);
  assert.match(source, /getAssetByCode\(normalizedCode\)/);
  assert.match(source, /view\.kind === 'fallback'/);
  assert.match(source, /src=\{view\.logo\}/);
  assert.match(source, /data-asset-code=\{view\.assetCode/);
  assert.doesNotMatch(source, /src=\{asset\.logo\}/);
});
