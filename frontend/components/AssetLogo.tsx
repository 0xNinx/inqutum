'use client';

import Image from 'next/image';
import { normalizeAssetCode, resolveAssetLogoViewModel } from '@/lib/asset-logo-contract';
import { getAssetByCode } from '@/lib/assets';

interface AssetLogoProps {
  code: string;
  size?: number;
  showName?: boolean;
  className?: string;
}

export default function AssetLogo({
  code,
  size = 24,
  showName = true,
  className = '',
}: AssetLogoProps) {
  const normalizedCode = normalizeAssetCode(code);
  const asset = normalizedCode ? getAssetByCode(normalizedCode) : undefined;
  const view = resolveAssetLogoViewModel(code, { asset, size, showName });

  if (view.kind === 'fallback' || !view.logo || !view.name || !view.assetCode) {
    return (
      <span className={className} data-asset-code={view.assetCode ?? undefined}>
        {view.label || view.fallbackText}
      </span>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className}`} data-asset-code={view.assetCode}>
      <div
        className="rounded-full overflow-hidden flex items-center justify-center bg-white shadow-sm border border-gray-100"
        style={{
          width: view.containerSize,
          height: view.containerSize,
          minWidth: view.containerSize,
          minHeight: view.containerSize,
          padding: '2px',
        }}
      >
        <Image
          src={view.logo}
          alt={view.name}
          width={view.imageSize}
          height={view.imageSize}
          className="object-contain rounded-full"
          unoptimized
          priority
        />
      </div>
      {view.label && (
        <span className="font-semibold">{view.label}</span>
      )}
    </div>
  );
}
