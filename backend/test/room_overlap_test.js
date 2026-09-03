// room_overlap_test.js
// Safe integration test for room-overlap backend behavior with strict run isolation + cleanup.
// Usage: node test/room_overlap_test.js [baseUrl]

const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const runId = `PHASE1C2C-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const createdReservationIds = new Set();
const usedRoomIds = new Set();
const scenarioResults = {};
const reservationOwnership = new Map();
const roomTypeById = new Map();
const roomPropertyById = new Map();
const fixture = {
  propertyId: null,
  roomTypeId: null,
  roomCategoryId: null,
  ratePlanId: null,
  identityNumber: null
};

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    fetchFn = require('node-fetch');
  } catch (_e) {
    console.error('Global fetch is not available. Use Node 18+ or install node-fetch.');
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const dt = new Date(dateStr);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

function enumerateDates(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || startStr === endStr) return [];

  const out = [];
  const cur = new Date(start);
  while (cur < end) {
    out.push(toDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function overlaps(rangeA, rangeB) {
  return rangeA.start < rangeB.end && rangeA.end > rangeB.start;
}

async function request(method, path, body, correlationSuffix = '') {
  const correlationId = `${runId}${correlationSuffix ? `-${correlationSuffix}` : ''}`;
  const resp = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return { status: resp.status, text, json, correlationId };
}

async function createOverlapFixture(client) {
  const propertyCode = `O${String(Date.now()).slice(-3)}${Math.random().toString(16).slice(2, 4)}`.toUpperCase();
  const roomTypeCode = `OVL-${propertyCode}`;
  const roomTypeName = `Overlap ${runId}`.slice(0, 100);
  fixture.identityNumber = `3171${String(Date.now()).slice(-12)}`;

  const property = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Overlap test fixture', TRUE)
     RETURNING id`,
    [runId, propertyCode]
  );
  fixture.propertyId = Number(property.rows[0].id);

  await client.query(
    `INSERT INTO property_pricing_settings (
       property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service
     ) VALUES ($1, 0, 0, FALSE, FALSE)`,
    [fixture.propertyId]
  );

  const category = await client.query(
    `INSERT INTO room_categories (property_id, code, name, is_active)
     VALUES ($1, 'OVL', $2, TRUE)
     RETURNING id`,
    [fixture.propertyId, `Overlap ${propertyCode}`]
  );
  fixture.roomCategoryId = Number(category.rows[0].id);

  const roomType = await client.query(
    `INSERT INTO room_types (
       property_id, room_category_id, code, name, base_rate, capacity, is_active
     ) VALUES ($1, $2, $3, $4, 100000, 2, TRUE)
     RETURNING id`,
    [fixture.propertyId, fixture.roomCategoryId, roomTypeCode, roomTypeName]
  );
  fixture.roomTypeId = Number(roomType.rows[0].id);

  const ratePlan = await client.query(
    `INSERT INTO rate_plans (
       property_id, room_type_id, code, name, base_rate, is_active, is_archived
     ) VALUES ($1, $2, $3, $4, 100000, TRUE, FALSE)
     RETURNING id`,
    [fixture.propertyId, fixture.roomTypeId, `BAR-${propertyCode}`, `BAR ${propertyCode}`]
  );
  fixture.ratePlanId = Number(ratePlan.rows[0].id);

  const rooms = await client.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES
       ($1, $2, 'OVL-A', 'OVL-A', 'VACANT_CLEAN', TRUE),
       ($1, $2, 'OVL-B', 'OVL-B', 'VACANT_CLEAN', TRUE)
     RETURNING id, room_number`,
    [fixture.propertyId, fixture.roomTypeId]
  );
  expect(rooms.rowCount === 2, 'Overlap fixture must create exactly two active physical rooms');

  await client.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     SELECT $1, $2, CURRENT_DATE + day_offset, 2, 0
     FROM generate_series(30, 419) AS day_offset`,
    [fixture.roomTypeId, roomTypeName]
  );
}

async function getRooms() {
  const result = await pool.query(`
    SELECT r.id, r.room_number, r.name, r.status, r.property_id,
           COALESCE(rt.name, r.name) AS room_type_name
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.property_id = $1
      AND r.status NOT IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
    ORDER BY r.id ASC
  `, [fixture.propertyId]);
  const rooms = result.rows.map((row) => ({
    id: Number(row.id),
    room_number: String(row.room_number || ''),
    name: String(row.room_type_name || row.name || ''),
    status: String(row.status || ''),
    property_id: Number(row.property_id)
  }));
  expect(Array.isArray(rooms) && rooms.length >= 2, 'Need at least 2 rooms for overlap tests');
  return rooms;
}

