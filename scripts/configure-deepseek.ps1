param([string]$Model = 'deepseek-flash')
$ErrorActionPreference = 'Stop'
$rtRoot = Split-Path $PSScriptRoot -Parent
Push-Location $rtRoot
$rtPointer = [IntPtr]::Zero
try {
  if (-not (Test-Path 'apps/api/dist/secretary.js')) { throw 'Run npm.cmd run build:api first.' }
  Write-Host 'DeepSeek setup: enter your API Key locally. Input is hidden and not added to shell history.'
  Write-Host 'A connection test will send one fictional schedule to DeepSeek and may use a small number of API tokens.'
  $rtSecret = Read-Host 'DeepSeek API Key' -AsSecureString
  $rtPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($rtSecret)
  $rtKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($rtPointer)
  @{ key = $rtKey; model = $Model } | ConvertTo-Json -Compress | node scripts/configure-deepseek.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Setup failed. No key was printed.' }
  $rtKey = $null
  node scripts/check-model.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Connection test failed. Configuration saved; fix the reported issue and run npm.cmd run model:check.' }
  # Restart only this repository's absolute-path backend, never an unrelated port owner.
  $rtMain = [IO.Path]::GetFullPath((Join-Path $rtRoot 'apps/api/dist/main.js'))
  $rtEnv = [IO.File]::ReadAllText((Join-Path $rtRoot '.env'))
  $rtPortMatch = [regex]::Match($rtEnv, '(?m)^PORT=(\d+)\s*$')
  $rtPort = if ($rtPortMatch.Success) { [int]$rtPortMatch.Groups[1].Value } else { 3000 }
  $rtEnv = $null
  $rtListeners = @(Get-NetTCPConnection -LocalPort $rtPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($rtOwner in ($rtListeners.OwningProcess | Select-Object -Unique)) {
    $rtProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $rtOwner"
    if (-not $rtProcess -or -not $rtProcess.CommandLine.Replace('/', '\').Contains($rtMain)) { throw 'Port belongs to another process. Stop your old backend manually, then run npm.cmd run start:api.' }
    Stop-Process -Id $rtOwner
  }
  Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $rtMain + '"') -WorkingDirectory $rtRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $rtRoot 'backend.stdout.log') -RedirectStandardError (Join-Path $rtRoot 'backend.stderr.log') | Out-Null
  $rtReady = $false
  for ($rtAttempt = 0; $rtAttempt -lt 15; $rtAttempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $rtState = Invoke-RestMethod -Uri "http://127.0.0.1:$rtPort/health" -TimeoutSec 2
      $rtStore = Invoke-RestMethod -Uri "http://127.0.0.1:$rtPort/ready" -TimeoutSec 2
      if ($rtState.secretary -eq 'http' -and $rtStore.status -eq 'ready') { $rtReady = $true; break }
    } catch { }
  }
  if (-not $rtReady) { throw 'Backend did not become ready. Run npm.cmd run start:api to check startup.' }
  Write-Host 'Ready. Compile preview A/B in WeChat DevTools and generate a schedule draft.'
} catch {
  $rtMessage = $_.Exception.Message
  if ($rtMessage -match '^(Run npm|Setup failed|Connection test failed|Port belongs to another process|Backend did not become ready)') { Write-Host $rtMessage }
  Write-Host 'Setup did not finish. Never paste your API Key into chat.'
  exit 1
} finally {
  $rtKey = $null
  if ($rtPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($rtPointer) }
  if ($rtSecret) { $rtSecret.Dispose() }
  Pop-Location
}
