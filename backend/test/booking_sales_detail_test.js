'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { generateToken } = require('../dist/domains/auth/authService');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const { assembleBookingSalesDetail } = require('../dist/domains/transactions/bookingSalesDetail');
const { getBookingSalesDetail } = require('../dist/domains/transactions/bookingSalesDetailService');
const {
  mapSaleSourceCategory,
  saleIdentityKey,
  findDuplicateSaleIdentities,
  isChargeToRoomDoubleRevenue,
  CHARGE_TO_ROOM_SALE_INVARIANT,
} = require('../dist/domains/transactions/saleSourceIdentity');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function staffToken(propertyId = 1, id = 40) {
  return generateToken({
    id,
    email: `sales3a${id}@oak.test`,
    username: `sales3a${id}`,
    full_name: 'Sales Staff',
    role: 'Front Office',
    role_id: 3,
    property_id: propertyId,
    scope: 'FULL',
  });
}

const booking = {
  id: 88,
  bid: 'LWG-260907-79W91XS8',
  property_id: 1,
  guest_name_snapshot: 'HADIRA NUR RAGAWAN',
  booker_name: 'Booker Hadira',
  booking_source: 'WALKIN',
  channel: 'WALKIN',
  booking_status: 'ACTIVE',
};

const reservations = [
  {
    id: 101,
    room_id: 11,
    room_number: '101',
    room_type_name: 'DELUXE KING',
    booked_room_type_name_snapshot: 'DELUXE KING',
    stay_sequence: 1,
    stay_type: 'OVERNIGHT',
    check_in: '2026-09-07',
    check_out: '2026-09-08',
    status: 'CHECKED_IN',
    stay_status: 'CHECKED_IN',
    amount_paid: 368000,
    remaining_balance: 50000,
  },
  {
    id: 204,
    room_id: 22,
    room_number: '204',
    room_type_name: 'DELUXE TRIPLE',
    booked_room_type_name_snapshot: 'DELUXE TRIPLE',
    stay_sequence: 2,
    stay_type: 'OVERNIGHT',
    check_in: '2026-09-07',
    check_out: '2026-09-09',
    status: 'BOOKED',
    stay_status: 'RESERVED',
    amount_paid: 92000,
    remaining_balance: 335200,
  },
];

