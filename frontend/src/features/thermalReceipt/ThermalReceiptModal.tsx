/**
 * Thermal Receipt — Main Modal
 *
 * Single modal with state machine flow:
 *   select-type → select-subtype (deposit only) → select-record (if multiple)
 *              → confirm-print → window.print()
 *
 * Fully independent from Document & Print system.
 */
import { useState, useCallback } from 'react';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import { getLogoServeUrl } from '../propertySettings/propertyBrandingApi';
import type { PropertyBrandingConfig } from '../propertySettings/propertyBrandingTypes';
import {
  fetchFolioFinancials,
  fetchDeposits,
  fetchIdentityCustody,
  extractReservationContext,
} from './thermalReceiptApi';
import type {
  ThermalStep,
  ThermalWidth,
  ThermalReceiptType,
  ThermalDepositSubType,
  PropertyInfo,
  FolioFinancials,
  ThermalDeposit,
  ThermalIdentityRecord,
  ThermalReceiptReservation,
  PropertyBrandingInfo,
} from './thermalReceiptTypes';
import { formatHotelDateTimeIndonesian } from './thermalReceiptFormatters';
import ThermalReceiptContent from './ThermalReceiptContent';
import ThermalDepositReceipt from './ThermalDepositReceipt';
import ThermalIdentityReceipt from './ThermalIdentityReceipt';
import './thermalReceipt.css';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  reservationId: number;
  propertyId: number | null;
  reservation: any;
  propertyBranding: PropertyBrandingConfig | null;
  propertyInfo: PropertyInfo | undefined | null;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThermalReceiptModal({
  isOpen,
  onClose,
  reservationId,
  propertyId,
  reservation,
  propertyBranding,
  propertyInfo,
  authFetch,
}: Props) {
  const { user } = useAuth();
  const printedBy = user?.full_name || user?.username || 'Resepsionis';

  // ── Step State ──
  const [step, setStep] = useState<ThermalStep>('select-type');
  const [receiptType, setReceiptType] = useState<ThermalReceiptType | null>(null);
  const [depositSubType, setDepositSubType] = useState<ThermalDepositSubType | null>(null);
  const [width, setWidth] = useState<ThermalWidth>(80);

  // ── Data State ──
  const [folioFinancials, setFolioFinancials] = useState<FolioFinancials | null>(null);
  const [deposits, setDeposits] = useState<ThermalDeposit[]>([]);
  const [identityRecords, setIdentityRecords] = useState<ThermalIdentityRecord[]>([]);
  const [selectedDepositId, setSelectedDepositId] = useState<number | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<number | null>(null);

  // ── Loading / Error State ──
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived data ──
  const effectivePropertyId = propertyId ?? reservation?.property_id ?? null;

  // Logo: resolve serve URL from storage key, fallback to raw URL
  const resolvedLogoUrl: string | null = (() => {
    if (!propertyBranding?.logoUrl) return null;
    const serveUrl = getLogoServeUrl(propertyBranding.logoUrl, effectivePropertyId ?? undefined);
    return serveUrl || propertyBranding.logoUrl;
  })();

  const property: PropertyBrandingInfo = {
    displayName: propertyBranding?.displayName || propertyInfo?.name || 'OAK HOTEL',
    logoUrl: resolvedLogoUrl,
    tagline: propertyBranding?.tagline || null,
    address: propertyInfo?.address || null,
    phone: propertyInfo?.phone || null,
  };

  const reservationCtx: ThermalReceiptReservation = extractReservationContext(reservation);
  const printedAt = formatHotelDateTimeIndonesian(new Date().toISOString());

  // ── Handlers ──

  const handleSelectType = useCallback((type: ThermalReceiptType) => {
    setReceiptType(type);
    setStep('confirm-print'); // will be overridden by async fetch below
    setLoading(true);
    setError(null);
    setFolioFinancials(null);
    setDeposits([]);
    setIdentityRecords([]);
    setSelectedDepositId(null);
    setSelectedIdentityId(null);

    if (type === 'folio') {
      fetchFolioFinancials(reservationId, effectivePropertyId!, authFetch)
        .then((fin) => {
          setFolioFinancials(fin);
          setStep('confirm-print');
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Gagal memuat data folio');
          setStep('confirm-print'); // show error in confirm screen
        })
        .finally(() => setLoading(false));
    } else {
      // deposit path — proceed to subtype selection
      setStep('select-subtype');
    }
  }, [reservationId, effectivePropertyId, authFetch]);

  const handleSelectSubType = useCallback((subType: ThermalDepositSubType) => {
    setDepositSubType(subType);
    setLoading(true);
    setError(null);

    Promise.all([
      fetchFolioFinancials(reservationId, effectivePropertyId!, authFetch),
      subType === 'cash'
        ? fetchDeposits(reservationId, effectivePropertyId!)
        : Promise.resolve<ThermalDeposit[]>([]),
      subType === 'identity'
        ? fetchIdentityCustody(reservationId, effectivePropertyId!)
        : Promise.resolve<ThermalIdentityRecord[]>([]),
    ])
      .then(([fin, depositList, identityList]) => {
        setFolioFinancials(fin);
        setDeposits(depositList);
        setIdentityRecords(identityList);

        // Auto-select single record, else prompt selection
        if (subType === 'cash' && depositList.length === 1) {
          setSelectedDepositId(depositList[0].id);
          setStep('confirm-print');
        } else if (subType === 'identity' && identityList.length === 1) {
          setSelectedIdentityId(identityList[0].id);
          setStep('confirm-print');
        } else if (depositList.length > 1 || identityList.length > 1) {
          setStep('select-record');
        } else {
          // Zero records — stay on confirm-print with empty state
          setStep('confirm-print');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Gagal memuat data');
        setStep('confirm-print');
      })
      .finally(() => setLoading(false));
  }, [reservationId, effectivePropertyId, authFetch]);

  const handleSelectRecord = useCallback((id: number, type: 'deposit' | 'identity') => {
    if (type === 'deposit') {
      setSelectedDepositId(id);
    } else {
      setSelectedIdentityId(id);
    }
    setStep('confirm-print');
  }, []);

  const handlePrint = useCallback(() => {
    document.documentElement.style.setProperty('--thermal-width', `${width}mm`);
    window.print();
  }, [width]);

  const handleClose = useCallback(() => {
    setStep('select-type');
    setReceiptType(null);
    setDepositSubType(null);
    setWidth(80);
    setFolioFinancials(null);
    setDeposits([]);
    setIdentityRecords([]);
    setSelectedDepositId(null);
    setSelectedIdentityId(null);
    setLoading(false);
    setError(null);
    document.documentElement.style.removeProperty('--thermal-width');
    onClose();
  }, [onClose]);

  // ── Determine what to show on confirm-print screen ──

  const selectedDeposit = deposits.find((d) => d.id === selectedDepositId) ?? null;
  const selectedIdentity = identityRecords.find((r) => r.id === selectedIdentityId) ?? null;
  const canPrint =
    !loading &&
    !error &&
    ((receiptType === 'folio' && folioFinancials !== null) ||
      (receiptType === 'deposit' && depositSubType === 'cash' && selectedDeposit !== null) ||
      (receiptType === 'deposit' && depositSubType === 'identity' && selectedIdentity !== null));

  // ── Render ──

  if (!isOpen) return null;

  // Step 1: Select receipt type
  if (step === 'select-type') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Cetak Thermal Receipt"
        subtitle="Pilih jenis bukti yang akan dicetak"
        size="sm"
      >
        <div className="thermal-selector">
          <p className="thermal-hint">
            Resepsionis akan mencetak bukti melalui printer thermal (58mm / 80mm).
          </p>
          <div className="thermal-selector-grid">
            <button
              type="button"
              className="thermal-selector-btn"
              onClick={() => handleSelectType('folio')}
            >
              <span className="thermal-selector-icon">🧾</span>
              <span className="thermal-selector-label">Struk Reservasi / Menginap</span>
              <span className="thermal-selector-desc">
                Ringkasan biaya, pembayaran, dan sisa tagihan
              </span>
            </button>
            <button
              type="button"
              className="thermal-selector-btn"
              onClick={() => handleSelectType('deposit')}
            >
              <span className="thermal-selector-icon">💰</span>
              <span className="thermal-selector-label">Deposit</span>
              <span className="thermal-selector-desc">
                Deposit uang atau jaminan identitas
              </span>
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Step 2 (deposit only): Select subtype
  if (step === 'select-subtype' && receiptType === 'deposit') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Pilih Jenis Deposit"
        subtitle="Deposit uang atau jaminan identitas?"
        size="sm"
      >
        <div className="thermal-selector">
          <div className="thermal-selector-grid">
            <button
              type="button"
              className="thermal-selector-btn"
              onClick={() => handleSelectSubType('cash')}
            >
              <span className="thermal-selector-icon">💵</span>
              <span className="thermal-selector-label">Deposit Uang</span>
              <span className="thermal-selector-desc">
                Bukti penerimaan pembayaran deposit
              </span>
            </button>
            <button
              type="button"
              className="thermal-selector-btn"
              onClick={() => handleSelectSubType('identity')}
            >
              <span className="thermal-selector-icon">🪪</span>
              <span className="thermal-selector-label">Jaminan Identitas</span>
              <span className="thermal-selector-desc">
                Catatan penahanan dokumen identitas tamu
              </span>
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Step 3: Select record (if multiple)
  if (step === 'select-record') {
    const isDepositPath = depositSubType === 'cash';
    const records: Array<{ id: number; label: string; meta: string }> = isDepositPath
      ? deposits.map((d) => ({
          id: d.id,
          label: `${d.deposit_number} — ${d.payment_method}`,
          meta: `Rp ${d.original_amount.toLocaleString('id-ID')} · ${d.status}`,
        }))
      : identityRecords.map((r) => ({
          id: r.id,
          label: `${r.document_type} — ${r.document_holder_name}`,
          meta: `${r.document_number_masked ?? '—'} · ${r.status}`,
        }));

    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title={isDepositPath ? 'Pilih Deposit' : 'Pilih Identitas'}
        subtitle={`Terdapat ${records.length} record. Pilih salah satu.`}
        size="sm"
      >
        <div className="thermal-selector">
          <div className="thermal-record-list">
            {records.map((rec) => (
              <button
                key={rec.id}
                type="button"
                className="thermal-record-btn"
                onClick={() =>
                  handleSelectRecord(rec.id, isDepositPath ? 'deposit' : 'identity')
                }
              >
                <span className="thermal-record-number">{rec.label}</span>
                <span className="thermal-record-meta">{rec.meta}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    );
  }

  // Step 4: Confirm print
  if (step === 'confirm-print') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Konfirmasi Cetak"
        subtitle="Preview dan cetak thermal receipt"
        size="md"
      >
        {/* Width selector */}
        <div className="thermal-width-selector">
          <span className="thermal-width-label">Ukuran Kertas:</span>
          <button
            type="button"
            className={`thermal-width-btn${width === 58 ? ' thermal-width-btn--active' : ''}`}
            onClick={() => setWidth(58)}
          >
            58mm
          </button>
          <button
            type="button"
            className={`thermal-width-btn${width === 80 ? ' thermal-width-btn--active' : ''}`}
            onClick={() => setWidth(80)}
          >
            80mm
          </button>
        </div>

        {/* Preview label */}
        <div className="thermal-preview-label">Preview:</div>

        {/* Loading */}
        {loading && (
          <div className="thermal-loading">
            <span>Memuat data thermal receipt…</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="thermal-error">
            <span>⚠️ {error}</span>
            <button type="button" onClick={handleClose} className="thermal-btn-secondary">
              Tutup
            </button>
          </div>
        )}

        {/* Empty state for deposit / identity with zero records */}
        {!loading &&
          !error &&
          receiptType === 'deposit' &&
          depositSubType === 'cash' &&
          deposits.length === 0 && (
            <div className="thermal-empty-state">
              <span>Belum ada deposit uang untuk reservasi ini.</span>
            </div>
          )}
        {!loading &&
          !error &&
          receiptType === 'deposit' &&
          depositSubType === 'identity' &&
          identityRecords.length === 0 && (
            <div className="thermal-empty-state">
              <span>Belum ada jaminan identitas untuk reservasi ini.</span>
            </div>
          )}

        {/* Receipt preview */}
        {!loading && !error && (
          <div id="thermal-print-target" className="thermal-preview-wrap">
            {receiptType === 'folio' && folioFinancials !== null && (
              <ThermalReceiptContent
                data={{ property, reservation: reservationCtx, printedBy, printedAt, width }}
                financials={folioFinancials}
              />
            )}
            {receiptType === 'deposit' &&
              depositSubType === 'cash' &&
              selectedDeposit && (
                <ThermalDepositReceipt
                  data={{
                    property,
                    reservation: reservationCtx,
                    deposit: selectedDeposit,
                    printedBy,
                    printedAt,
                    width,
                  }}
                />
              )}
            {receiptType === 'deposit' &&
              depositSubType === 'identity' &&
              selectedIdentity && (
                <ThermalIdentityReceipt
                  data={{
                    property,
                    reservation: reservationCtx,
                    identity: selectedIdentity,
                    printedBy,
                    printedAt,
                    width,
                  }}
                />
              )}
          </div>
        )}

        {/* Action buttons */}
        <div className="thermal-actions">
          <button
            type="button"
            onClick={handlePrint}
            className="thermal-btn-primary"
            disabled={!canPrint}
          >
            🖨️ Cetak Sekarang
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="thermal-btn-secondary"
          >
            Batal
          </button>
        </div>
      </Modal>
    );
  }

  return null;
}
