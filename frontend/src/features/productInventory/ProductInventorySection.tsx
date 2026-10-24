import { useState } from 'react';
import RoomMasterPage from '../roomMaster/RoomMasterPage';
import type { ActiveRoomReservation } from '../roomMaster/roomMasterTypes';
import PosInventoryWorkspace from '../posInventory/PosInventoryWorkspace';

interface Props {
  propertyId: number | null;
  posMenuCount?: number;
  posOrderCount?: number;
  onViewReservation: (reservation: ActiveRoomReservation) => void | Promise<void>;
}

// Produk & Inventori landing section: Kamar (Room Master) is the primary
// operational view; POS inventory management is available under the POS tab.
export default function ProductInventorySection({ propertyId, onViewReservation }: Props) {
  const [section, setSection] = useState<'pos' | 'kamar'>('pos');

  return (
    <div className="rm-page">
      <div className="rm-subnav-wrap">
        <div className="rm-subnav" role="tablist" aria-label="Produk & Inventori">
          <button
            type="button"
            role="tab"
            aria-selected={section === 'pos'}
            className={section === 'pos' ? 'active' : ''}
            onClick={() => setSection('pos')}
          >
            Inventaris POS
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'kamar'}
            className={section === 'kamar' ? 'active' : ''}
            onClick={() => setSection('kamar')}
          >
            Kamar
          </button>
        </div>
      </div>

      {section === 'kamar' ? (
        <RoomMasterPage propertyId={propertyId} onViewReservation={onViewReservation} />
      ) : (
        <PosInventoryWorkspace propertyId={propertyId} />
      )}
    </div>
  );
}
