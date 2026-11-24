export interface AssetLogoAsset {
  code?: unknown;
  name?: unknown;
  logo?: unknown;
}

export type AssetLogoReasonCode = 'INVALID_ASSET_CODE' | 'ASSET_NOT_FOUND';

export interface AssetLogoViewModel {
  kind: 'logo' | 'fallback';
  isValid: boolean;
  code: string;
  assetCode: string | null;
  name: string | null;
  logo: string | null;
  containerSize: number;
  imageSize: number;
  showName: boolean;
  label: string | null;
  fallbackText: string;
  degraded: boolean;
  reasonCode: AssetLogoReasonCode | null;
  recoveryAction: string | null;
}

export const ASSET_LOGO_COPY: {
  readonly unknownCode: string;
  readonly invalidRecovery: string;
  readonly logoRecovery: string;
};

export function normalizeAssetCode(code: unknown): string;
export function resolveAssetLogoViewModel(
  code: unknown,
  options?: {
    asset?: AssetLogoAsset | null;
    size?: number;
    showName?: boolean;
  }
): AssetLogoViewModel;
