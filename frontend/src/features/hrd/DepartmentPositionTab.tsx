import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { Department, Position } from './hrdTypes';

interface DepartmentPositionTabProps {
  propertyId: number;
}

export const DepartmentPositionTab: React.FC<DepartmentPositionTabProps> = ({ propertyId }) => {
  const { authFetch } = useAuth();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Filters
  const [deptSearch, setDeptSearch] = useState<string>('');
  const [posSearch, setPosSearch] = useState<string>('');
  const [posDeptFilter, setPosDeptFilter] = useState<string>('ALL');

  // Modals
  const [showDeptModal, setShowDeptModal] = useState<boolean>(false);
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [deptForm, setDeptForm] = useState({
    code: '',
    name: '',
    description: '',
    sort_order: 10,
    is_active: true
  });

  const [showPosModal, setShowPosModal] = useState<boolean>(false);
  const [editingPos, setEditingPos] = useState<Position | null>(null);
  const [posForm, setPosForm] = useState({
    department_id: 0,
    name: '',
    code: '',
    description: '',
    sort_order: 10,
    is_active: true
  });

  const [submitting, setSubmitting] = useState<boolean>(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [deptRes, posRes] = await Promise.all([
        authFetch(`/api/hrd/departments?property_id=${propertyId}&include_inactive=true`),
        authFetch(`/api/hrd/positions?property_id=${propertyId}&include_inactive=true`)
      ]);

      const [deptData, posData] = await Promise.all([deptRes.json(), posRes.json()]);

      if (deptRes.ok && Array.isArray(deptData.data)) {
        setDepartments(deptData.data);
      }
      if (posRes.ok && Array.isArray(posData.data)) {
        setPositions(posData.data);
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Gagal memuat data departemen dan jabatan' });
    } finally {
      setLoading(false);
    }
  }, [authFetch, propertyId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Handle Department CRUD
  const handleOpenAddDept = () => {
    setEditingDept(null);
    setDeptForm({
      code: '',
      name: '',
      description: '',
      sort_order: (departments.length + 1) * 10,
      is_active: true
    });
    setFeedback(null);
    setShowDeptModal(true);
  };

  const handleOpenEditDept = (d: Department) => {
    setEditingDept(d);
    setDeptForm({
      code: d.code,
      name: d.name,
      description: d.description || '',
      sort_order: d.sort_order,
      is_active: d.is_active
    });
    setFeedback(null);
    setShowDeptModal(true);
  };

  const handleSubmitDept = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const url = editingDept
        ? `/api/hrd/departments/${editingDept.id}`
        : '/api/hrd/departments';
      const method = editingDept ? 'PATCH' : 'POST';

      const payload = {
        property_id: propertyId,
        ...deptForm,
        code: deptForm.code.trim().toUpperCase()
      };

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan departemen');

      setFeedback({
        type: 'success',
        message: editingDept ? 'Departemen berhasil diperbarui' : 'Departemen baru berhasil ditambahkan'
      });
      setShowDeptModal(false);
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteDept = async (d: Department) => {
    if (!window.confirm(`Yakin ingin menghapus departemen "${d.name}"? Aksi ini tidak dapat dibatalkan.`)) {
      return;
    }
    try {
      const res = await authFetch(`/api/hrd/departments/${d.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus departemen');

      setFeedback({ type: 'success', message: 'Departemen berhasil dihapus' });
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  // Handle Position CRUD
  const handleOpenAddPos = () => {
    setEditingPos(null);
    const defaultDeptId = posDeptFilter !== 'ALL'
      ? Number(posDeptFilter)
      : (departments[0]?.id || 0);

    setPosForm({
      department_id: defaultDeptId,
      name: '',
      code: '',
      description: '',
      sort_order: 10,
      is_active: true
    });
    setFeedback(null);
    setShowPosModal(true);
  };

  const handleOpenEditPos = (p: Position) => {
    setEditingPos(p);
    setPosForm({
      department_id: p.department_id,
      name: p.name,
      code: p.code || '',
      description: p.description || '',
      sort_order: p.sort_order,
      is_active: p.is_active
    });
    setFeedback(null);
    setShowPosModal(true);
  };

  const handleSubmitPos = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const url = editingPos
        ? `/api/hrd/positions/${editingPos.id}`
        : '/api/hrd/positions';
      const method = editingPos ? 'PATCH' : 'POST';

      const payload = {
        property_id: propertyId,
        ...posForm,
        department_id: Number(posForm.department_id)
      };

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan posisi/jabatan');

      setFeedback({
        type: 'success',
        message: editingPos ? 'Jabatan berhasil diperbarui' : 'Jabatan baru berhasil ditambahkan'
      });
      setShowPosModal(false);
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeletePos = async (p: Position) => {
    if (!window.confirm(`Yakin ingin menghapus jabatan "${p.name}"?`)) {
      return;
    }
    try {
      const res = await authFetch(`/api/hrd/positions/${p.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus jabatan');

      setFeedback({ type: 'success', message: 'Jabatan berhasil dihapus' });
      await fetchData();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const filteredDepartments = departments.filter(d => {
    if (!deptSearch.trim()) return true;
    const q = deptSearch.toLowerCase();
    return d.name.toLowerCase().includes(q) || d.code.toLowerCase().includes(q);
  });

  const filteredPositions = positions.filter(p => {
    if (posDeptFilter !== 'ALL' && p.department_id !== Number(posDeptFilter)) return false;
    if (!posSearch.trim()) return true;
    const q = posSearch.toLowerCase();
    return p.name.toLowerCase().includes(q) || (p.code && p.code.toLowerCase().includes(q));
  });

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`p-3 rounded-xl border text-xs font-semibold flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Grid: 2 Columns on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ===================================================================== */}
        {/* SECTION 1: DEPARTEMEN */}
        {/* ===================================================================== */}
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
            <div>
              <h2 className="font-serif font-bold text-slate-900 text-sm flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#1b4332]" />
                Daftar Departemen ({departments.length})
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Struktur organisasi unit kerja per hotel.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenAddDept}
              className="px-3 py-1.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs shadow-xs cursor-pointer flex items-center gap-1.5 shrink-0"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Tambah Departemen
            </button>
          </div>

          <div className="p-3 border-b border-slate-100 bg-white">
            <input
              type="text"
              value={deptSearch}
              onChange={e => setDeptSearch(e.target.value)}
              placeholder="Cari kode atau nama departemen..."
              className="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
            />
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-slate-600 font-bold">
                  <th className="py-2.5 px-3">Kode</th>
                  <th className="py-2.5 px-3">Nama Departemen</th>
                  <th className="py-2.5 px-3 text-center">Staf</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      Memuat departemen...
                    </td>
                  </tr>
                ) : filteredDepartments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      Tidak ada departemen yang sesuai.
                    </td>
                  </tr>
                ) : (
                  filteredDepartments.map(d => (
                    <tr key={d.id} className="hover:bg-slate-50/50 transition">
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-800">
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                          {d.code}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900">
                        {d.name}
                        {d.description && (
                          <span className="block text-[10px] text-slate-400 truncate max-w-[180px]">
                            {d.description}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-100">
                          {d.employee_count || 0}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {d.is_active ? (
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            Aktif
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">
                            Nonaktif
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right space-x-1 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleOpenEditDept(d)}
                          className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                        >
                          Edit
                        </button>
                        {Number(d.employee_count || 0) === 0 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteDept(d)}
                            className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition"
                          >
                            Hapus
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ===================================================================== */}
        {/* SECTION 2: JABATAN / POSISI */}
        {/* ===================================================================== */}
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
            <div>
              <h2 className="font-serif font-bold text-slate-900 text-sm flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#c5a880]" />
                Daftar Jabatan ({positions.length})
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Posisi kerja terikat pada departemen operasional.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenAddPos}
              className="px-3 py-1.5 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] transition font-bold text-xs shadow-xs cursor-pointer flex items-center gap-1.5 shrink-0"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              Tambah Jabatan
            </button>
          </div>

          <div className="p-3 border-b border-slate-100 bg-white grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={posDeptFilter}
              onChange={e => setPosDeptFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
            >
              <option value="ALL">Semua Departemen ({departments.length})</option>
              {departments.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
            <input
              type="text"
              value={posSearch}
              onChange={e => setPosSearch(e.target.value)}
              placeholder="Cari nama jabatan..."
              className="px-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
            />
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-slate-600 font-bold">
                  <th className="py-2.5 px-3">Nama Jabatan</th>
                  <th className="py-2.5 px-3">Departemen</th>
                  <th className="py-2.5 px-3 text-center">Staf</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      Memuat jabatan...
                    </td>
                  </tr>
                ) : filteredPositions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      Tidak ada jabatan yang sesuai.
                    </td>
                  </tr>
                ) : (
                  filteredPositions.map(p => (
                    <tr key={p.id} className="hover:bg-slate-50/50 transition">
                      <td className="py-2.5 px-3 font-semibold text-slate-900">
                        {p.name}
                        {p.code && (
                          <span className="ml-1.5 text-[10px] text-slate-400 font-mono">
                            [{p.code}]
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-800">
                          {p.department_name || departments.find(d => d.id === p.department_id)?.name || '—'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-100">
                          {p.employee_count || 0}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {p.is_active ? (
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            Aktif
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">
                            Nonaktif
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right space-x-1 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleOpenEditPos(p)}
                          className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                        >
                          Edit
                        </button>
                        {Number(p.employee_count || 0) === 0 && (
                          <button
                            type="button"
                            onClick={() => handleDeletePos(p)}
                            className="px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition"
                          >
                            Hapus
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* MODAL: ADD / EDIT DEPARTMENT */}
      {/* ===================================================================== */}
      {showDeptModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingDept ? 'Edit Departemen' : 'Tambah Departemen Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowDeptModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitDept} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Kode Departemen <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  maxLength={10}
                  value={deptForm.code}
                  onChange={e => setDeptForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                  placeholder="Contoh: FO, HK, FB, ENG"
                  className="w-full p-2 rounded-xl border border-slate-300 font-mono font-bold focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Digunakan untuk nomor induk karyawan otomatis (e.g. FO-0001).
                </p>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Nama Departemen <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={deptForm.name}
                  onChange={e => setDeptForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Front Office"
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Deskripsi / Keterangan:
                </label>
                <textarea
                  rows={2}
                  value={deptForm.description}
                  onChange={e => setDeptForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Deskripsi operasional unit kerja..."
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Nomor Urut Tampilan:
                  </label>
                  <input
                    type="number"
                    value={deptForm.sort_order}
                    onChange={e => setDeptForm(f => ({ ...f, sort_order: Number(e.target.value) }))}
                    className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deptForm.is_active}
                      onChange={e => setDeptForm(f => ({ ...f, is_active: e.target.checked }))}
                      className="w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
                    />
                    <span className="font-bold text-slate-800">Status Aktif</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowDeptModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] font-bold shadow-xs disabled:opacity-50"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Departemen'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL: ADD / EDIT POSITION */}
      {/* ===================================================================== */}
      {showPosModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingPos ? 'Edit Jabatan' : 'Tambah Jabatan Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowPosModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitPos} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Departemen Terkait <span className="text-red-500">*</span>:
                </label>
                <select
                  required
                  value={posForm.department_id}
                  onChange={e => setPosForm(f => ({ ...f, department_id: Number(e.target.value) }))}
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                >
                  <option value={0} disabled>Pilih Departemen...</option>
                  {departments.filter(d => d.is_active || d.id === posForm.department_id).map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Nama Jabatan <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={posForm.name}
                  onChange={e => setPosForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Receptionist, Duty Manager, Room Attendant"
                  className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Kode Jabatan (Opsional):
                </label>
                <input
                  type="text"
                  value={posForm.code}
                  onChange={e => setPosForm(f => ({ ...f, code: e.target.value }))}
                  placeholder="Contoh: RCP, DM, RA"
                  className="w-full p-2 rounded-xl border border-slate-300 font-mono focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Nomor Urut Tampilan:
                  </label>
                  <input
                    type="number"
                    value={posForm.sort_order}
                    onChange={e => setPosForm(f => ({ ...f, sort_order: Number(e.target.value) }))}
                    className="w-full p-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={posForm.is_active}
                      onChange={e => setPosForm(f => ({ ...f, is_active: e.target.checked }))}
                      className="w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
                    />
                    <span className="font-bold text-slate-800">Status Aktif</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowPosModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-[#1b4332] text-white hover:bg-[#143326] font-bold shadow-xs disabled:opacity-50"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Jabatan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
