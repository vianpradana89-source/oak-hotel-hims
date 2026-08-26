import { useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import ConfirmDeleteModal from './ConfirmDeleteModal';
import RoomCategoryModal from './RoomCategoryModal';
import { roomMasterApi } from './roomMasterApi';
import { describeApiError, EmptyState, ErrorState, LoadingState, MasterStatusBadge } from './roomMasterUi';
import type { RoomCategory } from './roomMasterTypes';

interface Props {
  categories: RoomCategory[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChanged: (message: string) => void;
  onReordered: (categories: RoomCategory[]) => void;
  bannerError: { code: string; message: string } | null;
  onClearBanner: () => void;
}

type ModalState =
  | { kind: 'create' }
  | { kind: 'view' | 'edit'; target: RoomCategory }
  | null;

type DropTarget = { id: number; edge: 'before' | 'after' } | null;

export default function RoomCategoriesView({
  categories,
  loading,
  error,
  onRefresh,
  onChanged,
  onReordered,
  bannerError,
  onClearBanner
}: Props) {
  const [modal, setModal] = useState<ModalState>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomCategory | null>(null);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ code: string; message: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [search, setSearch] = useState('');
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const [moreMenuId, setMoreMenuId] = useState<number | null>(null);
  const reorderInFlightRef = useRef(false);

  const visibleCategories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return categories.filter((category) => {
      if (statusFilter === 'active' && !category.is_active) return false;
      if (statusFilter === 'inactive' && category.is_active) return false;
      return !needle || `${category.code} ${category.name}`.toLowerCase().includes(needle);
    });
  }, [categories, search, statusFilter]);

  const canReorder = !loading
    && !reorderSaving
    && rowBusyId === null
    && statusFilter === 'all'
    && search.trim() === ''
    && modal === null
    && deleteTarget === null
    && categories.length > 1;

  async function toggleActive(category: RoomCategory) {
    setMoreMenuId(null);
    setRowBusyId(category.id);
    setRowError(null);
    try {
      await roomMasterApi.updateRoomCategory(category.id, { is_active: !category.is_active });
      onChanged(`Kategori ${category.code} ${category.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setRowBusyId(null);
    }
  }

  async function saveOrder(nextCategories: RoomCategory[], movedCategory: RoomCategory) {
    if (reorderInFlightRef.current) return;
    const propertyIds = new Set(
      nextCategories
        .map((category) => Number(category.property_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    if (propertyIds.size !== 1 || nextCategories.some((category) => !propertyIds.has(Number(category.property_id)))) {
      setRowError({
        code: 'ROOM_CATEGORY_PROPERTY_MISMATCH',
        message: 'Urutan gagal disimpan karena daftar kategori tidak berasal dari satu properti.'
      });
      return;
    }

    reorderInFlightRef.current = true;
    setReorderSaving(true);
    setRowError(null);
    setMoreMenuId(null);
    try {
      const saved = await roomMasterApi.reorderRoomCategories({
        property_id: Array.from(propertyIds)[0],
        category_ids: nextCategories.map((category) => category.id)
      });
      onReordered(saved);
      const position = saved.findIndex((category) => category.id === movedCategory.id) + 1;
      setReorderAnnouncement(`${movedCategory.name} dipindahkan ke posisi ${position} dari ${saved.length}.`);
    } catch (err) {
      const described = describeApiError(err);
      setRowError({
        code: described.code,
        message: `Urutan tidak berubah. ${described.message}`
      });
      setReorderAnnouncement(`Gagal memindahkan ${movedCategory.name}. Urutan sebelumnya dipertahankan.`);
    } finally {
      reorderInFlightRef.current = false;
      setReorderSaving(false);
      setDraggedId(null);
      setDropTarget(null);
    }
  }

  function reorderedList(sourceId: number, targetId: number, edge: 'before' | 'after') {
    if (sourceId === targetId) return null;
    const source = categories.find((category) => category.id === sourceId);
    if (!source) return null;
    const remaining = categories.filter((category) => category.id !== sourceId);
    const targetIndex = remaining.findIndex((category) => category.id === targetId);
    if (targetIndex < 0) return null;
    const insertAt = targetIndex + (edge === 'after' ? 1 : 0);
    remaining.splice(insertAt, 0, source);
    return remaining.every((category, index) => category.id === categories[index]?.id) ? null : remaining;
  }

  function handleDrop(event: DragEvent<HTMLTableRowElement>, target: RoomCategory) {
    event.preventDefault();
    if (!canReorder) return;
    const sourceId = Number(event.dataTransfer.getData('text/room-category-id') || draggedId);
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    const next = reorderedList(sourceId, target.id, edge);
    if (next) {
      const moved = categories.find((category) => category.id === sourceId);
      if (moved) void saveOrder(next, moved);
    } else {
      setDraggedId(null);
      setDropTarget(null);
    }
  }

  function handleKeyboardReorder(event: KeyboardEvent<HTMLButtonElement>, category: RoomCategory) {
    if (!canReorder || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = categories.findIndex((item) => item.id === category.id);
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? categories.length - 1
        : event.key === 'ArrowUp'
          ? Math.max(0, currentIndex - 1)
          : Math.min(categories.length - 1, currentIndex + 1);
    if (targetIndex === currentIndex) return;
    const next = [...categories];
    next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, category);
    void saveOrder(next, category);
  }

  return (
    <div className="rm-panel">
      <div className="rm-panel-toolbar">
        <div>
          <div className="rm-toolbar-title">Daftar Kategori Kamar</div>
          <div className="rm-reorder-hint">
            {reorderSaving
              ? 'Menyimpan urutan kategori...'
              : canReorder
                ? 'Tarik pegangan untuk mengatur urutan tampilan.'
                : 'Tampilkan semua kategori tanpa pencarian untuk mengatur urutan.'}
          </div>
        </div>
        <button type="button" className="rm-btn rm-btn--primary" onClick={() => setModal({ kind: 'create' })}>
          + Tambah Kategori
        </button>
      </div>

      <div className="rm-toolbar-filters rm-toolbar-filters--panel">
        <select
          className="rm-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          aria-label="Filter status kategori kamar"
          disabled={reorderSaving}
        >
          <option value="all">Aktif &amp; Nonaktif</option>
          <option value="active">Aktif saja</option>
          <option value="inactive">Nonaktif saja</option>
        </select>
        <input
          className="rm-filter rm-filter--search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari kode / nama kategori..."
          aria-label="Cari kategori kamar"
          disabled={reorderSaving}
        />
        <span className="rm-filter-count">{visibleCategories.length} / {categories.length} kategori</span>
      </div>

      <div className="rm-sr-only" aria-live="polite">{reorderAnnouncement}</div>

      {(bannerError || rowError) && (
        <div className="rm-alert rm-alert--error rm-alert--panel">
          <span>
            {(rowError ?? bannerError)!.message}
            <span className="rm-alert-code">{(rowError ?? bannerError)!.code}</span>
          </span>
          <button
            type="button"
            className="rm-alert-dismiss"
            onClick={() => (bannerError ? onClearBanner() : setRowError(null))}
          >
            x
          </button>
        </div>
      )}

      {loading ? (
        <LoadingState label="Memuat kategori kamar..." />
      ) : error ? (
        <ErrorState message={error} onRetry={onRefresh} />
      ) : visibleCategories.length === 0 ? (
        <EmptyState
          title={categories.length === 0 ? 'Belum ada kategori kamar' : 'Tidak ada kategori yang cocok dengan filter'}
          hint={categories.length === 0 ? 'Tambahkan kategori pertama untuk mengelompokkan tipe kamar.' : undefined}
        />
      ) : (
        <div className="rm-table-wrap rm-category-table-wrap">
          <table className="rm-table rm-category-table">
            <thead>
              <tr>
                <th className="rm-order-column"><span className="rm-sr-only">Urutan</span></th>
                <th>Kode</th>
                <th>Nama Kategori</th>
                <th>Tipe / Varian</th>
                <th>Kamar Fisik</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visibleCategories.map((category) => {
                const rowDropTarget = dropTarget?.id === category.id ? dropTarget.edge : null;
                return (
                  <tr
                    key={category.id}
                    className={[
                      draggedId === category.id ? 'rm-category-row--dragging' : '',
                      rowDropTarget === 'before' ? 'rm-category-row--drop-before' : '',
                      rowDropTarget === 'after' ? 'rm-category-row--drop-after' : ''
                    ].filter(Boolean).join(' ')}
                    onDragOver={(event) => {
                      if (!canReorder || draggedId === null || draggedId === category.id) return;
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setDropTarget({ id: category.id, edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' });
                    }}
                    onDrop={(event) => handleDrop(event, category)}
                  >
                    <td className="rm-order-cell">
                      <button
                        type="button"
                        className="rm-drag-handle"
                        draggable={canReorder}
                        disabled={!canReorder}
                        aria-label={`Atur urutan ${category.name}. Posisi ${categories.findIndex((item) => item.id === category.id) + 1} dari ${categories.length}. Gunakan panah atas atau bawah.`}
                        title={canReorder ? 'Tarik atau gunakan tombol panah untuk mengubah urutan' : 'Hapus filter untuk mengubah urutan'}
                        onKeyDown={(event) => handleKeyboardReorder(event, category)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/room-category-id', String(category.id));
                          setDraggedId(category.id);
                          setMoreMenuId(null);
                        }}
                        onDragEnd={() => {
                          setDraggedId(null);
                          setDropTarget(null);
                        }}
                      >
                        ⠿
                      </button>
                    </td>
                    <td className="rm-cell-strong">{category.code}</td>
                    <td className="rm-type-name">{category.name}</td>
                    <td>{category.room_type_count ?? 0}</td>
                    <td>{category.physical_room_count ?? 0}</td>
                    <td><MasterStatusBadge active={Boolean(category.is_active)} /></td>
                    <td>
                      <span className="rm-actions-cell">
                        <button
                          type="button"
                          className="rm-btn rm-btn--ghost"
                          disabled={reorderSaving}
                          onClick={() => {
                            setMoreMenuId(null);
                            setModal({ kind: 'view', target: category });
                          }}
                        >
                          Detail
                        </button>
                        <button
                          type="button"
                          className="rm-btn rm-btn--ghost"
                          disabled={reorderSaving}
                          onClick={() => {
                            setMoreMenuId(null);
                            setModal({ kind: 'edit', target: category });
                          }}
                        >
                          Edit
                        </button>
                        <span
                          className="rm-more-actions"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setMoreMenuId(null);
                              (event.currentTarget.querySelector('.rm-more-trigger') as HTMLButtonElement | null)?.focus();
                            }
                          }}
                        >
                          <button
                            type="button"
                            className="rm-btn rm-btn--ghost rm-more-trigger"
                            aria-expanded={moreMenuId === category.id}
                            aria-controls={`category-more-${category.id}`}
                            disabled={rowBusyId !== null || reorderSaving}
                            onClick={() => setMoreMenuId((current) => current === category.id ? null : category.id)}
                          >
                            ⋮ More
                          </button>
                          {moreMenuId === category.id && (
                            <span className="rm-more-menu" id={`category-more-${category.id}`}>
                              <button
                                type="button"
                                disabled={rowBusyId !== null || reorderSaving}
                                onClick={() => void toggleActive(category)}
                              >
                                {rowBusyId === category.id ? 'Memproses...' : category.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                              </button>
                              <button
                                type="button"
                                className="rm-more-menu__danger"
                                disabled={rowBusyId !== null || reorderSaving}
                                onClick={() => {
                                  setMoreMenuId(null);
                                  setDeleteTarget(category);
                                }}
                              >
                                Hapus
                              </button>
                            </span>
                          )}
                        </span>
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
        <RoomCategoryModal
          mode="create"
          onClose={(changed) => {
            setModal(null);
            if (changed) onChanged('Kategori kamar baru dibuat.');
          }}
        />
      )}
      {modal && modal.kind !== 'create' && (
        <RoomCategoryModal
          mode="edit"
          category={modal.target}
          initialViewing={modal.kind === 'view'}
          onClose={(changed) => {
            const target = modal.target;
            setModal(null);
            if (changed) onChanged(`Kategori ${target.code} diperbarui.`);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          title={`Hapus Kategori ${deleteTarget.code}?`}
          description="Penghapusan permanen hanya dapat dilakukan jika kategori tidak digunakan oleh tipe / varian atau snapshot reservasi."
          onConfirm={() => roomMasterApi.deleteRoomCategory(deleteTarget.id)}
          onCancelled={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            onChanged(`Kategori ${deleteTarget.code} dihapus.`);
          }}
        />
      )}
    </div>
  );
}
