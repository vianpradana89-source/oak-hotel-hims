Backend prototype (Express) for Oak Hotel HIMS - Availability engine scaffold

Quickstart (local development)

1. Copy environment file
   - cp backend/.env.example backend/.env
   - Fill values (Postgres must be reachable)

2. Install dependencies
   - cd backend
   - npm install

3. Start development server
   - npm run dev
   - Server listens on PORT (default 5000)

Endpoints (availability)

GET /api/availability?room_type=Standard Room&start=2026-08-18&end=2026-08-25
  - Returns per-date availability entries (sellable = total_rooms - reserved_qty)

POST /api/availability/lock
  - Body: { reservation_id?, room_type, start, end, qty, ttl_minutes? }
  - Attempts to lock qty rooms for each date in range (start inclusive, end exclusive)
  - Uses DB SELECT ... FOR UPDATE to ensure concurrency-safety

Notes
- Database schema initialized automatically on server start (initializeDatabase). The v2 schema includes availability tables.
- A background sweeper runs every minute to release expired locks and adjust reserved_qty.
- This scaffold focuses on availability locking behavior for MVP paths. Next: integrate locking into booking flow, transactional outbox, idempotency.

Concurrency test

- A Node.js helper script is available at test/concurrency_test.js. It uses the built-in fetch API (Node v18+) to issue many concurrent POST /api/reservations requests and summarize results.
- Example: node test/concurrency_test.js 10 http://localhost:5000/api/reservations

PowerShell parallel curl example (Windows):

$jobs = @();
for ($i=0; $i -lt 10; $i++) {
  $body = @{
    room_id=1; guest_name = "PS Guest $i"; guest_phone = "0811000$i"; check_in = (Get-Date -Format yyyy-MM-dd); check_out = ((Get-Date).AddDays(1) -Format yyyy-MM-dd); total_price = 100000; qty = 1
  } | ConvertTo-Json
  $jobs += Start-Job -ScriptBlock { param($u,$b) curl -s -X POST $u -H "Content-Type: application/json" -d $b } -ArgumentList 'http://localhost:5000/api/reservations', $body
}
Receive-Job -Wait -AutoRemoveJob $jobs

Notes:
- Before running concurrency tests ensure:
  - Database is migrated and seeded (server will auto-seed on start)
  - The targeted room_type availability has low remaining capacity so contention occurs
  - Run the test against a single server instance to validate DB row locking behavior


