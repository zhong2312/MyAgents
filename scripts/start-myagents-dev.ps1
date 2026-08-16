<#
.SYNOPSIS
Starts MyAgents development mode against the long-term Windows test package data.

.DESCRIPTION
Uses F:\workspace\MyAgents-test profile/novel data by default, matching
Start-MyAgents.ps1 isolation:

  MYAGENTS_DATA_DIR / HOME / USERPROFILE / APPDATA / LOCALAPPDATA

Modes:
  Web   - Vite + TypeScript server (fast UI iteration)
  Tauri - Desktop shell via `npm run tauri:dev`

.EXAMPLE
.\scripts\start-myagents-dev.ps1

.EXAMPLE
.\scripts\start-myagents-dev.ps1 -Mode Tauri

.EXAMPLE
.\scripts\start-myagents-dev.ps1 -TestRoot 'D:\MyAgents-test' -AgentDir 'D:\MyAgents-test\小说\枪出如龙'
#>
[CmdletBinding()]
param(
    [string]$TestRoot = 'F:\workspace\MyAgents-test',
    [ValidateSet('Web', 'Tauri')]
    [string]$Mode = 'Web',
    [string]$AgentDir = '',
    [int]$Port = 3000,
    [int]$VitePort = 5173,
    [switch]$SkipBrowser,
    [switch]$SkipCleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$script:TestRoot = [System.IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
$script:NovelsDirectoryName = [string][char]0x5C0F + [string][char]0x8BF4
$script:BackendProcess = $null
$script:FrontendProcess = $null

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Gray
}

function Assert-PathExists {
    param(
        [string]$Path,
        [string]$Description
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing $Description : $Path"
    }
}

function Get-ListeningPids {
    param([int]$PortNumber)
    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    # Prefer netstat: Get-NetTCPConnection can hang for a long time on some Windows hosts.
    $lines = netstat -ano -p tcp 2>$null | Select-String -Pattern ":$PortNumber\s+.*LISTENING\s+(\d+)\s*$"
    foreach ($line in $lines) {
        if ($line.Line -match '(\d+)\s*$') {
            [void]$pids.Add([int]$Matches[1])
        }
    }
    return @($pids)
}

function Stop-DevProcesses {
    Write-Step 'Cleaning previous development processes'

    foreach ($portNumber in @($Port, $VitePort)) {
        foreach ($processId in @(Get-ListeningPids -PortNumber $portNumber)) {
            try {
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if ($process) {
                    Write-Info "Stopping PID $processId on port $portNumber ($($process.ProcessName))"
                    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                }
            } catch {
                # ignore
            }
        }
    }

    $lockPath = Join-Path $script:MyAgentsData 'app.lock'
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        $oldPidText = (Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue).Trim()
        if ($oldPidText -match '^[1-9][0-9]*$') {
            $oldPid = [int]$oldPidText
            $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($oldProcess) {
                Write-Info "Stopping locked MyAgents PID $oldPid"
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }

    # Only stop processes owned by the test package app directory.
    $appPrefix = [System.IO.Path]::GetFullPath((Join-Path $script:TestRoot 'app')).TrimEnd('\') + '\'
    $owned = @(Get-Process -Name myagents, MyAgents -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith(
                $appPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            $false
        }
    })
    foreach ($process in $owned) {
        Write-Info "Stopping test-package process PID $($process.Id)"
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 400
}

function Initialize-TestProfileEnv {
    $script:ProfileRoot = Join-Path $script:TestRoot 'profile'
    $script:MyAgentsData = Join-Path $script:ProfileRoot '.myagents'
    $script:NovelsRoot = Join-Path $script:TestRoot $script:NovelsDirectoryName
    $roaming = Join-Path $script:ProfileRoot 'AppData\Roaming'
    $local = Join-Path $script:ProfileRoot 'AppData\Local'
    $desktop = Join-Path $script:ProfileRoot 'Desktop'
    $documents = Join-Path $script:ProfileRoot 'Documents'

    foreach ($directory in @(
        $script:ProfileRoot,
        $roaming,
        $local,
        $script:MyAgentsData,
        $desktop,
        $documents,
        $script:NovelsRoot
    )) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    # Keep Rust, renderer, Sidecars, and OS app-data owners in one persistent profile.
    $env:MYAGENTS_DATA_DIR = $script:MyAgentsData
    $env:HOME = $script:ProfileRoot
    $env:USERPROFILE = $script:ProfileRoot
    $env:APPDATA = $roaming
    $env:LOCALAPPDATA = $local
    $env:MYAGENTS_TEST_ROOT = $script:TestRoot
    $env:MYAGENTS_BROWSER_DEV_STORAGE = '1'
    # Windows treats environment-variable names case-insensitively, but the
    # current process can still inherit both `Path` and `PATH`. PowerShell 5.1
    # Start-Process then fails while copying that environment into a child.
    $pathEntries = @($env:Path -split ';') + @($env:PATH -split ';') |
        Where-Object { $_ } |
        Select-Object -Unique
    [Environment]::SetEnvironmentVariable('Path', $null, 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    [Environment]::SetEnvironmentVariable('Path', ($pathEntries -join ';'), 'Process')
}

function Resolve-DefaultAgentDir {
    if ($AgentDir) {
        $resolved = [System.IO.Path]::GetFullPath($AgentDir)
        Assert-PathExists -Path $resolved -Description 'AgentDir'
        return $resolved
    }

    $projectsJson = Join-Path $script:MyAgentsData 'projects.json'
    if (Test-Path -LiteralPath $projectsJson -PathType Leaf) {
        try {
            $projects = Get-Content -LiteralPath $projectsJson -Raw -Encoding UTF8 | ConvertFrom-Json
            $novelProjects = @($projects | Where-Object {
                $_.path -and
                $_.path.StartsWith($script:NovelsRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
                (Test-Path -LiteralPath $_.path -PathType Container)
            } | Sort-Object {
                if ($_.lastOpened) { [datetime]$_.lastOpened } else { [datetime]::MinValue }
            } -Descending)

            if ($novelProjects.Count -gt 0) {
                return [System.IO.Path]::GetFullPath([string]$novelProjects[0].path)
            }
        } catch {
            Write-Info "Could not parse projects.json; falling back to novels directory."
        }
    }

    if (Test-Path -LiteralPath $script:NovelsRoot -PathType Container) {
        $firstNovel = Get-ChildItem -LiteralPath $script:NovelsRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($firstNovel) {
            return $firstNovel.FullName
        }
        return $script:NovelsRoot
    }

    return $script:RepoRoot
}

function Get-NodeCommand {
    $bundled = Join-Path $script:RepoRoot 'src-tauri\resources\nodejs\node.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
        return $bundled
    }

    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode) {
        return $systemNode.Source
    }

    throw 'Node.js was not found. Run setup_windows.ps1 or install Node.js >= 22.'
}

function Get-NpmCommand {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) {
        return $npm.Source
    }
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) {
        return $npm.Source
    }
    throw 'npm was not found.'
}

function Initialize-TauriBuildEnvironment {
    param([string]$BuildToolsRoot = 'F:\workspace\.myagents-build-tools')

    $cargoHome = Join-Path $BuildToolsRoot 'cargo'
    $rustupHome = Join-Path $BuildToolsRoot 'rustup'
    $bundledCargo = Join-Path $cargoHome 'bin\cargo.exe'
    if (Test-Path -LiteralPath $bundledCargo -PathType Leaf) {
        $env:CARGO_HOME = $cargoHome
        $env:RUSTUP_HOME = $rustupHome
        $env:PATH = "$(Join-Path $cargoHome 'bin');$env:PATH"
        Write-Info "Cargo=$bundledCargo"
    } elseif (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        throw "Cargo was not found. Install Rust or set up $BuildToolsRoot."
    }

    $vsDevShell = Join-Path $BuildToolsRoot 'vs2022\Common7\Tools\Launch-VsDevShell.ps1'
    if (-not (Test-Path -LiteralPath $vsDevShell -PathType Leaf)) {
        $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
            $installationPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
            if ($installationPath) {
                $vsDevShell = Join-Path $installationPath 'Common7\Tools\Launch-VsDevShell.ps1'
            }
        }
    }
    if (Test-Path -LiteralPath $vsDevShell -PathType Leaf) {
        Write-Info "Loading VS DevShell: $vsDevShell"
        & $vsDevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
    } else {
        Write-Info 'VS DevShell not found; relying on existing MSVC environment.'
    }
}

