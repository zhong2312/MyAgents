<#
.SYNOPSIS
Builds MyAgents and atomically updates the long-term Windows test package.

.EXAMPLE
.\scripts\package-myagents-test.ps1

.EXAMPLE
.\scripts\package-myagents-test.ps1 -ValidateOnly

.EXAMPLE
.\scripts\package-myagents-test.ps1 -TargetRoot 'D:\MyAgents-test' -SkipSmokeTest
#>
[CmdletBinding()]
param(
    [string]$TargetRoot = 'F:\workspace\MyAgents-test',
    [string]$BuildToolsRoot = 'F:\workspace\.myagents-build-tools',
    [switch]$SkipSmokeTest,
    [switch]$ValidateOnly,
    [switch]$ReuseBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$script:TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
$script:BuildToolsRoot = [System.IO.Path]::GetFullPath($BuildToolsRoot).TrimEnd('\')
$script:NovelsDirectoryName = [string][char]0x5C0F + [string][char]0x8BF4
$script:AppPath = Join-Path $script:TargetRoot 'app'
$script:StagingPath = Join-Path $script:TargetRoot 'app.new'
$script:BackupPath = Join-Path $script:TargetRoot 'app.previous'
$script:InfoPath = Join-Path $script:TargetRoot 'PACKAGE-INFO.json'
$script:InfoBackupPath = Join-Path $script:TargetRoot 'PACKAGE-INFO.previous.json'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Assert-ExactPath {
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Description
    )
    $actualFull = [System.IO.Path]::GetFullPath($Actual).TrimEnd('\')
    $expectedFull = [System.IO.Path]::GetFullPath($Expected).TrimEnd('\')
    if (-not $actualFull.Equals($expectedFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe $Description path: $actualFull"
    }
}

function Remove-PackageDirectory {
    param([string]$LeafName)
    $path = Join-Path $script:TargetRoot $LeafName
    Assert-ExactPath -Actual $path -Expected "$($script:TargetRoot)\$LeafName" -Description $LeafName
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

function Remove-PackageFile {
    param([string]$LeafName)
    $path = Join-Path $script:TargetRoot $LeafName
    Assert-ExactPath -Actual $path -Expected "$($script:TargetRoot)\$LeafName" -Description $LeafName
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

function Get-TestPackageProcesses {
    $appPrefix = [System.IO.Path]::GetFullPath($script:AppPath).TrimEnd('\') + '\'
    return @(Get-Process -Name myagents, node, cuse -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith(
                $appPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            $false
        }
    })
}

function Stop-TestPackageProcesses {
    $owned = @(Get-TestPackageProcesses)
    foreach ($process in @($owned | Where-Object ProcessName -eq 'myagents')) {
        $null = $process.CloseMainWindow()
    }

    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $owned = @(Get-TestPackageProcesses)
    } while (($owned | Where-Object ProcessName -eq 'myagents') -and (Get-Date) -lt $deadline)

    foreach ($process in @(Get-TestPackageProcesses)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    if (@(Get-TestPackageProcesses).Count -ne 0) {
        throw 'Test package processes are still running.'
    }
}

function Get-ProcessCommandLines {
    $commandLines = @{}
    try {
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
            if ($process.ProcessId -and $process.CommandLine) {
                $commandLines[[int]$process.ProcessId] = [string]$process.CommandLine
            }
        }
    } catch {
        # Some locked-down Windows environments deny WMI process inspection.
        # Path-based ownership checks below remain safe in that case.
    }
    return $commandLines
}

function Stop-OldMyAgentsProcesses {
    $ownedRoots = @(
        [System.IO.Path]::GetFullPath($script:RepoRoot).TrimEnd('\') + '\',
        [System.IO.Path]::GetFullPath($script:TargetRoot).TrimEnd('\') + '\',
        [System.IO.Path]::GetFullPath($script:BuildToolsRoot).TrimEnd('\') + '\'
    )
    $commandLines = Get-ProcessCommandLines
    $candidates = @(Get-Process -Name myagents, cargo, rustc, node, cuse -ErrorAction SilentlyContinue)
    $owned = @($candidates | Where-Object {
        $process = $_
        $path = ''
        try {
            if ($process.Path) {
                $path = [System.IO.Path]::GetFullPath($process.Path)
            }
        } catch {
            $path = ''
        }
        $commandLine = if ($commandLines.ContainsKey($process.Id)) {
            $commandLines[$process.Id]
        } else {
            ''
        }
        $pathOwned = $false
        foreach ($root in $ownedRoots) {
            if ($path -and $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $pathOwned = $true
                break
            }
        }
        $commandOwned = $commandLine -and (
            $commandLine.IndexOf($script:RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf($script:TargetRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf('Start-MyAgents-Dev', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        )

        # Cargo/rustc from the repository's isolated build toolchain are
        # build-owned even when their command line is unavailable. Other
        # Node processes are stopped only when their command line identifies
        # this repository, so unrelated desktop applications are untouched.
        ($pathOwned -or $commandOwned) -and (
            $process.ProcessName -ne 'node' -or $commandOwned
        )
    })

    if ($owned.Count -eq 0) {
        Write-Info 'No old MyAgents build or test processes found.'
        return
    }

    foreach ($process in @($owned | Where-Object ProcessName -eq 'myagents')) {
        $null = $process.CloseMainWindow()
    }
    Start-Sleep -Milliseconds 500
    foreach ($process in $owned) {
        if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
            Write-Info "Stopping old MyAgents process PID $($process.Id) ($($process.ProcessName))"
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 500

    $remaining = @(Get-Process -Id @($owned.Id) -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 0) {
        throw 'Old MyAgents processes are still running.'
    }
}

function Get-DirectoryFingerprint {
    param([string]$Path)
    $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction Stop)
    $latestTicks = 0L
    if ($files.Count -gt 0) {
        $latestTicks = ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc.Ticks
    }
    return [pscustomobject]@{
        FileCount = $files.Count
        TotalBytes = [long](($files | Measure-Object Length -Sum).Sum)
        LatestWriteTicks = $latestTicks
    }
}

function Assert-FingerprintUnchanged {
    param(
        [pscustomobject]$Before,
        [pscustomobject]$After,
        [string]$Name
    )
    if (
        $Before.FileCount -ne $After.FileCount -or
        $Before.TotalBytes -ne $After.TotalBytes -or
        $Before.LatestWriteTicks -ne $After.LatestWriteTicks
    ) {
        throw "Persistent directory changed during package replacement: $Name"
    }
}

function Get-VsDevShell {
    $bundled = Join-Path $script:BuildToolsRoot 'vs2022\Common7\Tools\Launch-VsDevShell.ps1'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
        return $bundled
    }

    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $installationPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
        if ($installationPath) {
            $candidate = Join-Path $installationPath 'Common7\Tools\Launch-VsDevShell.ps1'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }
    throw 'Visual Studio C++ Build Tools were not found.'
}

function Initialize-BuildEnvironment {
    $cargoHome = Join-Path $script:BuildToolsRoot 'cargo'
    $rustupHome = Join-Path $script:BuildToolsRoot 'rustup'
    $bundledCargo = Join-Path $cargoHome 'bin\cargo.exe'
    if (Test-Path -LiteralPath $bundledCargo -PathType Leaf) {
        $env:CARGO_HOME = $cargoHome
        $env:RUSTUP_HOME = $rustupHome
        $env:PATH = "$(Join-Path $cargoHome 'bin');$env:PATH"
    } elseif (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        throw 'Cargo was not found. Set -BuildToolsRoot or install Rust.'
    }

    $vsDevShell = Get-VsDevShell
    & $vsDevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}

function Copy-DirectoryResource {
    param(
        [string]$SourceRelativePath,
        [string]$DestinationName
    )
    $source = Join-Path $script:RepoRoot $SourceRelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Missing directory resource: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $script:StagingPath $DestinationName) -Recurse -Force
}

function Copy-FileResource {
    param(
        [string]$SourceRelativePath,
        [string]$DestinationName
    )
    $source = Join-Path $script:RepoRoot $SourceRelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing file resource: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $script:StagingPath $DestinationName) -Force
}

function Invoke-SmokeTest {
    $launcher = Join-Path $script:TargetRoot 'Start-MyAgents.ps1'
    & $launcher

    $expectedExe = [System.IO.Path]::GetFullPath((Join-Path $script:AppPath 'myagents.exe'))
    $deadline = (Get-Date).AddSeconds(30)
    $process = $null
    do {
        Start-Sleep -Milliseconds 500
        $process = Get-Process -Name myagents -ErrorAction SilentlyContinue | Where-Object {
            try {
                $_.Path -and [System.IO.Path]::GetFullPath($_.Path).Equals(
                    $expectedExe,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } catch {
                $false
            }
        } | Select-Object -First 1
    } while (-not $process -and (Get-Date) -lt $deadline)

    if (-not $process) {
        throw 'Smoke test failed: MyAgents did not start.'
    }
    Start-Sleep -Seconds 10
    $process = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.Responding -or $process.MainWindowHandle -eq 0) {
        throw 'Smoke test failed: MyAgents did not remain responsive.'
    }
    Write-Host "Smoke test passed (PID $($process.Id))." -ForegroundColor Green
    Stop-TestPackageProcesses
}

$directoryMappings = @(
    @{ Source = 'bundled-agents'; Name = 'bundled-agents' },
    @{ Source = 'bundled-skills'; Name = 'bundled-skills' },
    @{ Source = 'src-tauri\resources\claude-agent-sdk'; Name = 'claude-agent-sdk' },
    @{ Source = 'src-tauri\resources\cli'; Name = 'cli' },
    @{ Source = 'src-tauri\resources\nodejs'; Name = 'nodejs' },
    @{ Source = 'src-tauri\resources\sharp-runtime'; Name = 'sharp-runtime' },
    @{ Source = 'src-tauri\resources\tsx-runtime'; Name = 'tsx-runtime' },
    @{ Source = 'src\server\plugin-bridge\sdk-shim'; Name = 'plugin-bridge-sdk-shim' },
    @{ Source = 'src\shared'; Name = 'shared' },
    @{ Source = 'mino'; Name = 'mino' },
    @{ Source = 'src-tauri\infoplist\en.lproj'; Name = 'en.lproj' },
    @{ Source = 'src-tauri\infoplist\zh-Hans.lproj'; Name = 'zh-Hans.lproj' }
)

$fileMappings = @(
    @{ Source = 'src-tauri\target\x86_64-pc-windows-msvc\release\myagents.exe'; Name = 'myagents.exe' },
    @{ Source = 'src-tauri\resources\server-dist.js'; Name = 'server-dist.js' },
    @{ Source = 'src-tauri\resources\plugin-bridge-dist.mjs'; Name = 'plugin-bridge-dist.mjs' },
    @{ Source = 'src-tauri\binaries\cuse-x86_64-pc-windows-msvc.exe'; Name = 'cuse.exe' },
    @{ Source = 'src-tauri\resources\vcruntime140.dll'; Name = 'vcruntime140.dll' },
    @{ Source = 'src-tauri\resources\vcruntime140_1.dll'; Name = 'vcruntime140_1.dll' }
)

$rootFileMappings = @(
    @{ Source = 'scripts\test-package\Start-MyAgents.ps1'; Name = 'Start-MyAgents.ps1' },
    @{ Source = 'scripts\test-package\Start-MyAgents.cmd'; Name = 'Start-MyAgents.cmd' },
    @{ Source = 'scripts\test-package\README.txt'; Name = 'README.txt' }
)

if (-not (Test-Path -LiteralPath $script:TargetRoot -PathType Container)) {
    throw "Test package directory does not exist: $($script:TargetRoot)"
}
foreach ($required in @('Start-MyAgents.cmd', 'Start-MyAgents.ps1', 'README.txt', 'profile', $script:NovelsDirectoryName)) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:TargetRoot $required))) {
        throw "Missing test package entry: $required"
    }
}
foreach ($mapping in $directoryMappings) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $mapping.Source) -PathType Container)) {
        throw "Missing source directory: $($mapping.Source)"
    }
}
foreach ($mapping in $rootFileMappings) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $mapping.Source) -PathType Leaf)) {
        throw "Missing test-package root file: $($mapping.Source)"
    }
}
foreach ($relativePath in @(
    'src-tauri\binaries\cuse-x86_64-pc-windows-msvc.exe',
    'src-tauri\resources\vcruntime140.dll',
    'src-tauri\resources\vcruntime140_1.dll'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $relativePath) -PathType Leaf)) {
        throw "Missing static package input: $relativePath"
    }
}

