import React, { useState } from 'react';

export interface OakLogoProps {
  /**
   * 'compact' = circular badge/mark only (~32-40px)
   * 'full' = circular badge/mark + brand typography & subtitle
   * 'mark' = standalone mark element
   */
  variant?: 'compact' | 'full' | 'mark';
  /**
   * Configured image URL (e.g. from official static asset or property branding)
   */
  customLogoUrl?: string | null;
  /**
   * System product brand or property brand label (default: 'OAK HIMS')
   */
  brandTitle?: string;
  /**
   * Subtitle under the brand title (e.g. 'Hospitality Management' or property short code)
   */
  subtitle?: string;
  /**
   * Size in pixels for the mark (default: 36)
   */
  size?: number;
  /**
   * Accent color for badge border/ring (default: '#c5a880')
   */
  accentColor?: string;
  className?: string;
}

/**
 * Official OAK Logo & Brand Renderer Component
 *
 * IMPORTANT ARCHITECTURAL DIRECTIVE:
 * - This component is a RENDERER / WRAPPER, NOT an artwork source.
 * - Brand marks are authoritative hotel assets placed under `frontend/src/assets/branding/`.
 * - When official image assets are not loaded, this component displays a neutral, clean
 *   typographic monogram placeholder. It NEVER generates or draws fabricated tree artwork.
 */
export const OakLogo: React.FC<OakLogoProps> = ({
  variant = 'full',
  customLogoUrl,
  brandTitle = 'OAK HIMS',
  subtitle,
  size = 36,
  accentColor = '#c5a880',
  className = '',
}) => {
  const [imgError, setImgError] = useState(false);

  // Derive monogram text (e.g. "OAK" or first letter)
  const monogram = brandTitle.trim().slice(0, 3).toUpperCase() || 'OAK';

  // Render the circular emblem badge (Image if available, else clean neutral monogram)
  const renderMark = () => {
    if (customLogoUrl && !imgError) {
      return (
        <img
          src={customLogoUrl}
          alt={brandTitle}
          onError={() => setImgError(true)}
          style={{ width: size, height: size }}
          className="rounded-full object-cover border border-amber-300/40 shadow-xs shrink-0"
        />
      );
    }

    // Neutral typographic monogram placeholder (No fabricated tree SVG artwork)
    return (
      <div
        style={{
          width: size,
          height: size,
          borderColor: accentColor,
        }}
        className="rounded-full bg-[#131b24] text-[#c5a880] border flex items-center justify-center font-bold tracking-wider select-none shrink-0 shadow-xs"
        title={brandTitle}
        aria-label={`${brandTitle} Emblem`}
      >
        <span style={{ fontSize: Math.max(10, Math.floor(size * 0.35)) }}>
          {monogram.length <= 3 ? monogram : monogram.slice(0, 1)}
        </span>
      </div>
    );
  };

  if (variant === 'mark' || variant === 'compact') {
    return (
      <div className={`inline-flex items-center justify-center shrink-0 ${className}`} title={brandTitle}>
        {renderMark()}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 overflow-hidden select-none ${className}`}>
      {renderMark()}

      <div className="flex flex-col min-w-0 justify-center">
        <div className="flex items-center gap-1.5">
          <span className="font-bold tracking-wider text-sm text-slate-100 uppercase truncate">
            {brandTitle}
          </span>
          <span className="text-xs font-semibold px-1.5 py-0.2 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded shrink-0">
            HIMS
          </span>
        </div>
        {subtitle && (
          <span className="text-xs text-slate-400 truncate tracking-wide">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
};
