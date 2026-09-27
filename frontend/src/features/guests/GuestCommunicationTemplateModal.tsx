import React, { useEffect, useMemo, useState } from 'react';
import {
  createGuestCommunicationTemplate,
  updateGuestCommunicationTemplate,
  type GuestCommunicationCategory,
  type GuestCommunicationScope,
  type GuestCommunicationTemplate,
} from './guestCommunicationApi';

interface GuestCommunicationTemplateModalProps {
  isOpen: boolean;
  propertyId: number;
  template: GuestCommunicationTemplate | null;
  onClose: () => void;
  onSaved: (template: GuestCommunicationTemplate) => void;
}

const TEMPLATE_VARIABLES = [
  'guest_name',
  'guest_full_name',
  'reservation_id',
  'property_name',
  'check_in_date',
  'check_out_date',
  'check_out_time',
  'meal_plan',
  'room_type',
  'room_number',
] as const;

const SCOPES: Array<{ value: GuestCommunicationScope; label: string }> = [
  { value: 'STAY_OPERATIONAL', label: 'Operasional Tamu Menginap' },
  { value: 'CRM_CAMPAIGN', label: 'CRM Campaign' },
  { value: 'BIRTHDAY', label: 'Ulang Tahun' },
  { value: 'POST_STAY', label: 'Pasca Menginap' },
  { value: 'PROMOTION', label: 'Promosi' },
];

const CATEGORIES: Array<{ value: GuestCommunicationCategory; label: string }> = [
  { value: 'CHECKOUT_REMINDER', label: 'Pengingat Checkout' },
  { value: 'DINNER_PROMO', label: 'Promo Dinner' },
  { value: 'BREAKFAST_INFO', label: 'Informasi Sarapan' },
  { value: 'LAUNDRY_PROMO', label: 'Promo Laundry' },
  { value: 'LATE_CHECKOUT', label: 'Late Checkout' },
  { value: 'BIRTHDAY', label: 'Ulang Tahun' },
  { value: 'PROMOTION', label: 'Promosi' },
  { value: 'POST_STAY', label: 'Pasca Menginap' },
  { value: 'CUSTOM', label: 'Custom' },
];

function extractTemplateVariables(messageBody: string): string[] {
  const matches = messageBody.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g);
  return Array.from(new Set(Array.from(matches, (match) => match[1])));
}

export const GuestCommunicationTemplateModal: React.FC<
  GuestCommunicationTemplateModalProps
> = ({
  isOpen,
  propertyId,
  template,
  onClose,
  onSaved,
}) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<GuestCommunicationScope>('STAY_OPERATIONAL');
  const [category, setCategory] = useState<GuestCommunicationCategory>('CUSTOM');
  const [messageBody, setMessageBody] = useState('');
  const [allowedStatuses, setAllowedStatuses] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    setCode(template?.code ?? '');
    setName(template?.name ?? '');
    setScope(template?.scope ?? 'STAY_OPERATIONAL');
    setCategory(template?.category ?? 'CUSTOM');
    setMessageBody(template?.message_body ?? '');
    setAllowedStatuses(
      template?.allowed_reservation_statuses?.join(', ') ??
        (template?.scope === 'STAY_OPERATIONAL' || !template ? 'CHECKED_IN' : '')
    );
    setDisplayOrder(template?.display_order ?? 0);
    setIsActive(template?.is_active ?? true);
    setError(null);
  }, [isOpen, template]);

  const detectedVariables = useMemo(
    () => extractTemplateVariables(messageBody),
    [messageBody]
  );

  if (!isOpen) return null;

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    setMessageBody((current) =>
      current.length === 0
        ? token
        : `${current}${current.endsWith(' ') || current.endsWith('\n') ? '' : ' '}${token}`
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const normalizedCode = code.trim().toUpperCase();
    const normalizedName = name.trim();
    const normalizedMessage = messageBody.trim();

    if (!normalizedCode) {
      setError('Kode template wajib diisi.');
      return;
    }

    if (!normalizedName) {
      setError('Nama template wajib diisi.');
      return;
    }

    if (!normalizedMessage) {
      setError('Isi pesan WhatsApp wajib diisi.');
      return;
    }

    const unsupportedVariable = detectedVariables.find(
      (variable) => !TEMPLATE_VARIABLES.includes(variable as typeof TEMPLATE_VARIABLES[number])
    );

    if (unsupportedVariable) {
      setError(`Variabel {{${unsupportedVariable}}} tidak didukung.`);
      return;
    }

    const normalizedStatuses = Array.from(
      new Set(
        allowedStatuses
          .split(',')
          .map((status) => status.trim().toUpperCase())
          .filter(Boolean)
      )
    );

    setSaving(true);
    setError(null);

    try {
      const input = {
        code: normalizedCode,
        name: normalizedName,
        scope,
        category,
        message_body: normalizedMessage,
        allowed_reservation_statuses: normalizedStatuses,
        template_variables: detectedVariables,
        display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
        is_active: isActive,
      };

      const saved = template
        ? await updateGuestCommunicationTemplate(propertyId, template.id, input)
        : await createGuestCommunicationTemplate(propertyId, input);

      onSaved(saved);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Template komunikasi tamu gagal disimpan.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50/50">
          <div>
            <h3 className="text-base font-bold text-stone-900">
              {template ? 'Edit Template WhatsApp' : 'Tambah Template WhatsApp'}
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Template digunakan oleh CRM dan operasional Front Office.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1 text-stone-400 hover:text-stone-700 rounded-md transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5 text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Kode Template <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="CHECKOUT_REMINDER"
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none font-mono"
              />
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Nama Template <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Pengingat Checkout"
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Scope
              </label>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as GuestCommunicationScope)}
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
              >
                {SCOPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Kategori
              </label>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as GuestCommunicationCategory)}
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
              >
                {CATEGORIES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-stone-700 mb-1">
              Isi Pesan WhatsApp <span className="text-red-500">*</span>
            </label>
            <textarea
              rows={7}
              value={messageBody}
              onChange={(event) => setMessageBody(event.target.value)}
              placeholder="Halo {{guest_name}}, waktu checkout Anda adalah pukul {{check_out_time}}."
              disabled={saving}
              className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none resize-y"
            />
          </div>

          <div>
            <div className="font-semibold text-stone-700 mb-2">
              Variabel Otomatis
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insertVariable(variable)}
                  disabled={saving}
                  className="px-2 py-1 rounded border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-600 font-mono"
                >
                  {`{{${variable}}}`}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-stone-500 mt-2">
              Nilai variabel akan diambil otomatis dari data tamu, reservasi, kamar, dan properti saat pesan disiapkan.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Status Reservasi yang Diizinkan
              </label>
              <input
                type="text"
                value={allowedStatuses}
                onChange={(event) => setAllowedStatuses(event.target.value)}
                placeholder="CHECKED_IN"
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none font-mono"
              />
              <p className="text-[11px] text-stone-500 mt-1">
                Pisahkan beberapa status dengan koma.
              </p>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Urutan Tampilan
              </label>
              <input
                type="number"
                value={displayOrder}
                onChange={(event) => setDisplayOrder(Number(event.target.value))}
                disabled={saving}
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-stone-700">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={saving}
              className="rounded border-stone-300"
            />
            <span className="font-semibold">Template aktif</span>
          </label>

          <div className="pt-4 border-t border-stone-200 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold rounded transition-colors"
            >
              Batal
            </button>

            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold rounded shadow-xs transition-colors flex items-center gap-1.5"
            >
              {saving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Menyimpan...</span>
                </>
              ) : (
                <span>Simpan Template</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};