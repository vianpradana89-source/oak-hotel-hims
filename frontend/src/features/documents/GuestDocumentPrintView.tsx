import { useState } from 'react';
import { Modal } from '../../design-system/Modal';
import { type PropertyInfoDto, type PropertyBrandingDto } from './GuestDocumentContent';
import ReservationConfirmationPrint from './ReservationConfirmationPrint';
import QuotationPrint from './QuotationPrint';
import './guestDocumentPrint.css';

export type GuestDocumentKind = 'confirmation' | 'quotation';

export interface GuestDocumentPrintProps {
  isOpen: boolean;
  kind: GuestDocumentKind;
  reservation: any;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
  onClose: () => void;
}

const DOCUMENT_TITLES: Record<GuestDocumentKind, string> = {
  confirmation: 'Konfirmasi Reservasi',
  quotation: 'Quotation / Penawaran',
};

export default function GuestDocumentPrintView({
  isOpen,
  kind,
  reservation,
  propertyInfo,
  propertyBranding,
  onClose,
}: GuestDocumentPrintProps) {
  const [previewKey, setPreviewKey] = useState(0);

  const handlePrint = () => {
    // Bump key so the print DOM is fresh; then trigger the browser print dialog.
    setPreviewKey((k) => k + 1);
    // Small delay lets the DOM update before the print dialog opens.
    setTimeout(() => window.print(), 60);
  };

  if (!isOpen) return null;

  const docProps = {
    reservation,
    propertyInfo,
    propertyBranding,
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={DOCUMENT_TITLES[kind]}
      size="full"
      closeOnOverlayClick={false}
      footer={
        <div className="guest-doc-controls flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={handlePrint}
            className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <span>Cetak / Save PDF</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      }
    >
      <div className="guest-doc-print-wrap">
        {kind === 'confirmation' ? (
          <ReservationConfirmationPrint key={previewKey} {...docProps} />
        ) : (
          <QuotationPrint key={previewKey} {...docProps} />
        )}
      </div>
    </Modal>
  );
}
