import { useCallback, useEffect, useState } from 'react';
import { roomMasterApi } from './roomMasterApi';
import RoomTypesView from './RoomTypesView';
import PhysicalRoomsView from './PhysicalRoomsView';
import type { PhysicalRoom, RoomType } from './roomMasterTypes';
import './roomMaster.css';

type Tab = 'types' | 'rooms';

export default function RoomMasterPage() {
  const [tab, setTab] = useState<Tab>('types');
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [rooms, setRooms] = useState<PhysicalRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; code: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [types, roomList] = await Promise.all([
        roomMasterApi.listRoomTypes(),
        roomMasterApi.listRooms()
      ]);
      setRoomTypes(types);
      setRooms(roomList);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memuat data room master.';
      setLoadError(message);
    } finally {
      setLoading(false);
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
  const inactiveRooms = rooms.length - activeRooms;

  function handleChanged(message: string) {
    setBanner({ kind: 'success', code: 'OK', message });
    void load();
  }

  return (
    <div className="rm-page">
      <div className="rm-page-head">
        <div>
          <div className="rm-kicker">Produk &amp; Inventori</div>
          <h3 className="rm-title">KAMAR</h3>
          <p className="rm-subtitle">Kelola tipe kamar dan kamar fisik hotel</p>
        </div>
        <div className="rm-subnav" role="tablist" aria-label="Bagian Kamar">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'types'}
            className={tab === 'types' ? 'active' : ''}
            onClick={() => setTab('types')}
          >
            Tipe Kamar
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
        <div className="rm-card">
          <div className="rm-card-label">Kamar Nonaktif</div>
          <div className="rm-card-value rm-card-value--muted">{inactiveRooms}</div>
        </div>
      </div>

      {tab === 'types' ? (
        <RoomTypesView
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
          roomTypes={roomTypes}
          loading={loading}
          error={loadError}
          onRefresh={() => void load()}
          onChanged={handleChanged}
          bannerError={banner?.kind === 'error' ? { code: banner.code, message: banner.message } : null}
          onClearBanner={() => setBanner(null)}
        />
      )}
    </div>
  );
}
