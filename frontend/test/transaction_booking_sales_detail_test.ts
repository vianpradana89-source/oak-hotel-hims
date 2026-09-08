import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupPenjualanSaleRows,
  isStandalonePenjualanSale
} from '../src/features/transactions/penjualanBidGrouping.ts';
import {
  resolvePenjualanChildDetailTarget,
  resolvePenjualanMainRowDetailTarget
} from '../src/features/transactions/penjualanDetailTarget.ts';
import type { TransactionRecord } from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

function sale(partial: Partial<TransactionRecord> & { id: number }): TransactionRecord {
  return {
    property_id: 1,
    transaction_no: `TRX-${partial.id}`,
    transaction_date: '2026-09-07',
    transaction_time: '10:00:00',
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    source_id: null,
    source_reference: null,
    party_name: 'HADIRA NUR RAGAWAN',
    category_code: 'ROOM_SALES',
    category_name: 'Room Sales',
    department_code: 'FRONT_OFFICE',
    description: 'Room charge',
    amount: 0,
    discount_amount: 0,
    service_amount: 0,
    tax_amount: 0,
    net_amount: 0,
    payment_status: 'UNPAID',
    payment_method: 'CASH',
    transaction_status: 'POSTED',
    guest_id: null,
    guest_name_snapshot: 'HADIRA NUR RAGAWAN',
    room_number_snapshot: null,
    reservation_id: null,
    booking_id: 88,
    booking_bid: 'LWG-260907-79W91XS8',
    stay_type: 'OVERNIGHT',
    verification_status: 'UNVERIFIED',
    reversal_of_transaction_id: null,
    correction_group_id: null,
    notes: null,
    metadata: {},
    created_by: null,
    created_at: '2026-09-07T03:00:00.000Z',
    ...partial
  } as TransactionRecord;
}

const room101 = sale({
  id: 1,
  reservation_id: 101,
  stay_sequence: 1,
  room_number_snapshot: '101',
  room_type_name: 'DELUXE KING',
  amount: 460000,
  discount_amount: 92000,
  net_amount: 368000,
  effective_net_amount: 368000
});
const room204 = sale({
  id: 2,
  reservation_id: 204,
  stay_sequence: 2,
  room_number_snapshot: '204',
  room_type_name: 'DELUXE TRIPLE',
  amount: 534000,
  discount_amount: 106800,
  net_amount: 427200,
  effective_net_amount: 427200,
  transaction_time: '10:05:00'
});

console.log('=== OAK HIMS TRANSACTION-SALES-3A FRONTEND ===\n');

const grouped = groupPenjualanSaleRows([room204, room101]);
check(grouped.length === 1 && grouped[0].kind === 'bid_group', 'T. grouped BID is one list item');
const mainTarget = resolvePenjualanMainRowDetailTarget(grouped[0]);
check(mainTarget.kind === 'booking', 'T. main Detail target is booking-level');
check(mainTarget.kind === 'booking' && Number(mainTarget.bookingId) === 88, 'T. booking target uses booking_id, not latest child tx id');
check(mainTarget.kind === 'booking' && Number(mainTarget.bookingId) !== 2, 'C. main target is not latest child transaction id 2');

if (grouped[0].kind === 'bid_group') {
  const childTarget = resolvePenjualanChildDetailTarget(grouped[0].group.children[0]);
  check(childTarget.kind === 'transaction', 'U. child Detail remains transaction-level');
  check(childTarget.kind === 'transaction' && Number(childTarget.transactionId) > 0, 'U. child target has transaction id');
}

const standalone = groupPenjualanSaleRows([
  sale({
    id: 9,
    booking_id: null,
    booking_bid: null,
    reservation_id: null,
    source_type: 'POS_ORDER',
    amount: 90000,
    net_amount: 90000
  })
]);
check(standalone[0].kind === 'standalone', 'Q. standalone POS remains standalone');
check(isStandalonePenjualanSale(standalone[0].kind === 'standalone' ? standalone[0].tx : room101) === true, 'Q. walk-in POS has no BID');
const standaloneTarget = resolvePenjualanMainRowDetailTarget(standalone[0]);
check(standaloneTarget.kind === 'transaction', 'Q. standalone Detail stays transaction drawer');

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSrc = readFileSync(join(here, '../src/features/transactions/TransactionWorkspace.tsx'), 'utf8');
check(workspaceSrc.includes('BookingSalesDetailDrawer'), 'T. workspace mounts BookingSalesDetailDrawer');
check(workspaceSrc.includes('openPenjualanItemDetail'), 'T. grouped main row uses booking detail opener');
check(workspaceSrc.includes('openDetailDrawer(child.primary_transaction_id)'), 'U. child Detail still opens TransactionDetailDrawer');
check(!workspaceSrc.includes('onClick={() => openDetailDrawer(t.id)}') || workspaceSrc.includes('openPenjualanItemDetail(item)'), 'T. grouped main Detail is not latest-child t.id');

console.log(`\nPASS | booking sales detail frontend | ${assertions} assertions`);
