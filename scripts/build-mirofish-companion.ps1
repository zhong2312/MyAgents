<#
.SYNOPSIS
Builds the lean MiroFish novel companion as a self-contained runtime.

.DESCRIPTION
Uses PyInstaller through uv. The generated runtime is placed under
src-tauri/resources/mirofish-companion/runtime so Tauri and the portable
Windows test package can ship it as a separate loopback service.
#>
[CmdletBinding()]
param(
    [string]$SourceRoot = '',
    [string]$OutputRoot = '',
    [string]$BuildRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
if (-not $SourceRoot) {
    $SourceRoot = Join-Path $repoRoot 'src-tauri\resources\mirofish-companion\source'
}
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $repoRoot 'src-tauri\resources\mirofish-companion\runtime'
}
if (-not $BuildRoot) {
    $BuildRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'myagents-build-tools\mirofish-companion'
}

$sourceRootFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$outputRootFull = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$outputParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $outputRootFull)).TrimEnd('\')
$buildRootFull = [System.IO.Path]::GetFullPath($BuildRoot).TrimEnd('\')
$stagingRoot = "$outputRootFull.new"
$backupRoot = "$outputRootFull.previous"
$distRoot = Join-Path $buildRootFull 'dist'
$workRoot = Join-Path $buildRootFull 'work'
$specRoot = Join-Path $buildRootFull 'spec'
$backendRoot = Join-Path $sourceRootFull 'backend'
$runner = Join-Path $backendRoot 'novel_companion.py'
$requirements = Join-Path $backendRoot 'companion-requirements.txt'
$sourceManifestPath = Join-Path $sourceRootFull 'SOURCE.json'

function Assert-DirectChildPath {
    param(
        [string]$Path,
        [string]$ExpectedParent,
        [string]$Description
    )
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $full)).TrimEnd('\')
    if (-not $parent.Equals($ExpectedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe $Description path: $full"
    }
}

function Remove-SafeDirectory {
    param(
        [string]$Path,
        [string]$ExpectedParent,
        [string]$Description
    )
    Assert-DirectChildPath -Path $Path -ExpectedParent $ExpectedParent -Description $Description
    if (Test-Path -LiteralPath $Path -PathType Container) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

foreach ($required in @($runner, $requirements, (Join-Path $sourceRootFull 'LICENSE'), $sourceManifestPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing MiroFish companion source: $required"
    }
}
$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $sourceManifest.upstreamCommit -or -not $sourceManifest.files) {
    throw "Invalid MiroFish source manifest: $sourceManifestPath"
}
foreach ($entry in @($sourceManifest.files)) {
    $sourcePath = Join-Path $sourceRootFull ([string]$entry.path).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing manifest source file: $sourcePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$entry.sha256).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "MiroFish source hash mismatch: $($entry.path)"
    }
}
$uv = Get-Command uv.exe -ErrorAction SilentlyContinue
if (-not $uv) {
    $uv = Get-Command uv -ErrorAction Stop
}

New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
New-Item -ItemType Directory -Path $buildRootFull -Force | Out-Null
Remove-SafeDirectory -Path $distRoot -ExpectedParent $buildRootFull -Description 'PyInstaller dist'
Remove-SafeDirectory -Path $workRoot -ExpectedParent $buildRootFull -Description 'PyInstaller work'
Remove-SafeDirectory -Path $specRoot -ExpectedParent $buildRootFull -Description 'PyInstaller spec'
Remove-SafeDirectory -Path $stagingRoot -ExpectedParent $outputParent -Description 'companion staging'
Remove-SafeDirectory -Path $backupRoot -ExpectedParent $outputParent -Description 'companion backup'

$env:MIROFISH_COMPANION_MODE = '1'
$arguments = @(
    'run',
    '--no-project',
    '--with-requirements', $requirements,
    '--with', 'pyinstaller',
    'pyinstaller',
    '--noconfirm',
    '--clean',
    '--onedir',
    '--noupx',
    '--name', 'mirofish-companion',
    '--paths', $backendRoot,
    '--distpath', $distRoot,
    '--workpath', $workRoot,
    '--specpath', $specRoot,
    $runner
)

Push-Location $sourceRootFull
try {
    & $uv.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

$builtRoot = Join-Path $distRoot 'mirofish-companion'
$builtExe = Join-Path $builtRoot 'mirofish-companion.exe'
if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
    throw "PyInstaller output is incomplete: $builtExe"
}

Copy-Item -LiteralPath $builtRoot -Destination $stagingRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceRootFull 'LICENSE') -Destination (Join-Path $stagingRoot 'LICENSE-MiroFish-Explorer.txt') -Force
Copy-Item -LiteralPath $requirements -Destination (Join-Path $stagingRoot 'companion-requirements.txt') -Force

$sourceFiles = @($sourceManifest.files | ForEach-Object { ([string]$_.path).Replace('/', '\') })
$sourceBundleRoot = Join-Path $stagingRoot 'source'
foreach ($relativePath in $sourceFiles) {
    $sourcePath = Join-Path $sourceRootFull $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing companion source file: $sourcePath"
    }
    $destination = Join-Path $sourceBundleRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
}

$commit = [string]$sourceManifest.upstreamCommit
$sourceInfo = [ordered]@{
    component = 'MiroFish-Explorer novel companion'
    license = 'AGPL-3.0'
    upstream = 'https://github.com/jjy1000/MiroFish-Explorer'
    sourceCommit = $commit
    sourceManifest = 'src-tauri/resources/mirofish-companion/source/SOURCE.json'
    sourceManifestSha256 = (Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceFiles = $sourceFiles
    sourceFileHashes = @($sourceManifest.files)
    buildScript = 'scripts/build-mirofish-companion.ps1'
}
$sourceInfoJson = $sourceInfo | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $stagingRoot 'SOURCE.json'),
    "$sourceInfoJson`n",
    [System.Text.UTF8Encoding]::new($false)
)

$hadPrevious = Test-Path -LiteralPath $outputRootFull -PathType Container
if ($hadPrevious) {
    Move-Item -LiteralPath $outputRootFull -Destination $backupRoot
}
try {
    Move-Item -LiteralPath $stagingRoot -Destination $outputRootFull
    Remove-SafeDirectory -Path $backupRoot -ExpectedParent $outputParent -Description 'companion backup'
} catch {
    if (Test-Path -LiteralPath $outputRootFull -PathType Container) {
        Remove-SafeDirectory -Path $outputRootFull -ExpectedParent $outputParent -Description 'failed companion runtime'
    }
    if ($hadPrevious -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        Move-Item -LiteralPath $backupRoot -Destination $outputRootFull
    }
    throw
}

$runtimeFiles = @(Get-ChildItem -LiteralPath $outputRootFull -File -Recurse -Force)
[pscustomobject]@{
    Source = $sourceRootFull
    Runtime = $outputRootFull
    Executable = Join-Path $outputRootFull 'mirofish-companion.exe'
    FileCount = $runtimeFiles.Count
    TotalBytes = [long](($runtimeFiles | Measure-Object Length -Sum).Sum)
    SourceCommit = $commit
} | ConvertTo-Json
