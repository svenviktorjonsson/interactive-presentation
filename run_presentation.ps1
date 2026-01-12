param(
  [Parameter(Position = 0)]
  [string]$Presentation = "test",

  # Forward any remaining args directly to run_presentation.py (e.g. --port 8001 --no-reload)
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

Write-Host "[run_presentation.ps1] Presentation: $Presentation"

$poetry = Get-Command poetry -ErrorAction SilentlyContinue
$python = Get-Command python -ErrorAction SilentlyContinue

if ($poetry) {
  & $poetry.Path run python (Join-Path $repoRoot "run_presentation.py") -p $Presentation @Rest
  exit $LASTEXITCODE
}

if ($python) {
  & $python.Path (Join-Path $repoRoot "run_presentation.py") -p $Presentation @Rest
  exit $LASTEXITCODE
}

throw "Neither 'poetry' nor 'python' was found on PATH. Install Poetry+Python (recommended) or ensure python is available."

