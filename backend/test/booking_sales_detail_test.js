'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { generateToken } = require('../dist/domains/auth/authService');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const { assembleBookingSalesDetail } = require('../dist/domains/transactions/bookingSalesDetail');
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

function mockDetailPool({ bookingRow = booking, superAdminIds = [] } = {}) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
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
