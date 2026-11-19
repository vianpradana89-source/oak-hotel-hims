import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch as authFetch } from '../../lib/authenticatedFetch';

interface MinibarStandardsSettingsSectionProps {
  propertyId: number;
}

export const MinibarStandardsSettingsSection: React.FC<MinibarStandardsSettingsSectionProps> = ({
  propertyId,
}) => {
  const [loading, setLoading] = useState(false);
  const [standards, setStandards] = useState<any[]>([]);
  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [roomTypes, setRoomTypes] = useState<Array<{ id: number; name: string }>>([]);
  const [hkpLocation, setHkpLocation] = useState<{ id: number; code: string; name: string } | null>(null);

  const [selectedMenuItemId, setSelectedMenuItemId] = useState<string>('');
  const [itemRole, setItemRole] = useState<'COMPLIMENTARY' | 'PAID_MINIBAR'>('COMPLIMENTARY');
  const [standardQty, setStandardQty] = useState<string>('2');
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string>('ALL');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = useCallback(async () => {
    if (!propertyId) return;
    try {
      setLoading(true);
      const res = await authFetch(`/api/housekeeping/minibar-catalog?property_id=${propertyId}`);
      const json = await res.json();
      if (res.ok && json?.data) {
        setStandards(Array.isArray(json.data.active_room_standards) ? json.data.active_room_standards : []);
        setCatalogItems(Array.isArray(json.data.catalog_items) ? json.data.catalog_items : []);
        setRoomTypes(Array.isArray(json.data.room_types) ? json.data.room_types : []);
        setHkpLocation(json.data.hkp_location || null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveStandard = async () => {
    const pid = Number(selectedMenuItemId);
    const qty = Number(standardQty);
    if (!pid || qty <= 0) {
      setFeedback({ type: 'error', text: 'Pilih produk dan isi jumlah standar minimal 1.' });
      return;
    }
    try {
      setSaving(true);
      setFeedback(null);
      const res = await authFetch('/api/housekeeping/minibar-standards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          menu_item_id: pid,
          standard_qty: qty,
          item_role: itemRole,
          apply_all_room_types: selectedRoomTypeId === 'ALL',
          room_type_id: selectedRoomTypeId === 'ALL' ? null : Number(selectedRoomTypeId),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan standar kamar.');
      }
      setFeedback({
        type: 'success',
        text: 'Standar paket kamar (Complimentary / Minibar HKP) berhasil disimpan.',
      });
      setSelectedMenuItemId('');
      await loadData();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Gagal menyimpan standar kamar.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStandard = async (stdId: number) => {
    try {
      setFeedback(null);
      const res = await authFetch(
        `/api/housekeeping/minibar-standards/${stdId}?property_id=${propertyId}&all_room_types=true`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setFeedback({ type: 'success', text: 'Item standar kamar berhasil dihapus.' });
        await loadData();
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
      <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-neutral-900">
              Standar Paket Complimentary & Minibar Kamar (Gudang {hkpLocation?.code || 'HKP'})
            </h3>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
              Otomatis Potong Stok {hkpLocation?.code || 'HKP'}
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Atur produk Complimentary (contoh: Air Mineral gratis, otomatis potong stok HKP saat kamar selesai dibersihkan) dan produk Minibar Berbayar (ditagihkan & potong stok HKP saat checkout).
          </p>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {feedback && (
          <div
            className={`p-3 rounded-xl text-xs font-medium border ${
              feedback.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-rose-50 text-rose-800 border-rose-200'
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* Form Tambah / Update Standar Kamar */}
        <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-4">
            <label className="block text-[11px] font-bold text-neutral-700 mb-1">
              Pilih Produk (Master Barang / HKP) *
            </label>
            <select
              value={selectedMenuItemId}
              onChange={(e) => setSelectedMenuItemId(e.target.value)}
              className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
            >
              <option value="">— Pilih Produk —</option>
              {catalogItems.map((item) => (
                <option key={item.menu_item_id} value={item.menu_item_id}>
                  {item.name} {item.sku ? `(${item.sku})` : ''} — Stok HKP: {item.hkp_stock_balance} {item.base_unit_code}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label className="block text-[11px] font-bold text-neutral-700 mb-1">Jenis Peruntukan Kamar *</label>
            <select
              value={itemRole}
              onChange={(e) => setItemRole(e.target.value as 'COMPLIMENTARY' | 'PAID_MINIBAR')}
              className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
            >
              <option value="COMPLIMENTARY">Complimentary Gratis (Potong saat Bersihkan Kamar)</option>
              <option value="PAID_MINIBAR">Minibar Berbayar (Tagih & Potong saat Checkout)</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-neutral-700 mb-1">Tipe Kamar</label>
            <select
              value={selectedRoomTypeId}
              onChange={(e) => setSelectedRoomTypeId(e.target.value)}
              className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
            >
              <option value="ALL">Semua Tipe Kamar</option>
              {roomTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-1">
            <label className="block text-[11px] font-bold text-neutral-700 mb-1">Qty *</label>
            <input
              type="number"
              min={1}
              value={standardQty}
              onChange={(e) => setStandardQty(e.target.value)}
              className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-2.5 py-2 text-neutral-900 font-bold text-center focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveStandard}
              className="w-full py-2 px-3 rounded-xl text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] transition shadow-xs cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Menyimpan...' : '+ Simpan Standar'}
            </button>
          </div>
        </div>

        {/* Tabel Daftar Standar Aktif */}
        {loading ? (
          <div className="text-xs text-neutral-500 py-3">Memuat daftar standar kamar...</div>
        ) : standards.length === 0 ? (
          <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 text-xs text-neutral-500 text-center">
            Belum ada produk standar yang dikonfigurasi. Tambahkan produk Air Mineral sebagai <strong>Complimentary Gratis</strong> dan produk minuman/snack sebagai <strong>Minibar Berbayar</strong> di atas.
          </div>
        ) : (
          <div className="border border-neutral-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs text-left">
              <thead className="bg-neutral-50 text-neutral-600 border-b border-neutral-200">
                <tr>
                  <th className="py-2.5 px-3 font-bold">Produk</th>
                  <th className="py-2.5 px-3 font-bold">Peruntukan</th>
                  <th className="py-2.5 px-3 font-bold text-center">Qty Standar Kamar</th>
                  <th className="py-2.5 px-3 font-bold text-right">Harga Tagih Tamu</th>
                  <th className="py-2.5 px-3 font-bold text-right">Stok Gudang HKP</th>
                  <th className="py-2.5 px-3 font-bold text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {standards.map((std) => (
                  <tr key={std.id} className="hover:bg-neutral-50/70">
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-neutral-900">{std.item_name}</div>
                      {std.sku && <div className="text-[10px] font-mono text-neutral-500">{std.sku}</div>}
                    </td>
                    <td className="py-2.5 px-3">
                      {std.item_role === 'COMPLIMENTARY' ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
                          Complimentary Gratis (Bersihkan Kamar)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                          Minibar Berbayar (Cek Checkout)
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-center font-bold text-neutral-900">
                      {std.standard_qty} {std.base_unit_code}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-neutral-800">
                      {std.item_role === 'COMPLIMENTARY'
                        ? 'Rp 0 (Gratis)'
                        : `Rp ${Number(std.unit_price || 0).toLocaleString('id-ID')}`}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-800">
                      {std.hkp_stock_balance} {std.base_unit_code}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteStandard(std.id)}
                        className="text-rose-600 hover:text-rose-800 font-bold text-[11px] cursor-pointer"
                      >
                        Hapus
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
