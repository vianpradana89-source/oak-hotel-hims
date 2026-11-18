import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  deleteGuestCommunicationTemplate,
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
  const [search, setSearch] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<string>('ALL');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [editingTemplate, setEditingTemplate] = useState<GuestCommunicationTemplate | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState<GuestCommunicationTemplate | null>(null);

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

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((item) => {
      if (scopeFilter !== 'ALL' && item.scope !== scopeFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q) ||
        item.message_body.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [templates, search, scopeFilter]);

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

  const handleConfirmDelete = async () => {
    if (!confirmDeleteTemplate) return;
    const target = confirmDeleteTemplate;
    setDeletingId(target.id);
    setError(null);
    try {
      await deleteGuestCommunicationTemplate(propertyId, target.id);
      setTemplates((prev) => prev.filter((item) => item.id !== target.id));
      setConfirmDeleteTemplate(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus template komunikasi.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="space-y-4">
        {/* Top Toolbar */}
        <div className="bg-stone-50/80 border border-stone-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama template, kode, atau isi pesan..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-stone-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20"
            />
          </div>

          <div className="flex items-center flex-wrap gap-2">
            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              className="px-3 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-[#1E392A]/20 cursor-pointer"
            >
              <option value="ALL">Semua Kategori ({templates.length})</option>
              <option value="STAY_OPERATIONAL">Operasional Menginap</option>
              <option value="BIRTHDAY">Ulang Tahun</option>
              <option value="POST_STAY">Pasca Menginap</option>
              <option value="PROMOTION">Promosi</option>
              <option value="CRM_CAMPAIGN">Kampanye CRM</option>
            </select>

            <button
              type="button"
              onClick={openCreateModal}
              className="px-3.5 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white rounded-xl text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Tambah Template</span>
            </button>
          </div>
        </div>

        {loading && (
          <div className="p-8 text-center text-xs text-stone-500 bg-white border border-stone-200 rounded-2xl">
            Memuat template komunikasi tamu...
          </div>
        )}

        {!loading && error && (
          <div className="p-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl">
            {error}
          </div>
        )}

        {!loading && !error && filteredTemplates.length === 0 && (
          <div className="p-10 text-center bg-white border border-stone-200 rounded-2xl text-stone-500">
            <MessageSquareText className="w-8 h-8 mx-auto mb-2 text-stone-300" />
            <p className="text-xs font-semibold text-stone-700">Belum ada template komunikasi</p>
            <p className="text-[11px] text-stone-400 mt-0.5">
              Klik tombol Tambah Template di atas untuk membuat template pesan WhatsApp baru.
            </p>
          </div>
        )}

        {!loading && filteredTemplates.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {filteredTemplates.map((template) => (
              <div
                key={template.id}
                className="bg-white border border-stone-200 hover:border-stone-300 rounded-2xl p-4 shadow-2xs flex flex-col justify-between gap-3 transition-all"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h4 className="text-xs font-bold text-stone-900 truncate">
                          {template.name}
                        </h4>
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                            template.is_active
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-stone-100 text-stone-500 border border-stone-200'
                          }`}
                        >
                          {template.is_active ? (
                            <CheckCircle2 className="w-2.5 h-2.5" />
                          ) : (
                            <XCircle className="w-2.5 h-2.5" />
                          )}
                          <span>{template.is_active ? 'Aktif' : 'Nonaktif'}</span>
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="text-[10px] px-2 py-0.5 rounded bg-stone-100 text-stone-600 font-mono">
                          {template.code}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                          {template.scope} &middot; {template.category}
                        </span>
                      </div>
                    </div>

                    {/* Edit & Delete Icon Buttons */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditModal(template)}
                        className="p-2 rounded-xl border border-stone-200 text-stone-600 hover:text-[#1E392A] hover:bg-stone-50 transition-colors cursor-pointer"
                        title="Edit Template"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === template.id}
                        onClick={() => setConfirmDeleteTemplate(template)}
                        className="p-2 rounded-xl border border-red-200/80 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 cursor-pointer"
                        title="Hapus Template"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#FAF8F3] border border-[#E6DFC8]/70 text-xs text-stone-700 whitespace-pre-wrap leading-relaxed">
                    {template.message_body}
                  </div>
                </div>

                {Array.isArray(template.template_variables) && template.template_variables.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-stone-100">
                    <span className="text-[10px] text-stone-400 mr-1">Variabel:</span>
                    {template.template_variables.map((v) => (
                      <span
                        key={v}
                        className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-stone-100 text-stone-600"
                      >
                        &#123;&#123;{v}&#125;&#125;
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <GuestCommunicationTemplateModal
        isOpen={isTemplateModalOpen}
        propertyId={propertyId}
        template={editingTemplate}
        onClose={closeTemplateModal}
        onSaved={handleTemplateSaved}
      />

      {/* Delete Confirmation Modal */}
      {confirmDeleteTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-md p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center text-red-600 shrink-0">
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-stone-900">Hapus Template Komunikasi?</h4>
                <p className="text-xs text-stone-500 mt-1">
                  Anda yakin ingin menghapus template <strong>{confirmDeleteTemplate.name}</strong> ({confirmDeleteTemplate.code})?
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-100">
              <button
                type="button"
                onClick={() => setConfirmDeleteTemplate(null)}
                className="px-3.5 py-1.5 rounded-lg border border-stone-200 text-xs font-semibold text-stone-700 hover:bg-stone-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={deletingId === confirmDeleteTemplate.id}
                onClick={handleConfirmDelete}
                className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
              >
                {deletingId === confirmDeleteTemplate.id ? 'Menghapus...' : 'Ya, Hapus Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
