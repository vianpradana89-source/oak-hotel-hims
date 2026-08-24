BEGIN;

-- =========================================================
-- PHASE 1C.2B GUARDED DATA REPAIR
-- =========================================================

-- 1. Lock exact repair targets
SELECT id
FROM reservations
WHERE id IN (
    2,3,9,
    16,17,
    85,87,88,90,91,92,93,95,96,98,99,101
)
ORDER BY id
FOR UPDATE;

-- Lock retained rows that must remain unchanged
SELECT id
FROM reservations
WHERE id IN (10,11,12,13)
ORDER BY id
FOR UPDATE;


-- =========================================================
-- 2. Snapshot true pre-update state
-- =========================================================

CREATE TEMP TABLE repair_snapshot
ON COMMIT DROP
AS
SELECT
    r.id,
    r.booking_number,
    r.room_id,
    r.status AS old_status,
    r.stay_status AS old_stay_status,
    r.check_in,
    r.check_out,
    rm.room_number,
    rt.name AS room_type,
    CASE
        WHEN r.id IN (2,3,9)
            THEN 'LEGACY_INVALID_DATE_REPAIR'
        WHEN r.id IN (16,17)
            THEN 'DUPLICATE_DEMO_RESERVATION_REPAIR'
        WHEN r.id IN (85,87,88,90,91,92,93,95,96,98,99,101)
            THEN 'PHASE_1C_TEST_DATA_CLEANUP'
    END AS repair_reason
FROM reservations r
LEFT JOIN rooms rm
    ON rm.id = r.room_id
LEFT JOIN room_types rt
    ON rt.id = rm.room_type_id
WHERE r.id IN (
    2,3,9,
    16,17,
    85,87,88,90,91,92,93,95,96,98,99,101
);


CREATE TEMP TABLE retained_before
ON COMMIT DROP
AS
SELECT
    id,
    booking_number,
    room_id,
    status,
    stay_status,
    check_in,
    check_out
FROM reservations
WHERE id IN (10,11,12,13);


-- =========================================================
-- 3. Preconditions
-- =========================================================

DO $$
DECLARE
    v_snapshot_count integer;
    v_booked_count integer;
    v_retained_count integer;
    v_existing_audit integer;
BEGIN
    SELECT COUNT(*)
    INTO v_snapshot_count
    FROM repair_snapshot;

    IF v_snapshot_count <> 17 THEN
        RAISE EXCEPTION
            'repair_snapshot count mismatch: %',
            v_snapshot_count;
    END IF;

    SELECT COUNT(*)
    INTO v_booked_count
    FROM repair_snapshot
    WHERE old_status = 'BOOKED';

    IF v_booked_count <> 17 THEN
        RAISE EXCEPTION
            'not all 17 repair targets are BOOKED: %',
            v_booked_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repair_snapshot
        WHERE repair_reason IS NULL
    ) THEN
        RAISE EXCEPTION
            'repair classification missing';
    END IF;

    SELECT COUNT(*)
    INTO v_retained_count
    FROM retained_before;

    IF v_retained_count <> 4 THEN
        RAISE EXCEPTION
            'retained row count mismatch: %',
            v_retained_count;
    END IF;

    SELECT COUNT(*)
    INTO v_existing_audit
    FROM audit_logs
    WHERE correlation_id =
        'PHASE_1C2B_LEGACY_REPAIR-20260821';

    IF v_existing_audit <> 0 THEN
        RAISE EXCEPTION
            'repair correlation id already exists: %',
            v_existing_audit;
    END IF;

    IF (
        SELECT COUNT(*)
        FROM repair_snapshot
        WHERE id IN (2,3,9)
          AND old_status = 'BOOKED'
          AND check_in IS NOT NULL
          AND check_out IS NOT NULL
          AND check_out <= check_in
    ) <> 3 THEN
        RAISE EXCEPTION
            'invalid legacy precondition mismatch';
    END IF;