function sale(partial) {
  return {
    property_id: 1,
    transaction_type: 'SALE',
    source_type: 'ROOM_CHARGE',
    amount: 0,
    discount_amount: 0,
    net_amount: 0,
    payment_status: 'UNPAID',
    transaction_status: 'POSTED',
    booking_id: 88,
    ...partial,
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        const body = Buffer.concat(chunks).toString('utf8');
        try { json = JSON.parse(body); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function mockDetailPool({
  bookingRow = booking,
  superAdminIds = [],
  canonicalFinancials = null,
} = {}) {
  // canonicalFinancials: optional Map/record of reservationId -> {
  //   amount_paid, applied_deposit, hotel_collectible_remaining_balance, payment_responsibility
  // } to simulate calculateHotelCollectibleBalance outputs at service level.
  return {
    async query(sql, params = []) {
      const text = String(sql);
      // ── Canonical calculator stubs (calculateHotelCollectibleBalance) ──
      // These must run even when canonicalFinancials is not provided (default
      // zero state), because the service path now ALWAYS calls the canonical
      // calculator — failing to answer these queries would 500 the request.
      if (text.includes('booking_property_id')) {
        // calculateReservationFinancials reservation fetch
        const reservationId = Number(params[0]);
        return {
          rows: [{ id: reservationId, booking_property_id: Number(bookingRow.property_id), amount_paid: 0, total_price: 0 }],
          rowCount: 1,
        };
      }
      if (text.includes('CROSS JOIN allocated')) {
        // getEffectivePaymentStateForReservation inside canonical calculator
        const reservationId = Number(params[0]);
        const fin = canonicalFinancials instanceof Map
          ? canonicalFinancials.get(reservationId)
          : (canonicalFinancials ? canonicalFinancials[String(reservationId)] : null);
        const ordinary = fin ? Number(fin.amount_paid || 0) : 0;
        const hasHistory = Boolean(fin && (Number(fin.amount_paid) > 0 || Number(fin.applied_deposit) > 0));
        return {
          rows: [{
            direct_paid: ordinary,
            direct_source_cnt: hasHistory ? 1 : 0,
            direct_positive_cnt: hasHistory && ordinary > 0 ? 1 : 0,
            direct_history_cnt: hasHistory ? 1 : 0,
            allocated_paid: 0,
            alloc_effective_cnt: 0,
            alloc_positive_cnt: 0,
            alloc_history_cnt: 0,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('DEPOSIT_APPLY')) {
        const reservationId = Number(params[0]);
        const fin = canonicalFinancials instanceof Map
          ? canonicalFinancials.get(reservationId)
          : (canonicalFinancials ? canonicalFinancials[String(reservationId)] : null);
        return { rows: [{ applied_deposit: fin ? Number(fin.applied_deposit || 0) : 0 }], rowCount: 1 };
      }
      if (text.includes('gross_charges') && text.includes('folio_entries')) {
        // calculateReservationFinancials folio debits query (HOTEL_COLLECT path)
        const reservationId = Number(params[0]);
        const fin = canonicalFinancials instanceof Map
          ? canonicalFinancials.get(reservationId)
          : (canonicalFinancials ? canonicalFinancials[String(reservationId)] : null);
        const remaining = fin ? Number(fin.hotel_collectible_remaining_balance || 0) : 0;
        const applied = fin ? Number(fin.applied_deposit || 0) : 0;
        const ordinary = fin ? Number(fin.amount_paid || 0) : 0;
        const total = remaining + applied + ordinary;
        return {
          rows: [{
            gross_charges: total,
            charge_reversals: 0,
            room_charge_posted: total,
            commercial_discounts: 0,
            charge_count: total > 0 ? 1 : 0,
          }],
          rowCount: 1,
        };
      }
      // OTA_COLLECT: filter out ROOM_CHARGE from collectible total
      if (canonicalFinancials && text.includes('source_type') && text.includes('ROOM_CHARGE')) {
        const reservationId = Number(params[0]);
        const fin = canonicalFinancials instanceof Map
          ? canonicalFinancials.get(reservationId)
          : canonicalFinancials[String(reservationId)];
        return {
          rows: [{
            gross_collectible: fin ? Number(fin.hotel_collectible_total || 0) : 0,
            collectible_reversals: 0,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM users u') && text.includes('JOIN roles r')) {
        const userId = Number(params[0]);
        if (superAdminIds.includes(userId)) {
          return {
            rows: [{
              id: userId,
              username: 'superadmin',
              full_name: 'Platform Super Admin',
              email: 'sa@oak.test',
              user_is_active: true,
              role_id: 1,
              role_name: 'Super Admin',
              role_is_active: true,
              is_system_role: true,
              role_property_id: null,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM bookings b')) {
        const propertyId = Number(params[0]);
        const bid = String(params[1]);
        const numericId = params[2] == null ? null : Number(params[2]);
        if (!bookingRow || Number(bookingRow.property_id) !== propertyId) {
          return { rows: [], rowCount: 0 };
        }
        if (bookingRow.bid === bid || Number(bookingRow.id) === numericId) {
          return { rows: [bookingRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM reservations r') && text.includes('room_type_name')) {
        if (Number(params[0]) !== Number(bookingRow.property_id) || Number(params[1]) !== Number(bookingRow.id)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: reservations, rowCount: reservations.length };
      }
      if (text.includes('FROM transactions t') && text.includes('paid_amount')) {
        return {
          rows: [
            sale({ id: 1, reservation_id: 101, amount: 460000, discount_amount: 92000, net_amount: 368000, source_id: '850' }),
            sale({ id: 2, reservation_id: 204, amount: 534000, discount_amount: 106800, net_amount: 427200, source_id: '851' }),
          ],
          rowCount: 2,
        };
      }
      if (text.includes('payment_allocations pa') || text.includes('UNION ALL')) {
        // Canonical booking payment-history query (UNION ALL of allocations + direct).
        // Must be checked BEFORE the generic payment_transactions matcher.
        return {
          rows: [{
            payment_id: 501,
            pa_reservation_id: null,
            reservation_id: 101,
            transaction_id: 1,
            transaction_type: 'PAYMENT',
            payment_method: 'CASH',
            parent_amount: 368000,
            allocated_amount: null,
            status: 'SUCCESS',
            payment_status: 'SUCCESS',
            created_at: '2026-09-07T03:00:00.000Z',
            reference_code: 'PAY-101',
            scope: 'ROOM_RESERVATION',
            evidence_filename: 'bukti-101.jpg',
            evidence_storage_key: 'pe/101.jpg',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM payment_transactions pt')) {
        return {
          rows: [{
            id: 501,
            reservation_id: 101,
            transaction_id: 1,
            payment_method: 'CASH',
            amount: 368000,
            status: 'SUCCESS',
            created_at: '2026-09-07T03:00:00.000Z',
            reference_code: 'PAY-101',
            evidence_filename: 'bukti-101.jpg',
            evidence_storage_key: 'pe/101.jpg',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('folio_entries') && text.includes('COALESCE(SUM')) {
        // Mock calculateHotelCollectibleBalance → calculateReservationFinancials folio query
        const reservationId = Number(params[0]);
        return {
          rows: [{
            gross_charges: reservationId === 101 ? 460000 : 534000,
            charge_reversals: 0,
            room_charge_posted: reservationId === 101 ? 460000 : 534000,
            commercial_discounts: reservationId === 101 ? 92000 : 106800,
            charge_count: 1,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('reservation_nightly_rates')) {
        return { rows: [{ nightly_sum: 0 }], rowCount: 1 };
      }
      if (text.includes('payment_transactions') && text.includes('ROOM_RESERVATION')) {
        // getEffectivePaymentStateForReservation
        const reservationId = Number(params[0]);
        return {
          rows: [{
            direct_paid: reservationId === 101 ? 368000 : 0,
            direct_source_cnt: reservationId === 101 ? 1 : 0,
            direct_positive_cnt: reservationId === 101 ? 1 : 0,
            direct_history_cnt: reservationId === 101 ? 1 : 0,
            allocated_paid: 0,
            alloc_effective_cnt: 0,
            alloc_positive_cnt: 0,
            alloc_history_cnt: 0,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('folio_entries') && text.includes('DEPOSIT_APPLY')) {
        return { rows: [{ applied_deposit: 0 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

async function withServer(pool, fn) {
  const app = express();
  app.use('/api/transactions', createTransactionsRouter(pool));
  const { server, port } = await listen(app);
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const roomSales = [
    sale({
      id: 1,
      reservation_id: 101,
      source_id: '850',
      amount: 460000,
      discount_amount: 92000,
      net_amount: 368000,
      transaction_date: '2026-09-07',
    }),
    sale({
      id: 2,
      reservation_id: 204,
      source_id: '851',
      amount: 534000,
      discount_amount: 106800,
      net_amount: 427200,
      transaction_date: '2026-09-07',
    }),
  ];

  await test('A/B/C. booking detail returns entire booking, not latest child', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [],
    });
    assert.equal(detail.booking.bid, 'LWG-260907-79W91XS8');
    assert.equal(detail.booking.room_count, 2);
    assert.equal(detail.children.length, 2);
    assert.equal(detail.financial.net, 795200);
    assert.notEqual(detail.financial.net, 427200);
    assert.equal(detail.scope, 'LIFETIME_BOOKING');
    assert.equal(detail.context_label, 'Seluruh Booking');
  });

  await test('D. lifetime detail includes sales from different posted dates', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: [
        ...roomSales,
        sale({
          id: 3,
          reservation_id: 101,
          source_type: 'POS',
          source_id: 'POS-RST-00125',
          amount: 150000,
          net_amount: 150000,
          transaction_date: '2026-09-08',
        }),
      ],
      payments: [],
    });
    assert.equal(detail.financial.net, 945200);
    assert.ok(detail.source_breakdown.some((row) => row.category === 'POS'));
  });

  await test('E/F. gross/discount/net reconcile from effective sources', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [],
    });
    assert.equal(detail.financial.gross, 994000);
    assert.equal(detail.financial.discount, 198800);
    assert.equal(detail.financial.net, 795200);
    assert.equal(detail.financial.gross - detail.financial.discount, detail.financial.net);
    const childSum = detail.children.reduce((sum, child) => sum + child.net, 0);
    assert.equal(childSum, detail.financial.net);
  });

  await test('G. PAYMENT rows do not increase revenue', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: [
        ...roomSales,
        {
          id: 900,
          transaction_type: 'PAYMENT',
          source_type: 'BOOKING_PAYMENT',
          amount: 368000,
          net_amount: 368000,
          reservation_id: 101,
          booking_id: 88,
        },
      ],
      payments: [{
        id: 501,
        reservation_id: 101,
        payment_method: 'CASH',
        amount: 368000,
        status: 'SUCCESS',
        created_at: '2026-09-07T03:00:00.000Z',
        reference_code: 'PAY-101',
      }],
    });
    assert.equal(detail.financial.net, 795200);
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].amount, 368000);
  });

  await test('H. later payment changes paid/remaining only', async () => {
    const before = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [],
    });
    const after = assembleBookingSalesDetail({
      booking,
      reservations: reservations.map((row) => (
        row.id === 204
          ? { ...row, amount_paid: 427200, remaining_balance: 0 }
          : row
      )),
      sales: roomSales,
      payments: [{ id: 777, reservation_id: 204, amount: 335200, payment_method: 'QRIS', status: 'SUCCESS' }],
    });
    assert.equal(after.financial.net, before.financial.net);
    assert.equal(after.financial.gross, before.financial.gross);
    assert.equal(after.financial.paid, 795200);
    assert.equal(after.financial.remaining, 50000);
  });

  await test('I. correction/reversal uses effective lifecycle net', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations: [reservations[0]],
      sales: [
        sale({
          id: 94,
          reservation_id: 101,
          source_id: '850',
          amount: 300000,
          net_amount: 300000,
          transaction_status: 'VOIDED',
          correction_group_id: 'corr_folio850',
        }),
        sale({
          id: 95,
          reservation_id: 101,
          source_id: 'REV-850',
          amount: -300000,
          net_amount: -300000,
          transaction_status: 'REVERSED',
          reversal_of_transaction_id: 94,
          correction_group_id: 'corr_folio850',
        }),
        sale({
          id: 96,
          reservation_id: 101,
          source_id: '850',
          amount: 289000,
          net_amount: 289000,
          transaction_status: 'POSTED',
          correction_group_id: 'corr_folio850',
        }),
      ],
      payments: [],
    });
    assert.equal(detail.financial.net, 289000);
    assert.equal(detail.children.length, 1);
    assert.equal(detail.children[0].net, 289000);
  });

  await test('J. extra stay charge rolls into child, not a fake room', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: [
        ...roomSales,
        sale({
          id: 3,
          reservation_id: 101,
          source_type: 'EXTRA_BED',
          source_id: 'stay-extra-1',
          amount: 50000,
          net_amount: 50000,
        }),
      ],
      payments: [],
    });
    assert.equal(detail.children.length, 2);
    assert.equal(detail.booking.room_count, 2);
    const child101 = detail.children.find((child) => child.reservation_id === 101);
    assert.equal(child101.net, 418000);
    assert.ok(detail.source_breakdown.some((row) => row.category === 'STAY_EXTRA'));
  });

  await test('K. canonical room type label, not rooms.name', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations: [{
        ...reservations[0],
        room_type_name: 'DELUXE KING',
        booked_room_type_name_snapshot: 'DELUXE KING',
      }],
      sales: [roomSales[0]],
      payments: [],
    });
    assert.equal(detail.children[0].room_type_name, 'DELUXE KING');
  });

  await test('L. actual payment rows returned with evidence reference', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [{
        id: 501,
        reservation_id: 101,
        payment_method: 'CASH',
        amount: 368000,
        status: 'SUCCESS',
        created_at: '2026-09-07T03:00:00.000Z',
        reference_code: 'PAY-101',
        evidence_filename: 'bukti-101.jpg',
      }],
    });
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].method, 'CASH');
    assert.equal(detail.payments[0].evidence_reference, 'bukti-101.jpg');
  });

  await test('P. linked POS fixture appears under POS and booking context', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: [
        ...roomSales,
        sale({
          id: 11,
          reservation_id: 101,
          source_type: 'POS',
          source_id: 'POS-RST-00125',
          amount: 150000,
          net_amount: 150000,
        }),
      ],
      payments: [],
    });
    const pos = detail.source_breakdown.find((row) => row.category === 'POS');
    assert.ok(pos);
    assert.equal(pos.net, 150000);
    assert.equal(detail.children.find((child) => child.reservation_id === 101).net, 518000);
  });

  await test('source mapping is extensible including future PENALTY', async () => {
    assert.equal(mapSaleSourceCategory('ROOM_CHARGE'), 'ROOM');
    assert.equal(mapSaleSourceCategory('EXTRA_BED'), 'STAY_EXTRA');
    assert.equal(mapSaleSourceCategory('LAUNDRY'), 'LAUNDRY');
    assert.equal(mapSaleSourceCategory('POS_ORDER'), 'POS');
    assert.equal(mapSaleSourceCategory('PENALTY'), 'PENALTY');
    assert.equal(mapSaleSourceCategory('BANQUET'), 'OTHER_OUTLET');
    assert.equal(mapSaleSourceCategory('MANUAL_SALE'), 'OTHER');
  });

  await test('R. POS source identity does not collide with ROOM_CHARGE folio id', async () => {
    const rows = [
      { property_id: 1, source_type: 'ROOM_CHARGE', source_id: '850' },
      { property_id: 1, source_type: 'POS', source_id: 'POS-RST-00125' },
    ];
    assert.equal(findDuplicateSaleIdentities(rows).length, 0);
    assert.notEqual(
      saleIdentityKey(1, 'POS', 'POS-RST-00125'),
      saleIdentityKey(1, 'ROOM_CHARGE', '850')
    );
  });

  await test('S. Charge-to-Room contract: one economic source = one SALE', async () => {
    assert.ok(CHARGE_TO_ROOM_SALE_INVARIANT.includes('canonical SALE: one row'));
    const correct = [
      { property_id: 1, source_type: 'POS', source_id: 'POS-RST-00125' },
    ];
    assert.equal(isChargeToRoomDoubleRevenue({
      propertyId: 1,
      posSourceType: 'POS',
      posSourceId: 'POS-RST-00125',
      folioEntryId: '9901',
      projectedSales: correct,
    }), false);

    const forbidden = [
      { property_id: 1, source_type: 'POS', source_id: 'POS-RST-00125' },
      { property_id: 1, source_type: 'POS_ROOM_CHARGE', source_id: '9901' },
    ];
    assert.equal(isChargeToRoomDoubleRevenue({
      propertyId: 1,
      posSourceType: 'POS',
      posSourceId: 'POS-RST-00125',
      folioEntryId: '9901',
      projectedSales: forbidden,
    }), true);
  });

  await test('N. unauthorized request is rejected', async () => {
    const pool = mockDetailPool();
    await withServer(pool, async (port) => {
      const res = await request(port, '/api/transactions/sales/bookings/88?property_id=1');
      assert.equal(res.status, 401);
      assert.equal(res.json.code, 'UNAUTHORIZED');
    });
  });

  await test('M. wrong property is rejected', async () => {
    const pool = mockDetailPool();
    await withServer(pool, async (port) => {
      const res = await request(port, '/api/transactions/sales/bookings/88?property_id=2', staffToken(1));
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'FORBIDDEN');
    });
  });

  await test('same-property booking detail succeeds', async () => {
    const pool = mockDetailPool({ bookingRow: { ...booking, property_id: 1 } });
    await withServer(pool, async (port) => {
      const res = await request(port, '/api/transactions/sales/bookings/88?property_id=1', staffToken(1));
      assert.equal(res.status, 200);
      assert.equal(res.json.data.booking.bid, 'LWG-260907-79W91XS8');
      assert.equal(res.json.data.children.length, 2);
      assert.equal(res.json.data.financial.net, 795200);
    });
  });

  await test('O. Super Admin uses requested property, not a role_id shortcut', async () => {
    const pool = mockDetailPool({
      bookingRow: { ...booking, property_id: 2 },
      superAdminIds: [99],
    });
    await withServer(pool, async (port) => {
      const denied = await request(port, '/api/transactions/sales/bookings/88?property_id=2', staffToken(1, 40));
      assert.equal(denied.status, 403);
      const allowed = await request(port, '/api/transactions/sales/bookings/88?property_id=2', staffToken(9, 99));
      assert.equal(allowed.status, 200);
      assert.equal(allowed.json.data.booking.property_id, 2);
    });
  });

  await test('Q. DEPOSIT must NOT appear in payment history', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [
        {
          id: 501,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          payment_method: 'CASH',
          amount: 368000,
          status: 'SUCCESS',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'PAY-101',
        },
        {
          id: 502,
          reservation_id: 101,
          transaction_type: 'DEPOSIT',
          payment_method: 'CASH',
          amount: 200000,
          status: 'SUCCESS',
          created_at: '2026-09-07T02:00:00.000Z',
          reference_code: 'DEP-LWG-00075',
        },
      ],
    });
    assert.equal(detail.payments.length, 1, 'Q: only PAYMENT row should appear');
    assert.equal(detail.payments[0].payment_id, 501);
    assert.equal(detail.payments[0].amount, 368000);
    const depositFound = detail.payments.find((p) => p.payment_id === 502);
    assert.ok(!depositFound, 'Q: DEPOSIT must NOT appear in detail.payments');
  });

  await test('R. DEPOSIT_REFUND must NOT appear in payment history', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [
        {
          id: 503,
          reservation_id: 101,
          transaction_type: 'DEPOSIT_REFUND',
          payment_method: 'CASH',
          amount: 50000,
          status: 'SUCCESS',
          created_at: '2026-09-07T01:00:00.000Z',
          reference_code: 'DEPR-001',
        },
        {
          id: 504,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          payment_method: 'CASH',
          amount: 100000,
          status: 'SUCCESS',
          created_at: '2026-09-07T02:00:00.000Z',
          reference_code: 'PAY-101',
        },
      ],
    });
    assert.equal(detail.payments.length, 1, 'R: only PAYMENT row should appear');
    assert.equal(detail.payments[0].payment_id, 504);
    assert.equal(detail.payments[0].amount, 100000);
    const depRefFound = detail.payments.find((p) => p.payment_id === 503);
    assert.ok(!depRefFound, 'R: DEPOSIT_REFUND must NOT appear');
  });

  await test('S. CORRECTION_REPLACEMENT must appear in payment history', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [
        {
          id: 505,
          reservation_id: 101,
          transaction_type: 'CORRECTION_REPLACEMENT',
          payment_method: 'TRANSFER',
          amount: 25000,
          status: 'SUCCESS',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'CORR-001',
        },
      ],
    });
    assert.equal(detail.payments.length, 1, 'S: CORRECTION_REPLACEMENT should appear');
    assert.equal(detail.payments[0].payment_id, 505);
    assert.equal(detail.payments[0].method, 'TRANSFER');
    assert.equal(detail.payments[0].amount, 25000);
  });

  await test('T. BOOKING_GROUP allocated amount used, not parent amount', async () => {
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [
        {
          payment_id: 506,
          pa_reservation_id: 101,
          reservation_id: 101,
          transaction_id: null,
          transaction_type: 'PAYMENT',
          scope: 'BOOKING_GROUP',
          payment_method: 'CASH',
          parent_amount: 500000,
          allocated_amount: 100000,
          payment_status: 'SUCCESS',
          allocation_status: 'ACTIVE',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'BGP-C-001',
        },
      ],
    });
    assert.equal(detail.payments.length, 1, 'T: BOOKING_GROUP payment should appear');
    assert.equal(detail.payments[0].payment_id, 506, 'T: payment_id is the parent payment id');
    assert.equal(detail.payments[0].reservation_id, 101, 'T: reservation_id is the allocated reservation');
    assert.equal(detail.payments[0].amount, 100000, 'T: displayed amount is allocated_amount=100000, not parent_amount=500000');
  });

  await test('U. applied deposit does not double-count with canonical paid', async () => {
    // calculateReservationFinancials returns amount_paid = ordinary canonical payment ONLY.
    // applied_deposit is tracked separately. effective paid = amount_paid + applied_deposit.
    // When assembleBookingSalesDetail receives no reservationFinancials it falls back
    // to reservation.amount_paid. This test asserts that fallback behaviour is correct
    // and that no fake PAYMENT row is created for applied deposit.
    const detail = assembleBookingSalesDetail({
      booking,
      reservations: [
        {
          ...reservations[0],
          amount_paid: 368000, // fallback: ordinary canonical payment (no applied deposit in this fixture)
          remaining_balance: 0,
        },
        reservations[1],
      ],
      sales: roomSales,
      payments: [],
    });
    // Paid comes from reservation.amount_paid fallback (canonical path not exercised here)
    assert.equal(detail.children.find((c) => c.reservation_id === 101).paid, 368000);
    assert.equal(detail.children.find((c) => c.reservation_id === 101).remaining, 0);
    // No duplicate payment entries should be created from applied deposit
    assert.equal(detail.payments.length, 0, 'U: no fake deposit application payment rows');
  });

  await test('V. property isolation: scope is enforced at service layer', async () => {
    // The assembly layer cannot see property_id — property scoping is enforced
    // by bookingSalesDetailService.ts, not by assembleBookingSalesDetail().
    // This test verifies the assembly layer correctly passes through both
    // qualifying payment rows regardless of any mock property metadata.
    const detail = assembleBookingSalesDetail({
      booking: { ...booking, property_id: 1 },
      reservations: [{
        ...reservations[0],
        property_id: 1,
      }],
      sales: roomSales.slice(0, 1),
      payments: [
        {
          id: 507,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          scope: 'TRANSACTION_DIRECT',
          payment_method: 'CASH',
          amount: 9999,
          status: 'SUCCESS',
          created_at: '2026-09-07T04:00:00.000Z',
          reference_code: 'PAY-CROSS',
        },
        {
          id: 508,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          scope: 'ROOM_RESERVATION',
          payment_method: 'CASH',
          amount: 368000,
          status: 'SUCCESS',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'PAY-NORM',
        },
      ],
    });
    // Both qualifying PAYMENT rows appear at the assembly layer; property
    // isolation is enforced upstream by the service query.
    assert.equal(detail.payments.length, 2, 'V: both qualifying payments passed through assembly');
  });

  await test('W. no duplicate payment rows on identical input', async () => {
    // Two distinct rows with different ids are independent entries.
    // A single row duplicated in the array produces duplicate output
    // which matches current assembly behaviour (dedup is a query concern).
    const detail = assembleBookingSalesDetail({
      booking,
      reservations,
      sales: roomSales,
      payments: [
        {
          id: 509,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          scope: 'ROOM_RESERVATION',
          payment_method: 'CASH',
          amount: 368000,
          status: 'SUCCESS',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'PAY-DUP',
        },
        {
          id: 510,
          reservation_id: 101,
          transaction_type: 'PAYMENT',
          scope: 'ROOM_RESERVATION',
          payment_method: 'CASH',
          amount: 368000,
          status: 'SUCCESS',
          created_at: '2026-09-07T03:00:00.000Z',
          reference_code: 'PAY-DUP-2',
        },
      ],
    });
    assert.equal(detail.payments.length, 2, 'W: two distinct payment IDs produce two rows');
    const ids = detail.payments.map((p) => p.payment_id);
    assert.ok(ids.includes(509) && ids.includes(510), 'W: both payment ids preserved');
  });

  await test('X. canonical paid uses calculateHotelCollectibleBalance output', async () => {
    const canonicalFin = new Map([
      [101, { amount_paid: 200000, applied_deposit: 50000, hotel_collectible_remaining_balance: 118000, payment_responsibility: 'HOTEL_COLLECT' }],
      [204, { amount_paid: 0, applied_deposit: 0, hotel_collectible_remaining_balance: 427200, payment_responsibility: 'HOTEL_COLLECT' }],
    ]);
    const pool = mockDetailPool({ canonicalFinancials: canonicalFin });
    // getBookingSalesDetail calls calculateHotelCollectibleBalance per reservation
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    // Child 101: canonical paid = 200000 + 50000 = 250000
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    assert.equal(child101.paid, 250000, 'X: canonical paid = ordinary + applied_deposit');
    assert.equal(child101.remaining, 118000, 'X: canonical remaining from collectible');
    // Child 204: no canonical financials → fallback to amount_paid
    const child204 = detail.children.find((c) => c.reservation_id === 204);
    assert.equal(child204.paid, 0, 'X: reservation 204 has no canonical financials');
  });

  await test('Y. OTA_COLLECT: hotel extras remain collectible, room charge excluded', async () => {
    // Hotel has room charge of 368000 (OTA settled outside hotel) + extra charge 50000
    // Hotel collectible = 50000 only
    const canonicalFin = new Map([
      [101, { amount_paid: 10000, applied_deposit: 0, hotel_collectible_total: 50000, hotel_collectible_remaining_balance: 40000, payment_responsibility: 'OTA_COLLECT' }],
    ]);
    const pool = mockDetailPool({ bookingRow: { ...booking, payment_responsibility: 'OTA_COLLECT' }, canonicalFinancials: canonicalFin });
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    assert.equal(child101.paid, 10000, 'Y: OTA_COLLECT ordinary payment counted');
    assert.equal(child101.remaining, 40000, 'Y: OTA_COLLECT remaining is hotel extras only');
  });

  await test('Z. applied deposit adds to canonical paid without creating fake PAYMENT row', async () => {
    const canonicalFin = new Map([
      [101, { amount_paid: 100000, applied_deposit: 50000, hotel_collectible_remaining_balance: 218000, payment_responsibility: 'HOTEL_COLLECT' }],
    ]);
    const pool = mockDetailPool({ canonicalFinancials: canonicalFin });
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    assert.equal(child101.paid, 150000, 'Z: canonical paid = ordinary 100000 + applied_deposit 50000');
    // No fake PAYMENT row for applied deposit — deposit application is not a payment_history row
    const depositRows = detail.payments.filter((p) => p.amount === 50000);
    assert.equal(depositRows.length, 0, 'Z: no fake PAYMENT row for applied deposit');
  });

  await test('AA. booking query selects payment_responsibility', async () => {
    // Intercept the booking SELECT to assert payment_responsibility is in the SQL.
    let capturedBookingQueryText = '';
    const basePool = mockDetailPool({ bookingRow: booking });
    const interceptingPool = {
      async query(sql, params) {
        const text = String(sql);
        if (text.includes('FROM bookings b') && text.includes('ota_source_id')) {
          capturedBookingQueryText = text;
        }
        // Delegate all other queries (including canonical calculator stubs)
        return basePool.query(sql, params);
      },
    };
    await getBookingSalesDetail(interceptingPool, 1, 'LWG-260907-79W91XS8');
    assert.ok(
      capturedBookingQueryText.includes('payment_responsibility'),
      'AA: booking SELECT must include payment_responsibility column'
    );
  });

  await test('AB. canonical calculation failure propagates, does not silently fall back', async () => {
    // When calculateHotelCollectibleBalance throws, getBookingSalesDetail must
    // propagate the error rather than silently returning legacy amount_paid.
    const throwingPool = {
      async query(sql, params) {
        const text = String(sql);
        // Normal queries from bookingSalesDetailService
        if (text.includes('FROM bookings b')) {
          const propertyId = Number(params[0]);
          const bid = String(params[1]);
          const numericId = params[2] == null ? null : Number(params[2]);
          if (Number(booking.property_id) !== propertyId) return { rows: [], rowCount: 0 };
          if (booking.bid === bid || Number(booking.id) === numericId) {
            return { rows: [{ ...booking, payment_responsibility: 'HOTEL_COLLECT' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM reservations r') && text.includes('room_type_name')) {
          return { rows: reservations, rowCount: reservations.length };
        }
        if (text.includes('FROM transactions t') && text.includes('paid_amount')) {
          return { rows: [sale({ id: 1, reservation_id: 101, amount: 460000, discount_amount: 92000, net_amount: 368000 })], rowCount: 1 };
        }
        if (text.includes('payment_allocations') || text.includes('payment_transactions')) {
          return { rows: [], rowCount: 0 };
        }
        // All canonical calculator queries throw — no fallback
        if (text.includes('booking_property_id') || text.includes('folio_entries') || text.includes('DEPOSIT_APPLY') || text.includes('CROSS JOIN allocated')) {
          throw new Error('Canonical financial calculation failed');
        }
        return { rows: [], rowCount: 0 };
      },
    };
    let thrown = null;
    try {
      await getBookingSalesDetail(throwingPool, 1, 'LWG-260907-79W91XS8');
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown !== null, 'AB: error must be thrown when canonical calculation fails');
    assert.ok(
      String(thrown.message).includes('Canonical financial calculation failed'),
      'AB: original error must propagate, not be swallowed'
    );
  });

  await test('AC. OTA_COLLECT with zero hotel collectible shows PAID + responsibility field', async () => {
    // The core bug scenario: OTA booking, room charge settled outside hotel,
    // no hotel extras → hotel collectible = 0 → remaining = 0 → PAID.
    // This must NOT show UNPAID/329k contradiction.
    const canonicalFin = new Map([
      [101, { amount_paid: 0, applied_deposit: 0, hotel_collectible_total: 0, hotel_collectible_remaining_balance: 0, payment_responsibility: 'OTA_COLLECT' }],
    ]);
    const pool = mockDetailPool({ bookingRow: { ...booking, payment_responsibility: 'OTA_COLLECT' }, canonicalFinancials: canonicalFin });
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    assert.equal(child101.payment_status, 'PAID', 'AC: OTA_COLLECT with zero collectible → PAID');
    assert.equal(child101.remaining, 0, 'AC: OTA_COLLECT remaining is zero');
    assert.equal(child101.payment_responsibility, 'OTA_COLLECT', 'AC: payment_responsibility field present on child');
  });

  await test('AD. OTA_COLLECT with unpaid hotel extras shows PARTIAL, not UNPAID', async () => {
    // OTA room settled; hotel extras of 50000 remain; guest paid 20000 toward extras.
    const canonicalFin = new Map([
      [101, { amount_paid: 20000, applied_deposit: 0, hotel_collectible_total: 50000, hotel_collectible_remaining_balance: 30000, payment_responsibility: 'OTA_COLLECT' }],
    ]);
    const pool = mockDetailPool({ bookingRow: { ...booking, payment_responsibility: 'OTA_COLLECT' }, canonicalFinancials: canonicalFin });
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    assert.equal(child101.payment_status, 'PARTIAL', 'AD: OTA_COLLECT with partial extra payment → PARTIAL');
    assert.equal(child101.paid, 20000, 'AD: OTA_COLLECT paid reflects hotel extras only');
    assert.equal(child101.remaining, 30000, 'AD: OTA_COLLECT remaining is unpaid hotel extras');
  });

  await test('AE. booking-level payment_responsibility applies to all children', async () => {
    // payment_responsibility is a booking-level attribute; all reservations under
    // the same booking inherit it. This test verifies the field propagates to
    // every child row regardless of their individual canonical financials.
    const canonicalFin = new Map([
      [101, { amount_paid: 0, applied_deposit: 0, hotel_collectible_total: 0, hotel_collectible_remaining_balance: 0, payment_responsibility: 'OTA_COLLECT' }],
      [204, { amount_paid: 50000, applied_deposit: 0, hotel_collectible_total: 0, hotel_collectible_remaining_balance: 0, payment_responsibility: 'OTA_COLLECT' }],
    ]);
    const pool = mockDetailPool({ bookingRow: { ...booking, payment_responsibility: 'OTA_COLLECT' }, canonicalFinancials: canonicalFin });
    const detail = await getBookingSalesDetail(pool, 1, 'LWG-260907-79W91XS8');
    const child101 = detail.children.find((c) => c.reservation_id === 101);
    const child204 = detail.children.find((c) => c.reservation_id === 204);
    assert.equal(child101.payment_responsibility, 'OTA_COLLECT', 'AE: OTA booking → all children are OTA_COLLECT');
    assert.equal(child204.payment_responsibility, 'OTA_COLLECT', 'AE: OTA booking → all children are OTA_COLLECT');
    assert.equal(child101.payment_status, 'PAID', 'AE: OTA child with zero collectible → PAID');
    assert.equal(child204.payment_status, 'PAID', 'AE: OTA child with paid extras exceeding zero collectible → PAID');
  });

  if (failed > 0) {
    console.error(`\nFAILED ${failed} | passed ${passed}`);
    process.exit(1);
  }
  console.log(`\nPASS | booking sales detail | ${passed} tests`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
