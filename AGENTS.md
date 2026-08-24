# OAK HIMS — Project Rules

OAK Hotel Integrated Management System (HIMS/PMS). Backend: Express + pg (`backend/`), frontend: React + Vite (`frontend/`). PostgreSQL database `oak_hotel_db`.

Architectural principle:

```
ONE HOTEL / PROPERTY
→ ONE SOURCE OF TRUTH PER DOMAIN
→ ONE TRANSACTION FLOW
→ ONE AUDIT TRAIL
```

The architecture must remain capable of evolving toward multi-property without contaminating current single-property operational flows.

## 1. Database & Migration Safety

- PostgreSQL is authoritative persistent storage.
- Schema changes must be additive and idempotent whenever possible.
- Never DROP/TRUNCATE production-like data without explicit user approval.
- Never silently delete reservations, bookings, guests, payments, folios, inventory, or audit records.
- Never read, print, expose, stage, or commit secrets from `backend/.env`.
- `.env.example` may contain placeholders only.
- Backup/database dump files must never be committed.
- Before destructive repair, classify affected rows and report uncertain records instead of deleting them.
- Operational repair scripts must be guarded and preferably idempotent.

## 2. Room Master / Inventory Identity

- Canonical room-type identity is `room_type_id`.
- Display names such as `Deluxe King`, `Standard King`, `Deluxe Twin` are labels, NOT authoritative relational identity.
- Legacy name-based rows may be supported only through explicit compatibility/dual-read logic.
- Physical rooms and room types are separate entities.
- Never recreate loose name matching as the primary relationship.

## 3. Reservation Date Semantics

- All stay/inventory calculations use `[check_in, check_out)`.
- Check-in date is occupied. Checkout date is NOT an occupied night.
- Never introduce inclusive checkout inventory logic.
- Timezone-sensitive hotel dates must preserve the established Asia/Jakarta semantics.

## 4. Booking Authority

Frontend availability is advisory UX only. Backend remains final authority for:

- room sellability
- capacity
- overlap
- booking creation
- reservation creation
- room assignment
- check-in
- checkout
- cancellation
- inventory release

Never move authoritative protection exclusively to frontend code.

## 5. Inventory Invariants

After relevant changes/tests, verify:

- inventory drift = 0 (`reserved_qty` equals active BOOKED/CHECKED_IN nights per room type per hotel date)
- count of `reserved_qty < 0` = 0
- count of `reserved_qty > total_rooms` = 0

Checkout releases inventory according to the current authoritative RM-1B lifecycle. Never hide an inventory error by clamping values without diagnosing its source.

## 6. Room State Domains

Do not casually collapse these concepts:

- Occupancy/reservation state: `BOOKED`, `CHECKED_IN`, `CHECKED_OUT`
- Housekeeping state: `VACANT_CLEAN`, `VACANT_DIRTY`, `OCCUPIED_CLEAN`
- Maintenance/inventory blocking state: `OUT_OF_ORDER`, `OUT_OF_SERVICE`

UI may summarize them, but backend sources of truth must remain explicit.

## 7. Testing Standard

Never weaken an assertion merely to obtain PASS.

Integration tests must:

- use uniquely identifiable fixtures
- isolate required room state
- preserve `[check_in, check_out)`
- clean their own bookings/reservations/locks
- restore changed room status
- reconcile their own inventory
- use try/finally where appropriate
- leave zero session residue after success OR failure

A failing regression must be diagnosed as product regression, pre-existing defect, fixture defect, or environment/data issue before production logic is changed.

## 8. Regression Gate

For changes affecting booking/reservation/room inventory, run the relevant existing suites. Current important suites (run from `backend/`):

- `npm run test:booking-create`
- `npm run test:reservation-create-compat`
- `npm run test:room-overlap`
- `npm run test:reservation-stay-dates`
- `npm run test:reservation-patch-hardening`
- `npm run test:booking-completion`
- `npm run test:booking-invariants`
- availability regression: `node test/availability_regression_test.js`
- `npm run test:rm1b-canonical-identity`

Backend build (`tsc`) and frontend build (`tsc -b && vite build`) must pass before GO.

## 9. Coding / Modularity

- Avoid making `frontend/src/App.tsx` and `backend/src/index.ts` indefinitely larger.
- For substantial new domains/features, prefer extracting:
  - routes/controllers
  - services
  - repositories/data access
  - domain helpers
  - React components, hooks, API clients, types
- Do not perform broad refactors during an unrelated bug fix.
- Bug fixes should first make the smallest safe root-cause correction.
- Refactoring must be deliberate and separately validated.

## 10. Frontend UX Principles

OAK HIMS is operational hotel software. Prioritize:

- speed for receptionist/front office
- low click count
- clear status
- stable UI during async operations
- keyboard-friendly workflows where practical
- no unnecessary reload/flicker
- predictable modal behavior

For editable operational detail, default preference is:

```
VIEW → EDIT → CANCEL EDIT / SAVE
```

unless the workflow specifically requires immediate entry.

## 11. OAK Visual System

Preserve the established OAK visual concept:

- Forest Green
- Warm Ivory
- Muted Gold
- clean premium hotel-management appearance
- strong readability
- restrained decoration

Do not introduce an unrelated design language without approval.

## 12. Room Master Direction

Room Master must become the canonical foundation for:

```
Room Type → Physical Room → Inventory → Availability
→ Reservation → Calendar/Tape Chart → Housekeeping → Maintenance
```

Do not duplicate room master data inside booking UI. Booking UI consumes Room Master.

## 13. Calendar / Tape Chart Direction

Future calendar/tape chart should consume canonical Room Master data:

- Room Type → Physical Room → Room Status
- horizontal hotel-date timeline
- reservation bars following `[check_in, check_out)`

Calendar must not become a second source of truth.

## 14. Git Safety

Before significant work:

- inspect git status
- understand existing uncommitted changes
- do not overwrite unrelated work

Never stage/commit:

- `backend/.env`
- database dumps
- credential backups
- temporary operational artifacts

unless explicitly approved.

Never commit automatically unless the user explicitly requests a checkpoint/commit.

Known protected artifacts in this repository (never stage/commit): `oak-hotel-backend-env-*.txt`, `oak-hotel-db-*.sql`.

## 15. Agent Workflow

For substantial tasks:

1. AUDIT
2. IDENTIFY SOURCE OF TRUTH
3. IDENTIFY INVARIANTS
4. IMPLEMENT SMALLEST SAFE CHANGE
5. BUILD
6. RUN TARGETED TEST
7. RUN REGRESSION TESTS
8. CHECK DB INVARIANTS IF RELEVANT
9. REPORT FILES CHANGED
10. REPORT GO / NO-GO
11. STOP BEFORE COMMIT UNLESS EXPLICITLY AUTHORIZED

Do not claim a browser workflow was tested unless it was actually tested.

## 16. Bug Investigation

When debugging:

- reproduce first when possible
- distinguish UI symptom from backend root cause
- inspect current data before changing rules
- check stale async/cache behavior when relevant
- check canonical identity mapping
- check lifecycle state
- check timezone/date boundary
- check inventory ledger
- check fixture/test residue

Do not patch symptoms when the authoritative root cause can be fixed safely.