function Stop-ProcessTree {
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process) {
        return
    }
    try {
        if (-not $Process.HasExited) {
            # /T kills the whole tree so vite/tsx watch children do not linger.
            & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
        }
    } catch {
        # ignore
    }
}

function Stop-ChildProcesses {
    Stop-ProcessTree -Process $script:FrontendProcess
    Stop-ProcessTree -Process $script:BackendProcess
    $script:FrontendProcess = $null
    $script:BackendProcess = $null
}

function Start-WebDev {
    param(
        [string]$ResolvedAgentDir,
        [string]$NodePath
    )

    $viteEntry = Join-Path $script:RepoRoot 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path -LiteralPath $viteEntry -PathType Leaf)) {
        throw "Vite is not installed. Run npm install in $script:RepoRoot first."
    }

    Write-Step 'Starting backend (tsx watch)'
    $backendArgs = @(
        '--import', 'tsx/esm',
        '--watch',
        (Join-Path $script:RepoRoot 'src\server\index.ts'),
        '--agent-dir', $ResolvedAgentDir,
        '--port', "$Port"
    )
    $script:BackendProcess = Start-Process -FilePath $NodePath `
        -ArgumentList $backendArgs `
        -WorkingDirectory $script:RepoRoot `
        -PassThru `
        -NoNewWindow

    Start-Sleep -Seconds 2
    if ($script:BackendProcess.HasExited) {
        throw "Backend exited early with code $($script:BackendProcess.ExitCode)."
    }
    Write-Info "Backend PID $($script:BackendProcess.Id) -> http://localhost:$Port"

    Write-Step 'Starting frontend (Vite)'
    $frontendArgs = @(
        $viteEntry,
        '--host', '127.0.0.1',
        '--port', "$VitePort"
    )
    $script:FrontendProcess = Start-Process -FilePath $NodePath `
        -ArgumentList $frontendArgs `
        -WorkingDirectory $script:RepoRoot `
        -PassThru `
        -NoNewWindow

    Start-Sleep -Seconds 2
    if ($script:FrontendProcess.HasExited) {
        throw "Frontend exited early with code $($script:FrontendProcess.ExitCode)."
    }
    Write-Info "Frontend PID $($script:FrontendProcess.Id) -> http://localhost:$VitePort"

    if (-not $SkipBrowser) {
        Start-Process "http://localhost:$VitePort" | Out-Null
    }

    Write-Host ""
    Write-Host "Development environment is ready." -ForegroundColor Green
    Write-Host "  Mode      : Web"
    Write-Host "  Frontend  : http://localhost:$VitePort"
    Write-Host "  Backend   : http://localhost:$Port"
    Write-Host "  Profile   : $($script:ProfileRoot)"
    Write-Host "  Data dir  : $($script:MyAgentsData)"
    Write-Host "  Novels    : $($script:NovelsRoot)"
    Write-Host "  Agent dir : $ResolvedAgentDir"
    Write-Host ""
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

    try {
        while ($true) {
            if ($script:BackendProcess.HasExited) {
                throw "Backend process exited with code $($script:BackendProcess.ExitCode)."
            }
            if ($script:FrontendProcess.HasExited) {
                throw "Frontend process exited with code $($script:FrontendProcess.ExitCode)."
            }
            Start-Sleep -Seconds 1
        }
    } finally {
        Write-Host ""
        Write-Step 'Stopping development processes'
        Stop-ChildProcesses
    }
}

