import React, { useState, useEffect, useCallback } from 'react';

interface TestEntitySummary {
  id: number;
  name: string;
  code?: string;
  dependency_count: number;
  dependencies: string[];
}

interface TestDataListResult {
  employees: TestEntitySummary[];
  departments: TestEntitySummary[];
  positions: TestEntitySummary[];
  roles: TestEntitySummary[];
  schedule_groups: TestEntitySummary[];
  holidays: TestEntitySummary[];
  shift_templates: TestEntitySummary[];
}

interface PurgeResult {
  type: string;
  id: number;
  success: boolean;
  message: string;
  deleted?: Record<string, number>;
}

interface TestDataPurgeTabProps {
  propertyId: number;
}

const getAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
};

export const TestDataPurgeTab: React.FC<TestDataPurgeTabProps> = ({ propertyId }) => {
  const [data, setData] = useState<TestDataListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<{ type: string; id: number; name: string } | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeResult | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/hrd/test-data?property_id=${propertyId}`, { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.status === 'OK') {
        setData(json.data);
      } else {
        setError(json.message || 'Gagal memuat data test.');
      }
    } catch {
      setError('Gagal terhubung ke server.');
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalTestEntities = data
    ? data.employees.length + data.departments.length + data.positions.length +
      data.roles.length + data.schedule_groups.length + data.holidays.length +
      data.shift_templates.length
    : 0;

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    setPurgeResult(null);
    try {
      const res = await fetch(`/api/hrd/test-data/employees/${purgeTarget.id}/purge?property_id=${propertyId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const json = await res.json();
      if (json.status === 'OK') {
        setPurgeResult({ type: 'employee', id: purgeTarget.id, success: true, message: json.message, deleted: json.data?.deleted });
        setPurgeTarget(null);
        fetchData();
      } else {
        setPurgeResult({ type: 'employee', id: purgeTarget.id, success: false, message: json.message || 'Purge gagal.' });
      }
    } catch {
      setPurgeResult({ type: 'employee', id: purgeTarget.id, success: false, message: 'Gagal terhubung ke server.' });
    } finally {
      setPurging(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
        <div className="animate-spin w-6 h-6 border-2 border-[#1b4332] border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-sm text-slate-500">Memuat data test...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-2xl border border-red-200 p-6 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={fetchData} className="mt-3 px-4 py-2 text-xs font-bold text-red-700 bg-red-50 rounded-xl hover:bg-red-100 transition cursor-pointer">
          Coba Lagi
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-2xl border border-orange-200 p-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-orange-900">Data Test Cleanup</h3>
            <p className="text-xs text-orange-700">
              Hapus data test dan dependency terkait secara permanen. Data operasional real tidak terpengaruh.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 mt-3 text-xs">
          <span className="px-3 py-1 bg-orange-100 text-orange-800 rounded-full font-bold">
            {totalTestEntities} entitas test ditemukan
          </span>
          <button onClick={fetchData} className="px-3 py-1 bg-white text-slate-600 border border-slate-200 rounded-full font-bold hover:bg-slate-50 transition cursor-pointer">
            Refresh
          </button>
        </div>
      </div>

      {/* Purge Result Banner */}
      {purgeResult && (
        <div className={`rounded-2xl border p-4 ${purgeResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className="flex items-center gap-2">
            {purgeResult.success ? (
              <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <p className={`text-xs font-bold ${purgeResult.success ? 'text-green-800' : 'text-red-800'}`}>
              {purgeResult.message}
            </p>
            <button onClick={() => setPurgeResult(null)} className="ml-auto text-slate-400 hover:text-slate-600 cursor-pointer">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Test Entities */}
      {totalTestEntities === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-bold text-slate-600">Tidak ada data test</p>
          <p className="text-xs text-slate-400 mt-1">Semua data dalam kondisi bersih.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Test Employees */}
          {data!.employees.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
                <h4 className="text-xs font-bold text-slate-700 flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Karyawan Test ({data!.employees.length})
                </h4>
              </div>
              <div className="divide-y divide-slate-100">
                {data!.employees.map((emp) => (
                  <div key={emp.id} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700">
                        TEST
                      </span>
                      <div>
                        <p className="text-sm font-bold text-slate-800">{emp.name}</p>
                        <p className="text-xs text-slate-500">
                          {emp.code || `ID: ${emp.id}`}
                          {emp.dependency_count > 0 && (
                            <span className="ml-2 text-amber-600">
                              {emp.dependency_count} dependency: {emp.dependencies.join(', ')}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setPurgeTarget({ type: 'employee', id: emp.id, name: emp.name })}
                      className="px-3 py-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl hover:bg-red-100 transition cursor-pointer"
                    >
                      Bersihkan
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary for other entity types */}
          {['departments', 'positions', 'roles', 'schedule_groups', 'holidays', 'shift_templates'].map((key) => {
            const entities = data![key as keyof TestDataListResult] as TestEntitySummary[];
            if (!entities || entities.length === 0) return null;
            const labels: Record<string, string> = {
              departments: 'Departemen Test',
              positions: 'Jabatan Test',
              roles: 'Role Test',
              schedule_groups: 'Grup Jadwal Test',
              holidays: 'Hari Libur Test',
              shift_templates: 'Shift Template Test'
            };
            return (
              <div key={key} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
                  <h4 className="text-xs font-bold text-slate-700">
                    {labels[key]} ({entities.length})
                  </h4>
                </div>
                <div className="divide-y divide-slate-100">
                  {entities.map((e) => (
                    <div key={e.id} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700">
                          TEST
                        </span>
                        <div>
                          <p className="text-sm font-bold text-slate-800">{e.name}</p>
                          <p className="text-xs text-slate-500">
                            {e.code || `ID: ${e.id}`}
                            {e.dependency_count > 0 && (
                              <span className="ml-2 text-amber-600">
                                {e.dependency_count} dependency: {e.dependencies.join(', ')}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirmation Modal */}
      {purgeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setPurgeTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Hapus Data Test</h3>
                  <p className="text-xs text-slate-500">Tindakan ini tidak dapat dibatalkan.</p>
                </div>
              </div>
              <p className="text-sm text-slate-700 mb-1">
                Yakin ingin menghapus data test ini beserta dependency test terkait?
              </p>
              <p className="text-xs text-slate-500">
                <strong>{purgeTarget.name}</strong> (ID: {purgeTarget.id})
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 pb-6">
              <button
                onClick={() => setPurgeTarget(null)}
                disabled={purging}
                className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                onClick={handlePurge}
                disabled={purging}
                className="px-4 py-2 text-xs font-bold text-white bg-red-600 rounded-xl hover:bg-red-700 transition cursor-pointer disabled:opacity-50"
              >
                {purging ? 'Menghapus...' : 'Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
