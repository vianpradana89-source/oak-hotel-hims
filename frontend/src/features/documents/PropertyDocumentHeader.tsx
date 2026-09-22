import { getLogoServeUrl } from '../propertySettings/propertyBrandingApi';
import type { PropertyInfoDto, PropertyBrandingDto } from './GuestDocumentContent';

export interface PropertyDocumentHeaderProps {
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  /** Required for logo URL resolution when logoUrl is a managed storage key */
  propertyId?: number | null;
}

/**
 * PropertyDocumentHeader
 *
 * Shared A4 document header that renders property branding consistently
 * across all OAK HIMS A4 documents (Reservation Confirmation, Quotation,
 * Invoice, Form Registrasi).
 *
 * Features:
 *   - Resolves managed branding storage keys to backend serve URLs via getLogoServeUrl
 *   - External / manual URLs are passed through unchanged
 *   - Displays logo (if available), hotel name, tagline, property code
 *   - Address and phone are intentionally NOT shown here; they live in the footer
 *
 * Note: OAK Lawang baked-logo fallback is handled by OakLetterhead, not this component.
 */
export default function PropertyDocumentHeader({
  propertyInfo,
  propertyBranding,
  propertyId,
}: PropertyDocumentHeaderProps) {
  const hotelName =
    propertyBranding?.displayName || propertyInfo?.name || 'Hotel';
  const tagline = propertyBranding?.tagline;
  const propertyCode = propertyInfo?.property_code;

  // Resolve logo URL:
  //   - If the value is a managed branding key (starts with "branding/"),
  //     resolve it via getLogoServeUrl. On failure return null — never pass
  //     a raw storage key directly to <img src>.
  //   - Otherwise treat it as an external/manual URL and use it as-is.
  const resolvedLogoUrl: string | null = (() => {
    const rawLogoUrl = propertyBranding?.logoUrl;
    if (!rawLogoUrl) return null;

    if (typeof rawLogoUrl === 'string' && rawLogoUrl.startsWith('branding/')) {
      return getLogoServeUrl(rawLogoUrl, propertyId ?? undefined);
    }

    return rawLogoUrl;
  })();

  return (
    <div className="oak-letterhead-header">
      {resolvedLogoUrl ? (
        <img
          src={resolvedLogoUrl}
          alt=""
          className="oak-letterhead-logo"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
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
  );
}