END
$$;


-- =========================================================
-- 4. Per-reservation inventory release plan
-- =========================================================

CREATE TEMP TABLE repair_release_by_reservation
ON COMMIT DROP
AS
SELECT
    s.id AS reservation_id,
    s.booking_number,
    s.room_type,
    s.room_number,
    gs.release_date::date AS release_date,
    1::integer AS release_qty,
    s.repair_reason
FROM repair_snapshot s
CROSS JOIN LATERAL generate_series(
    s.check_in::timestamp,
    (s.check_out - 1)::timestamp,
    INTERVAL '1 day'
) AS gs(release_date)
WHERE s.old_status = 'BOOKED'
  AND s.check_in IS NOT NULL
  AND s.check_out IS NOT NULL
  AND s.check_out > s.check_in;


DO $$
BEGIN
    IF EXISTS (
        WITH expected(reservation_id, expected_nights) AS (
            VALUES
                (2,0),
                (3,0),
                (9,0),
                (16,5),
                (17,5),
                (85,2),
                (87,2),
                (88,1),
                (90,1),
                (91,1),
                (92,2),
                (93,2),
                (95,2),
                (96,1),
                (98,1),
                (99,1),
                (101,2)
        ),
        actual AS (
            SELECT
                s.id AS reservation_id,
                COALESCE(SUM(rr.release_qty),0)::integer AS actual_nights
            FROM repair_snapshot s
            LEFT JOIN repair_release_by_reservation rr
                ON rr.reservation_id = s.id
            GROUP BY s.id
        )
        SELECT 1
        FROM expected e
        JOIN actual a
            ON a.reservation_id = e.reservation_id
        WHERE a.actual_nights <> e.expected_nights
    ) THEN
        RAISE EXCEPTION
            'per-reservation release plan mismatch';
    END IF;

    IF (
        SELECT COALESCE(SUM(release_qty),0)
        FROM repair_release_by_reservation
    ) <> 28 THEN
        RAISE EXCEPTION
            'total release quantity must equal 28';
    END IF;
END
$$;


-- =========================================================
-- 5. Aggregate inventory release plan
-- =========================================================

CREATE TEMP TABLE repair_release_aggregate
ON COMMIT DROP
AS
SELECT
    room_type,
    release_date,
    SUM(release_qty)::integer AS release_qty
FROM repair_release_by_reservation
GROUP BY room_type, release_date;


-- Lock only exact ledger rows that will be changed
SELECT ad.id
FROM availability_dates ad
JOIN repair_release_aggregate ra
    ON ra.room_type = ad.room_type
   AND ra.release_date = ad.date
ORDER BY ad.room_type, ad.date
FOR UPDATE OF ad;


-- =========================================================
-- 6. Validate inventory after locks are held
-- =========================================================

DO $$
DECLARE
    v_plan_count integer;
    v_match_count integer;
BEGIN
    SELECT COUNT(*)
    INTO v_plan_count
    FROM repair_release_aggregate;

    SELECT COUNT(*)
    INTO v_match_count
    FROM availability_dates ad
    JOIN repair_release_aggregate ra
        ON ra.room_type = ad.room_type
       AND ra.release_date = ad.date;

    IF v_plan_count <> v_match_count THEN
        RAISE EXCEPTION
            'availability plan mismatch: % vs %',
            v_plan_count,
            v_match_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repair_release_aggregate ra
        JOIN availability_dates ad
            ON ad.room_type = ra.room_type
           AND ad.date = ra.release_date
        WHERE ad.reserved_qty < ra.release_qty
    ) THEN
        RAISE EXCEPTION
            'inventory ownership not proven';
    END IF;
END
$$;


-- =========================================================
-- 7. Exact inventory subtraction
-- =========================================================

