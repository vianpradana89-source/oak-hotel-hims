# setup_db.ps1 - create database if not exists and print connection info
# Usage: .\scripts\setup_db.ps1

# Load .env into environment variables (simple parser)
if (Test-Path '.env') {
  Get-Content .env | ForEach-Object {
    if ($_ -match "^\s*([^#=]+)\s*=\s*(.*)\s*$") {
      $k = $Matches[1].Trim()
      $v = $Matches[2].Trim()
      Set-Item -Path env:$k -Value $v
    }
  }
} else {
  Write-Host ".env not found in current folder. Copy .env.example to .env and edit connection values first." -ForegroundColor Yellow
  return
}

$host = $env:DB_HOST; $port = $env:DB_PORT; $user = $env:DB_USER; $db = $env:DB_NAME
Write-Host "Using PG: host=$host port=$port user=$user db=$db"

# Try to create database (ignore error if exists)
try {
  & psql -h $host -p $port -U $user -c "CREATE DATABASE $db;"
  Write-Host "Database '$db' created (or already existed)." -ForegroundColor Green
} catch {
  Write-Host "psql returned: $_" -ForegroundColor Yellow
  Write-Host "If psql isn't available or you don't have permissions, create database manually (pgAdmin)."
}

Write-Host "Done. Next: npm install && npm run dev to start server which will initialize schema and seed availability."