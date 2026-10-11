param(
    [ValidateSet('start', 'stop', 'status')][string]$Action = 'status',
    [string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$candidates = @()
if ($InstallDir) {
    $candidates += $InstallDir
} else {
    foreach ($base in @($env:LOCALAPPDATA, [Environment]::GetFolderPath('LocalApplicationData'), $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData/Local' }))) {
        if ($base) { $candidates += Join-Path $base 'RoundtableSecretary/postgres17' }
    }
}
$candidates = @($candidates | Select-Object -Unique)
$pgInstall = $null
foreach ($candidate in $candidates) {
    if ((Test-Path -LiteralPath (Join-Path $candidate 'pgsql/bin/pg_ctl.exe')) -and
        (Test-Path -LiteralPath (Join-Path $candidate 'data/PG_VERSION'))) {
        $pgInstall = [IO.Path]::GetFullPath($candidate)
        break
    }
}
if (!$pgInstall) {
    foreach ($candidate in $candidates) {
        Write-Host "Checked: $candidate"
        Write-Host "  pg_ctl.exe exists: $(Test-Path -LiteralPath (Join-Path $candidate 'pgsql/bin/pg_ctl.exe'))"
        Write-Host "  PG_VERSION exists: $(Test-Path -LiteralPath (Join-Path $candidate 'data/PG_VERSION'))"
    }
    throw 'PostgreSQL files were not found or are inaccessible. Use -InstallDir with the existing installation; do not initialize over existing data.'
}
$pgControl = Join-Path $pgInstall 'pgsql/bin/pg_ctl.exe'
$pgData = Join-Path $pgInstall 'data'
if ($Action -eq 'start') {
    & $pgControl -D $pgData status *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "PostgreSQL is already running: $pgInstall"
        exit 0
    }
}
switch ($Action) {
    'start' { & $pgControl -D $pgData -l (Join-Path $pgInstall 'server.log') -w start }
    'stop' { & $pgControl -D $pgData -m fast -w stop }
    'status' { & $pgControl -D $pgData status }
}
exit $LASTEXITCODE
