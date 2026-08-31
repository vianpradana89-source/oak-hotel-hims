import React, { useState, useEffect } from 'react';
import type { OtaSource, CreateOtaSourceInput, UpdateOtaSourceInput } from './otaTypes';
import { fetchOtaSources, createOtaSource, updateOtaSource, deleteOtaSource } from './otaApi';

interface Props {
  propertyId: number;
  isOpen: boolean;
  onClose: () => void;
  onSourceUpdated?: () => void;
}

export default function OtaSourceManagerModal({ propertyId, isOpen, onClose, onSourceUpdated }: Props) {
  const [sources, setSources] = useState<OtaSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingSource, setEditingSource] = useState<Partial<OtaSource> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [commissionRate, setCommissionRate] = useState<string>('');
  const [isActive, setIsActive] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadSources = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const data = await fetchOtaSources(propertyId, { includeArchived: true });
      setSources(data);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memuat daftar OTA');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadSources();
      resetForm();
    }
  }, [isOpen, propertyId]);

  const resetForm = () => {
    setIsCreating(false);
    setEditingSource(null);
    setCode('');
    setName('');
    setDescription('');
    setCommissionRate('');
    setIsActive(true);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleStartCreate = () => {
    resetForm();
    setIsCreating(true);
  };

  const handleStartEdit = (source: OtaSource) => {
    setIsCreating(false);
    setEditingSource(source);
    setCode(source.code);
    setName(source.name);
    setDescription(source.description || '');
    setCommissionRate(source.commission_rate_percent !== null && source.commission_rate_percent !== undefined ? String(source.commission_rate_percent) : '');
    setIsActive(source.is_active);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!name.trim()) {
      setErrorMsg('Nama OTA wajib diisi');
      return;
    }

    try {
      if (isCreating) {
        if (!code.trim()) {
          setErrorMsg('Kode OTA wajib diisi');
          return;
        }
        const dto: CreateOtaSourceInput = {
          property_id: propertyId,
          code: code.trim().toUpperCase().replace(/\s+/g, '_'),
          name: name.trim(),
          description: description.trim() || undefined,
          commission_rate_percent: commissionRate ? Number(commissionRate) : undefined,
          is_active: isActive
        };
        await createOtaSource(dto);
        setSuccessMsg('Sumber OTA baru berhasil ditambahkan');
      } else if (editingSource?.id) {
        const dto: UpdateOtaSourceInput = {
          name: name.trim(),
          description: description.trim() || undefined,
          commission_rate_percent: commissionRate ? Number(commissionRate) : undefined,
          is_active: isActive
        };
        await updateOtaSource(editingSource.id, dto);
        setSuccessMsg('Sumber OTA berhasil diperbarui');
      }

      await loadSources();
      resetForm();
      if (onSourceUpdated) onSourceUpdated();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan sumber OTA');
    }
  };

  const handleToggleActive = async (source: OtaSource) => {
    try {
      setErrorMsg(null);
      await updateOtaSource(source.id, { is_active: !source.is_active });
      await loadSources();
      if (onSourceUpdated) onSourceUpdated();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengubah status aktif');
    }
  };

  const handleDelete = async (source: OtaSource) => {
    if (!window.confirm(`Yakin ingin menghapus / mengarsipkan channel OTA "${source.name}"?`)) {
      return;
    }

    try {
      setErrorMsg(null);
      const res = await deleteOtaSource(source.id);
      setSuccessMsg(res.message);
      await loadSources();
      if (onSourceUpdated) onSourceUpdated();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menghapus sumber OTA');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl border border-emerald-900/10 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-5 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-800/60 rounded-xl border border-emerald-700/50">
              <svg className="w-5 h-5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-white">Master Sumber OTA</h2>
              <p className="text-xs text-emerald-300/80">Kelola daftar channel Online Travel Agent & komisi</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-emerald-300 hover:text-white p-2 rounded-lg hover:bg-emerald-800/40 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-stone-50/50">
          {errorMsg && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-3">
              <svg className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm flex items-start gap-3">
              <svg className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>{successMsg}</span>
            </div>
          )}

          {/* Form Create / Edit */}
          {(isCreating || editingSource) && (
            <form onSubmit={handleSave} className="p-5 bg-white rounded-xl border border-emerald-900/15 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-stone-200 pb-3">
                <h3 className="font-semibold text-stone-800 text-sm flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                  {isCreating ? 'Tambah Channel OTA Baru' : `Edit Channel OTA: ${editingSource?.name}`}
                </h3>
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-xs text-stone-500 hover:text-stone-700 underline"
                >
                  Batal
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nama OTA <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Contoh: Tiket.com, Agoda, Expedia"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full text-sm px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Kode OTA <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!isCreating}
                    placeholder="Contoh: EXPEDIA, TIKET_COM"
                    value={code}
                    onChange={e => setCode(e.target.value.toUpperCase())}
                    className="w-full text-sm px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all outline-none disabled:bg-stone-100 disabled:text-stone-500"
                  />
                  {isCreating && (
                    <p className="text-[10px] text-stone-500 mt-1">Kode unik identifikasi teknis (otomatis huruf kapital)</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Estimasi Komisi (%)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    placeholder="Contoh: 15"
                    value={commissionRate}
                    onChange={e => setCommissionRate(e.target.value)}
                    className="w-full text-sm px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Deskripsi / Catatan
                  </label>
                  <input
                    type="text"
                    placeholder="Opsional"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    className="w-full text-sm px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={e => setIsActive(e.target.checked)}
                    className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-stone-300"
                  />
                  <span className="text-xs font-medium text-stone-700">Aktif (Dapat dipilih saat buat reservasi)</span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-4 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold text-white bg-emerald-800 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
                  >
                    {isCreating ? 'Simpan OTA Baru' : 'Perbarui OTA'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* List Table */}
          <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-stone-200 flex items-center justify-between bg-stone-50/70">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-600">
                Daftar Channel OTA ({sources.length})
              </span>
              {!isCreating && !editingSource && (
                <button
                  onClick={handleStartCreate}
                  className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  + Tambah OTA
                </button>
              )}
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-stone-500">Memuat data OTA...</div>
            ) : sources.length === 0 ? (
              <div className="py-12 text-center text-xs text-stone-500">Belum ada channel OTA yang terdaftar.</div>
            ) : (
              <div className="divide-y divide-stone-100">
                {sources.map(src => (
                  <div
                    key={src.id}
                    className={`p-4 flex items-center justify-between gap-4 hover:bg-stone-50/80 transition-colors ${
                      src.is_archived ? 'opacity-50 bg-stone-100/60' : ''
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-stone-900">{src.name}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200">
                          {src.code}
                        </span>
                        {src.is_archived ? (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-stone-200 text-stone-700">
                            Diarsipkan
                          </span>
                        ) : src.is_active ? (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                            Aktif
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                            Nonaktif
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-stone-500">
                        {src.commission_rate_percent !== null && src.commission_rate_percent !== undefined && (
                          <span>Komisi: <strong>{src.commission_rate_percent}%</strong></span>
                        )}
                        {src.description && <span>• {src.description}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {!src.is_archived && (
                        <>
                          <button
                            onClick={() => handleToggleActive(src)}
                            title={src.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                            className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                              src.is_active
                                ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                                : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                            }`}
                          >
                            {src.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                          </button>
                          <button
                            onClick={() => handleStartEdit(src)}
                            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-100 transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(src)}
                            className="px-2.5 py-1 text-xs font-medium rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 transition-colors"
                          >
                            Hapus
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-stone-100 border-t border-stone-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-semibold text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-xl transition-colors shadow-sm"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
