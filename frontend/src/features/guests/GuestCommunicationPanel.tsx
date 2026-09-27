import React, { useEffect, useState } from 'react';
import {
  listGuestCommunicationTemplates,
  type GuestCommunicationTemplate,
} from './guestCommunicationApi';
import { GuestCommunicationTemplateModal } from './GuestCommunicationTemplateModal';

interface GuestCommunicationPanelProps {
  propertyId: number;
}

export const GuestCommunicationPanel: React.FC<GuestCommunicationPanelProps> = ({
  propertyId,
}) => {
  const [templates, setTemplates] = useState<GuestCommunicationTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [editingTemplate, setEditingTemplate] = useState<GuestCommunicationTemplate | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadTemplates = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await listGuestCommunicationTemplates(propertyId);
        if (!cancelled) {
          setTemplates(data);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Template komunikasi tamu gagal dimuat.'
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadTemplates();

    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const openCreateModal = () => {
    setEditingTemplate(null);
    setIsTemplateModalOpen(true);
  };

  const openEditModal = (template: GuestCommunicationTemplate) => {
    setEditingTemplate(template);
    setIsTemplateModalOpen(true);
  };

  const closeTemplateModal = () => {
    setIsTemplateModalOpen(false);
    setEditingTemplate(null);
  };

  const handleTemplateSaved = (savedTemplate: GuestCommunicationTemplate) => {
    setTemplates((current) => {
      const existingIndex = current.findIndex((item) => item.id === savedTemplate.id);

      if (existingIndex === -1) {
        return [...current, savedTemplate].sort(
          (a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name)
        );
      }

      return current
        .map((item) => (item.id === savedTemplate.id ? savedTemplate : item))
        .sort(
          (a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name)
        );
    });
  };

  return (
    <>
      <div className="space-y-4">
        <div className="bg-white border border-stone-200 rounded-lg p-5 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-stone-900">
                Komunikasi Tamu
              </h2>
              <p className="text-xs text-stone-500 mt-1">
                Kelola template WhatsApp dan riwayat komunikasi tamu untuk properti aktif.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] bg-stone-100 text-stone-600 px-2 py-1 rounded font-mono">
                Property ID: #{propertyId}
              </span>

              <button
                type="button"
                onClick={openCreateModal}
                className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white rounded text-xs font-semibold shadow-xs transition-colors"
              >
                + Tambah Template
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-lg shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-stone-200">
            <h3 className="text-sm font-bold text-stone-900">
              Template WhatsApp
            </h3>
            <p className="text-xs text-stone-500 mt-1">
              Template aktif maupun nonaktif yang tersedia untuk properti ini.
            </p>
          </div>

          {loading && (
            <div className="p-5 text-sm text-stone-500">
              Memuat template komunikasi...
            </div>
          )}

          {!loading && error && (
            <div className="p-5 text-sm text-red-700 bg-red-50">
              {error}
            </div>
          )}

          {!loading && !error && templates.length === 0 && (
            <div className="p-5 text-sm text-stone-500">
              Belum ada template komunikasi.
            </div>
          )}

          {!loading && !error && templates.length > 0 && (
            <div className="divide-y divide-stone-100">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className="px-5 py-4 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-stone-900">
                        {template.name}
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-stone-100 text-stone-600 font-mono">
                        {template.code}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                          template.is_active
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-stone-100 text-stone-500 border border-stone-200'
                        }`}
                      >
                        {template.is_active ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </div>

                    <div className="text-xs text-stone-500 mt-2 whitespace-pre-wrap">
                      {template.message_body}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-[11px] text-stone-500">
                      {template.scope} · {template.category}
                    </div>

                    <button
                      type="button"
                      onClick={() => openEditModal(template)}
                      className="px-2.5 py-1 text-[11px] font-semibold border border-stone-300 rounded text-stone-700 hover:bg-stone-50 transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <GuestCommunicationTemplateModal
        isOpen={isTemplateModalOpen}
        propertyId={propertyId}
        template={editingTemplate}
        onClose={closeTemplateModal}
        onSaved={handleTemplateSaved}
      />
    </>
  );
};