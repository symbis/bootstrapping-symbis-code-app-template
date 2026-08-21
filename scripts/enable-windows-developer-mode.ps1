param(
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$RegistryPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$RegistryName = 'AllowDevelopmentWithoutDevLicense'

function Test-DeveloperMode {
    if (-not (Test-Path -LiteralPath $RegistryPath)) { return $false }
    $Value = (Get-ItemProperty -LiteralPath $RegistryPath -Name $RegistryName -ErrorAction SilentlyContinue).$RegistryName
    return $Value -eq 1
}

if (Test-DeveloperMode) {
    Write-Host 'Windows Developer Mode is enabled.'
    exit 0
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
$IsAdministrator = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdministrator) {
    if ($Elevated) { throw 'Developer Mode requires administrator rights.' }
    $Arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        '-Elevated'
    )
    $Process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $Arguments -Wait -PassThru
    if ($Process.ExitCode -ne 0) { throw 'Developer Mode was not enabled. The UAC prompt may have been cancelled or policy blocked the change.' }
    exit 0
}

New-Item -Path $RegistryPath -Force | Out-Null
New-ItemProperty -LiteralPath $RegistryPath -Name $RegistryName -PropertyType DWord -Value 1 -Force | Out-Null

if (-not (Test-DeveloperMode)) { throw 'Developer Mode registry verification failed.' }
Write-Host 'Windows Developer Mode is enabled.'
