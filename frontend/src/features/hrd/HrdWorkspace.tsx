import React, { useState, useEffect } from 'react';

interface HrEmployee {
  id: number;
  property_id: number;
  first_name: string;
  last_name?: string;
  employee_code?: string;
  role: string;
  department: string;
  username?: string;
  email?: string;
  phone?: string;
  is_active: boolean;
  created_at: string;
}

interface HrdWorkspaceProps {
  propertyId: number;
  propertyName?: string;
}

export const HrdWorkspace: React.FC<HrdWorkspaceProps> = ({ propertyId, propertyName }) => {
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [availableRoles, setAvailableRoles] = useState<{ role: string; category: string; description: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<HrEmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [formPayload, setFormPayload] = useState({
    name: '',
    username: '',
    email: '',
    phone: '',
    role: 'Crew',
    department: 'Housekeeping',
    is_active: true
  });

  const fetchData = async () => {
    try {
      setLoading(true);
      const [empRes, rolesRes] = await Promise.all([
        fetch(`/api/hrd/employees?property_id=${propertyId}`),
        fetch(`/api/hrd/roles?property_id=${propertyId}`)
      ]);

      const empData = await empRes.json();
      const rolesData = await rolesRes.json();

      if (empData.status === 'OK') setEmployees(empData.data || []);
      if (rolesData.status === 'OK') {
        setAvailableRoles(rolesData.data?.available_roles || []);
      }
    } catch (err: any) {
      console.error('Failed to load HRD data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [propertyId]);

  const handleOpenAdd = () => {
    setErrorMessage('');
    setFormPayload({
      name: '',
      username: '',
      email: '',
      phone: '',
      role: availableRoles[0]?.role || 'Crew',
      department: 'Housekeeping',
      is_active: true
    });
    setEditingEmployee(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (emp: HrEmployee) => {
    setErrorMessage('');
    setFormPayload({
      name: `${emp.first_name} ${emp.last_name || ''}`.trim(),
      username: emp.username || '',
      email: emp.email || '',
      phone: emp.phone || '',
      role: emp.role || 'Crew',
      department: emp.department || 'Housekeeping',
      is_active: emp.is_active
    });
    setEditingEmployee(emp);
    setShowAddModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setSubmitting(true);
    try {
      if (editingEmployee) {
        const res = await fetch(`/api/hrd/employees/${editingEmployee.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            ...formPayload
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal memperbarui akun karyawan');
      } else {
        const res = await fetch('/api/hrd/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            ...formPayload
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mendaftarkan karyawan');
      }

      setShowAddModal(false);
      await fetchData();
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeactivate = async (emp: HrEmployee) => {
    if (!confirm(`Nonaktifkan akun karyawan "${emp.first_name}"?`)) return;
    try {
      const res = await fetch(`/api/hrd/employees/${emp.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menonaktifkan akun');
      await fetchData();
    } catch (err: any) {
      alert(err.message || 'Gagal menonaktifkan akun');
    }
  };

  const filteredEmployees = employees.filter(emp => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const fullName = `${emp.first_name} ${emp.last_name || ''}`.toLowerCase();
    const role = (emp.role || '').toLowerCase();
    const dept = (emp.department || '').toLowerCase();
    const user = (emp.username || '').toLowerCase();
    return fullName.includes(q) || role.includes(q) || dept.includes(q) || user.includes(q);
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
              DEPARTEMEN
            </span>
            <h1 className="text-xl font-bold font-serif text-slate-900">
              HRD — Manajemen Karyawan & Akun Akses
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Pengelolaan identitas, akun login, dan penetapan peran operasional untuk properti {propertyName || 'OAK Hotel'}.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenAdd}
          className="px-4 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white text-xs font-bold flex items-center justify-center gap-2 shadow-xs transition cursor-pointer shrink-0"
        >
          <span>+ Tambah Karyawan</span>
        </button>
      </div>

      {/* Info Card on Policy */}
      <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 flex items-start gap-3">
        <span className="text-base font-bold text-amber-700">ℹ</span>
        <div>
          <strong className="font-bold">Kebijakan Hak Akses Tingkat Properti:</strong>
          <p className="text-amber-800 mt-0.5">
            Penetapan role tingkat tinggi (Owner & General Manager) secara default disembunyikan dari form HRD untuk mencegah eskalasi wewenang yang tidak disengaja. Konfigurasi kebijakan ini dapat disesuaikan oleh manajemen di menu <strong>Manajemen &rarr; Pengaturan Properti &rarr; HRD & Karyawan</strong>.
          </p>
        </div>
      </div>

      {/* Main List */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-sm text-slate-900">Daftar Akun & Akses Karyawan</h2>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700">
              {filteredEmployees.length} Karyawan
            </span>
          </div>
          <div className="relative w-full sm:w-64">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama, role, departemen..."
              className="w-full py-1.5 pl-3 pr-3 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
            />
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs text-slate-500">
            Memuat daftar akun karyawan...
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500">
            Tidak ada data karyawan yang sesuai.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px]">
                  <th className="py-3 px-4">Nama Karyawan</th>
                  <th className="py-3 px-4">Role & Akses</th>
                  <th className="py-3 px-4">Departemen</th>
                  <th className="py-3 px-4">Username / Email</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.map(emp => (
                  <tr key={emp.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">
                        {emp.first_name} {emp.last_name || ''}
                      </div>
                      {emp.employee_code && (
                        <div className="text-[10px] text-slate-400 font-mono">
                          {emp.employee_code}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-block px-2.5 py-0.5 rounded-full font-bold text-[10px] border ${
                        ['Owner', 'General Manager'].includes(emp.role)
                          ? 'bg-purple-50 text-purple-800 border-purple-200'
                          : ['Head Department / Supervisor', 'Department Manager'].includes(emp.role)
                          ? 'bg-blue-50 text-blue-800 border-blue-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {emp.role}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-700">
                      {emp.department || '-'}
                    </td>
                    <td className="py-3 px-4 text-slate-600">
                      <div>{emp.username || emp.email || '-'}</div>
                      {emp.phone && <div className="text-[10px] text-slate-400">{emp.phone}</div>}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                        emp.is_active
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : 'bg-rose-50 text-rose-800 border border-rose-200'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${emp.is_active ? 'bg-emerald-600' : 'bg-rose-600'}`} />
                        {emp.is_active ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenEdit(emp)}
                          className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-[11px] transition cursor-pointer"
                        >
                          Edit
                        </button>
                        {emp.is_active && (
                          <button
                            type="button"
                            onClick={() => handleDeactivate(emp)}
                            className="px-2.5 py-1 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-semibold text-[11px] transition cursor-pointer"
                          >
                            Nonaktifkan
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <h3 className="font-serif font-bold text-base text-slate-900">
                {editingEmployee ? 'Edit Akun Karyawan' : 'Tambah Akun Karyawan Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
                ⚠ {errorMessage}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Nama Lengkap <span className="text-red-500">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={formPayload.name}
                  onChange={(e) => setFormPayload(p => ({ ...p, name: e.target.value }))}
                  placeholder="Contoh: Budi Santoso"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Username / ID Login:
                  </label>
                  <input
                    type="text"
                    value={formPayload.username}
                    onChange={(e) => setFormPayload(p => ({ ...p, username: e.target.value }))}
                    placeholder="budi.hk"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Nomor Telepon:
                  </label>
                  <input
                    type="text"
                    value={formPayload.phone}
                    onChange={(e) => setFormPayload(p => ({ ...p, phone: e.target.value }))}
                    placeholder="08123456789"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">
                  Email (Opsional):
                </label>
                <input
                  type="email"
                  value={formPayload.email}
                  onChange={(e) => setFormPayload(p => ({ ...p, email: e.target.value }))}
                  placeholder="budi@oakhotel.com"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Role / Peran <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.role}
                    onChange={(e) => setFormPayload(p => ({ ...p, role: e.target.value }))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    {availableRoles.map(r => (
                      <option key={r.role} value={r.role}>
                        {r.role}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">
                    Departemen <span className="text-red-500">*</span>:
                  </label>
                  <select
                    value={formPayload.department}
                    onChange={(e) => setFormPayload(p => ({ ...p, department: e.target.value }))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  >
                    <option value="Housekeeping">Housekeeping</option>
                    <option value="Front Office">Front Office</option>
                    <option value="Food & Beverage">Food & Beverage</option>
                    <option value="Engineering & Maintenance">Engineering & Maintenance</option>
                    <option value="Finance & Accounting">Finance & Accounting</option>
                    <option value="Human Resources">Human Resources</option>
                    <option value="Management">Management</option>
                  </select>
                </div>
              </div>

              {editingEmployee && (
                <div className="pt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="is_active_toggle"
                    checked={formPayload.is_active}
                    onChange={(e) => setFormPayload(p => ({ ...p, is_active: e.target.checked }))}
                    className="rounded border-slate-300 text-[#1b4332] focus:ring-[#1b4332]"
                  />
                  <label htmlFor="is_active_toggle" className="text-slate-700 font-semibold cursor-pointer">
                    Akun Aktif (Dapat login ke sistem)
                  </label>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white font-bold transition cursor-pointer shadow-xs disabled:bg-slate-300"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Akun'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
