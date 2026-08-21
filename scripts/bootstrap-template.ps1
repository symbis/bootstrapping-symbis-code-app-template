param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BootstrapArguments
)

$ErrorActionPreference = 'Stop'

function Get-NodeStatus {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 'missing' }
    $Major = & node -p 'Number(process.versions.node.split(".")[0])' 2>$null
    if ($LASTEXITCODE -eq 0 -and [int]$Major -ge 22) { return 'installed' }
    return 'upgradeRequired'
}

function Get-ArgumentValue([string]$Name) {
    for ($Index = 0; $Index -lt $BootstrapArguments.Count; $Index++) {
        if ($BootstrapArguments[$Index] -eq $Name -and $Index + 1 -lt $BootstrapArguments.Count) {
            return $BootstrapArguments[$Index + 1]
        }
    }
    return $null
}

function Get-CommandStatus([string]$Name) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return 'installed' }
    return 'missing'
}

function Get-GnuMakeStatus {
    if (-not (Get-Command make -ErrorAction SilentlyContinue)) { return 'missing' }
    $Output = (& make --version 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0 -and $Output -match '^GNU Make\s+\d') { return 'installed' }
    return 'missing'
}

function Get-DeveloperModeStatus {
    $Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
    $Value = (Get-ItemProperty -LiteralPath $Path -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
    if ($Value -eq 1) { return 'installed' }
    return 'missing'
}

function Get-GitSymlinkStatus {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return 'unknown' }
    $Value = (& git config --global --get core.symlinks 2>$null) -join ''
    if ($LASTEXITCODE -eq 0 -and $Value -eq 'true') { return 'installed' }
    return 'missing'
}

function Add-PlanAction([System.Collections.ArrayList]$Actions, [string]$Id, [bool]$SystemChange = $false, [bool]$Conditional = $false) {
    [void]$Actions.Add([ordered]@{ id = $Id; systemChange = $SystemChange; conditional = $Conditional })
}

$Target = Get-ArgumentValue '--target'
if (-not $Target) { throw '--target is required.' }
if (-not [IO.Path]::IsPathRooted($Target)) { throw '--target must be an absolute path.' }

if ((Get-NodeStatus) -eq 'installed') {
    & node (Join-Path $PSScriptRoot 'bootstrap-template.mjs') @BootstrapArguments
    exit $LASTEXITCODE
}

if ($BootstrapArguments -contains '--plan') {
    $Mode = Get-ArgumentValue '--mode'; if (-not $Mode) { $Mode = 'auto' }
    $Auth = Get-ArgumentValue '--auth'; if (-not $Auth) { $Auth = 'auto' }
    if ($Mode -eq 'auto') {
        if (-not (Test-Path -LiteralPath $Target)) {
            $Mode = 'new'
        } elseif ((Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1).Count -eq 0) {
            $Mode = 'new'
        } elseif ((Test-Path -LiteralPath (Join-Path $Target 'Makefile')) -and (Test-Path -LiteralPath (Join-Path $Target 'package.json'))) {
            $Mode = 'existing'
        } else {
            throw "Target $Target is not empty and is not a recognized template checkout"
        }
    }

    $Prerequisites = [ordered]@{
        winget = Get-CommandStatus 'winget.exe'
        git = Get-CommandStatus 'git'
        node = Get-NodeStatus
        gnuMake = Get-GnuMakeStatus
        azureCli = Get-CommandStatus 'az'
        developerMode = Get-DeveloperModeStatus
        gitSymlinks = Get-GitSymlinkStatus
    }
    $Actions = [System.Collections.ArrayList]::new()
    if ($Mode -eq 'existing') { Add-PlanAction $Actions 'preflight-existing-checkout' }
    if ($Prerequisites.developerMode -ne 'installed') { Add-PlanAction $Actions 'enable-windows-developer-mode' $true }
    if ($Prerequisites.git -ne 'installed') { Add-PlanAction $Actions 'install-git' $true }
    if ($Prerequisites.node -ne 'installed') { Add-PlanAction $Actions 'install-node' $true }
    if ($Prerequisites.gnuMake -ne 'installed') { Add-PlanAction $Actions 'install-gnu-make' $true }
    if ($Auth -eq 'azure-cli' -and $Prerequisites.azureCli -ne 'installed') { Add-PlanAction $Actions 'install-azure-cli' $true }
    if ($Prerequisites.gitSymlinks -ne 'installed') { Add-PlanAction $Actions 'enable-git-symlinks' $true }
    if ($Mode -eq 'new') {
        Add-PlanAction $Actions 'prove-repository-access'; Add-PlanAction $Actions 'clone-template'
        Add-PlanAction $Actions 'verify-symlinks'; Add-PlanAction $Actions 'inspect-safe-chain-choice'
        Add-PlanAction $Actions 'run-make-install'; Add-PlanAction $Actions 'validate-install-drift'
        Add-PlanAction $Actions 'initialize-application-repository'
        if ($Auth -eq 'auto' -and $Prerequisites.azureCli -ne 'installed') { Add-PlanAction $Actions 'conditional-azure-cli-fallback' $false $true }
    } else {
        Add-PlanAction $Actions 'repair-symlinks'; Add-PlanAction $Actions 'resolve-safe-chain-choice'; Add-PlanAction $Actions 'run-make-install'
    }
    $Plan = [ordered]@{
        platform = 'win32'
        mode = $Mode
        target = $Target
        auth = [ordered]@{ strategy = $Auth; attempted = @(); selected = $null; repositoryReadAccess = $null }
        prerequisites = $Prerequisites
        requiresSystemApproval = [bool]($Actions | Where-Object { $_.systemChange } | Select-Object -First 1)
        actions = $Actions
    }
    $Plan | ConvertTo-Json -Depth 6
    exit 0
}

if ($BootstrapArguments -notcontains '--approve-system-changes') {
    throw 'Node.js 22+ is missing. Review --plan and approve the listed system changes before installing Node.'
}
if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Start-Process 'ms-appinstaller:?source=https://aka.ms/getwinget'
    throw 'WinGet is missing. Microsoft App Installer was opened; complete that trusted UI installation and rerun.'
}

& winget.exe install --exact --id OpenJS.NodeJS.LTS --source winget `
    --accept-package-agreements --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw 'Node.js installation through WinGet failed.' }
$env:PATH = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    'C:\Program Files\nodejs',
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')
) -join ';'
if ((Get-NodeStatus) -ne 'installed') { throw 'Node.js 22+ was installed but is not visible yet. Reopen PowerShell and rerun.' }
& node (Join-Path $PSScriptRoot 'bootstrap-template.mjs') @BootstrapArguments
exit $LASTEXITCODE
