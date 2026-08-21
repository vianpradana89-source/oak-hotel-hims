Test helpers for concurrency and integration testing

concurrency_test.js - simple Node.js script that issues N concurrent POST /api/reservations requests.

Prerequisites:
- Node.js installed (v18+ recommended for built-in fetch API)
- Backend server running (see project README)

Run example:
- node test/concurrency_test.js 10 http://localhost:5000/api/reservations

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
- The test script creates multiple reservations concurrently. Use it to verify only one request succeeds when availability for the target dates is limited.
- Make sure availability_dates seeded for the room type have low remaining capacity to exercise contention.
