/**
 * Thermal Receipt — Main Modal
 *
 * Single modal with state machine flow:
 *   select-type → select-subtype (deposit only) → select-record (if multiple)
 *              → confirm-print → window.print()
 *
 * Fully independent from Document & Print system.
 *
 * Print isolation:
 *   - Screen preview: rendered inside modal (no print ID)
 *   - Print root: rendered via React Portal to document.body
 *     (#thermal-print-target), independent of modal layout
 */
import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  onOpenRegistrationForm?: () => void;
}

// ─── Helper: render receipt JSX (reused for screen preview + print portal) ────

function renderReceiptContent(
  receiptType: ThermalReceiptType | null,
  depositSubType: ThermalDepositSubType | null,
  folioFinancials: FolioFinancials | null,
  deposits: ThermalDeposit[],
  identityRecords: ThermalIdentityRecord[],
  selectedDepositId: number | null,
  selectedIdentityId: number | null,
  property: PropertyBrandingInfo,
  reservationCtx: ThermalReceiptReservation,
  printedBy: string,
  printedAt: string,
  width: ThermalWidth
) {
  const selectedDeposit = deposits.find((d) => d.id === selectedDepositId) ?? null;
  const selectedIdentity = identityRecords.find((r) => r.id === selectedIdentityId) ?? null;

  return (
    <>
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
    </>
  );
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
  onOpenRegistrationForm,
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
  const printedAt = new Date().toISOString();

  // ── Handlers ──

  const handleSelectType = useCallback((type: ThermalReceiptType) => {
    // Form Registrasi - open A4 modal directly, close thermal selector
    if (type === ('registration_form' as ThermalReceiptType)) {
      onClose();
      onOpenRegistrationForm?.();
      return;
    }

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
  }, [reservationId, effectivePropertyId, authFetch, onClose, onOpenRegistrationForm]);

  const handleSelectSubType = useCallback((subType: ThermalDepositSubType) => {
    setDepositSubType(subType);
    setLoading(true);
    setError(null);

    // Deposit/Identity receipts do NOT need folio financials.
    // Fetch ONLY what this receipt type actually renders.
    const depositPromise = subType === 'cash'
      ? fetchDeposits(reservationId, effectivePropertyId!)
      : Promise.resolve<ThermalDeposit[]>([]);
    const identityPromise = subType === 'identity'
      ? fetchIdentityCustody(reservationId, effectivePropertyId!)
      : Promise.resolve<ThermalIdentityRecord[]>([]);

    Promise.all([depositPromise, identityPromise])
      .then(([depositList, identityList]) => {
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

  // Receipt subtitle for confirm-print step
  const receiptSubtitle = (() => {
    if (receiptType === 'folio') return 'Struk Reservasi / Menginap';
    if (receiptType === 'deposit' && depositSubType === 'cash') return 'Bukti Deposit Uang';
    if (receiptType === 'deposit' && depositSubType === 'identity') return 'Bukti Jaminan Identitas';
    return '';
  })();

  // ── Build footer JSX (shared between step 4 Modal) ──

  const confirmFooter = (
    <div className="three-actions">
      <button
        type="button"
        onClick={handleClose}
        className="three-btn-secondary"
      >
        Batal
      </button>
      <button
        type="button"
        onClick={handlePrint}
        className="three-btn-primary"
        disabled={!canPrint}
      >
        🖨️ Cetak Sekarang
      </button>
    </div>
  );

  // ── Build portal content (rendered via createPortal to document.body) ──
  // Only shown when confirm-print step is active and we have valid receipt data.
  // The portal is hidden on screen (display:none by CSS) but visible during @media print.
  const printPortalContent = (
    !loading &&
    !error &&
    receiptType !== null &&
    ((receiptType === 'folio' && folioFinancials !== null) ||
      (receiptType === 'deposit' && depositSubType !== null && (
        (depositSubType === 'cash' && selectedDeposit !== null) ||
        (depositSubType === 'identity' && selectedIdentity !== null)
      )))
  ) ? (
    <div id="thermal-print-target" className="thermal-print-root">
      {renderReceiptContent(
        receiptType, depositSubType, folioFinancials,
        deposits, identityRecords,
        selectedDepositId, selectedIdentityId,
        property, reservationCtx, printedBy, printedAt, width
      )}
    </div>
  ) : null;

  // Sync portal visibility: hidden on screen, shown only during @media print
  useEffect(() => {
    const root = document.getElementById('thermal-print-target');
    if (root) {
      root.style.display = 'none';
    }
  }, []);

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
        <div className="three-selector">
          <div className="three-selector-grid">
            <button
              type="button"
              className="three-selector-btn"
              onClick={() => handleSelectType('folio')}
            >
              <span className="three-selector-icon">🧾</span>
              <div className="three-selector-content">
                <span className="three-selector-label">Struk Reservasi / Menginap</span>
                <span className="three-selector-desc">
                  Ringkasan biaya, pembayaran, dan sisa tagihan
                </span>
              </div>
            </button>
            <button
              type="button"
              className="three-selector-btn"
              onClick={() => handleSelectType('deposit')}
            >
              <span className="three-selector-icon">💰</span>
              <div className="three-selector-content">
                <span className="three-selector-label">Bukti Deposit</span>
                <span className="three-selector-desc">
                  Deposit uang atau jaminan identitas
                </span>
              </div>
            </button>
            <button
              type="button"
              className="three-selector-btn"
              onClick={() => handleSelectType('registration_form' as ThermalReceiptType)}
            >
              <span className="three-selector-icon">A4</span>
              <div className="three-selector-content">
                <span className="three-selector-label">Form Registrasi</span>
                <span className="three-selector-desc">
                  Formulir A4 untuk tamu saat check-in
                </span>
              </div>
            </button>
          </div>
          <p className="three-hint">
            Pilih dokumen yang ingin dicetak.
          </p>
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
        title="Cetak Thermal Receipt"
        subtitle="Pilih jenis bukti yang akan dicetak"
        size="sm"
      >
        <div className="three-step-indicator">
          <span className="three-step-dot three-step-dot--completed" />
          <span className="three-step-label">1. Pilih Jenis</span>
          <span className="three-step-dot three-step-dot--active" />
          <span className="three-step-label">2. Pilih Detail</span>
        </div>
        <div className="three-selector">
          <div className="three-selector-grid">
            <button
              type="button"
              className="three-selector-btn"
              onClick={() => handleSelectSubType('cash')}
            >
              <span className="three-selector-icon">💵</span>
              <div className="three-selector-content">
                <span className="three-selector-label">Deposit Uang</span>
                <span className="three-selector-desc">
                  Bukti penerimaan pembayaran deposit
                </span>
              </div>
            </button>
            <button
              type="button"
              className="three-selector-btn"
              onClick={() => handleSelectSubType('identity')}
            >
              <span className="three-selector-icon">🪪</span>
              <div className="three-selector-content">
                <span className="three-selector-label">Jaminan Identitas</span>
                <span className="three-selector-desc">
                  Catatan penahanan dokumen identitas tamu
                </span>
              </div>
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
        title="Cetak Thermal Receipt"
        subtitle="Pilih jenis bukti yang akan dicetak"
        size="sm"
      >
        <div className="three-step-indicator">
          <span className="three-step-dot three-step-dot--completed" />
          <span className="three-step-label">1. Pilih Jenis</span>
          <span className="three-step-dot three-step-dot--completed" />
          <span className="three-step-label">2. Pilih Detail</span>
          <span className="three-step-dot three-step-dot--active" />
          <span className="three-step-label">3. Pilih Record</span>
        </div>
        <div className="three-selector">
          <div className="three-record-list">
            {records.map((rec) => (
              <button
                key={rec.id}
                type="button"
                className="three-record-btn"
                onClick={() =>
                  handleSelectRecord(rec.id, isDepositPath ? 'deposit' : 'identity')
                }
              >
                <span className="three-record-number">{rec.label}</span>
                <span className="three-record-meta">{rec.meta}</span>
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
      <>
        {/* Screen preview modal */}
        <Modal
          isOpen={isOpen}
          onClose={handleClose}
          title="Cetak Thermal Receipt"
          subtitle={receiptSubtitle || 'Preview dan cetak thermal receipt'}
          size="md"
          footer={confirmFooter}
        >
          {/* Step indicator */}
          <div className="three-step-indicator">
            <span className="three-step-dot three-step-dot--completed" />
            <span className="three-step-label">1. Pilih Jenis</span>
            {depositSubType && (
              <>
                <span className="three-step-dot three-step-dot--completed" />
                <span className="three-step-label">2. Pilih Detail</span>
              </>
            )}
            {(deposits.length > 1 || identityRecords.length > 1) && (
              <>
                <span className="three-step-dot three-step-dot--completed" />
                <span className="three-step-label">3. Pilih Record</span>
              </>
            )}
            <span className="three-step-dot three-step-dot--active" />
            <span className="three-step-label">4. Konfirmasi</span>
          </div>

          {/* Width selector */}
          <div className="three-width-selector">
            <span className="three-width-label">Ukuran Kertas:</span>
            <span className="three-width-segment">
              <button
                type="button"
                className={`three-width-btn${width === 58 ? ' three-width-btn--active' : ''}`}
                onClick={() => setWidth(58)}
              >
                58mm
              </button>
              <button
                type="button"
                className={`three-width-btn${width === 80 ? ' three-width-btn--active' : ''}`}
                onClick={() => setWidth(80)}
              >
                80mm
              </button>
            </span>
          </div>

          {/* Loading */}
          {loading && (
            <div className="three-loading">
              <span>Memuat data thermal receipt…</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="three-error">
              <span>⚠️ {error}</span>
              <button type="button" onClick={handleClose} className="three-btn-secondary">
                Tutup
              </button>
            </div>
          )}

          {/* Empty state for deposit / identity with zero records */}
          {!loading && !error && receiptType === 'deposit' && depositSubType === 'cash' && deposits.length === 0 && (
            <div className="three-empty-state">
              <span className="three-empty-icon">💰</span>
              <span className="three-empty-title">Belum Ada Deposit</span>
              <span className="three-empty-desc">
                Reservasi ini belum memiliki data deposit uang yang bisa dicetak.
              </span>
            </div>
          )}
          {!loading && !error && receiptType === 'deposit' && depositSubType === 'identity' && identityRecords.length === 0 && (
            <div className="three-empty-state">
              <span className="three-empty-icon">🪪</span>
              <span className="three-empty-title">Belum Ada Jaminan Identitas</span>
              <span className="three-empty-desc">
                Reservasi ini belum memiliki data jaminan identitas yang bisa dicetak.
              </span>
            </div>
          )}

          {/* Receipt preview — NO print ID here; print root is in the portal below */}
          {!loading && !error && (
            <div className="three-preview-container">
              <div className="three-preview-label">Preview Struk</div>
              <div className="three-preview-wrap">
                {renderReceiptContent(
                  receiptType, depositSubType, folioFinancials,
                  deposits, identityRecords,
                  selectedDepositId, selectedIdentityId,
                  property, reservationCtx, printedBy, printedAt, width
                )}
              </div>
            </div>
          )}
        </Modal>

        {/* Print portal: separate root attached to document.body.
            Hidden on screen (display:none). Visible only during @media print.
            Completely isolated from modal layout/positioning. */}
        {isOpen && printPortalContent !== null && createPortal(
          printPortalContent,
          document.body
        )}
      </>
    );
  }

  return null;
}
