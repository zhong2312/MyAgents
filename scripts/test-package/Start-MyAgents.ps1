$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$appDir = Join-Path $root 'app'
$exePath = Join-Path $appDir 'myagents.exe'
$profileRoot = Join-Path $root 'profile'

if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "MyAgents executable was not found: $exePath"
}

$running = Get-Process -Name 'myagents' -ErrorAction SilentlyContinue
if ($running) {
    throw 'Another MyAgents instance is running. Close it before starting the long-term test package.'
}

$roaming = Join-Path $profileRoot 'AppData\Roaming'
$local = Join-Path $profileRoot 'AppData\Local'
$myAgentsData = Join-Path $profileRoot '.myagents'
$desktop = Join-Path $profileRoot 'Desktop'
$documents = Join-Path $profileRoot 'Documents'
foreach ($directory in @($profileRoot, $roaming, $local, $myAgentsData, $desktop, $documents)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

# Keep Rust, renderer, Sidecars, and OS app-data owners in one persistent profile.
$env:MYAGENTS_DATA_DIR = $myAgentsData
$env:HOME = $profileRoot
$env:USERPROFILE = $profileRoot
$env:APPDATA = $roaming
$env:LOCALAPPDATA = $local
$env:MYAGENTS_TEST_ROOT = $root

Start-Process -FilePath $exePath -WorkingDirectory $appDir
