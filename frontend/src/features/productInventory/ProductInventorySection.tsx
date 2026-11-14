import type { ActiveRoomReservation } from '../roomMaster/roomMasterTypes';
import PosInventoryWorkspace from '../posInventory/PosInventoryWorkspace';

interface Props {
  propertyId: number | null;
  posMenuCount?: number;
  posOrderCount?: number;
  onViewReservation?: (reservation: ActiveRoomReservation) => void | Promise<void>;
  onNavigateToProcurement?: () => void;
}

export default function ProductInventorySection({ propertyId, onNavigateToProcurement }: Props) {
  return (
    <div className="rm-page">
      <PosInventoryWorkspace propertyId={propertyId} onNavigateToProcurement={onNavigateToProcurement} />
    </div>
  );
}
