param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BootstrapArguments
)

$ErrorActionPreference = 'Stop'

function Test-SupportedNode {
    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $NodeCommand) { return $false }
    $Major = & node -p 'Number(process.versions.node.split(".")[0])' 2>$null
    return $LASTEXITCODE -eq 0 -and [int]$Major -ge 22
}

function Get-ArgumentValue([string]$Name) {
    for ($Index = 0; $Index -lt $BootstrapArguments.Count; $Index++) {
        if ($BootstrapArguments[$Index] -eq $Name -and $Index + 1 -lt $BootstrapArguments.Count) {
            return $BootstrapArguments[$Index + 1]
        }
    }
    return $null
}

if (Test-SupportedNode) {
    & node (Join-Path $PSScriptRoot 'bootstrap-template.mjs') @BootstrapArguments
    exit $LASTEXITCODE
}

if ($BootstrapArguments -contains '--plan') {
    $RequestedMode = Get-ArgumentValue '--mode'
    if (-not $RequestedMode) { $RequestedMode = 'auto' }
    $Plan = [ordered]@{
        platform = 'win32'
        mode = $RequestedMode
        target = Get-ArgumentValue '--target'
        requiresSystemApproval = $true
        actions = @(
            @{ id = 'enable-windows-developer-mode' },
            @{ id = 'install-node' },
            @{ id = 'continue-bootstrap' }
        )
    }
    $Plan | ConvertTo-Json -Depth 4
    exit 0
}

if ($BootstrapArguments -notcontains '--approve-system-changes') {
    throw 'Node.js 22+ is missing. Review --plan and approve system changes before bootstrapping Node.'
}

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Start-Process 'ms-appinstaller:?source=https://aka.ms/getwinget'
    throw 'WinGet is missing. Microsoft App Installer was opened; complete that trusted UI installation and rerun the same command.'
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

if (-not (Test-SupportedNode)) { throw 'Node.js 22+ was installed but is not visible yet. Reopen PowerShell and rerun the same command.' }
& node (Join-Path $PSScriptRoot 'bootstrap-template.mjs') @BootstrapArguments
exit $LASTEXITCODE
