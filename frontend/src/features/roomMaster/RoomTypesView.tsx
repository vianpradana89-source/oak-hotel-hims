import { useMemo, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, EmptyState, ErrorState, LoadingState, MasterStatusBadge } from './roomMasterUi';
import type { RoomType } from './roomMasterTypes';
import RoomTypeModal from './RoomTypeModal';

interface Props {
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [search, setSearch] = useState('');

  const visibleTypes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return roomTypes.filter((rt) => {
      if (statusFilter === 'active' && !rt.is_active) return false;
      if (statusFilter === 'inactive' && rt.is_active) return false;
      if (needle && !`${rt.code} ${rt.name}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [roomTypes, statusFilter, search]);

  async function toggleActive(roomType: RoomType) {
    setRowBusyId(roomType.id);
    setRowError(null);
    try {
      await roomMasterApi.updateRoomType(roomType.id, { is_active: !roomType.is_active });
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
        <div className="rm-toolbar-title">Daftar Tipe Kamar</div>
        <button type="button" className="rm-btn rm-btn--primary" onClick={() => setModal({ kind: 'create' })}>
          + Tambah Tipe Kamar
        </button>
      </div>

      <div className="rm-toolbar-filters" style={{ padding: '10px 14px', borderBottom: '1px solid var(--oak-divider)' }}>
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
          className="rm-filter"
          style={{ minWidth: 160 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari kode / nama tipe…"
          aria-label="Cari tipe kamar"
        />
        <span className="rm-cell-muted" style={{ fontSize: 11 }}>
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
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged('Tipe kamar baru dibuat.');
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <RoomTypeModal
          mode="edit"
          roomType={modal.target}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged(`Tipe ${modal.target.code} diperbarui.`);
          }}
        />
      )}
    </div>
  );
}
