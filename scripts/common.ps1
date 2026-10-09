# Shared helpers for the PulseLake scripts (works in Windows PowerShell 5.1 and PowerShell 7).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$SettingsFile = Join-Path $Root ".pulselake.json"

function Find-AwsCli {
    $cmd = Get-Command aws -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
    if (Test-Path $default) { return $default }
    throw "AWS CLI v2 not found. Install it: winget install Amazon.AWSCLI"
}
$AwsExe = Find-AwsCli

# Runs the AWS CLI in the project region and throws on failure.
function Invoke-Aws {
    $out = & $AwsExe @args --region $script:Region
    if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}

function Get-Settings {
    if (Test-Path $SettingsFile) { return Get-Content $SettingsFile -Raw | ConvertFrom-Json }
    return [pscustomobject]@{}
}

function Save-Settings($obj) {
    [IO.File]::WriteAllText($SettingsFile, ($obj | ConvertTo-Json))
}

function Get-StackOutputs([string]$StackName) {
    $raw = Invoke-Aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs" --output json
    $map = @{}
    foreach ($o in ($raw | Out-String | ConvertFrom-Json)) { $map[$o.OutputKey] = $o.OutputValue }
    return $map
}

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}