function Start-TauriDev {
    param([string]$NpmPath)

    Write-Step 'Starting Tauri development mode'
    Write-Info 'Frontend uses Vite HMR; Rust shell is debug-built.'
    Write-Info "Profile data: $($script:MyAgentsData)"
    Initialize-TauriBuildEnvironment
    Write-Host ""

    Push-Location $script:RepoRoot
    try {
        & $NpmPath run tauri:dev
        if ($LASTEXITCODE -ne 0) {
            throw "tauri:dev failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

try {
    Assert-PathExists -Path $script:RepoRoot -Description 'repository root'
    Assert-PathExists -Path (Join-Path $script:RepoRoot 'package.json') -Description 'package.json'
    Assert-PathExists -Path $script:TestRoot -Description 'test package root'

    Write-Host ""
    Write-Host "MyAgents development mode (test-package data)" -ForegroundColor Cyan
    Write-Host "  Repository : $($script:RepoRoot)"
    Write-Host "  Test root  : $($script:TestRoot)"
    Write-Host "  Mode       : $Mode"
    Write-Host ""

    Initialize-TestProfileEnv
    if (-not $SkipCleanup) {
        Stop-DevProcesses
    }

    $resolvedAgentDir = Resolve-DefaultAgentDir
    Write-Step 'Using isolated test-package profile'
    Write-Info "MYAGENTS_DATA_DIR=$($env:MYAGENTS_DATA_DIR)"
    Write-Info "HOME/USERPROFILE=$($env:USERPROFILE)"
    Write-Info "Novels=$($script:NovelsRoot)"
    Write-Info "AgentDir=$resolvedAgentDir"

    $npmPath = Get-NpmCommand
    Write-Step 'Preparing Azgaar Fantasy Map Runtime'
    Push-Location $script:RepoRoot
    try {
        & $npmPath run prepare:azgaar-runtime
        if ($LASTEXITCODE -ne 0) {
            throw "Azgaar Runtime preparation failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    if ($Mode -eq 'Web') {
        $nodePath = Get-NodeCommand
        Write-Info "Node=$nodePath"
        Start-WebDev -ResolvedAgentDir $resolvedAgentDir -NodePath $nodePath
    } else {
        Start-TauriDev -NpmPath $npmPath
    }
} catch {
    Write-Host ""
    Write-Host "Failed to start development mode: $($_.Exception.Message)" -ForegroundColor Red
    Stop-ChildProcesses
    exit 1
}