async function createReservation(roomId, checkIn, checkOut, label) {
  const propertyId = roomPropertyById.get(Number(roomId));
  const payload = {
    room_id: roomId,
    property_id: propertyId,
    guest_name: `${runId} ${label}`,
    guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    identity_number: fixture.identityNumber,
    has_valid_identity: true,
    ktp_path: `/uploads/identities/${runId}-${label}.jpg`,
    rate_plan_id: fixture.ratePlanId,
    check_in: checkIn,
    check_out: checkOut,
    total_price: 100000,
    qty: 1
  };
  const result = await request('POST', '/api/reservations', payload, label);
  const id = result.json?.data?.id;
  if (result.status === 201 && Number.isFinite(Number(id))) {
    const reservationId = Number(id);
    createdReservationIds.add(reservationId);
    const roomType = String(roomTypeById.get(Number(roomId)) || '');
    if (!roomType) {
      throw new Error(`Missing room_type mapping for room ${roomId}`);
    }
    const nights = enumerateDates(checkIn, checkOut).map((date) => `${roomType}::${date}`);
    reservationOwnership.set(reservationId, {
      roomId: Number(roomId),
      checkIn: String(checkIn),
      checkOut: String(checkOut),
      ownedNights: nights,
      releasedNights: new Set()
    });
  }
  return result;
}

