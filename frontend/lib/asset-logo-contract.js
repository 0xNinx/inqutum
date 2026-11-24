'use strict';

/**
 * AssetLogo view contract (issue #159).
 *
 * A logo is presentation only: it must never imply a different asset than the
 * record asked for, and a missing or broken logo must degrade to readable text
 * instead of a broken image. The lookup stays in the component (the catalog is
 * typed TypeScript); this module validates the resolution and the display
 * inputs, including edge cases the catalog cannot guarantee.
 */

const ASSET_LOGO_COPY = Object.freeze({
  unknownCode: '?',
  invalidRecovery: 'Select a supported Stellar asset and try again.',
  logoRecovery: 'The asset logo is unavailable; the asset code is shown instead.',
});

const MIN_SIZE = 8;
const MAX_SIZE = 256;

function normalizeAssetCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function safeText(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function safeSize(size) {
  const raw = typeof size === 'number' && Number.isFinite(size) ? size : NaN;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(Number.isNaN(raw) ? 24 : raw)));
}

function resolveAssetLogoViewModel(code, options) {
  const input = options && typeof options === 'object' ? options : {};
  const normalizedCode = normalizeAssetCode(code);
  const asset = input.asset && typeof input.asset === 'object' ? input.asset : null;
  const size = safeSize(input.size);
  const showName = input.showName === undefined ? true : Boolean(input.showName);
  const assetCode = safeText(asset?.code, 16);
  const name = safeText(asset?.name, 80);
  const logo = safeText(asset?.logo, 512);
  const safeLogo = logo && /^https?:\/\/[^\s]+$/i.test(logo) ? logo : null;

  if (!normalizedCode) {
    return {
      kind: 'fallback',
      isValid: false,
      code: '',
      assetCode: null,
      name: null,
      logo: null,
      containerSize: size,
      imageSize: Math.max(1, size - 4),
      showName,
      label: null,
      fallbackText: ASSET_LOGO_COPY.unknownCode,
      degraded: true,
      reasonCode: 'INVALID_ASSET_CODE',
      recoveryAction: ASSET_LOGO_COPY.invalidRecovery,
    };
  }

  if (!asset || assetCode !== normalizedCode || !name || !safeLogo) {
    return {
      kind: 'fallback',
      isValid: false,
      code: normalizedCode,
      assetCode: assetCode || null,
      name,
      logo: null,
      containerSize: size,
      imageSize: Math.max(1, size - 4),
      showName,
      label: assetCode && showName ? assetCode : null,
      fallbackText: normalizedCode,
      degraded: true,
      reasonCode: 'ASSET_NOT_FOUND',
      recoveryAction: safeLogo ? ASSET_LOGO_COPY.invalidRecovery : ASSET_LOGO_COPY.logoRecovery,
    };
  }

  return {
    kind: 'logo',
    isValid: true,
    code: normalizedCode,
    assetCode,
    name,
    logo: safeLogo,
    containerSize: size,
    imageSize: Math.max(1, size - 4),
    showName,
    label: showName ? assetCode : null,
    fallbackText: assetCode,
    degraded: false,
    reasonCode: null,
    recoveryAction: null,
  };
}

module.exports = {
  ASSET_LOGO_COPY,
  normalizeAssetCode,
  resolveAssetLogoViewModel,
};
