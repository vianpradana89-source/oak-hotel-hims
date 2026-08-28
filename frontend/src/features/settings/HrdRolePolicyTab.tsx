import React, { useState, useEffect } from 'react';

interface HrdRolePolicyTabProps {
  propertyId: number;
}

export const HrdRolePolicyTab: React.FC<HrdRolePolicyTabProps> = ({ propertyId }) => {
  const [policies, setPolicies] = useState({
    allow_hrd_assign_owner_role: false,
    allow_hrd_assign_gm_role: false,
    allow_hrd_assign_dept_manager_role: true,
    allow_hrd_assign_accountant_role: true
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const fetchPolicy = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/hrd/policies?property_id=${propertyId}`);
        const json = await res.json();
        if (json.status === 'OK' && json.data) {
          setPolicies({
            allow_hrd_assign_owner_role: !!json.data.allow_hrd_assign_owner_role,
            allow_hrd_assign_gm_role: !!json.data.allow_hrd_assign_gm_role,
            allow_hrd_assign_dept_manager_role: json.data.allow_hrd_assign_dept_manager_role !== false,
            allow_hrd_assign_accountant_role: json.data.allow_hrd_assign_accountant_role !== false
          });
        }
      } catch (err: any) {
        console.error('Failed to load HRD role policies', err);
      } finally {
        setLoading(false);
      }
    };
    fetchPolicy();
  }, [propertyId]);

  const handleToggle = async (key: keyof typeof policies) => {
    const nextVal = !policies[key];
    const updated = { ...policies, [key]: nextVal };
    setPolicies(updated);
    try {
      setSaving(true);
      setFeedback(null);
      const res = await fetch('/api/hrd/policies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          ...updated
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menyimpan kebijakan role');
      setFeedback({ type: 'success', message: 'Kebijakan penetapan role berhasil diperbarui.' });
    } catch (err: any) {
      setPolicies(policies); // rollback
      setFeedback({ type: 'error', message: err.message || 'Gagal menyimpan kebijakan' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-xs text-neutral-500">Memuat kebijakan hak akses role HRD...</div>;
  }

  return (
    <div className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-5 space-y-5">
      <div className="pb-3 border-b border-neutral-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="font-bold text-sm text-neutral-900">Kebijakan Penetapan Role & Akun Karyawan</h3>
          <p className="text-xs text-neutral-500">
            Kontrol keamanan penetapan role tingkat tinggi oleh staf HRD properti.
          </p>
        </div>
        {saving && <span className="text-[11px] font-bold text-amber-700 animate-pulse">Menyimpan...</span>}
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-semibold ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border border-rose-200 text-rose-800'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Security explanation banner */}
      <div className="p-4 rounded-xl bg-purple-50/70 border border-purple-200 text-xs text-purple-950 space-y-1">
        <strong className="font-bold">Prinsip Keamanan Role OAK HIMS:</strong>
        <p className="text-purple-900">
          Role Owner dan General Manager memiliki akses operasional dan finansial penuh ke seluruh properti. Secara default, opsi role ini disembunyikan dari HRD agar pendaftaran staf baru tidak dapat secara tidak sengaja memicu eskalasi hak akses eksekutif.
        </p>
      </div>

      {/* Role Policy Toggles */}
      <div className="space-y-3">
        <div className="p-3.5 rounded-xl border border-neutral-200 bg-[#faf9f6] flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-xs text-neutral-900 flex items-center gap-2">
              <span>Izinkan HRD Menetapkan Role Owner</span>
              {!policies.allow_hrd_assign_owner_role && (
                <span className="px-2 py-0.5 rounded text-[10px] bg-neutral-200 text-neutral-700 font-bold">
                  Terkunci (Rekomendasi)
                </span>
              )}
            </div>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Jika nonaktif, role "Owner" tidak muncul di dropdown pendaftaran akun HRD dan ditolak oleh backend (HTTP 403).
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleToggle('allow_hrd_assign_owner_role')}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl transition cursor-pointer shrink-0 ${
              policies.allow_hrd_assign_owner_role
                ? 'bg-purple-700 text-white shadow-xs'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
            }`}
          >
            {policies.allow_hrd_assign_owner_role ? 'DIIZINKAN' : 'DISEMBUNYIKAN'}
          </button>
        </div>

        <div className="p-3.5 rounded-xl border border-neutral-200 bg-[#faf9f6] flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-xs text-neutral-900 flex items-center gap-2">
              <span>Izinkan HRD Menetapkan Role General Manager</span>
              {!policies.allow_hrd_assign_gm_role && (
                <span className="px-2 py-0.5 rounded text-[10px] bg-neutral-200 text-neutral-700 font-bold">
                  Terkunci (Rekomendasi)
                </span>
              )}
            </div>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Jika nonaktif, role "General Manager" tidak muncul di dropdown pendaftaran akun HRD.
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleToggle('allow_hrd_assign_gm_role')}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl transition cursor-pointer shrink-0 ${
              policies.allow_hrd_assign_gm_role
                ? 'bg-purple-700 text-white shadow-xs'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
            }`}
          >
            {policies.allow_hrd_assign_gm_role ? 'DIIZINKAN' : 'DISEMBUNYIKAN'}
          </button>
        </div>

        <div className="p-3.5 rounded-xl border border-neutral-200 bg-[#faf9f6] flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-xs text-neutral-900">
              Izinkan HRD Menetapkan Role Department Manager
            </div>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Kepala departemen operasional (HK Manager, FO Manager, F&B Manager).
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleToggle('allow_hrd_assign_dept_manager_role')}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl transition cursor-pointer shrink-0 ${
              policies.allow_hrd_assign_dept_manager_role
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
            }`}
          >
            {policies.allow_hrd_assign_dept_manager_role ? 'AKTIF' : 'NONAKTIF'}
          </button>
        </div>

        <div className="p-3.5 rounded-xl border border-neutral-200 bg-[#faf9f6] flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-xs text-neutral-900">
              Izinkan HRD Menetapkan Role Accountant & Finance
            </div>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Staf pembukuan, kasir kas besar, dan akuntansi properti.
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleToggle('allow_hrd_assign_accountant_role')}
            className={`px-3 py-1.5 text-xs font-bold rounded-xl transition cursor-pointer shrink-0 ${
              policies.allow_hrd_assign_accountant_role
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
            }`}
          >
            {policies.allow_hrd_assign_accountant_role ? 'AKTIF' : 'NONAKTIF'}
          </button>
        </div>
      </div>
    </div>
  );
};
