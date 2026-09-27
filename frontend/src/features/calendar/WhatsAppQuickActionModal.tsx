/**
 * WhatsApp Quick Action Modal — shared between ReservationDetailDrawer & QuickReservationDetail
 *
 * 规则：
 * - 不重复 modal JSX
 * - 复用 hook useWhatsAppQuickAction 的 state/handlers
 */
import type { UseWhatsAppQuickActionResult } from './useWhatsAppQuickAction';

interface WhatsAppQuickActionModalProps {
  isOpen: boolean;
  guestName?: string;
  guestPhone: string;
  hooks: UseWhatsAppQuickActionResult;
}

export default function WhatsAppQuickActionModal({
  isOpen,
  guestName,
  guestPhone,
  hooks,
}: WhatsAppQuickActionModalProps) {
  const {
    waTemplates,
    waTemplatesLoading,
    waSelectedTemplate,
    waPreviewMessage,
    waLoadingPreview,
    waError,
    waMarkingOpened,
    handleSelectTemplate,
    handleSendWhatsApp,
    setWhatsAppModalOpen,
  } = hooks;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in-0 duration-150"
        onClick={!waLoadingPreview && !waMarkingOpened ? () => setWhatsAppModalOpen(false) : undefined}
        aria-hidden="true"
      />

      {/* Modal Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Kirim WhatsApp Tamu"
        className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl border border-slate-200/90 flex flex-col overflow-hidden max-h-[90vh] z-10 transition-transform animate-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#fcfbf9] border-b border-slate-200/80 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900 truncate tracking-tight">
              Kirim WhatsApp ke {guestName || 'Tamu'}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setWhatsAppModalOpen(false)}
            className={`p-1.5 rounded-lg transition-colors shrink-0 ${!waLoadingPreview && !waMarkingOpened ? 'cursor-pointer text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'cursor-not-allowed text-slate-200 pointer-events-none'}`}
            aria-label="Tutup dialog"
            disabled={waLoadingPreview || waMarkingOpened}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          <div className="space-y-4">
            {/* Template Selection */}
            <div>
              <label className="block text-xs font-bold text-stone-600 mb-1.5">
                Pilih Template Pesan
              </label>
              {waTemplatesLoading ? (
                <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs text-stone-500 text-center">
                  Memuat template...
                </div>
              ) : waTemplates.length === 0 ? (
                <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs text-stone-500 text-center">
                  Tidak ada template aktif untuk properti ini.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {waTemplates.map((tpl) => {
                    const isSelected = waSelectedTemplate?.id === tpl.id;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => handleSelectTemplate(tpl)}
                        disabled={waLoadingPreview || waMarkingOpened}
                        className={`w-full text-left p-2.5 rounded-lg border transition-colors cursor-pointer text-xs ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                            : 'border-stone-200 bg-white hover:bg-stone-50 text-stone-700'
                        } ${waLoadingPreview || waMarkingOpened ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <div className="font-semibold">{tpl.name}</div>
                        <div className="text-stone-500 mt-0.5">{tpl.category}</div>
                        <div className="text-stone-400 mt-0.5 font-mono text-[10px]">{tpl.code}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Preview */}
            {waSelectedTemplate && (
              <div>
                <label className="block text-xs font-bold text-stone-600 mb-1.5">
                  Preview Pesan
                </label>
                {waLoadingPreview ? (
                  <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs text-stone-500 text-center animate-pulse">
                    Menyiapkan pesan...
                  </div>
                ) : waPreviewMessage ? (
                  <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200 text-xs text-stone-800 font-mono whitespace-pre-wrap">
                    {waPreviewMessage}
                  </div>
                ) : null}
              </div>
            )}

            {/* Error */}
            {waError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                {waError}
              </div>
            )}

            {/* Info */}
            {waSelectedTemplate && !waLoadingPreview && (
              <div className="text-[11px] text-stone-500">
                Nomor tujuan: <span className="font-mono font-semibold text-stone-700">{guestPhone}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {waSelectedTemplate && hooks.waDeepLink && (
          <div className="px-5 py-3 bg-[#faf9f6] border-t border-slate-200/80 flex items-center justify-end gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setWhatsAppModalOpen(false)}
              className="px-3.5 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold text-xs rounded-xl transition-colors cursor-pointer"
            >
              Tutup
            </button>
            <button
              type="button"
              onClick={handleSendWhatsApp}
              disabled={waMarkingOpened}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-xs rounded-xl shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
            >
              {waMarkingOpened ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Menandai...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  Buka WhatsApp
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
