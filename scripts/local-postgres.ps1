param([ValidateSet('start', 'stop', 'status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$pgInstall = Join-Path $env:LOCALAPPDATA 'RoundtableSecretary/postgres17'
$pgControl = Join-Path $pgInstall 'pgsql/bin/pg_ctl.exe'
$pgData = Join-Path $pgInstall 'data'
if (!(Test-Path -LiteralPath $pgControl) -or !(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    throw '尚未初始化本机 PostgreSQL，请先完成安装配置。'
}
switch ($Action) {
    'start' { & $pgControl -D $pgData -l (Join-Path $pgInstall 'server.log') -w start }
    'stop' { & $pgControl -D $pgData -m fast -w stop }
    'status' { & $pgControl -D $pgData status }
}
exit $LASTEXITCODE
