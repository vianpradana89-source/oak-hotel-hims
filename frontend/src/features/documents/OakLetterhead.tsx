import React from 'react';
import { type PropertyInfoDto, type PropertyBrandingDto } from './GuestDocumentContent';
import PropertyDocumentHeader from './PropertyDocumentHeader';
import logoPng from '../../assets/branding/oak-letterhead/logo.png';
import rosePng from '../../assets/branding/oak-letterhead/rose.png';
import watermarkPng from '../../assets/branding/oak-letterhead/watermark_center.png';

/**
 * OakLetterhead
 *
 * Reusable OAK branded A4 document wrapper.
 *
 * Visual elements:
 *   - thin muted-gold frame (1.5px border)
 *   - logo: top-left, resolved via getLogoServeUrl;
 *     the baked OAK Lawang logo asset is shown ONLY when the active property
 *     is clearly OAK Lawang (propertyCode "LWG" or name matches /oak lawang/i).
 *     Otherwise, no logo is rendered (text-only header) to avoid
 *     showing one hotel's logo on another hotel's document.
 *   - watermark: centered, low-opacity (0.07) -- OAK Lawang only
 *   - rose ornament: bottom-left corner -- OAK Lawang only
 *   - footer: canonical property address / phone first, system note secondary
 *   - tagline: optional, from propertyBranding
 *   - content slot: dynamic document body
 *
 * All identity data comes from props. No static hotel contact is hardcoded.
 */

export interface OakLetterheadProps {
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  /** Document title, e.g. "Konfirmasi Reservasi" */
  documentTitle: string;
  /** Dynamic document body content */
  children: React.ReactNode;
  /** Ref to the header element (for PDF snapshot) */
  headerRef?: React.Ref<HTMLDivElement>;
  /** Ref to the footer element (for PDF snapshot) */
  footerRef?: React.Ref<HTMLDivElement>;
}

/**
 * Returns true when the active property is clearly OAK Lawang.
 * The baked OAK Lawang logo and ornaments belong to OAK Lawang only.
 *
 * Heuristics (any hit = true):
 *   1. propertyCode === "LWG"   (canonical OAK Lawang property code)
 *   2. displayName / name matches /oak\s*lawang/i
 */
function isOakLawangProperty(
  propertyInfo?: PropertyInfoDto,
  propertyBranding?: PropertyBrandingDto,
): boolean {
  const code = (propertyInfo?.property_code || '').trim().toUpperCase();
  if (code === 'LWG') return true;
  const name = propertyBranding?.displayName || propertyInfo?.name || '';
  if (/oak\s*lawang/i.test(name.trim())) return true;
  return false;
}

export default function OakLetterhead({
  propertyInfo,
  propertyBranding,
  documentTitle,
  children,
  headerRef,
  footerRef,
}: OakLetterheadProps) {
  // Decide whether to show the baked OAK Lawang logo as fallback.
  // Rules:
  //   1. If property has an uploaded logoUrl → PropertyDocumentHeader resolves it via getLogoServeUrl.
  //   2. If no uploaded logo AND property is OAK Lawang → show baked logo asset.
  //   3. Otherwise → text-only header (no logo).
  const useBakedLogo =
    !propertyBranding?.logoUrl && isOakLawangProperty(propertyInfo, propertyBranding);

  // Multi-property ornament safety:
  // The baked watermark and rose are OAK Lawang-specific decorations.
  // They must NOT be shown on another property's document.
  const isOakLawang = isOakLawangProperty(propertyInfo, propertyBranding);
  const showOaksOrnaments = isOakLawang;

  // Dynamic brand colors from property branding
  const primaryColor = propertyBranding?.primaryColor || '#1b4332';
  const accentColor = propertyBranding?.accentColor || '#c5a880';

  const now = new Date();
  const printedDate = now.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className="oak-letterhead"
      style={{
        '--doc-primary-color': primaryColor,
        '--doc-accent-color': accentColor,
      } as React.CSSProperties}
    >
      {/* Gold frame */}
      <div className="oak-letterhead-frame">

        {/* Watermark - centered, very low opacity, OAK Lawang only */}
        {showOaksOrnaments && (
          <img
            src={watermarkPng}
            alt=""
            className="oak-letterhead-watermark"
            aria-hidden="true"
          />
        )}

        {/* Header: canonical A4 header with managed logo URL resolution */}
        <div
          ref={headerRef}
          data-html2canvas-ignore="true"
        >
          {useBakedLogo ? (
            /* OAK Lawang fallback: baked logo asset (local static bundle) */
            <div className="oak-letterhead-header">
              <img
                src={logoPng}
                alt=""
                className="oak-letterhead-logo"
              />
              <div className="oak-letterhead-info">
                <div className="oak-letterhead-hotel-name">
                  {propertyBranding?.displayName || propertyInfo?.name || 'Hotel'}
                </div>
                {propertyBranding?.tagline ? (
                  <div className="oak-letterhead-tagline">{propertyBranding.tagline}</div>
                ) : null}
                {propertyInfo?.property_code ? (
                  <div className="oak-letterhead-code">
                    Kode Properti: {propertyInfo.property_code}
                  </div>
                ) : null}
                {propertyInfo?.address ? (
                  <div className="oak-letterhead-address">{propertyInfo.address}</div>
                ) : null}
                {propertyInfo?.phone ? (
                  <div className="oak-letterhead-phone">Telp: {propertyInfo.phone}</div>
                ) : null}
              </div>
            </div>
          ) : (
            /* Property branding logo (managed via getLogoServeUrl) */
            <PropertyDocumentHeader
              propertyInfo={propertyInfo}
              propertyBranding={propertyBranding}
              propertyId={propertyInfo?.id ?? null}
            />
          )}
        </div>

        {/* Document title */}
        <div className="oak-letterhead-title">{documentTitle}</div>

        {/* Dynamic body */}
        <div className="oak-letterhead-body">{children}</div>

        {/* Rose ornament bottom-left, OAK Lawang only */}
        {showOaksOrnaments && (
          <img
            src={rosePng}
            alt=""
            className="oak-letterhead-rose"
            aria-hidden="true"
          />
        )}

        {/* Footer: canonical property data first, system note secondary */}
        <div
          className="oak-letterhead-footer"
          ref={footerRef}
          data-html2canvas-ignore="true"
        >
          {(propertyInfo?.address || propertyInfo?.phone) && (
            <div className="oak-letterhead-footer-contact">
              {propertyInfo?.address ? <span>{propertyInfo.address}</span> : null}
              {propertyInfo?.address && propertyInfo?.phone ? <span>&nbsp;|&nbsp;</span> : null}
              {propertyInfo?.phone ? <span>Telp: {propertyInfo.phone}</span> : null}
            </div>
          )}
          <div className="oak-letterhead-footer-system">
            <span>
              Dokumen ini dicetak secara otomatis dari sistem OAK HIMS
            </span>
            <span>Waktu cetak: {printedDate}</span>
          </div>
        </div>

      </div>
    </div>
  );
}
