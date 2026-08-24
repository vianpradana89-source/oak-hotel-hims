import { useState } from 'react';
import RoomMasterPage from '../roomMaster/RoomMasterPage';

interface Props {
  posMenuCount: number;
  posOrderCount: number;
}

// Produk & Inventori landing section: Kamar (Room Master) is the primary
// operational view; the legacy POS summary remains available as a tab.
export default function ProductInventorySection({ posMenuCount, posOrderCount }: Props) {
  const [section, setSection] = useState<'kamar' | 'pos'>('kamar');

  return (
    <div className="rm-page">
      <div className="rm-subnav-wrap">
        <div className="rm-subnav" role="tablist" aria-label="Produk & Inventori">
          <button
            type="button"
            role="tab"
            aria-selected={section === 'kamar'}
            className={section === 'kamar' ? 'active' : ''}
            onClick={() => setSection('kamar')}
          >
            Kamar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'pos'}
            className={section === 'pos' ? 'active' : ''}
            onClick={() => setSection('pos')}
          >
            POS
          </button>
        </div>
      </div>

      {section === 'kamar' ? (
        <RoomMasterPage />
      ) : (
        <div className="bg-white border rounded shadow-sm p-4">
          <h3 className="font-bold text-lg mb-3">Produk &amp; Inventori</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="border rounded p-3">
              <div className="text-xs uppercase text-gray-500">Menu aktif</div>
              <div className="text-2xl font-bold mt-2">{posMenuCount}</div>
            </div>
            <div className="border rounded p-3">
              <div className="text-xs uppercase text-gray-500">Order hari ini</div>
              <div className="text-2xl font-bold mt-2">{posOrderCount}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
