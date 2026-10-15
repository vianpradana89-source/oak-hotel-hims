/**
 * PosThermalReceiptModal — Preview + Print modal untuk POS receipt authoritative.
 *
 * Data source: fetchPosReceipt (single GET, no mutation).
 * Print isolation: React Portal → #thermal-print-target on document.body,
 *   hidden on screen, visible only during @media print (existing CSS).
 *
 * Lifecycle:
 *   - When isOpen flips to true (or orderId/propertyId changes while open):
 *     fetch authoritative receipt via fetchPosReceipt.
 *   - Stale guard: a monotonically-increasing request sequence number is
 *     captured at fetch time. If the component unmounts, orderId/propertyId
 *     changes, or modal closes before the response arrives, the stale result
 *     is silently discarded.
 *   - printedAt is captured ONCE per successful fetch for this modal session;
 *     a subsequent re-open produces a fresh timestamp.
 *   - Print: sets --thermal-width CSS var → window.print(). No popup.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import { fetchPosReceipt } from '../pos/posReceiptApi';
import type { PosReceiptData } from '../pos/posReceiptTypes';
import { buildPosReceiptWhatsAppUrl } from '../pos/posReceiptWhatsApp';
import type { ThermalWidth } from './thermalReceiptTypes';
import PosThermalReceiptContent from './PosThermalReceiptContent';
import './thermalReceipt.css';

// ── Props ─────────────────────────────────────────────────────────────────

interface PosThermalReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: number;
  propertyId: number;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

// ── Component ─────────────────────────────────────────────────────────────

export default function PosThermalReceiptModal({
  isOpen,
  onClose,
  orderId,
  propertyId,
  authFetch,
}: PosThermalReceiptModalProps) {
  const { user } = useAuth();
  const printedBy = user?.full_name || user?.username || 'Staff';

  // ── State ───────────────────────────────────────────────────────────
  const [width, setWidth] = useState<ThermalWidth>(80);
  const [receipt, setReceipt] = useState<PosReceiptData | null>(null);
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Stale-request guard ─────────────────────────────────────────────
  // Monotonically increasing sequence. Each fetch captures the current seq;
  // when the promise resolves, only apply state if seq still matches.
  const seqRef = useRef(0);
  // Track the last fetched keys so we don't re-fetch on re-render with same keys
  const fetchedKeyRef = useRef<string | null>(null);

  // Unmount safety: invalidate any in-flight fetch and clean the global
  // print-width variable even if the parent removes this component directly.
  useEffect(() => {
    return () => {
      seqRef.current += 1;
      document.documentElement.style.removeProperty('--thermal-width');
    };
  }, []);

  // ── Fetch on open / orderId / propertyId change ────────────────────
  useEffect(() => {
    if (!isOpen) {
      // Reset when closed — fresh state next time
      setReceipt(null);
      setPrintedAt(null);
      setError(null);
      setLoading(false);
      fetchedKeyRef.current = null;
      seqRef.current += 1; // invalidate any in-flight requests
      document.documentElement.style.removeProperty('--thermal-width');
      return;
    }

    const key = `${orderId}:${propertyId}`;
    if (fetchedKeyRef.current === key && receipt !== null) {
      // Already fetched this key for this open session — skip
      return;
    }

    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    fetchedKeyRef.current = key;

    fetchPosReceipt(orderId, propertyId, authFetch)
      .then((data) => {
        // Stale guard: discard if a newer request superseded this one
        if (mySeq !== seqRef.current) return;
        setReceipt(data);
        setPrintedAt(new Date().toISOString());
      })
      .catch((err: unknown) => {
        if (mySeq !== seqRef.current) return;
        setReceipt(null);
        setPrintedAt(null);
        setError(
          err instanceof Error ? err.message : 'Gagal memuat struk POS',
        );
      })
      .finally(() => {
        if (mySeq === seqRef.current) setLoading(false);
      });
  }, [isOpen, orderId, propertyId, authFetch]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handlePrint = useCallback(() => {
    document.documentElement.style.setProperty('--thermal-width', `${width}mm`);
    window.print();
  }, [width]);

  const handleClose = useCallback(() => {
    seqRef.current += 1; // invalidate in-flight
    onClose();
  }, [onClose]);

  const canPrint =
    !loading && !error && receipt !== null && printedAt !== null;

  // WhatsApp: nomor HANYA dari receipt.order.guest_phone (via helper).
  // URL dihitung saat receipt valid; null jika nomor tidak ada/tidak valid.
  const whatsappUrl =
    receipt !== null && !loading && !error
      ? buildPosReceiptWhatsAppUrl(receipt)
      : null;
  const canWhatsApp = whatsappUrl !== null;

  const handleWhatsApp = useCallback(() => {
    if (whatsappUrl) {
      window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    }
  }, [whatsappUrl]);

  // ── Render ───────────────────────────────────────────────────────────

  if (!isOpen) return null;

  const subtitle = receipt
    ? `No. Order: ${receipt.order.order_number}`
    : undefined;

  const footer = (
    <div className="three-actions">
      <button
        type="button"
        onClick={handleClose}
        className="three-btn-secondary"
      >
        Tutup
      </button>
      {canWhatsApp && (
        <button
          type="button"
          onClick={handleWhatsApp}
          className="three-btn-secondary"
        >
          WhatsApp
        </button>
      )}
      <button
        type="button"
        onClick={handlePrint}
        className="three-btn-primary"
        disabled={!canPrint}
      >
        Cetak
      </button>
    </div>
  );

  // ── Portal print content ──────────────────────────────────────────────
  // Rendered to document.body, hidden on screen, visible in @media print.
  const printPortalContent = canPrint && receipt && printedAt ? (
    <div id="thermal-print-target" className="thermal-print-root">
      <PosThermalReceiptContent
        receipt={receipt}
        width={width}
        printedBy={printedBy}
        printedAt={printedAt}
      />
    </div>
  ) : null;

  return (
    <>
      {/* Screen preview modal */}
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Struk POS"
        subtitle={subtitle}
        size="md"
        footer={footer}
      >
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
            <span>Memuat struk POS…</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="three-error">
            <span>⚠️ {error}</span>
            <button
              type="button"
              onClick={handleClose}
              className="three-btn-secondary"
            >
              Tutup
            </button>
          </div>
        )}

        {/* Retry */}
        {!loading && error && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              type="button"
              className="three-btn-secondary"
              onClick={() => {
                fetchedKeyRef.current = null;
                setReceipt(null);
                setPrintedAt(null);
                setError(null);
                setLoading(true);
                const mySeq = ++seqRef.current;
                fetchPosReceipt(orderId, propertyId, authFetch)
                  .then((data) => {
                    if (mySeq !== seqRef.current) return;
                    setReceipt(data);
                    setPrintedAt(new Date().toISOString());
                  })
                  .catch((err: unknown) => {
                    if (mySeq !== seqRef.current) return;
                    setReceipt(null);
                    setPrintedAt(null);
                    setError(
                      err instanceof Error ? err.message : 'Gagal memuat struk POS',
                    );
                  })
                  .finally(() => {
                    if (mySeq === seqRef.current) setLoading(false);
                  });
              }}
            >
              Coba Lagi
            </button>
          </div>
        )}

        {/* Receipt preview — NO print ID here; print root is the portal */}
        {!loading && !error && receipt && printedAt && (
          <div className="three-preview-container">
            <div className="three-preview-label">Preview Struk</div>
            <div className="three-preview-wrap">
              <PosThermalReceiptContent
                receipt={receipt}
                width={width}
                printedBy={printedBy}
                printedAt={printedAt}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* Print portal: separate root attached to document.body.
          Hidden on screen (display:none by CSS). Visible only during @media print. */}
      {printPortalContent &&
        createPortal(printPortalContent, document.body)}
    </>
  );
}
