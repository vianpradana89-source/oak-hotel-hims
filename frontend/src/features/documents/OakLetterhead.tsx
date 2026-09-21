import React from 'react';
import { type PropertyInfoDto, type PropertyBrandingDto } from './GuestDocumentContent';
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
 *   - logo: top-left, from propertyBranding.logoUrl when available;
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
  const hotelName =
    propertyBranding?.displayName || propertyInfo?.name || 'Hotel';
  const tagline = propertyBranding?.tagline;
  const address = propertyInfo?.address;
  const phone = propertyInfo?.phone;
  const propertyCode = propertyInfo?.property_code;

  // Multi-property logo safety:
  // - Use propertyBranding.logoUrl whenever it is set (any property with its own logo).
  // - Otherwise, show the baked OAK Lawang logo ONLY when the property is OAK Lawang.
  // - Otherwise, no logo is shown (text-only header).
  const useBakedLogo =
    !propertyBranding?.logoUrl && isOakLawangProperty(propertyInfo, propertyBranding);
  const showLogo = Boolean(propertyBranding?.logoUrl) || useBakedLogo;
  const logoSrc = propertyBranding?.logoUrl || logoPng;

  // Multi-property ornament safety:
  // The baked watermark and rose are OAK Lawang-specific decorations.
  // They must NOT be shown on another property's document.
  const isOakLawang = isOakLawangProperty(propertyInfo, propertyBranding);
  const showOaksOrnaments = isOakLawang;

  const now = new Date();
  const printedDate = now.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="oak-letterhead">
      {/* Gold frame */}
      <div className="oak-letterhead-frame">

        {/* Watermark - centered, very low opacity */}
        {showOaksOrnaments && (
          <img
            src={watermarkPng}
            alt=""
            className="oak-letterhead-watermark"
            aria-hidden="true"
          />
        )}

        {/* Header: logo + hotel info */}
        <div
          className="oak-letterhead-header"
          ref={headerRef}
          data-html2canvas-ignore="true"
        >
          {showLogo ? (
            <img
              src={logoSrc}
              alt=""
              className="oak-letterhead-logo"
              onError={(e) => {
                // If the remote logo fails and we are NOT on OAK Lawang, hide it.
                const img = e.target as HTMLImageElement;
                if (isOakLawangProperty(propertyInfo, propertyBranding)) {
                  img.src = logoPng;
                } else {
                  img.style.display = 'none';
                }
              }}
            />
          ) : null}
          <div className="oak-letterhead-info">
            <div className="oak-letterhead-hotel-name">{hotelName}</div>
            {tagline ? (
              <div className="oak-letterhead-tagline">{tagline}</div>
            ) : null}
            {propertyCode ? (
              <div className="oak-letterhead-code">
                Kode Properti: {propertyCode}
              </div>
            ) : null}
          </div>
        </div>

        {/* Document title */}
        <div className="oak-letterhead-title">{documentTitle}</div>

        {/* Dynamic body */}
        <div className="oak-letterhead-body">{children}</div>

        {/* Rose ornament bottom-left */}
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
          {(address || phone) && (
            <div className="oak-letterhead-footer-contact">
              {address ? <span>{address}</span> : null}
              {address && phone ? <span>&nbsp;|&nbsp;</span> : null}
              {phone ? <span>Telp: {phone}</span> : null}
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
