import { useMemo, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import {
  describeApiError,
  EmptyState,
  ErrorState,
  LoadingState,
  MasterStatusBadge,
  OperationalStatusBadge
} from './roomMasterUi';
import type { PhysicalRoom, RoomType } from './roomMasterTypes';
import RoomModal from './RoomModal';

interface Props {
  rooms: PhysicalRoom[];
  roomTypes: RoomType[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChanged: (message: string) => void;
  bannerError: { code: string; message: string } | null;
  onClearBanner: () => void;
}

type ModalState = { kind: 'create' } | { kind: 'edit'; target: PhysicalRoom } | null;

export default function PhysicalRoomsView({
  rooms,
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

  // Canonical room_type_id filter — never name matching (AGENTS.md §2).
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [floorFilter, setFloorFilter] = useState('');
  const [search, setSearch] = useState('');

  const floors = useMemo(
    () => Array.from(new Set(rooms.map((r) => r.floor).filter((f): f is string => Boolean(f)))).sort(),
    [rooms]
  );

  const visibleRooms = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rooms.filter((r) => {
      if (typeFilter !== 'all' && String(r.room_type_id ?? '') !== typeFilter) return false;
      if (activeFilter === 'active' && !r.is_active) return false;
      if (activeFilter === 'inactive' && r.is_active) return false;
      if (floorFilter && (r.floor ?? '') !== floorFilter) return false;
      if (needle && !r.room_number.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rooms, typeFilter, activeFilter, floorFilter, search]);

  async function toggleActive(room: PhysicalRoom) {
    setRowBusyId(room.id);
    setRowError(null);
    try {
      await roomMasterApi.updateRoom(room.id, { is_active: !room.is_active });
      onChanged(`Kamar ${room.room_number} ${room.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <div className="rm-panel">
      <div className="rm-panel-toolbar">
        <div className="rm-toolbar-title">Daftar Kamar Fisik</div>
        <button type="button" className="rm-btn rm-btn--primary" onClick={() => setModal({ kind: 'create' })}>
          + Tambah Kamar
        </button>
      </div>

      <div className="rm-toolbar-filters" style={{ padding: '10px 14px', borderBottom: '1px solid var(--oak-divider)' }}>
        <select className="rm-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter tipe kamar">
          <option value="all">Semua Tipe</option>
          {roomTypes.map((t) => (
            <option key={t.id} value={String(t.id)}>
              {t.code} · {t.name}
            </option>
          ))}
        </select>
        <select
          className="rm-filter"
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}
          aria-label="Filter status aktif"
        >
          <option value="all">Aktif & Nonaktif</option>
          <option value="active">Aktif saja</option>
          <option value="inactive">Nonaktif saja</option>
        </select>
        <select
          className="rm-filter"
          value={floorFilter}
          onChange={(e) => setFloorFilter(e.target.value)}
          aria-label="Filter lantai"
        >
          <option value="">Semua Lantai</option>
          {floors.map((f) => (
            <option key={f} value={f}>Lantai {f}</option>
          ))}
        </select>
        <input
          className="rm-filter"
          style={{ minWidth: 160 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari nomor kamar…"
          aria-label="Cari nomor kamar"
        />
        <span className="rm-cell-muted" style={{ fontSize: 11 }}>
          {visibleRooms.length} / {rooms.length} kamar
        </span>
      </div>

      {(bannerError || rowError) && (
        <div className="rm-alert rm-alert--error" style={{ margin: '12px 14px 0' }}>
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
        <LoadingState label="Memuat kamar fisik…" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRefresh} />
      ) : visibleRooms.length === 0 ? (
        <EmptyState
          title={rooms.length === 0 ? 'Belum ada kamar fisik' : 'Tidak ada kamar yang cocok dengan filter'}
          hint={rooms.length === 0 ? 'Tambahkan kamar fisik pertama untuk memulai.' : undefined}
        />
      ) : (
        <div className="rm-table-wrap">
          <table className="rm-table">
            <thead>
              <tr>
                <th>No. Kamar</th>
                <th>Tipe Kamar</th>
                <th>Lantai</th>
                <th>Status Operasional</th>
                <th>Status Master</th>
                <th>Reservasi Aktif</th>
                <th>Catatan</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visibleRooms.map((room) => (
                <tr key={room.id}>
                  <td className="rm-cell-strong">{room.room_number}</td>
                  <td>
                    <span className="rm-type-name">{room.room_type_name || '—'}</span>{' '}
                    <span className="rm-cell-muted">({room.room_type_code || '—'})</span>
                  </td>
                  <td>{room.floor || '—'}</td>
                  <td><OperationalStatusBadge status={room.status} /></td>
                  <td><MasterStatusBadge active={Boolean(room.is_active)} /></td>
                  <td>
                    {Number(room.active_reservation_count ?? 0) > 0 ? (
                      <span className="rm-badge rm-badge--occupied">{room.active_reservation_count} aktif</span>
                    ) : (
                      <span className="rm-cell-muted">0</span>
                    )}
                  </td>
                  <td className="rm-cell-muted" style={{ maxWidth: 200 }}>
                    {(room.notes || '—').length > 60 ? `${room.notes!.slice(0, 60)}…` : room.notes || '—'}
                  </td>
                  <td>
                    <span className="rm-actions-cell">
                      <button
                        type="button"
                        className="rm-btn rm-btn--ghost"
                        onClick={() => setModal({ kind: 'edit', target: room })}
                      >
                        Detail
                      </button>
                      <button
                        type="button"
                        className={`rm-btn ${room.is_active ? 'rm-btn--danger' : 'rm-btn--ghost'}`}
                        disabled={
                          rowBusyId === room.id ||
                          (Number(room.active_reservation_count ?? 0) > 0 && room.is_active)
                        }
                        title={
                          Number(room.active_reservation_count ?? 0) > 0 && room.is_active
                            ? 'Kamar masih memiliki reservasi aktif'
                            : room.is_active
                              ? 'Nonaktifkan kamar'
                              : 'Aktifkan kamar'
                        }
                        onClick={() => void toggleActive(room)}
                      >
                        {rowBusyId === room.id ? '…' : room.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'create' && (
        <RoomModal
          mode="create"
          roomTypes={roomTypes}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged('Kamar baru dibuat.');
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <RoomModal
          mode="edit"
          room={modal.target}
          roomTypes={roomTypes}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged(`Kamar ${modal.target.room_number} diperbarui.`);
          }}
        />
      )}
    </div>
  );
}