CREATE TEMP TABLE repair_inventory_updated
ON COMMIT DROP
AS
WITH changed AS (
    UPDATE availability_dates ad
    SET reserved_qty = ad.reserved_qty - ra.release_qty
    FROM repair_release_aggregate ra
    WHERE ad.room_type = ra.room_type
      AND ad.date = ra.release_date
    RETURNING
        ad.id,
        ad.room_type,
        ad.date,
        ad.reserved_qty
)
SELECT *
FROM changed;


DO $$
DECLARE
    v_expected integer;
    v_actual integer;
BEGIN
    SELECT COUNT(*)
    INTO v_expected
    FROM repair_release_aggregate;

    SELECT COUNT(*)
    INTO v_actual
    FROM repair_inventory_updated;

    IF v_expected <> v_actual THEN
        RAISE EXCEPTION
            'inventory update row count mismatch: % vs %',
            v_expected,
            v_actual;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repair_inventory_updated
        WHERE reserved_qty < 0
    ) THEN
        RAISE EXCEPTION
            'negative inventory produced';
    END IF;
END
$$;


-- =========================================================
-- 8. Reservation lifecycle transition
-- Persist ACTUAL UPDATE RETURNING rows
-- =========================================================

CREATE TEMP TABLE repair_updated
ON COMMIT DROP
AS
WITH changed AS (
    UPDATE reservations r
    SET
        status = 'CANCELLED',
        stay_status = 'CANCELLED'
    FROM repair_snapshot s
    WHERE r.id = s.id
      AND s.old_status = 'BOOKED'
      AND r.status = 'BOOKED'
    RETURNING
        r.id,
        r.room_id,
        r.booking_number AS new_booking_number,
        r.status AS new_status,
        r.stay_status AS new_stay_status
)
SELECT
    c.id,
    c.room_id,
    c.new_booking_number,
    c.new_status,
    c.new_stay_status,
    s.booking_number AS old_booking_number,
    s.old_status,
    s.old_stay_status,
    s.check_in AS old_check_in,
    s.check_out AS old_check_out,
    s.room_number,
    s.room_type,
    s.repair_reason
FROM changed c
JOIN repair_snapshot s
    ON s.id = c.id;


-- =========================================================
-- 9. Exact transition assertions
-- =========================================================

DO $$
DECLARE
    v_updated_count integer;
    v_invalid_legacy integer;
    v_duplicate_demo integer;
    v_phase1c_test integer;
BEGIN
    SELECT COUNT(*)
    INTO v_updated_count
    FROM repair_updated;

    IF v_updated_count <> 17 THEN
        RAISE EXCEPTION
            'repair_updated count mismatch: %',
            v_updated_count;
    END IF;

    SELECT
        COUNT(*) FILTER (
            WHERE repair_reason = 'LEGACY_INVALID_DATE_REPAIR'
        ),
        COUNT(*) FILTER (
            WHERE repair_reason = 'DUPLICATE_DEMO_RESERVATION_REPAIR'
        ),
        COUNT(*) FILTER (
            WHERE repair_reason = 'PHASE_1C_TEST_DATA_CLEANUP'
        )
    INTO
        v_invalid_legacy,
        v_duplicate_demo,
        v_phase1c_test
    FROM repair_updated;

    IF v_invalid_legacy <> 3 THEN
        RAISE EXCEPTION
            'invalid legacy transition mismatch: %',
            v_invalid_legacy;
    END IF;

    IF v_duplicate_demo <> 2 THEN
        RAISE EXCEPTION
            'duplicate demo transition mismatch: %',
            v_duplicate_demo;
    END IF;

    IF v_phase1c_test <> 12 THEN
        RAISE EXCEPTION
            'Phase 1C transition mismatch: %',
            v_phase1c_test;
    END IF;

    IF v_invalid_legacy
       + v_duplicate_demo
       + v_phase1c_test <> 17 THEN
        RAISE EXCEPTION
            'total transition count mismatch';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repair_updated
        WHERE new_status <> 'CANCELLED'
           OR new_stay_status <> 'CANCELLED'
    ) THEN
        RAISE EXCEPTION
            'unexpected repaired lifecycle state';
    END IF;
