import React, { useState, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

/**
 * PosCommunicationSettingsTab — WhatsApp POS communication settings form.
 *
 * Follows the visual/loading/save/error pattern of PaymentInstructionsSettingsTab.
 * Rendered inside the "POS & F&B" category of ManagementSettingsWorkspace,
 * after the Payment Instructions section.
 *
 * Backend endpoints (C2B-0):
 *   GET /api/pos/communication-settings?property_id=<id>   (POS:view read)
 *   PUT /api/pos/communication-settings                     (Pengaturan:edit)
 *
 * Canonical field names:
 *   whatsapp_enabled, whatsapp_intro_message, whatsapp_closing_message
 */

export interface PosCommunicationSettingsTabProps {
  propertyId: number;
  activeProperty?: {
    id: number;
    name: string;
    property_code?: string;
  };
  apiBaseUrl?: string;
}

interface CommSettingsData {
  whatsapp_enabled: boolean;
  whatsapp_intro_message: string | null;
  whatsapp_closing_message: string | null;
}

const MAX_MSG_LEN = 500;

export const PosCommunicationSettingsTab: React.FC<PosCommunicationSettingsTabProps> = ({
  propertyId,
  activeProperty,
  apiBaseUrl = '/api',
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Form state
  const [whatsappEnabled, setWhatsappEnabled] = useState<boolean>(true);
  const [introMessage, setIntroMessage] = useState<string>('');
  const [closingMessage, setClosingMessage] = useState<string>('');

  // Initial copy for cancel/reset
  const [initialData, setInitialData] = useState<CommSettingsData | null>(null);

  // Stale / scope guard — mirrors PaymentInstructionsSettingsTab pattern
  const activePropertyRef = useRef(propertyId);
  activePropertyRef.current = propertyId;
  const scopeEpoch = useRef({ propertyId, apiBaseUrl, version: 0 });
  if (scopeEpoch.current.propertyId !== propertyId || scopeEpoch.current.apiBaseUrl !== apiBaseUrl) {
    scopeEpoch.current = { propertyId, apiBaseUrl, version: scopeEpoch.current.version + 1 };
  }

  const applyData = (data: CommSettingsData) => {
    setWhatsappEnabled(data.whatsapp_enabled);
    setIntroMessage(data.whatsapp_intro_message ?? '');
    setClosingMessage(data.whatsapp_closing_message ?? '');
    setInitialData(data);
  };

  // ── GET ───────────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    const requestedProperty = propertyId;
    const requestedEpoch = scopeEpoch.current.version;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/pos/communication-settings?property_id=${propertyId}`,
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg =
          res.status === 403
            ? 'Anda tidak memiliki izin membaca pengaturan komunikasi POS.'
            : errJson.message || `Gagal memuat pengaturan komunikasi POS (HTTP ${res.status})`;
        throw new Error(msg);
      }
      const json = await res.json();
      if (
        activePropertyRef.current === requestedProperty &&
        scopeEpoch.current.version === requestedEpoch
      ) {
        const data = json.data as CommSettingsData | null;
        if (data && typeof data.whatsapp_enabled === 'boolean') {
          applyData({
            whatsapp_enabled: data.whatsapp_enabled,
            whatsapp_intro_message:
              typeof data.whatsapp_intro_message === 'string' ? data.whatsapp_intro_message : null,
            whatsapp_closing_message:
              typeof data.whatsapp_closing_message === 'string' ? data.whatsapp_closing_message : null,
          });
        } else {
          // No row yet or invalid shape — use defaults
          applyData({
            whatsapp_enabled: true,
            whatsapp_intro_message: null,
            whatsapp_closing_message: null,
          });
        }
      }
    } catch (err: unknown) {
      if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Gagal memuat pengaturan komunikasi POS.',
        });
      }
    } finally {
      if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
        setLoading(false);
      }
    }
  }, [propertyId, apiBaseUrl]);

  useEffect(() => {
    setSaving(false);
    setInitialData(null);
    loadSettings();
  }, [loadSettings]);

  // ── RESET ───────────────────────────────���───────────────────────────────
  const handleReset = () => {
    if (initialData) {
      applyData(initialData);
      setFeedback(null);
    }
  };

  // ── PUT ───────────────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    const trimmedIntro = introMessage.trim();
    const trimmedClosing = closingMessage.trim();

    if (trimmedIntro.length > MAX_MSG_LEN || trimmedClosing.length > MAX_MSG_LEN) {
      setFeedback({
        type: 'error',
        message: `Pesan maksimal ${MAX_MSG_LEN} karakter.`,
      });
      return;
    }

    const requestedProperty = propertyId;
    const requestedEpoch = scopeEpoch.current.version;
    setSaving(true);
    setFeedback(null);

    const payload = {
      property_id: propertyId,
      whatsapp_enabled: whatsappEnabled,
      whatsapp_intro_message: trimmedIntro.length > 0 ? trimmedIntro : null,
      whatsapp_closing_message: trimmedClosing.length > 0 ? trimmedClosing : null,
    };

    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/pos/communication-settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      const json = await res.json().catch(() => ({}));

      if (res.status === 403) {
        throw new Error('Anda tidak memiliki izin mengubah pengaturan POS.');
      }
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan pengaturan komunikasi POS.');
      }

      if (activePropertyRef.current !== requestedProperty || scopeEpoch.current.version !== requestedEpoch) {
        return;
      }

      // Update local state from response if available
      if (json.data && typeof json.data.whatsapp_enabled === 'boolean') {
        applyData({
          whatsapp_enabled: json.data.whatsapp_enabled,
          whatsapp_intro_message:
            typeof json.data.whatsapp_intro_message === 'string'
              ? json.data.whatsapp_intro_message
              : null,
          whatsapp_closing_message:
            typeof json.data.whatsapp_closing_message === 'string'
              ? json.data.whatsapp_closing_message
              : null,
        });
      } else {
        // Fallback: use the payload we just sent
        applyData({
          whatsapp_enabled: whatsappEnabled,
          whatsapp_intro_message: payload.whatsapp_intro_message,
          whatsapp_closing_message: payload.whatsapp_closing_message,
        });
      }

      setFeedback({
        type: 'success',
        message: 'Pengaturan komunikasi POS berhasil disimpan.',
      });
      setTimeout(() => {
        if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
          setFeedback(null);
        }
      }, 5000);
    } catch (err: unknown) {
      if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Gagal menyimpan pengaturan.',
        });
      }
    } finally {
      if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
        setSaving(false);
      }
    }
  };

  // ── Loading / Error states ────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-neutral-200/90 p-8 text-center space-y-3 shadow-xs">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-700 border-t-transparent rounded-full" />
        <p className="text-xs text-neutral-500 font-medium">Memuat pengaturan komunikasi POS…</p>
      </div>
    );
  }

  if (feedback?.type === 'error' && !initialData) {
    return (
      <div className="bg-white rounded-2xl border border-red-200 p-5 space-y-3 shadow-xs">
        <div className="text-xs font-semibold text-red-800">{feedback.message}</div>
        <button
          type="button"
          onClick={() => void loadSettings()}
          className="text-xs font-semibold text-neutral-600 underline hover:text-neutral-900"
        >
          Muat ulang
        </button>
      </div>
    );
  }

  // ── Preview helper ────────────────────────────────────────────────────
  const hotelLabel = activeProperty?.name || 'Nama Hotel';
  const trimmedIntroPreview = introMessage.trim();
  const trimmedClosingPreview = closingMessage.trim();

  const previewLines: React.ReactNode[] = [];

  if (trimmedIntroPreview) {
    previewLines.push(
      <span key="intro" className="text-emerald-700 italic">{trimmedIntroPreview}</span>,
      <span key="intro-blank"> </span>,
    );
  }

  previewLines.push(
    <div key="hotel" className="font-bold">*{hotelLabel}*</div>,
    <div key="order-ref">No. Order: POS-YYMMDD-0001</div>,
    <div key="trx">No. Transaksi: …</div>,
    <div key="blank-1"> </div>,
    <div key="items">Detail Pesanan: …</div>,
    <div key="total">Total: Rp …</div>,
    <div key="blank-2"> </div>,
    <div key="payment">Pembayaran:</div>,
    <div key="method">Metode: …</div>,
    <div key="blank-3"> </div>,
  );

  if (trimmedClosingPreview) {
    previewLines.push(
      <span key="closing" className="text-emerald-700 italic">{trimmedClosingPreview}</span>,
      <span key="closing-blank"> </span>,
    );
  }

  previewLines.push(
    <div key="thanks">Terima kasih telah berbelanja di {hotelLabel}!</div>,
    <div key="farewell">Semoga berkenan. Sampai jumpa.</div>,
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Feedback alert */}
      {feedback && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-neutral-400 hover:text-neutral-700 font-bold ml-3"
          >
            ×
          </button>
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white rounded-2xl border border-neutral-200/90 p-5 shadow-xs space-y-6">
        {/* Header */}
        <div className="border-b border-neutral-100 pb-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold text-neutral-900">Pengiriman WhatsApp POS</h3>
            <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
              Runtime Config
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Atur pengiriman struk POS melalui WhatsApp dan pesan tambahan yang menyertai struk.
          </p>
        </div>

        {/* Toggle */}
        <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200/80 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-neutral-800">
              Aktifkan pengiriman struk via WhatsApp
            </div>
            <div className="text-[11px] text-neutral-500">
              Jika dinonaktifkan, tombol WhatsApp pada struk POS tetap terlihat tetapi tidak dapat digunakan.
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              disabled={saving}
              type="checkbox"
              checked={whatsappEnabled}
              onChange={(e) => setWhatsappEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-neutral-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-700" />
          </label>
        </div>

        {/* Intro textarea */}
        <div>
          <label className="block text-xs font-bold text-neutral-700 mb-1">
            Pesan Pembuka
            <span className="ml-2 font-normal text-neutral-400 text-[10px]">
              {introMessage.length}/{MAX_MSG_LEN}
            </span>
          </label>
          <p className="text-[11px] text-neutral-500 mb-2">
            Ditampilkan sebelum nama hotel pada pesan WhatsApp.
          </p>
          <textarea
            disabled={saving}
            rows={3}
            value={introMessage}
            maxLength={MAX_MSG_LEN}
            onChange={(e) => setIntroMessage(e.target.value)}
            placeholder="Contoh: Selamat datang di restoran kami! Berikut struk pesanan Anda."
            className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition resize-y"
          />
        </div>

        {/* Closing textarea */}
        <div>
          <label className="block text-xs font-bold text-neutral-700 mb-1">
            Pesan Penutup
            <span className="ml-2 font-normal text-neutral-400 text-[10px]">
              {closingMessage.length}/{MAX_MSG_LEN}
            </span>
          </label>
          <p className="text-[11px] text-neutral-500 mb-2">
            Ditampilkan sebelum ucapan terima kasih standar.
          </p>
          <textarea
            disabled={saving}
            rows={3}
            value={closingMessage}
            maxLength={MAX_MSG_LEN}
            onChange={(e) => setClosingMessage(e.target.value)}
            placeholder="Contoh: Jangan lupa follow media sosial kami!"
            className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition resize-y"
          />
        </div>

        {/* Preview */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-600 mb-2">
            Preview Struktur Pesan
          </div>
          <p className="text-[10px] text-neutral-400 mb-2">
            Data transaksi pada preview hanya contoh.
          </p>
          <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200 text-xs whitespace-pre-wrap font-mono text-neutral-700 leading-relaxed max-h-64 overflow-y-auto">
            {previewLines}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-neutral-100">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="px-4 py-2 text-xs font-semibold text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-xl transition cursor-pointer disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs transition flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {saving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Menyimpan…</span>
              </>
            ) : (
              <span>Simpan Pengaturan WhatsApp</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