$null = Get-VsDevShell
$bundledCargo = Join-Path $script:BuildToolsRoot 'cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $bundledCargo -PathType Leaf) -and -not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw 'Cargo was not found.'
}

if ($ValidateOnly) {
    [pscustomobject]@{
        Repository = $script:RepoRoot
        Target = $script:TargetRoot
        BuildTools = $script:BuildToolsRoot
        AppExists = Test-Path -LiteralPath (Join-Path $script:AppPath 'myagents.exe')
        ExistingBuildOutput = Test-Path -LiteralPath (Join-Path $script:RepoRoot 'src-tauri\target\x86_64-pc-windows-msvc\release\myagents.exe')
        PersistentDirectories = @('profile', $script:NovelsDirectoryName)
        Status = 'ready'
    } | ConvertTo-Json
    return
}

if (-not $SkipSmokeTest) {
    $otherInstances = @(Get-Process -Name myagents -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and -not [System.IO.Path]::GetFullPath($_.Path).StartsWith(
                ([System.IO.Path]::GetFullPath($script:AppPath).TrimEnd('\') + '\'),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            $false
        }
    })
    if ($otherInstances.Count -gt 0) {
        throw 'Another MyAgents installation is running. Close it or use -SkipSmokeTest.'
    }
}

Write-Step 'Stopping the long-term test package'
Write-Step 'Checking for old MyAgents build processes'
Stop-OldMyAgentsProcesses
Stop-TestPackageProcesses

$profilePath = Join-Path $script:TargetRoot 'profile'
$novelsPath = Join-Path $script:TargetRoot $script:NovelsDirectoryName
$profileBefore = Get-DirectoryFingerprint $profilePath
$novelsBefore = Get-DirectoryFingerprint $novelsPath

if ($ReuseBuild) {
    Write-Step 'Reusing the completed Windows release'
    foreach ($mapping in $fileMappings) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $mapping.Source) -PathType Leaf)) {
            throw "Missing completed release output: $($mapping.Source)"
        }
    }
} else {
    Write-Step 'Building the Windows release'
    Initialize-BuildEnvironment
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction Stop
    }
    Push-Location $script:RepoRoot
    try {
        & $npmCommand.Source run tauri:build -- --no-bundle --target x86_64-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri release build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

Write-Step 'Assembling app.new'
Remove-PackageDirectory 'app.new'
New-Item -ItemType Directory -Path $script:StagingPath | Out-Null
try {
    foreach ($mapping in $directoryMappings) {
        Copy-DirectoryResource -SourceRelativePath $mapping.Source -DestinationName $mapping.Name
    }
    foreach ($mapping in $fileMappings) {
        Copy-FileResource -SourceRelativePath $mapping.Source -DestinationName $mapping.Name
    }

    foreach ($relative in @('myagents.exe', 'server-dist.js', 'plugin-bridge-dist.mjs', 'nodejs\node.exe', 'cli\myagents.js', 'cuse.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:StagingPath $relative) -PathType Leaf)) {
            throw "Staging validation failed: $relative"
        }
    }

    Write-Step 'Switching the application directory'
    if (-not (Test-Path -LiteralPath $script:AppPath -PathType Container) -and (Test-Path -LiteralPath $script:BackupPath -PathType Container)) {
        Move-Item -LiteralPath $script:BackupPath -Destination $script:AppPath
    }
    Remove-PackageDirectory 'app.previous'
    Remove-PackageFile 'PACKAGE-INFO.previous.json'

    $hadPreviousApp = Test-Path -LiteralPath $script:AppPath -PathType Container
    if ($hadPreviousApp) {
        Move-Item -LiteralPath $script:AppPath -Destination $script:BackupPath
    }

    $switched = $false
    $hadPreviousInfo = $false
    try {
        Move-Item -LiteralPath $script:StagingPath -Destination $script:AppPath
        $switched = $true

        $hadPreviousInfo = Test-Path -LiteralPath $script:InfoPath -PathType Leaf
        if ($hadPreviousInfo) {
            Copy-Item -LiteralPath $script:InfoPath -Destination $script:InfoBackupPath -Force
        }

        $packageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $script:RepoRoot 'package.json') | ConvertFrom-Json
        $exePath = Join-Path $script:AppPath 'myagents.exe'
        $commit = (& git -C $script:RepoRoot rev-parse HEAD).Trim()
        $dirty = -not [string]::IsNullOrWhiteSpace((& git -C $script:RepoRoot status --porcelain | Out-String))
        $appFiles = @(Get-ChildItem -LiteralPath $script:AppPath -File -Recurse -Force)
        $info = [ordered]@{
            packageVersion = 1
            appVersion = $packageJson.version
            profile = 'release'
            platform = 'windows-x86_64'
            builtAt = [DateTimeOffset]::Now.ToString('O')
            sourceCommit = $commit
            sourceDirty = $dirty
            executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash
            appFileCount = $appFiles.Count
            appBytes = [long](($appFiles | Measure-Object Length -Sum).Sum)
            persistentDirectories = @('profile', $script:NovelsDirectoryName)
            replaceOnUpdate = @('app', 'PACKAGE-INFO.json', 'Start-MyAgents.cmd', 'Start-MyAgents.ps1', 'README.txt')
            packagingScript = 'scripts/package-myagents-test.ps1'
        }
        $json = $info | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($script:InfoPath, "$json`n", [System.Text.UTF8Encoding]::new($false))

        foreach ($mapping in $rootFileMappings) {
            Copy-Item -LiteralPath (Join-Path $script:RepoRoot $mapping.Source) -Destination (Join-Path $script:TargetRoot $mapping.Name) -Force
        }

        Assert-FingerprintUnchanged -Before $profileBefore -After (Get-DirectoryFingerprint $profilePath) -Name 'profile'
        Assert-FingerprintUnchanged -Before $novelsBefore -After (Get-DirectoryFingerprint $novelsPath) -Name $script:NovelsDirectoryName

        if (-not $SkipSmokeTest) {
            Write-Step 'Running the one-click startup smoke test'
            Invoke-SmokeTest
        }

        Remove-PackageDirectory 'app.previous'
        Remove-PackageFile 'PACKAGE-INFO.previous.json'
        Write-Host "`nPackage complete: $($script:TargetRoot)" -ForegroundColor Green
        Write-Host "Executable SHA-256: $($info.executableSha256)"
    } catch {
        Stop-TestPackageProcesses
        if ($switched -and (Test-Path -LiteralPath $script:AppPath)) {
            Remove-PackageDirectory 'app'
        }
        if (Test-Path -LiteralPath $script:BackupPath -PathType Container) {
            Move-Item -LiteralPath $script:BackupPath -Destination $script:AppPath
        }
        if (Test-Path -LiteralPath $script:InfoBackupPath -PathType Leaf) {
            Move-Item -LiteralPath $script:InfoBackupPath -Destination $script:InfoPath -Force
        } elseif (-not $hadPreviousInfo -and (Test-Path -LiteralPath $script:InfoPath -PathType Leaf)) {
            Remove-PackageFile 'PACKAGE-INFO.json'
        }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $script:StagingPath) {
        Remove-PackageDirectory 'app.new'
    }
}
