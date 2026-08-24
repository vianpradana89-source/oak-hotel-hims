# Fix: Timezone-Aware Availability Date Queries

## Problem
The multi-room booking composer was showing "no available rooms" for dates where the tape chart displayed ready inventory. The root cause was a **timezone mismatch** in how dates were being compared.

### Root Cause Analysis
The database stores availability dates as UTC timestamps with timezone offset (e.g., `2026-08-22T17:00:00.000Z`), which represent local dates in Asia/Jakarta timezone (UTC+7):
- `2026-08-22T17:00:00.000Z` in UTC = `2026-08-23 00:00:00` in Asia/Jakarta (UTC+7)

The backend queries were comparing these timestamps directly with local dates without timezone conversion:
```sql
WHERE date >= '2026-08-23'::date AND date < '2026-08-24'::date
```

This caused the comparison to fail because:
- The timestamp `2026-08-22T17:00:00.000Z` casts to date `2026-08-22` (in UTC)
- The query `2026-08-22 >= 2026-08-23` returns FALSE
- No rows are returned, and the UI shows "no available rooms"

## Solution
Added timezone-aware date conversion to both availability query endpoints using PostgreSQL's `AT TIME ZONE` clause:
```sql
WHERE (date AT TIME ZONE 'Asia/Jakarta')::date >= $1::date 
  AND (date AT TIME ZONE 'Asia/Jakarta')::date < $2::date
```

This correctly converts the UTC timestamp to local date before comparison:
- `2026-08-22T17:00:00.000Z AT TIME ZONE 'Asia/Jakarta'` = `2026-08-23 00:00:00+07:00` = date `2026-08-23`
- The query `2026-08-23 >= 2026-08-23` returns TRUE ✓
- Correct rows are returned

## Changes Made
1. **`backend/src/index.ts` (Line 2040)**: Fixed `/api/availability` endpoint query
   - Added timezone conversion to date comparisons
   - Ensures availability query returns correct data based on local dates

2. **`backend/src/index.ts` (Line 3245)**: Fixed `/api/tapechart` endpoint query  
   - Added timezone conversion to date comparisons
   - Ensures tape chart uses same date logic as availability endpoint

## Testing
The fix was validated with:
1. ✓ Direct database queries showing correct timezone conversion
2. ✓ End-to-end test confirming API behavior for both available and booked dates
3. ✓ Frontend builds successfully with the changes
4. ✓ Backend compiles without TypeScript errors

## Impact
- **Availability Queries**: Now correctly return availability data based on local dates
- **UI Behavior**: Multi-room booking composer correctly shows available/unavailable rooms
- **Tape Chart**: Consistent date handling across all endpoints
- **No Breaking Changes**: Existing bookings and reservations unaffected

## Verification
After this fix, the availability queries work as follows:
- Requesting `start=2026-08-24&end=2026-08-25` correctly returns inventory for that local date
- The multi-room composer can now properly filter available rooms
- Dates align between UI date picker (local) and database storage (UTC with offset)
