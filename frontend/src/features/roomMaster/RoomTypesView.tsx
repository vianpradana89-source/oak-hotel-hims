import { useMemo, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, EmptyState, ErrorState, LoadingState, MasterStatusBadge } from './roomMasterUi';
import type { RoomCategory, RoomType } from './roomMasterTypes';
import RoomTypeModal from './RoomTypeModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';

interface Props {
  propertyId: number | null;
  categories: RoomCategory[];
  roomTypes: RoomType[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChanged: (message: string) => void;
  bannerError: { code: string; message: string } | null;
  onClearBanner: () => void;
}

type ModalState = { kind: 'create' } | { kind: 'edit'; target: RoomType } | null;
export default function RoomTypesView({
  propertyId,
  categories,
  roomTypes,
  loading,
  error,
  onRefresh,
  onChanged,
  bannerError,
  onClearBanner
}: Props) {
  const [modal, setModal] = useState<ModalState>(null);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ code: string; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomType | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );

  const visibleTypes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return roomTypes.filter((rt) => {
      if (statusFilter === 'active' && !rt.is_active) return false;
      if (statusFilter === 'inactive' && rt.is_active) return false;
      if (categoryFilter !== 'all' && String(rt.room_category_id ?? '') !== categoryFilter) return false;
      const category = rt.room_category_id == null ? null : categoryById.get(rt.room_category_id);
      if (needle && !`${rt.code} ${rt.name} ${category?.code ?? ''} ${category?.name ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [roomTypes, statusFilter, categoryFilter, categoryById, search]);

  async function toggleActive(roomType: RoomType) {
    if (!propertyId) return;
    setRowBusyId(roomType.id);
    setRowError(null);
    try {
      await roomMasterApi.updateRoomType(roomType.id, propertyId, { is_active: !roomType.is_active });
      onChanged(`Tipe ${roomType.code} ${roomType.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <div className="rm-panel">
      <div className="rm-panel-toolbar">
        <div className="rm-toolbar-title">Daftar Tipe / Varian Kamar</div>
        <button type="button" className="rm-btn rm-btn--primary" onClick={() => setModal({ kind: 'create' })}>
          + Tambah Tipe Kamar
        </button>
      </div>

      <div className="rm-toolbar-filters rm-toolbar-filters--panel">
        <select
          className="rm-filter"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter kategori kamar"
        >
          <option value="all">Semua Kategori</option>
          {categories.map((category) => (
            <option key={category.id} value={String(category.id)}>
              {category.code} · {category.name}{category.is_active ? '' : ' (nonaktif)'}
            </option>
          ))}
        </select>
        <select
          className="rm-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          aria-label="Filter status tipe kamar"
        >
          <option value="all">Aktif &amp; Nonaktif</option>
          <option value="active">Aktif saja</option>
          <option value="inactive">Nonaktif saja</option>
        </select>
        <input
          className="rm-filter rm-filter--search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari kode / nama tipe…"
          aria-label="Cari tipe kamar"
        />
        <span className="rm-filter-count">
          {visibleTypes.length} / {roomTypes.length} tipe
        </span>
      </div>

      {(bannerError || rowError) && (
        <div className={`rm-alert rm-alert--error`} style={{ margin: '12px 14px 0' }}>
          <span>
            {(rowError ?? bannerError)!.message}
            <span className="rm-alert-code">{(rowError ?? bannerError)!.code}</span>
          </span>
          <button
            type="button"
            className="rm-alert-dismiss"
            onClick={() => (bannerError ? onClearBanner() : setRowError(null))}
          >
            ×
          </button>
        </div>
      )}

      {loading ? (
        <LoadingState label="Memuat tipe kamar…" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRefresh} />
      ) : visibleTypes.length === 0 ? (
        <EmptyState
          title={roomTypes.length === 0 ? 'Belum ada tipe kamar' : 'Tidak ada tipe yang cocok dengan filter'}
          hint={roomTypes.length === 0 ? 'Tambahkan tipe kamar pertama untuk memulai.' : undefined}
        />
      ) : (
        <div className="rm-table-wrap">
          <table className="rm-table">
            <thead>
              <tr>
                <th>Kode</th>
                <th>Nama Tipe</th>
                <th>Kategori</th>
                <th>Tipe Kasur</th>
                <th>Okupansi</th>
                <th>Kamar Aktif/Total</th>
                <th>Puncak Reservasi</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visibleTypes.map((rt) => {
                const category = rt.room_category_id == null ? null : categoryById.get(rt.room_category_id);
                const occupancy = [
                  rt.capacity != null ? `${rt.capacity} org` : null,
                  rt.max_adults != null || rt.max_children != null
                    ? `${rt.max_adults ?? '?'}A·${rt.max_children ?? '?'}C`
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <tr key={rt.id}>
                    <td className="rm-cell-strong">{rt.code}</td>
                    <td className="rm-type-name">{rt.name}</td>
                    <td>
                      {category ? (
                        <>
                          <span className="rm-type-name">{category.name}</span>{' '}
                          <span className="rm-cell-muted">({category.code})</span>
                        </>
                      ) : (
                        <span className="rm-cell-muted">Belum dikategorikan</span>
                      )}
                    </td>
                    <td className="rm-cell-muted">{rt.bed_type || '—'}</td>
                    <td>{occupancy || '—'}</td>
                    <td>
                      <span className="rm-cell-strong">{rt.active_physical_rooms ?? 0}</span>
                      <span className="rm-cell-muted"> / {rt.physical_room_count ?? 0}</span>
                    </td>
                    <td className={Number(rt.future_reserved_peak ?? 0) > 0 ? 'rm-cell-strong' : 'rm-cell-muted'}>
                      {rt.future_reserved_peak ?? 0}
                    </td>
                    <td><MasterStatusBadge active={Boolean(rt.is_active)} /></td>
                    <td>
                      <span className="rm-actions-cell">
                        <button
                          type="button"
                          className="rm-btn rm-btn--ghost"
                          onClick={() => setModal({ kind: 'edit', target: rt })}
                        >
                          Detail
                        </button>
                        <button
                          type="button"
                          className={`rm-btn ${rt.is_active ? 'rm-btn--danger' : 'rm-btn--ghost'}`}
                          disabled={rowBusyId === rt.id}
                          title={rt.is_active ? 'Nonaktifkan tipe kamar' : 'Aktifkan tipe kamar'}
                          onClick={() => void toggleActive(rt)}
                        >
                          {rowBusyId === rt.id ? '…' : rt.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                        </button>
                        <button
                          type="button"
                          className="rm-btn rm-btn--delete"
                          disabled={rowBusyId === rt.id}
                          title="Hapus permanen (hanya jika belum memiliki riwayat)"
                          onClick={() => setDeleteTarget(rt)}
                        >
                          Hapus
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'create' && (
        <RoomTypeModal
          mode="create"
          propertyId={propertyId}
          categories={categories}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged('Tipe kamar baru dibuat.');
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <RoomTypeModal
          mode="edit"
          propertyId={propertyId}
          roomType={modal.target}
          categories={categories}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged(`Tipe ${modal.target.code} diperbarui.`);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          title={`Hapus Tipe Kamar ${deleteTarget.code}?`}
          description="Penghapusan permanen hanya dapat dilakukan jika tipe kamar belum memiliki riwayat."
          onConfirm={() => propertyId !== null && roomMasterApi.deleteRoomType(deleteTarget.id, propertyId)}
          onCancelled={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            onChanged(`Tipe ${deleteTarget.code} dihapus.`);
          }}
        />
      )}
    </div>
  );
}
