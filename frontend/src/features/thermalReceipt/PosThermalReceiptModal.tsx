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
 *   - WhatsApp Digital Receipt: Direct dispatch via backend gateway & Web link fallback.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import {
  fetchPosReceipt,
  sendPosReceiptWhatsApp,
  fetchPosReceiptWhatsAppLogs,
  type PosWhatsAppReceiptLog,
} from '../pos/posReceiptApi';
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

  // WhatsApp dispatch state
  const [waPhone, setWaPhone] = useState('');
  const [isSendingWa, setIsSendingWa] = useState(false);
  const [waSendFeedback, setWaSendFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [waLogs, setWaLogs] = useState<PosWhatsAppReceiptLog[]>([]);

  // Communication settings (runtime config for WhatsApp intro/closing).
  // Default: enabled, no custom intro/closing — mirrors the backend default
  // when no row exists in property_pos_communication_settings.
  const [commSettingsState, setCommSettings] = useState({
    whatsapp_enabled: true,
    whatsapp_intro_message: null as string | null,
    whatsapp_closing_message: null as string | null,
  });

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
      setWaPhone('');
      setIsSendingWa(false);
      setWaSendFeedback(null);
      setWaLogs([]);
      setCommSettings({
        whatsapp_enabled: true,
        whatsapp_intro_message: null,
        whatsapp_closing_message: null,
      });
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
    setWaSendFeedback(null);
    fetchedKeyRef.current = key;

    fetchPosReceipt(orderId, propertyId, authFetch)
      .then((data) => {
        // Stale guard: discard if a newer request superseded this one
        if (mySeq !== seqRef.current) return;
        setReceipt(data);
        setPrintedAt(new Date().toISOString());
        if (data.order?.guest_phone) {
          setWaPhone(data.order.guest_phone);
        }
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

    // Fetch existing WhatsApp dispatch logs
    fetchPosReceiptWhatsAppLogs(orderId, propertyId, authFetch)
      .then((logs) => {
        if (mySeq === seqRef.current) {
          setWaLogs(logs);
        }
      })
      .catch(() => {
        // Non-blocking log fetch error
      });
  }, [isOpen, orderId, propertyId, authFetch]);

  // ── Communication settings fetch (independent of receipt fetch) ──────────
  // Fires in parallel with the receipt fetch on open / propertyId change.
  // Failure (403/404/500/network/invalid payload) → keep default
  // whatsapp_enabled=true so the button stays functional (fail-open).
  // Only a valid 200 with whatsapp_enabled=false disables the button.
  const commSeqRef = useRef(0);
  useEffect(() => {
    if (!isOpen || !propertyId) {
      commSeqRef.current += 1; // invalidate
      return;
    }

    const mySeq = ++commSeqRef.current;
    let cancelled = false;

    authFetch(`/api/pos/communication-settings?property_id=${propertyId}`)
      .then((res) => {
        if (cancelled || mySeq !== commSeqRef.current) return;
        if (!res.ok) {
          console.warn(
            '[PosThermalReceiptModal] comm settings fetch failed:',
            res.status,
          );
          return;
        }
        return res.json().then((json: Record<string, unknown>) => {
          if (cancelled || mySeq !== commSeqRef.current) return;
          const data = json?.data as Record<string, unknown> | null | undefined;
          if (data === null || data === undefined || typeof data !== 'object') return;
          const enabled = data.whatsapp_enabled;
          const intro = data.whatsapp_intro_message;
          const closing = data.whatsapp_closing_message;
          const validShape =
            typeof enabled === 'boolean' &&
            (intro === null || typeof intro === 'string') &&
            (closing === null || typeof closing === 'string');
          if (validShape) {
            setCommSettings({
              whatsapp_enabled: enabled,
              whatsapp_intro_message: intro,
              whatsapp_closing_message: closing,
            });
          } else {
            console.warn(
              '[PosThermalReceiptModal] comm settings payload invalid, using defaults',
            );
          }
        });
      })
      .catch((err: unknown) => {
        if (cancelled || mySeq !== commSeqRef.current) return;
        console.warn(
          '[PosThermalReceiptModal] comm settings network error:',
          err instanceof Error ? err.message : err,
        );
      });

    return () => {
      cancelled = true;
      commSeqRef.current += 1;
    };
  }, [isOpen, propertyId, authFetch]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handlePrint = useCallback(() => {
    document.documentElement.style.setProperty('--thermal-width', `${width}mm`);
    window.print();
  }, [width]);

  const handleClose = useCallback(() => {
    seqRef.current += 1; // invalidate in-flight
    onClose();
  }, [onClose]);

  const handleSendWhatsAppReceipt = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanPhone = waPhone.trim();
    if (!cleanPhone) {
      setWaSendFeedback({
        type: 'error',
        message: 'Masukkan nomor WhatsApp penerima.',
      });
      return;
    }

    setIsSendingWa(true);
    setWaSendFeedback(null);

    try {
      const result = await sendPosReceiptWhatsApp(orderId, propertyId, cleanPhone, authFetch);
      if (result.success) {
        const masked = result.data?.recipient_phone_masked || cleanPhone;
        setWaSendFeedback({
          type: 'success',
          message: `Struk berhasil dikirim via WhatsApp ke ${masked}`,
        });
        // Refresh logs
        fetchPosReceiptWhatsAppLogs(orderId, propertyId, authFetch)
          .then((logs) => setWaLogs(logs))
          .catch(() => {});
      } else {
        setWaSendFeedback({
          type: 'error',
          message: result.error || 'Gagal mengirim struk via WhatsApp',
        });
      }
    } catch (err: any) {
      setWaSendFeedback({
        type: 'error',
        message: err.message || 'Terjadi kesalahan saat mengirim struk WhatsApp',
      });
    } finally {
      setIsSendingWa(false);
    }
  };

  const canPrint =
    !loading && !error && receipt !== null && printedAt !== null;

  // WhatsApp Web fallback
  const commSettings = commSettingsState;
  const whatsappOptions = {
    intro: commSettings.whatsapp_intro_message,
    closing: commSettings.whatsapp_closing_message,
  };
  const whatsappUrl =
    receipt !== null && !loading && !error
      ? buildPosReceiptWhatsAppUrl(receipt, whatsappOptions)
      : null;
  const canWhatsAppWeb = whatsappUrl !== null && commSettings.whatsapp_enabled;

  const whatsappWebTooltip = !canWhatsAppWeb
    ? !commSettings.whatsapp_enabled
      ? 'Pengiriman WhatsApp dinonaktifkan dari Pengaturan POS'
      : 'Nomor WhatsApp pelanggan tidak tersedia atau tidak valid'
    : 'Buka tautan WhatsApp Web di tab baru';

  const handleWhatsAppWeb = useCallback(() => {
    if (whatsappUrl && canWhatsAppWeb) {
      window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    }
  }, [whatsappUrl, canWhatsAppWeb]);

  // ── Render ───────────────────────────────────────────────────────────

  if (!isOpen) return null;

  const subtitle = receipt
    ? `No. Order: ${receipt.order.order_number}`
    : undefined;

  const lastSentLog = waLogs.length > 0 ? waLogs[0] : null;

  const footer = (
    <div className="three-actions">
      <button
        type="button"
        onClick={handleClose}
        className="three-btn-secondary"
      >
        Tutup
      </button>
      <button
        type="button"
        onClick={handleWhatsAppWeb}
        className="three-btn-secondary"
        disabled={!canWhatsAppWeb}
        title={whatsappWebTooltip}
      >
        Buka WA Web
      </button>
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

        {/* WhatsApp Dispatch Panel */}
        {!loading && !error && receipt && (
          <div className="three-wa-panel">
            <div className="three-wa-header">
              <span className="three-wa-title">
                <span>📱</span> Kirim Struk Digital WhatsApp
              </span>
              {!commSettings.whatsapp_enabled && (
                <span style={{ fontSize: '11px', color: '#dc2626', fontWeight: 500 }}>
                  Fitur dinonaktifkan di pengaturan
                </span>
              )}
            </div>

            <form onSubmit={handleSendWhatsAppReceipt} className="three-wa-form">
              <input
                type="text"
                className="three-wa-input"
                placeholder="08xxx / 628xxx"
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value)}
                disabled={isSendingWa || !commSettings.whatsapp_enabled}
              />
              <button
                type="submit"
                className="three-btn-wa"
                disabled={isSendingWa || !commSettings.whatsapp_enabled || !waPhone.trim()}
              >
                {isSendingWa ? 'Mengirim...' : 'Kirim Struk WA'}
              </button>
            </form>

            {waSendFeedback && (
              <div
                className={
                  waSendFeedback.type === 'success'
                    ? 'three-wa-feedback-success'
                    : 'three-wa-feedback-error'
                }
              >
                <span>{waSendFeedback.type === 'success' ? '✓' : '⚠️'}</span>
                <span>{waSendFeedback.message}</span>
              </div>
            )}

            {lastSentLog && !waSendFeedback && (
              <div className="three-wa-logs-summary">
                <span>ℹ️</span>
                <span>
                  Terakhir dikirim: {lastSentLog.status === 'SENT' ? 'Sukses' : 'Gagal'} ke{' '}
                  {lastSentLog.recipient_phone_masked} (
                  {new Date(lastSentLog.created_at).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  )
                </span>
              </div>
            )}
          </div>
        )}

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
                    if (data.order?.guest_phone) {
                      setWaPhone(data.order.guest_phone);
                    }
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
