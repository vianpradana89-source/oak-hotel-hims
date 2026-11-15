import React from 'react';
import { useState } from 'react';
import { Modal } from '../../../design-system/Modal';
import type { PropertyInfoDto, PropertyBrandingDto } from '../../documents/GuestDocumentContent';
import { REGISTRATION_FORM_DEFAULT_TERM_ITEMS } from './registrationFormDraft';
import type { RegistrationFormClause } from './registrationFormDraft';
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
  const cloneTerms = (items: RegistrationFormClause[]): RegistrationFormClause[] =>
    items.map(item => ({ text: item.text }));

  const [terms, setTerms] = useState<RegistrationFormClause[]>(() => cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
  const [serverTerms, setServerTerms] = useState<RegistrationFormClause[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [identityRecord, setIdentityRecord] = useState<any>(null);

  // Load saved terms and deposit/identity data when modal opens
  React.useEffect(() => {
    if (!isOpen || !propertyId) return;

    // Reset state when opening for new property or reopening modal
    setServerTerms(null);
    setTerms(cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
    setLoading(true);
    setError(null);
    setSaveSuccess(false);

    // Load saved registration form terms
    const loadTerms = authFetch(`/api/settings/property/registration-form/terms?property_id=${propertyId}`)
      .then(r => r.json())
      .then(json => {
        if (json.status === 'OK' && Array.isArray(json.data?.terms_content) && json.data.terms_content.length > 0) {
          const saved = cloneTerms(json.data.terms_content);
          setTerms(saved);
          setServerTerms(saved);
        } else {
          setTerms(cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
          setServerTerms(null);
        }
      })
      .catch(() => {
        setTerms(cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
        setServerTerms(null);
      });

    // Load deposits and identity
    const loadData = Promise.all([
      authFetch(`/api/reservations/${reservationId}/deposits?property_id=${propertyId}`)
        .then(r => r.json())
        .then(json => Array.isArray(json?.data) ? json.data : [])
        .catch(() => []),
      authFetch(`/api/reservations/${reservationId}/identity-custody?property_id=${propertyId}`)
        .then(r => r.json())
        .then(json => Array.isArray(json?.data) && json.data.length > 0 ? json.data[0] : null)
        .catch(() => null),
    ]);

    Promise.all([loadTerms, loadData])
      .then(([, [deps, id]]) => {
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
    setTerms(cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
    setServerTerms(null);
    setSaveSuccess(false);
    onClose();
  };

  const handleResetTerms = () => {
    setTerms(serverTerms ? cloneTerms(serverTerms) : cloneTerms(REGISTRATION_FORM_DEFAULT_TERM_ITEMS));
    setSaveSuccess(false);
  };

  const handleAddClause = () => {
    setTerms(prev => {
      if (prev.length >= 12) return prev;
      return [...prev, { text: '' }];
    });
  };

  const handleRemoveClause = (index: number) => {
    setTerms(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleMoveClause = (index: number, direction: 'up' | 'down') => {
    setTerms(prev => {
      if (direction === 'up' && index === 0) return prev;
      if (direction === 'down' && index === prev.length - 1) return prev;
      const newTerms = [...prev];
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      [newTerms[index], newTerms[swapIndex]] = [newTerms[swapIndex], newTerms[index]];
      return newTerms;
    });
  };

  const handleClauseChange = (index: number, newText: string) => {
    setTerms(prev => {
      const newTerms = [...prev];
      newTerms[index] = { text: newText };
      return newTerms;
    });
  };

  const validateAndSave = async () => {
    // Validate
    for (let i = 0; i < terms.length; i++) {
      const trimmed = terms[i].text.trim();
      if (trimmed.length === 0) {
        setError(`Syarat ${i + 1} tidak boleh kosong`);
        return;
      }
      if (trimmed.length > 200) {
        setError(`Syarat ${i + 1} melebihi 200 karakter`);
        return;
      }
    }

    if (!propertyId || saveLoading) return;

    setSaveLoading(true);
    setSaveSuccess(false);
    setError(null);

    try {
      const res = await authFetch(
        `/api/settings/property/registration-form/terms?property_id=${propertyId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terms_content: terms }),
        }
      );
      const json = await res.json();
      if (json.status === 'OK' && Array.isArray(json.data?.terms_content)) {
        const saved = cloneTerms(json.data.terms_content);
        setTerms(saved);
        setServerTerms(saved);
        setSaveSuccess(true);
      } else if (json.status === 'OK') {
        // Response OK but terms_content missing/invalid — fall back to local terms
        setServerTerms(terms);
        setSaveSuccess(true);
      } else {
        setError(json.message || 'Gagal menyimpan ketentuan');
      }
    } catch (err: any) {
      setError(err?.message || 'Gagal menyimpan ketentuan');
    } finally {
      setSaveLoading(false);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
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
            {error}
          </div>
        ) : (
          <div className="reg-form-modal-content">
            {/* Left panel: Terms editor */}
            <div className="reg-form-editor-panel">
              <div className="reg-form-editor-header">
                <span className="reg-form-terms-label">Ketentuan &amp; Syarat</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetTerms}
                    className="reg-form-reset-btn"
                  >
                    Reset ke Default
                  </button>
                  <button
                    type="button"
                    onClick={validateAndSave}
                    disabled={saveLoading}
                    className={`reg-form-save-btn ${saveSuccess ? 'reg-form-save-success' : ''}`}
                  >
                    {saveLoading ? 'Menyimpan...' : saveSuccess ? 'Tersimpan!' : 'Simpan sebagai Default'}
                  </button>
                </div>
              </div>

              <div className="reg-form-clauses-list">
                {terms.map((clause, index) => (
                  <div key={index} className="reg-form-clause-item">
                    <div className="reg-form-clause-header">
                      <span className="reg-form-clause-number">Syarat {index + 1}</span>
                      <div className="reg-form-clause-actions">
                        <button
                          type="button"
                          onClick={() => handleMoveClause(index, 'up')}
                          disabled={index === 0}
                          className="reg-form-clause-btn reg-form-move-up"
                          title="Naik"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveClause(index, 'down')}
                          disabled={index === terms.length - 1}
                          className="reg-form-clause-btn reg-form-move-down"
                          title="Turun"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveClause(index)}
                          disabled={terms.length <= 1}
                          className="reg-form-clause-btn reg-form-delete"
                          title="Hapus"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={clause.text}
                      onChange={(e) => handleClauseChange(index, e.target.value)}
                      className="reg-form-clause-textarea"
                      placeholder={`Ketik syarat ${index + 1}...`}
                      rows={2}
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={handleAddClause}
                disabled={terms.length >= 12}
                className="reg-form-add-clause-btn"
              >
                + Tambah Syarat
              </button>

              {saveSuccess && (
                <div className="reg-form-save-notice">
                  Ketentuan berhasil disimpan untuk properti ini.
                </div>
              )}

              {terms.length >= 12 && (
                <div className="reg-form-clause-warning">
                  Maksimal 12 syarat
                </div>
              )}
            </div>

            {/* Right panel: A4 preview */}
            <div className="reg-form-preview-panel">
              <div className="print-only">
                <RegistrationFormPrint
                  reservation={reservation}
                  propertyInfo={propertyInfo}
                  propertyBranding={propertyBranding}
                  deposits={deposits}
                  identityRecord={identityRecord}
                  terms={terms}
                  siblingReservations={reservation?.sibling_reservations ?? null}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
