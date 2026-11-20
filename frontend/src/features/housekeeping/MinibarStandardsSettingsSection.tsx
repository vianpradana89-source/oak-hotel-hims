import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { authenticatedFetch as authFetch } from '../../lib/authenticatedFetch';

interface MinibarStandardsSettingsSectionProps {
  propertyId: number;
}

interface GroupedStandardItem {
  id: number;
  menu_item_id: number;
  item_name: string;
  sku: string;
  item_role: 'COMPLIMENTARY' | 'PAID_MINIBAR';
  standard_qty: number;
  unit_price: number;
  base_unit_code: string;
  hkp_stock_balance: number;
  room_type_ids: number[];
  room_type_names: string[];
  is_all_room_types: boolean;
}

export const MinibarStandardsSettingsSection: React.FC<MinibarStandardsSettingsSectionProps> = ({
  propertyId,
}) => {
  const [loading, setLoading] = useState(false);
  const [rawStandards, setRawStandards] = useState<any[]>([]);
  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [roomTypes, setRoomTypes] = useState<Array<{ id: number; name: string }>>([]);
  const [readyRooms, setReadyRooms] = useState<Array<{ id: number; room_number: string; status: string; room_type_name: string }>>([]);
  const [hkpLocation, setHkpLocation] = useState<{ id: number; code: string; name: string } | null>(null);

  const [selectedMenuItemId, setSelectedMenuItemId] = useState<string>('');
  const [itemRole, setItemRole] = useState<'COMPLIMENTARY' | 'PAID_MINIBAR'>('PAID_MINIBAR');
  const [standardQty, setStandardQty] = useState<string>('2');
  const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string>('ALL');
  const [selectedReadyRoomTarget, setSelectedReadyRoomTarget] = useState<string>('ALL');
  const [deductCompOnReadyStock, setDeductCompOnReadyStock] = useState<boolean>(true);
  const [stockingReady, setStockingReady] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = useCallback(async () => {
    if (!propertyId) return;
    try {
      setLoading(true);
      const res = await authFetch(`/api/housekeeping/minibar-catalog?property_id=${propertyId}`);
      const json = await res.json();
      if (res.ok && json?.data) {
        const allStds = Array.isArray(json.data.standards)
          ? json.data.standards
          : Array.isArray(json.data.active_room_standards)
          ? json.data.active_room_standards
          : [];
        setRawStandards(allStds);
        setCatalogItems(Array.isArray(json.data.catalog_items) ? json.data.catalog_items : []);
        setRoomTypes(Array.isArray(json.data.room_types) ? json.data.room_types : []);
        setReadyRooms(Array.isArray(json.data.ready_rooms) ? json.data.ready_rooms : []);
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

  // Group standards by (menu_item_id + item_role + standard_qty) so we can show exact room type coverage
  const groupedStandards = useMemo<GroupedStandardItem[]>(() => {
    const totalRoomTypesCount = roomTypes.length;
    const map = new Map<string, GroupedStandardItem>();

    for (const row of rawStandards) {
      const role: 'COMPLIMENTARY' | 'PAID_MINIBAR' =
        String(row.item_role || 'PAID_MINIBAR').toUpperCase() === 'COMPLIMENTARY'
          ? 'COMPLIMENTARY'
          : 'PAID_MINIBAR';
      const key = `${row.menu_item_id}:${role}:${row.standard_qty}`;
      const rtId = Number(row.room_type_id || 0);
      const rtName = String(row.room_type_name || '').trim();

      const existing = map.get(key);
      if (existing) {
        if (rtId > 0 && !existing.room_type_ids.includes(rtId)) {
          existing.room_type_ids.push(rtId);
        }
        if (rtName && !existing.room_type_names.includes(rtName)) {
          existing.room_type_names.push(rtName);
        }
      } else {
        map.set(key, {
          id: Number(row.id),
          menu_item_id: Number(row.menu_item_id),
          item_name: String(row.item_name || ''),
          sku: String(row.sku || ''),
          item_role: role,
          standard_qty: Number(row.standard_qty || 0),
          unit_price: Number(row.unit_price || 0),
          base_unit_code: String(row.base_unit_code || 'PCS').toUpperCase(),
          hkp_stock_balance: Number(row.hkp_stock_balance || 0),
          room_type_ids: rtId > 0 ? [rtId] : [],
          room_type_names: rtName ? [rtName] : [],
          is_all_room_types: false,
        });
      }
    }

    const result = Array.from(map.values());
    for (const item of result) {
      item.is_all_room_types =
        totalRoomTypesCount > 0 && item.room_type_ids.length >= totalRoomTypesCount;
    }

    return result.sort((a, b) => {
      if (a.item_role !== b.item_role) {
        return a.item_role === 'COMPLIMENTARY' ? -1 : 1;
      }
      return a.item_name.localeCompare(b.item_name, 'id');
    });
  }, [rawStandards, roomTypes]);

  const handleSaveStandard = async () => {
    const pid = Number(selectedMenuItemId);
    const qty = Number(standardQty);
    if (!pid || qty <= 0) {
      setFeedback({ type: 'error', text: 'Pilih produk dan isi jumlah standar minimal 1.' });
      return;
    }
    const isAllRoomTypes = selectedRoomTypeId === 'ALL';
    const targetRtName = isAllRoomTypes
      ? `Semua Tipe Kamar (${roomTypes.length} Tipe)`
      : roomTypes.find((rt) => String(rt.id) === String(selectedRoomTypeId))?.name || 'Tipe Kamar Terpilih';

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
          apply_all_room_types: isAllRoomTypes,
          room_type_id: isAllRoomTypes ? null : Number(selectedRoomTypeId),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan standar kamar.');
      }
      setFeedback({
        type: 'success',
        text: `Standar paket kamar berhasil disimpan untuk ${targetRtName}.`,
      });
      setSelectedMenuItemId('');
      setSelectedRoomTypeId('ALL');
      await loadData();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Gagal menyimpan standar kamar.' });
    } finally {
      setSaving(false);
    }
  };

  const handleApplyToAllRoomTypes = async (item: GroupedStandardItem) => {
    try {
      setSaving(true);
      setFeedback(null);
      const res = await authFetch('/api/housekeeping/minibar-standards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          menu_item_id: item.menu_item_id,
          standard_qty: item.standard_qty,
          item_role: item.item_role,
          apply_all_room_types: true,
          room_type_id: null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menerapkan ke semua tipe kamar.');
      }
      setFeedback({
        type: 'success',
        text: `Produk "${item.item_name}" berhasil diterapkan ke Semua Tipe Kamar (${roomTypes.length} Tipe).`,
      });
      await loadData();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Gagal menerapkan ke semua tipe kamar.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStandard = async (stdId: number, deleteAllRoomTypes = true) => {
    try {
      setFeedback(null);
      const res = await authFetch(
        `/api/housekeeping/minibar-standards/${stdId}?property_id=${propertyId}&all_room_types=${deleteAllRoomTypes ? 'true' : 'false'}`,
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

  const handleStockReadyRooms = async () => {
    try {
      setStockingReady(true);
      setFeedback(null);
      const isAllReady = selectedReadyRoomTarget === 'ALL';
      const res = await authFetch('/api/housekeeping/minibar-stock-ready-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          apply_all_ready_rooms: isAllReady,
          room_ids: isAllReady ? null : [Number(selectedReadyRoomTarget)],
          deduct_complimentary: deductCompOnReadyStock,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal mengisi minibar/complimentary ke kamar Ready.');
      }
      const count = Number(json.data?.rooms_count || 0);
      setFeedback({
        type: 'success',
        text: `Berhasil mencatat pengisian Minibar & Complimentary pada ${count} kamar Ready${
          deductCompOnReadyStock ? ' (stok Complimentary HKP otomatis dipotong)' : ''
        }.`,
      });
      await loadData();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || 'Gagal mengisi minibar/complimentary ke kamar Ready.' });
    } finally {
      setStockingReady(false);
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
            Hanya produk yang didaftarkan di tabel ini yang akan muncul sesuai peruntukannya: <strong>Complimentary Gratis</strong> (saat bersihkan kamar) atau <strong>Minibar Berbayar</strong> (saat cek kamar checkout & konfirmasi FO).
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
        <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 space-y-2.5">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
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
              <label className="block text-[11px] font-bold text-neutral-700 mb-1">Cakupan Tipe Kamar</label>
              <select
                value={selectedRoomTypeId}
                onChange={(e) => setSelectedRoomTypeId(e.target.value)}
                className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
              >
                <option value="ALL">✓ Semua Tipe Kamar (Otomatis)</option>
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    Khusus: {rt.name}
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
          <div className="text-[11px] text-neutral-500">
            💡 <strong>Tips:</strong> Biarkan pilihan <strong>Cakupan Tipe Kamar</strong> pada <strong>&ldquo;✓ Semua Tipe Kamar (Otomatis)&rdquo;</strong> agar cukup 1x simpan langsung berlaku untuk seluruh tipe kamar. Pilih tipe kamar tertentu hanya jika ada kamar dengan isi minibar khusus.
          </div>
        </div>

        {/* Tabel Daftar Standar Aktif */}
        {loading ? (
          <div className="text-xs text-neutral-500 py-3">Memuat daftar standar kamar...</div>
        ) : groupedStandards.length === 0 ? (
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
                  <th className="py-2.5 px-3 font-bold">Cakupan Tipe Kamar</th>
                  <th className="py-2.5 px-3 font-bold text-center">Qty Standar Kamar</th>
                  <th className="py-2.5 px-3 font-bold text-right">Harga Tagih Tamu</th>
                  <th className="py-2.5 px-3 font-bold text-right">Stok Gudang HKP</th>
                  <th className="py-2.5 px-3 font-bold text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {groupedStandards.map((std) => (
                  <tr key={`${std.menu_item_id}-${std.item_role}-${std.standard_qty}`} className="hover:bg-neutral-50/70">
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
                    <td className="py-2.5 px-3">
                      {std.is_all_room_types ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                          ✓ Semua Tipe Kamar ({roomTypes.length} Tipe)
                        </span>
                      ) : (
                        <div className="flex flex-col items-start gap-1">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                            Khusus: {std.room_type_names.join(', ') || '1 Tipe Kamar'}
                          </span>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => handleApplyToAllRoomTypes(std)}
                            className="text-[10px] font-bold text-emerald-700 hover:text-emerald-900 underline cursor-pointer disabled:opacity-50"
                          >
                            + Terapkan ke Semua Tipe Kamar
                          </button>
                        </div>
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
                        onClick={() => handleDeleteStandard(std.id, std.is_all_room_types)}
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

        {/* Panel Pengisian untuk Kamar yang Sudah Terlanjur Ready (VACANT_CLEAN / INSPECTED) */}
        <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3 text-xs">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-bold text-emerald-950 flex items-center gap-1.5">
                <span>🏨 Isi Complimentary &amp; Minibar ke Kamar yang Sudah Terlanjur Ready (Siap Huni)</span>
              </div>
              <p className="text-[11px] text-emerald-800 mt-0.5">
                Gunakan fitur ini untuk mengisi/mencatat stok Minibar &amp; Complimentary pada kamar yang saat ini sudah berstatus <strong>VACANT_CLEAN / INSPECTED</strong> tanpa harus mengubah status kamar menjadi kotor.
              </p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
              {readyRooms.length} Kamar Ready Saat Ini
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
            <div className="md:col-span-4">
              <label className="block text-[11px] font-bold text-emerald-950 mb-1">
                Pilih Kamar Siap Huni (Ready)
              </label>
              <select
                value={selectedReadyRoomTarget}
                onChange={(e) => setSelectedReadyRoomTarget(e.target.value)}
                className="w-full text-xs bg-white border border-emerald-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-600 cursor-pointer"
              >
                <option value="ALL">✓ Semua Kamar Ready ({readyRooms.length} Kamar)</option>
                {readyRooms.map((rm) => (
                  <option key={rm.id} value={rm.id}>
                    Kamar {rm.room_number} — {rm.room_type_name} ({rm.status})
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-5 pt-3 md:pt-4">
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deductCompOnReadyStock}
                  onChange={(e) => setDeductCompOnReadyStock(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-emerald-400 text-[#1b4332] focus:ring-emerald-600 cursor-pointer"
                />
                <span className="text-[11px] text-emerald-950 font-medium">
                  Potong juga stok <strong>Complimentary Gratis (Air Mineral)</strong> dari Gudang HKP sekarang
                  <span className="block text-[10px] text-emerald-700 font-normal">
                    (Jika tidak dicentang, sistem hanya mencatat isi kulkas Minibar Berbayar tanpa memotong stok Air Mineral HKP).
                  </span>
                </span>
              </label>
            </div>

            <div className="md:col-span-3 pt-2 md:pt-4">
              <button
                type="button"
                disabled={stockingReady || readyRooms.length === 0}
                onClick={handleStockReadyRooms}
                className="w-full py-2.5 px-3 rounded-xl text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] transition shadow-xs cursor-pointer disabled:opacity-50"
              >
                {stockingReady
                  ? 'Memproses Kamar...'
                  : selectedReadyRoomTarget === 'ALL'
                  ? `💧 Isi ke Semua Kamar Ready (${readyRooms.length})`
                  : '💧 Isi ke Kamar Terpilih'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