async function cleanupFixture(client) {
  if (!fixture.propertyId) return;

  await client.query('BEGIN');
  try {
    // Covers checkout-created tasks if an earlier reservation cleanup failed.
    await client.query('DELETE FROM housekeeping_tasks WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [fixture.roomTypeId]);
    await client.query('DELETE FROM rate_plans WHERE id = $1', [fixture.ratePlanId]);
    await client.query('DELETE FROM rooms WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM room_types WHERE id = $1', [fixture.roomTypeId]);
    await client.query('DELETE FROM room_categories WHERE id = $1', [fixture.roomCategoryId]);
    await client.query(
      `DELETE FROM guests
       WHERE created_property_id = $1
         AND full_name LIKE $2`,
      [fixture.propertyId, `${runId}%`]
    );
    await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [fixture.propertyId]);
    // The generated property is exclusive to this test run, including audit
    // entries emitted by checkout housekeeping flows without this correlation ID.
    await client.query('DELETE FROM audit_logs WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM properties WHERE id = $1', [fixture.propertyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function trackCancellationRelease(reservationId) {
  const record = reservationOwnership.get(Number(reservationId));
  if (!record) throw new Error(`Missing ownership record for cancellation ${reservationId}`);
  for (const nightKey of record.ownedNights) {
    record.releasedNights.add(nightKey);
  }
}

function trackCheckoutRelease(reservationId) {
  const record = reservationOwnership.get(Number(reservationId));
  if (!record) throw new Error(`Missing ownership record for checkout ${reservationId}`);
  for (const nightKey of record.ownedNights) {
    record.releasedNights.add(nightKey);
  }
}

async function establishSellableRoomStatus(client, roomId) {
  await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', Number(roomId)]);
}

function trackMoveTransfer(reservationId, toRoomId) {
  const record = reservationOwnership.get(Number(reservationId));
  if (!record) throw new Error(`Missing ownership record for move ${reservationId}`);

  const fromRoomType = String(roomTypeById.get(Number(record.roomId)) || '');
  const toRoomType = String(roomTypeById.get(Number(toRoomId)) || '');
  if (!fromRoomType || !toRoomType) {
    throw new Error(`Missing room_type mapping for move ${reservationId}`);
  }
  if (fromRoomType === toRoomType) {
    record.roomId = Number(toRoomId);
    return;
  }

  const nights = enumerateDates(record.checkIn, record.checkOut);
  const nextOwned = [];
  for (const key of record.ownedNights) {
    if (!record.releasedNights.has(key)) {
      record.releasedNights.add(key);
    }
  }
  for (const date of nights) {
    nextOwned.push(`${toRoomType}::${date}`);
  }
  record.ownedNights.push(...nextOwned);
  record.roomId = Number(toRoomId);
}

function markScenario(name, passed, detail = '') {
  scenarioResults[name] = { passed, detail };
}

async function getBaselineCounts(client) {
  const overlapRes = await client.query(`
    WITH active AS (
      SELECT id, room_id, check_in, check_out
      FROM reservations
      WHERE status IN ('BOOKED','CHECKED_IN')
    )
    SELECT COUNT(*) AS overlap_count
    FROM active a
    JOIN active b
      ON a.id < b.id
     AND a.room_id = b.room_id
     AND a.check_in < b.check_out
     AND a.check_out > b.check_in
  `);

  const invalidActiveRes = await client.query(`
    SELECT COUNT(*) AS invalid_active_count
    FROM reservations
    WHERE status IN ('BOOKED','CHECKED_IN')
      AND (check_in IS NULL OR check_out IS NULL OR check_out <= check_in)
  `);

  const invViolationRes = await client.query(`
    SELECT COUNT(*) AS inventory_violation_count
    FROM availability_dates
    WHERE reserved_qty < 0 OR reserved_qty > total_rooms
  `);

  return {
    overlapCount: Number(overlapRes.rows[0]?.overlap_count || 0),
    invalidActiveCount: Number(invalidActiveRes.rows[0]?.invalid_active_count || 0),
    inventoryViolationCount: Number(invViolationRes.rows[0]?.inventory_violation_count || 0)
  };
}

async function findSafeBaseDate(client, roomAId, roomBId, roomAType, roomBType) {
  const windowsByRoom = {
    [roomAId]: [
      [0, 3], [5, 7], [10, 13], [15, 18], [20, 23], [25, 27], [30, 34], [35, 37], [40, 43]
    ],
    [roomBId]: [
      [25, 27], [30, 33], [35, 37], [45, 47]
    ]
  };

  const active = await client.query(`
    SELECT room_id,
           to_char(check_in::date, 'YYYY-MM-DD') AS check_in_key,
           to_char(check_out::date, 'YYYY-MM-DD') AS check_out_key
    FROM reservations
    WHERE room_id = ANY($1::int[])
      AND status IN ('BOOKED','CHECKED_IN')
  `, [[roomAId, roomBId]]);

  const availabilityRows = await client.query(`
    SELECT room_type,
           to_char(date::date, 'YYYY-MM-DD') AS date_key,
           total_rooms,
           reserved_qty
    FROM availability_dates
    WHERE room_type = ANY($1::text[])
      AND date >= CURRENT_DATE + INTERVAL '30 day'
      AND date < CURRENT_DATE + INTERVAL '420 day'
  `, [[roomAType, roomBType]]);
  const availabilityMap = new Map();
  for (const row of availabilityRows.rows) {
    const key = `${row.room_type}::${String(row.date_key)}`;
    availabilityMap.set(key, {
      total: Number(row.total_rooms || 0),
      reserved: Number(row.reserved_qty || 0)
    });
  }

  const byRoom = new Map();
  for (const row of active.rows) {
    const roomId = Number(row.room_id);
    const list = byRoom.get(roomId) || [];
    list.push({
      start: String(row.check_in_key),
      end: String(row.check_out_key)
    });
    byRoom.set(roomId, list);
  }

  const today = new Date();
  for (let offset = 30; offset <= 360; offset += 1) {
    const base = new Date(today);
    base.setDate(today.getDate() + offset);
    const baseDate = toDateKey(base);
    let safe = true;

    for (const [roomIdText, windows] of Object.entries(windowsByRoom)) {
      const roomId = Number(roomIdText);
      const roomType = roomId === roomAId ? roomAType : roomBType;
      const existing = byRoom.get(roomId) || [];
      for (const [startOffset, endOffset] of windows) {
        const target = {
          start: addDays(baseDate, startOffset),
          end: addDays(baseDate, endOffset)
        };
        if (existing.some((row) => overlaps(row, target))) {
          safe = false;
          break;
        }
        const nights = enumerateDates(target.start, target.end);
        for (const date of nights) {
          const availableRow = availabilityMap.get(`${roomType}::${date}`);
          if (!availableRow) {
            safe = false;
            break;
          }
          const sellable = Number(availableRow.total) - Number(availableRow.reserved);
          if (sellable < 1) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
      }
      if (!safe) break;
    }

    if (safe) return baseDate;
  }

  throw new Error('Unable to find isolated future date window for room overlap tests');
}

async function selectScenarioDRoom(client, rooms, baseDate) {
  const roomTypeCounts = await client.query(`
    SELECT COALESCE(rt.name, r.name) AS room_type, COUNT(*)::int AS total_rooms
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    GROUP BY COALESCE(rt.name, r.name)
  `);
  const totals = new Map(roomTypeCounts.rows.map((r) => [String(r.room_type), Number(r.total_rooms || 0)]));
  const candidateRooms = rooms.filter((room) => Number(totals.get(String(room.name)) || 0) >= 2);
  if (candidateRooms.length === 0) {
    throw new Error('Scenario D requires a room_type with at least 2 physical rooms');
  }

  const d1Start = addDays(baseDate, 15);
  const d1End = addDays(baseDate, 17);
  const d2Start = addDays(baseDate, 16);
  const d2End = addDays(baseDate, 18);
  const neededDates = [d1Start, d2Start, addDays(baseDate, 17)];

  for (const room of candidateRooms) {
    const roomId = Number(room.id);
    const roomType = String(room.name);

    const overlaps = await client.query(`
      SELECT COUNT(*)::int AS total
      FROM reservations
      WHERE room_id = $1
        AND status IN ('BOOKED','CHECKED_IN')
        AND (
          (check_in < $2::date AND check_out > $3::date) OR
          (check_in < $4::date AND check_out > $5::date)
        )
    `, [roomId, d1End, d1Start, d2End, d2Start]);
    if (Number(overlaps.rows[0]?.total || 0) > 0) continue;

    const availability = await client.query(`
      SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key,
             total_rooms,
             reserved_qty
      FROM availability_dates
      WHERE room_type = $1
        AND date = ANY($2::date[])
    `, [roomType, neededDates]);

    const availMap = new Map(availability.rows.map((r) => [String(r.date_key), {
      total: Number(r.total_rooms || 0),
      reserved: Number(r.reserved_qty || 0)
    }]));

    let ok = true;
    for (const dateKey of neededDates) {
      const row = availMap.get(dateKey);
      if (!row) {
        ok = false;
        break;
      }
      const sellable = row.total - row.reserved;
      if (sellable < 2) {
        ok = false;
        break;
      }
    }

    if (ok) return room;
  }

  throw new Error('No safe Scenario D room/date found where capacity cannot mask CHECKED_OUT semantics');
}

async function getAvailabilitySnapshot(client, roomTypes, startDate, endDateExclusive) {
  const result = await client.query(`
    SELECT room_type,
           to_char(date::date, 'YYYY-MM-DD') AS date_key,
           reserved_qty,
           total_rooms
    FROM availability_dates
    WHERE room_type = ANY($1::text[])
      AND date >= $2::date
      AND date < $3::date
    ORDER BY room_type, date
  `, [roomTypes, startDate, endDateExclusive]);

  const snapshot = new Map();
  for (const row of result.rows) {
    const key = `${row.room_type}::${String(row.date_key)}`;
    snapshot.set(key, {
      room_type: row.room_type,
      date: String(row.date_key),
      reserved_qty: Number(row.reserved_qty),
      total_rooms: Number(row.total_rooms)
    });
  }
  return snapshot;
}

async function cleanupRun(client, roomStatusBaseline, availabilityBaseline) {
  await client.query('BEGIN');
  try {
    const trackedIds = Array.from(createdReservationIds.values());

    const runRows = await client.query(
      `SELECT id, booking_id
       FROM reservations
       WHERE guest_name LIKE $1
          OR correlation_id LIKE $2`,
      [`${runId}%`, `${runId}%`]
    );

    const runScopedIds = runRows.rows
      .map((r) => Number(r.id))
      .filter((v) => Number.isFinite(v));

    const reservationIds = Array.from(
      new Set([...trackedIds, ...runScopedIds])
    );

    // Resolve parent bookings BEFORE deleting reservations.
    // Only bookings proven to belong to this test run are eligible.
    const runBookingRows = await client.query(
      `SELECT DISTINCT b.id
       FROM bookings b
       LEFT JOIN reservations r ON r.booking_id = b.id
       WHERE b.correlation_id LIKE $1
          OR b.guest_name_snapshot LIKE $2
          OR r.id = ANY($3::int[])`,
      [`${runId}%`, `${runId}%`, reservationIds]
    );

    const bookingIds = runBookingRows.rows
      .map((r) => Number(r.id))
      .filter((v) => Number.isFinite(v));

    if (bookingIds.length > 0) {
      await client.query(
        `SELECT id
         FROM bookings
         WHERE id = ANY($1::bigint[])
         ORDER BY id
         FOR UPDATE`,
        [bookingIds]
      );
    }

    if (reservationIds.length > 0) {
      await client.query(
        `SELECT id
         FROM reservations
         WHERE id = ANY($1::int[])
         ORDER BY id
         FOR UPDATE`,
        [reservationIds]
      );

      const ownedUnreleasedByKey = new Map();

      for (const reservationId of reservationIds) {
        const record = reservationOwnership.get(Number(reservationId));

        if (!record) {
          throw new Error(
            `Cleanup failed: ownership record missing for reservation ${reservationId}`
          );
        }

        for (const nightKey of record.ownedNights) {
          if (record.releasedNights.has(nightKey)) continue;

          ownedUnreleasedByKey.set(
            nightKey,
            (ownedUnreleasedByKey.get(nightKey) || 0) + 1
          );
        }
      }

      const keys = Array.from(ownedUnreleasedByKey.keys()).sort();

      for (const key of keys) {
        const [roomType, dateKey] = key.split('::');

        if (!roomType || !dateKey) {
          throw new Error(`Cleanup failed: invalid ownership key ${key}`);
        }

        const ownedDelta = Number(ownedUnreleasedByKey.get(key) || 0);

        if (ownedDelta <= 0) continue;

        const baseline = availabilityBaseline.get(key);

        if (!baseline) {
          throw new Error(`Cleanup failed: baseline missing for ${key}`);
        }

        const current = await client.query(
          `SELECT reserved_qty
           FROM availability_dates
           WHERE room_type = $1
             AND date = $2::date
           FOR UPDATE`,
          [roomType, dateKey]
        );

        if (current.rowCount === 0) {
          throw new Error(
            `Cleanup failed: missing availability row ${key}`
          );
        }

        const currentReserved = Number(
          current.rows[0].reserved_qty || 0
        );

        const baselineReserved = Number(
          baseline.reserved_qty || 0
        );

        if (currentReserved < baselineReserved) {
          throw new Error(
            `Cleanup failed: availability below baseline on ${key} ` +
            `(current=${currentReserved}, baseline=${baselineReserved})`
          );
        }

        const excess = currentReserved - baselineReserved;

        if (excess < ownedDelta) {
          throw new Error(
            `Cleanup failed: insufficient excess for owned delta on ${key} ` +
            `(excess=${excess}, owned_delta=${ownedDelta})`
          );
        }

        if (excess > ownedDelta) {
          throw new Error(
            `Cleanup failed: ambiguous excess on ${key} ` +
            `(excess=${excess}, owned_delta=${ownedDelta})`
          );
        }

        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = reserved_qty - $1
           WHERE room_type = $2
             AND date = $3::date`,
          [ownedDelta, roomType, dateKey]
        );
      }

      await client.query(
        'DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])',
        [reservationIds]
      );

      await client.query(
        'DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])',
        [reservationIds]
      );

      await client.query(
        'DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])',
        [reservationIds]
      );

      await client.query(
        'DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])',
        [reservationIds]
      );

      await client.query(`
        DELETE FROM housekeeping_tasks 
        WHERE reservation_id = ANY($1::int[])
           OR (source_type = 'CHECKOUT_EVENT' AND source_entity_id = ANY($2::text[]))
      `, [reservationIds, reservationIds.map(String)]);

      await client.query(
        'DELETE FROM reservations WHERE id = ANY($1::int[])',
        [reservationIds]
      );
    }

    // Delete booking headers only AFTER their child reservations are gone.
    // The correlation/guest prefix guard prevents deletion of unrelated bookings.
    if (bookingIds.length > 0) {
      const deletedBookings = await client.query(
        `DELETE FROM bookings b
         WHERE b.id = ANY($1::bigint[])
           AND (
             b.correlation_id LIKE $2
             OR b.guest_name_snapshot LIKE $3
           )
           AND NOT EXISTS (
             SELECT 1
             FROM reservations r
             WHERE r.booking_id = b.id
           )
         RETURNING b.id`,
        [
          bookingIds,
          `${runId}%`,
          `${runId}%`
        ]
      );

      if (deletedBookings.rowCount !== bookingIds.length) {
        const deletedIds = new Set(
          deletedBookings.rows.map((r) => Number(r.id))
        );

        const notDeleted = bookingIds.filter(
          (id) => !deletedIds.has(Number(id))
        );

        throw new Error(
          `Cleanup failed: not all run-owned bookings were safely deleted; ` +
          `remaining booking ids=${notDeleted.join(',')}`
        );
      }
    }

    for (const [roomId, status] of roomStatusBaseline.entries()) {
      await client.query(
        'UPDATE rooms SET status = $1 WHERE id = $2',
        [status, roomId]
      );
    }

    await client.query(
      `DELETE FROM audit_logs
       WHERE correlation_id LIKE $1`,
      [`${runId}%`]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function verifyPostCleanup(client, baseline, roomStatusBaseline, availabilityBaseline) {
  const afterCounts = await getBaselineCounts(client);
  expect(afterCounts.overlapCount === baseline.overlapCount, `Overlap baseline mismatch after cleanup (${afterCounts.overlapCount} vs ${baseline.overlapCount})`);
  expect(afterCounts.invalidActiveCount === baseline.invalidActiveCount, `Invalid-active baseline mismatch after cleanup (${afterCounts.invalidActiveCount} vs ${baseline.invalidActiveCount})`);
  expect(afterCounts.inventoryViolationCount === baseline.inventoryViolationCount, `Inventory-violation baseline mismatch after cleanup (${afterCounts.inventoryViolationCount} vs ${baseline.inventoryViolationCount})`);

  const residue = await client.query(
    `SELECT COUNT(*) AS total
     FROM reservations
     WHERE guest_name LIKE $1 OR correlation_id LIKE $2`,
    [`%${runId}%`, `${runId}%`]
  );
  expect(Number(residue.rows[0]?.total || 0) === 0, `Cleanup residue remains for runId ${runId}`);
  const bookingResidue = await client.query(
  `SELECT COUNT(*) AS total
   FROM bookings
   WHERE correlation_id LIKE $1
      OR guest_name_snapshot LIKE $2`,
  [`${runId}%`, `${runId}%`]
);

expect(
  Number(bookingResidue.rows[0]?.total || 0) === 0,
  `Cleanup booking residue remains for runId ${runId}`
);

  if (availabilityBaseline.size > 0) {
    const keys = Array.from(availabilityBaseline.values());
    const roomTypes = [...new Set(keys.map((k) => k.room_type))];
    const minDate = keys.map((k) => k.date).sort()[0];
    const maxDate = addDays(keys.map((k) => k.date).sort().slice(-1)[0], 1);
    const afterAvailability = await getAvailabilitySnapshot(client, roomTypes, minDate, maxDate);

    for (const [key, base] of availabilityBaseline.entries()) {
      const now = afterAvailability.get(key);
      if (!now) throw new Error(`Missing post-cleanup availability row ${key}`);
      if (Number(now.reserved_qty) !== Number(base.reserved_qty)) {
        throw new Error(`Availability mismatch for ${key}: ${now.reserved_qty} vs ${base.reserved_qty}`);
      }
      if (Number(now.total_rooms) !== Number(base.total_rooms)) {
        throw new Error(`Availability total_rooms mismatch for ${key}: ${now.total_rooms} vs ${base.total_rooms}`);
      }
    }
  }

  if (roomStatusBaseline.size > 0) {
    const roomIds = Array.from(roomStatusBaseline.keys());
    const rows = await client.query('SELECT id, status FROM rooms WHERE id = ANY($1::int[])', [roomIds]);
    const current = new Map(rows.rows.map((r) => [Number(r.id), String(r.status)]));
    for (const [roomId, status] of roomStatusBaseline.entries()) {
      const currentStatus = current.get(Number(roomId));
      if (currentStatus !== status) {
        throw new Error(`Room status mismatch after cleanup for room ${roomId}: ${currentStatus} vs ${status}`);
      }
    }
  }
}

async function run() {
  const client = await pool.connect();
  let baseline = null;
  let roomStatusBaseline = new Map();
  let availabilityBaseline = new Map();

  let scenarioFailure = null;
  try {
    await client.query('BEGIN');
    try {
      await createOverlapFixture(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const rooms = await getRooms();
    for (const room of rooms) {
      roomTypeById.set(Number(room.id), String(room.name || ''));
      roomPropertyById.set(Number(room.id), Number(room.property_id));
    }
    const roomA = rooms[0];
    const roomB = rooms[1];
    usedRoomIds.add(Number(roomA.id));
    usedRoomIds.add(Number(roomB.id));

    const baseDate = await findSafeBaseDate(client, Number(roomA.id), Number(roomB.id), String(roomA.name), String(roomB.name));
    const day = (offset) => addDays(baseDate, offset);
    const scenarioDRoom = await selectScenarioDRoom(client, rooms, baseDate);
    usedRoomIds.add(Number(scenarioDRoom.id));

    baseline = await getBaselineCounts(client);

    const baselineRoomIds = Array.from(new Set([Number(roomA.id), Number(roomB.id), Number(scenarioDRoom.id)]));
    const roomStatusRows = await client.query('SELECT id, status FROM rooms WHERE id = ANY($1::int[])', [baselineRoomIds]);
    roomStatusBaseline = new Map(roomStatusRows.rows.map((r) => [Number(r.id), String(r.status)]));

    const availabilityStart = day(0);
    const availabilityEnd = day(48);
    const baselineRoomTypes = [...new Set([String(roomA.name), String(roomB.name), String(scenarioDRoom.name)])];
    availabilityBaseline = await getAvailabilitySnapshot(client, baselineRoomTypes, availabilityStart, availabilityEnd);

    // A. overlapping create -> 409
    {
      const first = await createReservation(roomA.id, day(0), day(2), 'A1');
      expect(first.status === 201, `A1 create failed: ${first.status} ${first.text}`);
      const overlap = await createReservation(roomA.id, day(1), day(3), 'A2');
      expect(overlap.status === 409, `A2 overlap must fail 409, got ${overlap.status}, payload=${overlap.text}`);
      expect(overlap.json?.code === 'ROOM_OVERLAP', 'A2 overlap payload code must be ROOM_OVERLAP');
      markScenario('A', true);
    }

    // B. adjacent create -> success
    {
      const first = await createReservation(roomA.id, day(5), day(6), 'B1');
      expect(first.status === 201, `B1 create failed: ${first.status} ${first.text}`);
      const adjacent = await createReservation(roomA.id, day(6), day(7), 'B2');
      expect(adjacent.status === 201, `B2 adjacent must succeed, got ${adjacent.status}`);
      markScenario('B', true);
    }

    // C. overlap with CANCELLED -> success
    {
      const base = await createReservation(roomA.id, day(10), day(12), 'C1');
      expect(base.status === 201, `C1 create failed: ${base.status} ${base.text}`);
      const cancel = await request('POST', `/api/reservations/${base.json?.data?.id}/cancel`, { property_id: roomA.property_id }, 'C1-cancel');
      expect(cancel.status === 200, `C1 cancel failed: ${cancel.status} ${cancel.text}`);
      trackCancellationRelease(base.json?.data?.id);
      const overlapCancelled = await createReservation(roomA.id, day(11), day(13), 'C2');
      expect(overlapCancelled.status === 201, `C2 must succeed over CANCELLED, got ${overlapCancelled.status}`);
      markScenario('C', true);
    }

    // D. overlap with CHECKED_OUT -> success
    {
      await establishSellableRoomStatus(client, scenarioDRoom.id);
      const base = await createReservation(scenarioDRoom.id, day(15), day(17), 'D1');
      expect(base.status === 201, `D1 create failed: ${base.status} ${base.text}`);
      const checkout = await request('POST', `/api/reservations/${base.json?.data?.id}/checkout`, { property_id: scenarioDRoom.property_id, skip_inspection: true }, 'D1-checkout');
      expect(checkout.status === 200, `D1 checkout failed: ${checkout.status} ${checkout.text}`);
      trackCheckoutRelease(base.json?.data?.id);
      await establishSellableRoomStatus(client, scenarioDRoom.id);
      const overlapCheckedOut = await createReservation(scenarioDRoom.id, day(16), day(18), 'D2');
      expect(overlapCheckedOut.status === 201, `D2 must succeed over CHECKED_OUT, got ${overlapCheckedOut.status}`);
      markScenario('D', true);
    }

    // E. overlap with CHECKED_IN -> 409
    {
      const base = await createReservation(roomA.id, day(20), day(22), 'E1');
      expect(base.status === 201, `E1 create failed: ${base.status} ${base.text}`);
      const checkin = await request('POST', `/api/reservations/${base.json?.data?.id}/checkin`, { property_id: roomA.property_id, force: true, override_guest_identity: true, override_housekeeping: true }, 'E1-checkin');
      expect(checkin.status === 200, `E1 checkin failed: ${checkin.status} ${checkin.text}`);
      const overlapCheckedIn = await createReservation(roomA.id, day(21), day(23), 'E2');
      expect(overlapCheckedIn.status === 409, `E2 must fail over CHECKED_IN, got ${overlapCheckedIn.status}`);
      markScenario('E', true);
    }

    // F. move into occupied room -> 409
    {
      await establishSellableRoomStatus(client, roomA.id);
      const occupied = await createReservation(roomB.id, day(25), day(27), 'F1');
      expect(occupied.status === 201, `F1 occupied create failed: ${occupied.status} ${occupied.text}`);
      const movable = await createReservation(roomA.id, day(25), day(27), 'F2');
      expect(movable.status === 201, `F2 movable create failed: ${movable.status} ${movable.text}`);
      const move = await request('POST', `/api/reservations/${movable.json?.data?.id}/move`, { property_id: roomA.property_id, to_room_id: roomB.id }, 'F2-move');
      expect(move.status === 409, `F move must fail 409, got ${move.status}`);
      if (move.status === 200) {
        trackMoveTransfer(movable.json?.data?.id, roomB.id);
      }
      markScenario('F', true);
    }

    // G. PATCH room/date into overlap -> 409
    {
      await establishSellableRoomStatus(client, roomA.id);
      const occupied = await createReservation(roomB.id, day(30), day(32), 'G1');
      expect(occupied.status === 201, `G1 occupied create failed: ${occupied.status} ${occupied.text}`);
      const patchable = await createReservation(roomA.id, day(33), day(34), 'G2');
      expect(patchable.status === 201, `G2 patchable create failed: ${patchable.status} ${patchable.text}`);
      const patchOverlap = await request('PATCH', `/api/reservations/${patchable.json?.data?.id}`, {
        property_id: roomA.property_id,
        room_id: roomB.id,
        check_in: day(31),
        check_out: day(33),
        status: 'BOOKED'
      }, 'G2-patch');
      expect(patchOverlap.status === 409, `G patch overlap must fail 409, got ${patchOverlap.status}`);
      markScenario('G', true);
    }

    // H. check-in overlap -> 409
    {
      await establishSellableRoomStatus(client, roomA.id);
      const occupied = await createReservation(roomA.id, day(35), day(37), 'H1');
      expect(occupied.status === 201, `H1 occupied create failed: ${occupied.status} ${occupied.text}`);
      const checkinOccupied = await request('POST', `/api/reservations/${occupied.json?.data?.id}/checkin`, { property_id: roomA.property_id, force: true, override_guest_identity: true, override_housekeeping: true }, 'H1-checkin');
      expect(checkinOccupied.status === 200, `H1 checkin failed: ${checkinOccupied.status} ${checkinOccupied.text}`);

      const candidate = await createReservation(roomB.id, day(35), day(37), 'H2');
      expect(candidate.status === 201, `H2 candidate create failed: ${candidate.status} ${candidate.text}`);
      const setCancelled = await request('POST', `/api/reservations/${candidate.json?.data?.id}/cancel`, { property_id: roomB.property_id }, 'H2-cancel');
      expect(setCancelled.status === 200, `H2 cancel setup failed: ${setCancelled.status} ${setCancelled.text}`);
      trackCancellationRelease(candidate.json?.data?.id);
      const checkinCandidate = await request('POST', `/api/reservations/${candidate.json?.data?.id}/checkin`, { property_id: roomB.property_id, force: true, override_guest_identity: true, override_housekeeping: true }, 'H2-checkin');
      expect(checkinCandidate.status === 409, `H checkin overlap must fail 409, got ${checkinCandidate.status}`);
      markScenario('H', true);
    }

    // I. rollback preserves inventory
    {
      await establishSellableRoomStatus(client, roomA.id);
      const base = await createReservation(roomA.id, day(40), day(42), 'I1');
      expect(base.status === 201, `I1 base create failed: ${base.status} ${base.text}`);
      const before = await client.query(
        `SELECT reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2::date`,
        [String(roomA.name), day(40)]
      );
      expect(before.rowCount === 1, 'I1 missing baseline availability row');
      const beforeQty = Number(before.rows[0].reserved_qty || 0);
      const overlap = await createReservation(roomA.id, day(41), day(43), 'I2');
      expect(overlap.status === 409, `I2 overlap must fail 409, got ${overlap.status}`);
      const after = await client.query(
        `SELECT reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2::date`,
        [String(roomA.name), day(40)]
      );
      expect(after.rowCount === 1, 'I1 missing post-overlap availability row');
      const afterQty = Number(after.rows[0].reserved_qty || 0);
      expect(beforeQty === afterQty, `I reserved_qty changed on failed overlap (before=${beforeQty}, after=${afterQty})`);
      markScenario('I', true);
    }

    // J. concurrency readiness
    {
      const attempts = 8;
      const requests = Array.from({ length: attempts }).map((_, i) => (
        createReservation(roomB.id, day(45), day(47), `J${i + 1}`)
      ));
      const results = await Promise.all(requests);
      const success = results.filter((r) => r.status >= 200 && r.status < 300).length;
      const conflict = results.filter((r) => r.status === 409).length;
      const unexpected = results.filter((r) => r.status < 200 || (r.status >= 300 && r.status !== 409));
      expect(unexpected.length === 0, `J unexpected responses present: ${unexpected.map((r) => r.status).join(',')}`);
      expect(success + conflict === attempts, `J inconsistent totals success(${success}) + conflict(${conflict}) != ${attempts}`);
      markScenario('J', true, `success=${success}, conflict=${conflict}, total=${attempts}`);
    }
  } catch (err) {
    scenarioFailure = err;
    for (const key of ['A','B','C','D','E','F','G','H','I','J']) {
      if (!scenarioResults[key]) {
        markScenario(key, false, key === 'A' ? String(err.message || err) : 'Not executed due to earlier failure');
      }
    }
  } finally {
    let cleanupError = null;
    try {
      await cleanupRun(client, roomStatusBaseline, availabilityBaseline);
      if (baseline) {
        await verifyPostCleanup(client, baseline, roomStatusBaseline, availabilityBaseline);
      }
    } catch (err) {
      cleanupError = err;
    }
    try {
      await cleanupFixture(client);
    } catch (err) {
      cleanupError = cleanupError || err;
    } finally {
      client.release();
      await pool.end();
    }
    if (cleanupError) throw cleanupError;
  }

  if (scenarioFailure) {
    throw scenarioFailure;
  }

  console.log('Run ID:', runId);
  console.log('Scenario results:', JSON.stringify(scenarioResults, null, 2));
  console.log('Room overlap backend tests passed with cleanup verification.');
}

run().catch((err) => {
  console.error('Room overlap backend tests failed:', err.message || err);
  console.error('Run ID:', runId);
  console.error('Scenario results snapshot:', JSON.stringify(scenarioResults, null, 2));
  process.exitCode = 1;
});
