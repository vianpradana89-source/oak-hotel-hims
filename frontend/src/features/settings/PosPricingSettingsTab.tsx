import React, { useState, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

/**
 * PosPricingSettingsTab — Service Charge & PBJT POS settings form.
 *
 * Follows the visual/loading/save/error pattern of PosCommunicationSettingsTab.
 * Rendered inside the "POS & F&B" category of ManagementSettingsWorkspace,
 * after the PosCommunicationSettingsTab section.
 *
 * Backend endpoints:
 *   GET /api/pos/pricing-settings?property_id=<id>   (POS:view read)
 *   PUT /api/pos/pricing-settings                     (Pengaturan:edit)
 *
 * Canonical field names:
 *   service_charge_enabled, service_charge_percent,
 *   tax_enabled, tax_percent
 *
 * V1 EXCLUSIVE ONLY: no prices_include_service / prices_include_tax flags.
 * When enabled=false, percent inputs are visually disabled (grayed out) but
 * their values are PRESERVED in form state — toggling ON restores the
 * previously entered percent without re-entry.
 * Toggle is disabled only while saving.
 */

export interface PosPricingSettingsTabProps {
  propertyId: number;
  activeProperty?: {
    id: number;
    name: string;
    property_code?: string;
  };
  apiBaseUrl?: string;
}

interface PricingSettingsData {
  service_charge_enabled: boolean;
  service_charge_percent: number;
  tax_enabled: boolean;
  tax_percent: number;
}

/** In-memory defaults when no row exists in the DB. */
const DEFAULTS: PricingSettingsData = {
  service_charge_enabled: false,
  service_charge_percent: 0,
  tax_enabled: false,
  tax_percent: 0,
};

export const PosPricingSettingsTab: React.FC<PosPricingSettingsTabProps> = ({
  propertyId,
  activeProperty,
  apiBaseUrl = '/api',
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Form state (percent as string for input control, converted on save)
  const [serviceEnabled, setServiceEnabled] = useState<boolean>(false);
  const [servicePercent, setServicePercent] = useState<string>('0');
  const [taxEnabled, setTaxEnabled] = useState<boolean>(false);
  const [taxPercent, setTaxPercent] = useState<string>('0');

  // Initial copy for cancel/reset
  const [initialData, setInitialData] = useState<PricingSettingsData | null>(null);

  // Stale / scope guard — mirrors PosCommunicationSettingsTab pattern
  const activePropertyRef = useRef(propertyId);
  activePropertyRef.current = propertyId;
  const scopeEpoch = useRef({ propertyId, apiBaseUrl, version: 0 });
  if (scopeEpoch.current.propertyId !== propertyId || scopeEpoch.current.apiBaseUrl !== apiBaseUrl) {
    scopeEpoch.current = { propertyId, apiBaseUrl, version: scopeEpoch.current.version + 1 };
  }

  const applyData = (data: PricingSettingsData) => {
    setServiceEnabled(data.service_charge_enabled);
    setServicePercent(String(data.service_charge_percent));
    setTaxEnabled(data.tax_enabled);
    setTaxPercent(String(data.tax_percent));
    setInitialData(data);
  };

  // ── GET ─────────────────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    const requestedProperty = propertyId;
    const requestedEpoch = scopeEpoch.current.version;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/pos/pricing-settings?property_id=${propertyId}`,
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg =
          res.status === 403
            ? 'Anda tidak memiliki izin membaca pengaturan pricing POS.'
            : errJson.message || `Gagal memuat pengaturan pricing POS (HTTP ${res.status})`;
        throw new Error(msg);
      }
      const json = await res.json();
      if (
        activePropertyRef.current === requestedProperty &&
        scopeEpoch.current.version === requestedEpoch
      ) {
        const data = json.data as PricingSettingsData | null;
        if (data && typeof data.service_charge_enabled === 'boolean') {
          applyData({
            service_charge_enabled: data.service_charge_enabled,
            service_charge_percent: Number(data.service_charge_percent) || 0,
            tax_enabled: data.tax_enabled,
            tax_percent: Number(data.tax_percent) || 0,
          });
        } else {
          applyData(DEFAULTS);
        }
      }
    } catch (err: unknown) {
      if (activePropertyRef.current === requestedProperty && scopeEpoch.current.version === requestedEpoch) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Gagal memuat pengaturan pricing POS.',
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

  // ── RESET ───────────────────────────────────────────────────────────────────
  const handleReset = () => {
    if (initialData) {
      applyData(initialData);
      setFeedback(null);
    }
  };

  // ── PUT ─────────────────────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    const svcNum = servicePercent.trim() === '' ? 0 : parseFloat(servicePercent.trim());
    const taxNum = taxPercent.trim() === '' ? 0 : parseFloat(taxPercent.trim());

    if (isNaN(svcNum) || svcNum < 0 || svcNum > 100) {
      setFeedback({ type: 'error', message: 'Persen service charge harus angka 0–100 (maks 2 desimal).' });
      return;
    }
    if (isNaN(taxNum) || taxNum < 0 || taxNum > 100) {
      setFeedback({ type: 'error', message: 'Persen PBJT harus angka 0–100 (maks 2 desimal).' });
      return;
    }
    if (Math.round(svcNum * 100) / 100 !== svcNum) {
      setFeedback({ type: 'error', message: 'Persen service charge maksimal 2 desimal.' });
      return;
    }
    if (Math.round(taxNum * 100) / 100 !== taxNum) {
      setFeedback({ type: 'error', message: 'Persen PBJT maksimal 2 desimal.' });
      return;
    }

    const requestedProperty = propertyId;
    const requestedEpoch = scopeEpoch.current.version;
    setSaving(true);
    setFeedback(null);

    const payload = {
      property_id: propertyId,
      service_charge_enabled: serviceEnabled,
      service_charge_percent: Math.round(svcNum * 100) / 100,
      tax_enabled: taxEnabled,
      tax_percent: Math.round(taxNum * 100) / 100,
    };

    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/pos/pricing-settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      const json = await res.json().catch(() => ({}));

      if (res.status === 403) {
        throw new Error('Anda tidak memiliki izin mengubah pengaturan pricing POS.');
      }
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan pengaturan pricing POS.');
      }

      if (activePropertyRef.current !== requestedProperty || scopeEpoch.current.version !== requestedEpoch) {
        return;
      }

      // Update local state from response if available
      if (json.data && typeof json.data.service_charge_enabled === 'boolean') {
        applyData({
          service_charge_enabled: json.data.service_charge_enabled,
          service_charge_percent: Number(json.data.service_charge_percent) || 0,
          tax_enabled: json.data.tax_enabled,
          tax_percent: Number(json.data.tax_percent) || 0,
        });
      } else {
        applyData({
          service_charge_enabled: payload.service_charge_enabled,
          service_charge_percent: payload.service_charge_percent,
          tax_enabled: payload.tax_enabled,
          tax_percent: payload.tax_percent,
        });
      }

      setFeedback({
        type: 'success',
        message: 'Pengaturan pricing POS berhasil disimpan.',
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

  // ── Loading / Error states ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-neutral-200/90 p-8 text-center space-y-3 shadow-xs">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-700 border-t-transparent rounded-full" />
        <p className="text-xs text-neutral-500 font-medium">Memuat pengaturan pricing POS…</p>
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

  // ── Percent input helper component ────────────────────────────────────────
  const PercentInput = ({
    label,
    description,
    value,
    onChange,
    disabled,
  }: {
    label: string;
    description: string;
    value: string;
    onChange: (v: string) => void;
    disabled: boolean;
  }) => (
    <div>
      <label className="block text-xs font-bold text-neutral-700 mb-1">{label}</label>
      <p className="text-[11px] text-neutral-500 mb-2">{description}</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          min={0}
          max={100}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-28 text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition disabled:bg-neutral-100 disabled:text-neutral-400"
        />
        <span className="text-xs font-bold text-neutral-500">%</span>
      </div>
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
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
            <h3 className="text-sm font-bold text-neutral-900">
              Service Charge & PBJT POS
              {activeProperty && (
                <span className="ml-2 text-[11px] font-normal text-neutral-400">
                  — {activeProperty.name}
                </span>
              )}
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
              Runtime Config
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Atur service charge dan PBJT (Pajak Barang dan Jasa Tertentu) untuk order POS/F&B.
            Nilai disimpan sebagai snapshot per order; order historis tidak berubah saat setting diubah.
          </p>
        </div>

        {/* Service Charge section */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-600">
            Service Charge
          </div>
          <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200/80 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-neutral-800">
                  Aktifkan Service Charge
                </div>
                <div className="text-[11px] text-neutral-500">
                  Ditambahkan di atas subtotal setelah diskon.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  disabled={saving}
                  type="checkbox"
                  checked={serviceEnabled}
                  onChange={(e) => setServiceEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-neutral-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-700" />
              </label>
            </div>
            <PercentInput
              label="Persen Service Charge"
              description="0.00 – 100.00 % (maks 2 desimal). Digunakan saat service charge diaktifkan."
              value={servicePercent}
              onChange={setServicePercent}
              disabled={saving || !serviceEnabled}
            />
          </div>
        </div>

        {/* PBJT section */}
        <div className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-600">
            PBJT (Pajak Barang dan Jasa Tertentu)
          </div>
          <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200/80 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-neutral-800">
                  Aktifkan PBJT
                </div>
                <div className="text-[11px] text-neutral-500">
                  PBJT dihitung di atas (subtotal setelah diskon + service charge).
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  disabled={saving}
                  type="checkbox"
                  checked={taxEnabled}
                  onChange={(e) => setTaxEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-neutral-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-700" />
              </label>
            </div>
            <PercentInput
              label="Persen PBJT"
              description="0.00 – 100.00 % (maks 2 desimal). Digunakan saat PBJT diaktifkan."
              value={taxPercent}
              onChange={setTaxPercent}
              disabled={saving || !taxEnabled}
            />
          </div>
        </div>

        {/* Info note */}
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="text-[11px] font-semibold text-amber-800">
            V1 EXCLUSIVE ONLY
          </div>
          <div className="text-[10px] text-amber-700 mt-0.5">
            Harga item POS bersifat exclusive (tidak termasuk service/tax).
            Dukungan harga inclusive akan ditambahkan di versi berikutnya.
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
              <span>Simpan Pengaturan Pricing</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
