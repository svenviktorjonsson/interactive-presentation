param(
  [Parameter(Position = 0)]
  [string]$Presentation = "basic",

  [int]$Port = 8010
)

$ErrorActionPreference = "Stop"

$nextRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $nextRoot

$repoRoot = Split-Path -Parent $nextRoot

function Ensure-WebBuild {
  Write-Host "[next/run_presentation.ps1] Building web..."
  Push-Location (Join-Path $nextRoot "web")
  try {
    if (!(Test-Path "node_modules")) { npm install | Out-Host }
    npm run build | Out-Host
  } finally {
    Pop-Location
  }
}

function Ensure-PythonEditableInstall {
  Write-Host "[next/run_presentation.ps1] Installing python package (editable)..."
  Push-Location (Join-Path $nextRoot "python")
  try {
    python -m pip install -e . | Out-Host
  } finally {
    Pop-Location
  }
}

$prPath = (Join-Path (Join-Path $nextRoot "examples") (Join-Path $Presentation "presentation.pr"))
if (!(Test-Path $prPath)) {
  # Allow passing a direct path as $Presentation
  if (Test-Path $Presentation) {
    $prPath = (Resolve-Path $Presentation).Path
  } else {
    throw "Presentation not found. Expected '$prPath' or a direct path argument."
  }
}

Ensure-WebBuild

# Don't `pip install` on every run (Windows can lock the generated .exe).
# Run directly from source by putting `next/python` on PYTHONPATH.
$pyRoot = (Join-Path $nextRoot "python")
if ($env:PYTHONPATH) { $env:PYTHONPATH = "$pyRoot;$env:PYTHONPATH" } else { $env:PYTHONPATH = "$pyRoot" }

$url = "http://127.0.0.1:$Port/"

# Ensure we don't have an old server instance still bound to the port.
try {
  $existing = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($procId in $existing) {
    try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
  }
} catch {}
Start-Sleep -Milliseconds 150

Write-Host "[next/run_presentation.ps1] Starting server on $url"

# Start server in a separate process so we can wait until it's up, then open browser.
$argLine = "-m interactive_presentation.cli run `"$prPath`" --port $Port"
$server = Start-Process -PassThru -NoNewWindow python -ArgumentList $argLine

for ($i = 0; $i -lt 50; $i++) {
  try {
    $modelUrl = "$url" + "model"
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $modelUrl | Out-Null
    break
  } catch {
    Start-Sleep -Milliseconds 100
  }
}

Write-Host "[next/run_presentation.ps1] Opening $url"
$cacheBust = [DateTime]::UtcNow.Ticks
$openUrl = "$url" + "?ts=$cacheBust"
Start-Process $openUrl | Out-Null

Write-Host "[next/run_presentation.ps1] Server pid=$($server.Id). Press Ctrl+C in this window to stop."
Wait-Process -Id $server.Id

