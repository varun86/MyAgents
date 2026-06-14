param(
    [string[]]$Targets = @()
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ToolchainFile = Join-Path $ProjectDir "rust-toolchain.toml"

if (-not (Test-Path $ToolchainFile)) {
    throw "rust-toolchain.toml not found: $ToolchainFile"
}

if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    throw "rustup is required. Install Rust via https://rustup.rs, then rerun setup/build."
}

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
& rustup toolchain install $RustToolchain --profile minimal
if ($LASTEXITCODE -ne 0) {
    throw "rustup toolchain install $RustToolchain failed"
}

foreach ($Component in $Components) {
    Write-Host "  Rust component: $Component" -ForegroundColor Cyan
    & rustup component add $Component --toolchain $RustToolchain
    if ($LASTEXITCODE -ne 0) {
        throw "rustup component add $Component --toolchain $RustToolchain failed"
    }
}

foreach ($Target in $Targets) {
    if ([string]::IsNullOrWhiteSpace($Target)) { continue }
    Write-Host "  Rust target: $Target" -ForegroundColor Cyan
    & rustup target add $Target --toolchain $RustToolchain
    if ($LASTEXITCODE -ne 0) {
        throw "rustup target add $Target --toolchain $RustToolchain failed"
    }
}

& cargo "+$RustToolchain" --version | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "cargo +$RustToolchain is not usable"
}

if ($Components -contains "rustfmt") {
    & rustfmt "+$RustToolchain" --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "rustfmt +$RustToolchain is not usable"
    }
}

if ($Components -contains "clippy") {
    & cargo "+$RustToolchain" clippy --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "cargo +$RustToolchain clippy is not usable"
    }
}

Write-Host "  OK - Rust toolchain ready" -ForegroundColor Green
