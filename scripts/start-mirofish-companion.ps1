[CmdletBinding()]
param(
    [string]$SourceRoot = '',
    [int]$Port = 5103
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceRoot) {
    $SourceRoot = Join-Path $repoRoot 'src-tauri\resources\mirofish-companion\source'
}
$backendRoot = Join-Path $SourceRoot 'backend'
$runner = Join-Path $backendRoot 'novel_companion.py'
$requirements = Join-Path $backendRoot 'companion-requirements.txt'

if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "MiroFish novel companion was not found: $runner"
}
if (-not (Get-Command uv.exe -ErrorAction SilentlyContinue)) {
    throw 'uv.exe was not found. Install uv before starting the companion.'
}

$env:PYTHONUTF8 = '1'
$env:MIROFISH_HOST = '127.0.0.1'
$env:MIROFISH_PORT = [string]$Port
$env:MIROFISH_COMPANION_MODE = '1'
if (-not $env:SECRET_KEY) {
    $env:SECRET_KEY = [guid]::NewGuid().ToString('N')
}
if (-not $env:NOVEL_SIMULATION_DATA_DIR) {
    $dataRoot = if ($env:MYAGENTS_DATA_DIR) {
        $env:MYAGENTS_DATA_DIR
    } else {
        Join-Path $env:USERPROFILE '.myagents'
    }
    $env:NOVEL_SIMULATION_DATA_DIR = Join-Path $dataRoot 'mirofish-novel-simulations'
}

Write-Host "MiroFish novel companion: http://127.0.0.1:$Port" -ForegroundColor Cyan
& uv.exe run --no-project --with-requirements $requirements python $runner
exit $LASTEXITCODE
