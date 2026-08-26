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
import type {
  ActiveRoomReservation,
  ActiveRoomReservationDrilldown,
  PhysicalRoom,
  RoomCategory,
  RoomType
} from './roomMasterTypes';
import RoomModal from './RoomModal';
import ConfirmDeleteModal from './ConfirmDeleteModal';

interface Props {
  propertyId: number | null;
  rooms: PhysicalRoom[];
  categories: RoomCategory[];
  roomTypes: RoomType[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChanged: (message: string) => void;
  bannerError: { code: string; message: string } | null;
  onClearBanner: () => void;
  onViewReservation: (reservation: ActiveRoomReservation) => void | Promise<void>;
}

type ModalState = { kind: 'create' } | { kind: 'edit'; target: PhysicalRoom } | null;
type ReservationDrilldownState = {
  room: PhysicalRoom;
  data: ActiveRoomReservationDrilldown | null;
  loading: boolean;
  error: string | null;
};

function reservationStatusLabel(status: ActiveRoomReservation['status']) {
  return status === 'CHECKED_IN' ? 'Check-in' : 'Booked';
}

export default function PhysicalRoomsView({
  propertyId,
  rooms,
  categories,
  roomTypes,
  loading,
  error,
  onRefresh,
  onChanged,
  bannerError,
  onClearBanner,
  onViewReservation
}: Props) {
  const [modal, setModal] = useState<ModalState>(null);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ code: string; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PhysicalRoom | null>(null);
  const [reservationDrilldown, setReservationDrilldown] = useState<ReservationDrilldownState | null>(null);

  // Canonical room_type_id filter — never name matching (AGENTS.md §2).
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [floorFilter, setFloorFilter] = useState('');
  const [search, setSearch] = useState('');

  const floors = useMemo(
    () => Array.from(new Set(rooms.map((r) => r.floor).filter((f): f is string => Boolean(f)))).sort(),
    [rooms]
  );

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );
  const typeById = useMemo(
    () => new Map(roomTypes.map((roomType) => [roomType.id, roomType])),
    [roomTypes]
  );

