import { useCallback, useEffect, useRef, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import RoomCategoriesView from './RoomCategoriesView';
import RoomTypesView from './RoomTypesView';
import PhysicalRoomsView from './PhysicalRoomsView';
import type { ActiveRoomReservation, PhysicalRoom, RoomCategory, RoomType } from './roomMasterTypes';
import './roomMaster.css';

type Tab = 'categories' | 'types' | 'rooms';

interface Props {
  onViewReservation: (reservation: ActiveRoomReservation) => void | Promise<void>;
}

export default function RoomMasterPage({ onViewReservation }: Props) {
  const [tab, setTab] = useState<Tab>('categories');
  const [categories, setCategories] = useState<RoomCategory[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [rooms, setRooms] = useState<PhysicalRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; code: string; message: string } | null>(null);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    setLoadError(null);
    try {
      const [categoryList, types, roomList] = await Promise.all([
        roomMasterApi.listRoomCategories(),
        roomMasterApi.listRoomTypes(),
        roomMasterApi.listRooms()
      ]);
      if (loadVersionRef.current === version) {
        setCategories(categoryList);
        setRoomTypes(types);
        setRooms(roomList);
      }
    } catch (err) {
      if (loadVersionRef.current === version) {
        const message = err instanceof Error ? err.message : 'Gagal memuat data room master.';
        setLoadError(message);
      }
    } finally {
      if (loadVersionRef.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Success feedback self-dismisses; errors stay until acknowledged.
  useEffect(() => {
    if (banner?.kind !== 'success') return;
    const timer = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const activeRooms = rooms.filter((r) => r.is_active).length;

  function handleChanged(message: string) {
    setBanner({ kind: 'success', code: 'OK', message });
    void load();
  }

  function handleCategoriesReordered(nextCategories: RoomCategory[]) {
    setCategories(nextCategories);
    setBanner({ kind: 'success', code: 'OK', message: 'Urutan kategori kamar disimpan.' });
  }

  return (
    <div className="rm-page">
      <div className="rm-page-head">
        <div>
          <div className="rm-kicker">Produk &amp; Inventori</div>
          <h3 className="rm-title">KAMAR</h3>
          <p className="rm-subtitle">Kelola kategori, tipe / varian, dan kamar fisik hotel</p>
        </div>
        <div className="rm-subnav" role="tablist" aria-label="Bagian Kamar">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'categories'}
            className={tab === 'categories' ? 'active' : ''}
            onClick={() => setTab('categories')}
          >
            Kategori Kamar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'types'}
            className={tab === 'types' ? 'active' : ''}
            onClick={() => setTab('types')}
          >
            Tipe / Varian Kamar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rooms'}
            className={tab === 'rooms' ? 'active' : ''}
            onClick={() => setTab('rooms')}
          >
            Kamar Fisik
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={banner.kind === 'success' ? 'rm-alert rm-alert--success' : 'rm-alert rm-alert--error'}
        >
          <span>
            {banner.message}
            {banner.kind === 'error' && <span className="rm-alert-code">{banner.code}</span>}
          </span>
          <button type="button" className="rm-alert-dismiss" onClick={() => setBanner(null)}>×</button>
        </div>
      )}

      <div className="rm-summary-grid">
        <div className="rm-card">
          <div className="rm-card-label">Total Kategori</div>
          <div className="rm-card-value">{categories.length}</div>
        </div>
        <div className="rm-card">
          <div className="rm-card-label">Total Tipe Kamar</div>
          <div className="rm-card-value">{roomTypes.length}</div>
        </div>
        <div className="rm-card">
          <div className="rm-card-label">Total Kamar Fisik</div>
          <div className="rm-card-value">{rooms.length}</div>
        </div>
        <div className="rm-card">
          <div className="rm-card-label">Kamar Aktif</div>
          <div className="rm-card-value">{activeRooms}</div>
        </div>
      </div>

      {tab === 'categories' ? (
        <RoomCategoriesView
          categories={categories}
          loading={loading}
          error={loadError}
          onRefresh={() => void load()}
          onChanged={handleChanged}
          onReordered={handleCategoriesReordered}
          bannerError={banner?.kind === 'error' ? { code: banner.code, message: banner.message } : null}
          onClearBanner={() => setBanner(null)}
        />
      ) : tab === 'types' ? (
        <RoomTypesView
          categories={categories}
          roomTypes={roomTypes}
          loading={loading}
          error={loadError}
          onRefresh={() => void load()}
          onChanged={handleChanged}
          bannerError={banner?.kind === 'error' ? { code: banner.code, message: banner.message } : null}
          onClearBanner={() => setBanner(null)}
        />
      ) : (
        <PhysicalRoomsView
          rooms={rooms}
          categories={categories}
          roomTypes={roomTypes}
          loading={loading}
          error={loadError}
          onRefresh={() => void load()}
          onChanged={handleChanged}
          bannerError={banner?.kind === 'error' ? { code: banner.code, message: banner.message } : null}
          onClearBanner={() => setBanner(null)}
          onViewReservation={onViewReservation}
        />
      )}
    </div>
  );
}