END
$$;


-- =========================================================
-- 10. Permanent DATA_REPAIR audit
-- =========================================================

INSERT INTO audit_logs (
    module,
    action,
    entity,
    record_id,
    new_value,
    correlation_id,
    timestamp
)
SELECT
    'PMS',
    'DATA_REPAIR',
    'RESERVATION',
    u.id::varchar,
    jsonb_build_object(
        'reservation_id', u.id,
        'old_status', u.old_status,
        'old_stay_status', u.old_stay_status,
        'old_check_in', u.old_check_in,
        'old_check_out', u.old_check_out,
        'old_booking_number', u.old_booking_number,
        'new_status', u.new_status,
        'new_stay_status', u.new_stay_status,
        'repair_reason', u.repair_reason,
        'released_nights', COALESCE(SUM(rr.release_qty),0),
        'room_number', u.room_number,
        'room_type', u.room_type
    )::text,
    'PHASE_1C2B_LEGACY_REPAIR-20260821',
    NOW()
FROM repair_updated u
LEFT JOIN repair_release_by_reservation rr
    ON rr.reservation_id = u.id
GROUP BY
    u.id,
    u.old_booking_number,
    u.old_status,
    u.old_stay_status,
    u.old_check_in,
    u.old_check_out,
    u.new_status,
    u.new_stay_status,
    u.repair_reason,
    u.room_number,
    u.room_type;


DO $$
DECLARE
    v_audit_count integer;
BEGIN
    SELECT COUNT(*)
    INTO v_audit_count
    FROM audit_logs
    WHERE correlation_id =
        'PHASE_1C2B_LEGACY_REPAIR-20260821';

    IF v_audit_count <> 17 THEN
        RAISE EXCEPTION
            'audit row count mismatch: %',
            v_audit_count;
    END IF;
END
$$;


-- =========================================================
-- 11. Retained rows must remain unchanged
-- =========================================================

DO $$
DECLARE
    v_drift integer;
BEGIN
    SELECT COUNT(*)
    INTO v_drift
    FROM retained_before b
    JOIN reservations a
        ON a.id = b.id
    WHERE
        a.booking_number IS DISTINCT FROM b.booking_number
        OR a.room_id IS DISTINCT FROM b.room_id
        OR a.status IS DISTINCT FROM b.status
        OR a.stay_status IS DISTINCT FROM b.stay_status
        OR a.check_in IS DISTINCT FROM b.check_in
        OR a.check_out IS DISTINCT FROM b.check_out;

    IF v_drift <> 0 THEN
        RAISE EXCEPTION
            'retained reservation drift detected: %',
            v_drift;
    END IF;
END
$$;


-- =========================================================
-- 12. Final invariants
-- =========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM reservations a
        JOIN reservations b
          ON a.id < b.id
         AND a.room_id = b.room_id
         AND a.status IN ('BOOKED','CHECKED_IN')
         AND b.status IN ('BOOKED','CHECKED_IN')
         AND a.check_in < b.check_out
         AND a.check_out > b.check_in
    ) THEN
        RAISE EXCEPTION
            'active physical-room overlap remains';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM reservations
        WHERE status IN ('BOOKED','CHECKED_IN')
          AND (
              check_in IS NULL
              OR check_out IS NULL
              OR check_out <= check_in
          )
    ) THEN
        RAISE EXCEPTION
            'invalid active reservation remains';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM availability_dates
        WHERE reserved_qty < 0
    ) THEN
        RAISE EXCEPTION
            'negative reserved_qty exists';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM availability_dates
        WHERE reserved_qty > total_rooms
    ) THEN
        RAISE EXCEPTION
            'reserved_qty exceeds total_rooms';
    END IF;
END
$$;

COMMIT;