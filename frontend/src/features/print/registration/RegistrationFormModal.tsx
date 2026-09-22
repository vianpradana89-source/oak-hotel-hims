import React from 'react';
import { useState } from 'react';
import { Modal } from '../../../design-system/Modal';
import type { PropertyInfoDto, PropertyBrandingDto } from '../../documents/GuestDocumentContent';
import { REGISTRATION_FORM_DEFAULT_TERMS } from './registrationFormDraft';
import RegistrationFormPrint from './RegistrationFormPrint';
import './registrationForm.css';

export interface RegistrationFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservationId: number;
  propertyId: number | null;
  reservation: any;
  propertyBranding?: PropertyBrandingDto;
  propertyInfo?: PropertyInfoDto;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export default function RegistrationFormModal({
  isOpen,
  onClose,
  reservationId,
  propertyId,
  reservation,
  propertyBranding,
  propertyInfo,
  authFetch,
}: RegistrationFormModalProps) {
  const [terms, setTerms] = useState(REGISTRATION_FORM_DEFAULT_TERMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folioFinancials, setFolioFinancials] = useState<any>(null);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [identityRecord, setIdentityRecord] = useState<any>(null);

  React.useEffect(() => {
    if (!isOpen || !propertyId) return;
    setLoading(true);
    setError(null);

    Promise.all([
      authFetch(`/api/reservations/${reservationId}/folio?property_id=${propertyId}`)
        .then(r => r.json())
        .then(json => json?.data?.authoritative_financials || null)
        .catch(() => null),
      authFetch(`/api/reservations/${reservationId}/deposits?property_id=${propertyId}`)
        .then(r => r.json())
        .then(json => Array.isArray(json?.data) ? json.data : [])
        .catch(() => []),
      authFetch(`/api/reservations/${reservationId}/identity-custody?property_id=${propertyId}`)
        .then(r => r.json())
        .then(json => Array.isArray(json?.data) && json.data.length > 0 ? json.data[0] : null)
        .catch(() => null),
    ])
      .then(([fin, deps, id]) => {
        setFolioFinancials(fin);
        setDeposits(deps);
        setIdentityRecord(id);
      })
      .catch((err) => {
        setError(err?.message || 'Gagal memuat data');
      })
      .finally(() => setLoading(false));
  }, [isOpen, reservationId, propertyId, authFetch]);

  const handlePrint = () => {
    window.print();
  };

  const handleClose = () => {
    setTerms(REGISTRATION_FORM_DEFAULT_TERMS);
    onClose();
  };

  const handleResetTerms = () => {
    setTerms(REGISTRATION_FORM_DEFAULT_TERMS);
  };

  if (!isOpen) return null;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Formulir Registrasi"
        subtitle="Pratinjau formulir registrasi dan deposit A4"
        size="full"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="px-4 py-2 bg-emerald-800 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <span>Cetak</span>
            </button>
          </div>
        }
      >
        {loading ? (
          <div className="reg-form-loading">
            Memuat data...
          </div>
        ) : error ? (
          <div className="reg-form-error">
            Gagal memuat data: {error}
          </div>
        ) : (
          <div className="reg-form-modal-content">
            {/* Terms editor */}
            <div className="reg-doc-section">
              <div className="reg-form-terms-row">
                <span className="reg-form-terms-label">Ketentuan &amp; Syarat:</span>
                <button
                  type="button"
                  onClick={handleResetTerms}
                  className="reg-form-reset-btn"
                >
                  Reset ke Default
                </button>
              </div>
              <textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className="reg-form-terms-editor"
                rows={6}
              />
            </div>

            {/* A4 Print preview */}
            <div className="print-only">
              <RegistrationFormPrint
                reservation={reservation}
                propertyInfo={propertyInfo}
                propertyBranding={propertyBranding}
                folioFinancials={folioFinancials}
                deposits={deposits}
                identityRecord={identityRecord}
                terms={terms}
              />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
