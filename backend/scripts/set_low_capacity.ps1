<# set_low_capacity.ps1 - set availability total_rooms=1 for a given room_type and date
Usage: .\scripts\set_low_capacity.ps1 -room_type 'Standard Room' -date '2026-08-18'
#>
param(
  [string]$room_type = 'Standard Room',
  [string]$date = (Get-Date -Format yyyy-MM-dd)
)

# Load .env
if (Test-Path '.env') {
  Get-Content .env | ForEach-Object {
    if ($_ -match "^\s*([^#=]+)\s*=\s*(.*)\s*$") {
      $k = $Matches[1].Trim()
      $v = $Matches[2].Trim()
      Set-Item -Path env:$k -Value $v
    }
  }
} else {
  Write-Host ".env not found. Copy .env.example to .env and edit connection values first." -ForegroundColor Yellow
  return
}

$host = $env:DB_HOST; $port = $env:DB_PORT; $user = $env:DB_USER; $db = $env:DB_NAME
Write-Host "Updating availability for room_type='$room_type' date='$date' on $host:$port db=$db"

$cmd = "UPDATE availability_dates SET total_rooms = 1, reserved_qty = 0 WHERE room_type = '$room_type' AND date = '$date'; SELECT room_type, date, total_rooms, reserved_qty FROM availability_dates WHERE room_type = '$room_type' AND date = '$date';"

try {
  & psql -h $host -p $port -U $user -d $db -c $cmd
} catch {
  Write-Host "psql returned: $_" -ForegroundColor Yellow
}