  const visibleRooms = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rooms.filter((r) => {
      const roomType = r.room_type_id == null ? null : typeById.get(r.room_type_id);
      const category = roomType?.room_category_id == null ? null : categoryById.get(roomType.room_category_id);
      if (categoryFilter !== 'all' && String(roomType?.room_category_id ?? '') !== categoryFilter) return false;
      if (typeFilter !== 'all' && String(r.room_type_id ?? '') !== typeFilter) return false;
      if (activeFilter === 'active' && !r.is_active) return false;
      if (activeFilter === 'inactive' && r.is_active) return false;
      if (floorFilter && (r.floor ?? '') !== floorFilter) return false;
      if (needle && !`${r.room_number} ${category?.code ?? ''} ${category?.name ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rooms, categoryFilter, typeFilter, activeFilter, floorFilter, typeById, categoryById, search]);

  async function toggleActive(room: PhysicalRoom) {
    if (!propertyId) return;
    setRowBusyId(room.id);
    setRowError(null);
    try {
      await roomMasterApi.updateRoom(room.id, propertyId, { is_active: !room.is_active });
      onChanged(`Kamar ${room.room_number} ${room.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setRowBusyId(null);
    }
  }

  async function openActiveReservations(room: PhysicalRoom) {
    if (!propertyId) return;
    setReservationDrilldown({ room, data: null, loading: true, error: null });
    try {
      const data = await roomMasterApi.listActiveRoomReservations(room.id, propertyId);
      setReservationDrilldown((current) => current?.room.id === room.id
        ? { room, data, loading: false, error: null }
        : current);
    } catch (err) {
      const detail = describeApiError(err);
      setReservationDrilldown((current) => current?.room.id === room.id
        ? { room, data: null, loading: false, error: detail.message }
        : current);
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

      <div className="rm-toolbar-filters rm-toolbar-filters--panel">
        <select
          className="rm-filter"
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setTypeFilter('all');
          }}
          aria-label="Filter kategori kamar"
        >
          <option value="all">Semua Kategori</option>
          {categories.map((category) => (
            <option key={category.id} value={String(category.id)}>
              {category.code} · {category.name}{category.is_active ? '' : ' (nonaktif)'}
            </option>
          ))}
        </select>
        <select className="rm-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter tipe kamar">
          <option value="all">Semua Tipe</option>
          {roomTypes
            .filter((t) => categoryFilter === 'all' || String(t.room_category_id ?? '') === categoryFilter)
            .map((t) => (
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
          className="rm-filter rm-filter--search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari nomor kamar…"
          aria-label="Cari nomor kamar"
        />
        <span className="rm-filter-count">
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
                <th>Kategori</th>
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
              {visibleRooms.map((room) => {
                const roomType = room.room_type_id == null ? null : typeById.get(room.room_type_id);
                const category = roomType?.room_category_id == null ? null : categoryById.get(roomType.room_category_id);
                return (
                  <tr key={room.id}>
                    <td className="rm-cell-strong">{room.room_number}</td>
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
                    <td>
                      <span className="rm-type-name">{room.room_type_name || '-'}</span>{' '}
                      <span className="rm-cell-muted">({room.room_type_code || '-'})</span>
                    </td>
                    <td>{room.floor || '-'}</td>
                    <td><OperationalStatusBadge status={room.status} /></td>
                    <td><MasterStatusBadge active={Boolean(room.is_active)} /></td>
                    <td>
                      {Number(room.active_reservation_count ?? 0) > 0 ? (
                        <button
                          type="button"
                          className="rm-badge rm-badge--occupied rm-active-reservation-trigger"
                          onClick={() => void openActiveReservations(room)}
                          aria-label={`Lihat ${room.active_reservation_count} reservasi aktif kamar ${room.room_number}`}
                        >
                          {room.active_reservation_count} aktif <span aria-hidden="true">&gt;</span>
                        </button>
                      ) : (
                        <span className="rm-cell-muted">0</span>
                      )}
                    </td>
                    <td className="rm-cell-muted rm-notes-cell">
                      {(room.notes || '-').length > 60 ? `${room.notes!.slice(0, 60)}...` : room.notes || '-'}
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
                        <button
                          type="button"
                          className="rm-btn rm-btn--delete"
                          disabled={rowBusyId === room.id}
                          title="Hapus permanen (hanya jika belum memiliki riwayat)"
                          onClick={() => setDeleteTarget(room)}
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
        <RoomModal
          mode="create"
          propertyId={propertyId}
          categories={categories}
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
          propertyId={propertyId}
          room={modal.target}
          categories={categories}
          roomTypes={roomTypes}
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged(`Kamar ${modal.target.room_number} diperbarui.`);
          }}
        />
      )}

      {reservationDrilldown && (
        <div
          className="rm-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rm-active-reservations-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReservationDrilldown(null);
          }}
        >
          <div className="rm-modal rm-modal--reservations">
            <div className="rm-modal-head">
              <div>
                <span className="rm-kicker">Kamar {reservationDrilldown.room.room_number}</span>
                <h3 id="rm-active-reservations-title" className="rm-modal-title">Reservasi Aktif</h3>
              </div>
              <button type="button" className="rm-btn rm-btn--ghost" onClick={() => setReservationDrilldown(null)}>
                Tutup
              </button>
            </div>
            <div className="rm-modal-body rm-active-reservations-body">
              {reservationDrilldown.loading ? (
                <LoadingState label="Memuat reservasi aktif..." />
              ) : reservationDrilldown.error ? (
                <div className="rm-alert rm-alert--error">{reservationDrilldown.error}</div>
              ) : reservationDrilldown.data?.reservations.length ? (
                <div className="rm-active-reservation-list">
                  {reservationDrilldown.data.reservations.map((reservation) => (
                    <article key={reservation.id} className="rm-active-reservation-item">
                      <div className="rm-active-reservation-main">
                        <div className="rm-active-reservation-identity">
                          <strong>{reservation.bid || reservation.booking_number || `Reservasi #${reservation.id}`}</strong>
                          {reservation.bid && reservation.booking_number && <span>{reservation.booking_number}</span>}
                        </div>
                        <div className="rm-active-reservation-guest">{reservation.guest_name}</div>
                      </div>
                      <div className="rm-active-reservation-meta">
                        <span className="rm-badge rm-badge--occupied">{reservationStatusLabel(reservation.status)}</span>
                        <span className={`rm-reservation-classification rm-reservation-classification--${reservation.classification.toLowerCase()}`}>
                          {reservation.classification === 'IN_HOUSE' ? 'In-house' : 'Mendatang'}
                        </span>
                      </div>
                      <div className="rm-active-reservation-stay">
                        <span>{reservation.check_in}</span>
                        <span aria-hidden="true">-&gt;</span>
                        <span>{reservation.check_out}</span>
                        <strong>{reservation.nights} malam</strong>
                      </div>
                      <button
                        type="button"
                        className="rm-btn rm-btn--ghost rm-active-reservation-action"
                        onClick={() => {
                          setReservationDrilldown(null);
                          void onViewReservation(reservation);
                        }}
                      >
                        Lihat Reservasi
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rm-state">Tidak ada reservasi aktif.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          title={`Hapus Kamar ${deleteTarget.room_number}?`}
          description="Penghapusan permanen hanya dapat dilakukan jika kamar belum memiliki riwayat operasional."
          onConfirm={async () => {
            if (propertyId !== null) {
              await roomMasterApi.deleteRoom(deleteTarget.id, propertyId);
            }
          }}
          onCancelled={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            onChanged(`Kamar ${deleteTarget.room_number} dihapus.`);
          }}
        />
      )}
    </div>
  );
}
