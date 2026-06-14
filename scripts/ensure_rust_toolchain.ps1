param(
    [string[]]$Targets = @()
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ToolchainFile = Join-Path $ProjectDir "rust-toolchain.toml"

function Refresh-ProcessPath {
    $pathValues = @(
        [Environment]::GetEnvironmentVariable("Path", "Process"),
        [Environment]::GetEnvironmentVariable("Path", "Machine"),
        [Environment]::GetEnvironmentVariable("Path", "User")
    )
    if ($env:USERPROFILE) {
        $pathValues += (Join-Path $env:USERPROFILE ".cargo\bin")
    }

    $seen = @{}
    $segments = @()
    foreach ($pathValue in $pathValues) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) { continue }
        foreach ($part in ($pathValue -split ';')) {
            $trimmed = $part.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
            $key = $trimmed.TrimEnd('\').ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                $segments += $trimmed
            }
        }
    }

    $env:Path = ($segments -join ';')
}

function Require-CommandPath {
    param([string]$Name, [string]$InstallHint)
    Refresh-ProcessPath
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$Name is required. $InstallHint"
    }
    return $cmd.Source
}

if (-not (Test-Path $ToolchainFile)) {
    throw "rust-toolchain.toml not found: $ToolchainFile"
}

$RustupExe = Require-CommandPath "rustup" "Install Rust via https://rustup.rs, then rerun setup/build."

$ToolchainText = Get-Content $ToolchainFile -Raw
if ($ToolchainText -notmatch 'channel\s*=\s*"([^"]+)"') {
    throw "Cannot parse Rust channel from rust-toolchain.toml"
}
$RustToolchain = $Matches[1]

$Components = @()
if ($ToolchainText -match 'components\s*=\s*\[([^\]]*)\]') {
    $Components = [regex]::Matches($Matches[1], '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
}
if ($Components.Count -eq 0) {
    $Components = @("rustfmt", "clippy")
}

Write-Host "  Rust toolchain: $RustToolchain" -ForegroundColor Cyan
& $RustupExe toolchain install $RustToolchain --profile minimal
if ($LASTEXITCODE -ne 0) {
    throw "rustup toolchain install $RustToolchain failed"
}

foreach ($Component in $Components) {
    Write-Host "  Rust component: $Component" -ForegroundColor Cyan
    & $RustupExe component add $Component --toolchain $RustToolchain
    if ($LASTEXITCODE -ne 0) {
        throw "rustup component add $Component --toolchain $RustToolchain failed"
    }
}

foreach ($Target in $Targets) {
    if ([string]::IsNullOrWhiteSpace($Target)) { continue }
    Write-Host "  Rust target: $Target" -ForegroundColor Cyan
    & $RustupExe target add $Target --toolchain $RustToolchain
    if ($LASTEXITCODE -ne 0) {
        throw "rustup target add $Target --toolchain $RustToolchain failed"
    }
}

$CargoExe = Require-CommandPath "cargo" "Install Rust via rustup."
& $CargoExe "+$RustToolchain" --version | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "cargo +$RustToolchain is not usable"
}

if ($Components -contains "rustfmt") {
    $RustfmtExe = Require-CommandPath "rustfmt" "Run this script after rustup installs the rustfmt component."
    & $RustfmtExe "+$RustToolchain" --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "rustfmt +$RustToolchain is not usable"
    }
}

if ($Components -contains "clippy") {
    & $CargoExe "+$RustToolchain" clippy --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "cargo +$RustToolchain clippy is not usable"
    }
}

Write-Host "  OK - Rust toolchain ready" -ForegroundColor Green
