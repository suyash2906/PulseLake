<#
.SYNOPSIS
  Switches the spend phase and re-arms the system after the kill switch fired.
  testing = kill switch at $9 real usage, demo = kill switch at $22.
.EXAMPLE
  ./scripts/phase.ps1 -Phase demo
#>
param(
    [Parameter(Mandatory)][ValidateSet("testing", "demo")][string]$Phase,
    [string]$Region = "ap-southeast-2"
)
. "$PSScriptRoot\common.ps1"
$script:Region = $Region

Invoke-Aws ssm put-parameter --name /pulselake/phase --value $Phase --type String --overwrite | Out-Null
Write-Host "Phase set to $Phase" -ForegroundColor Green

# Re-arm: enable every pulselake_* rule and remove the deny policy from the guest role.
$rules = Invoke-Aws iot list-topic-rules --query "rules[?starts_with(ruleName, 'pulselake_')].ruleName" --output json | Out-String | ConvertFrom-Json
foreach ($r in $rules) { Invoke-Aws iot enable-topic-rule --rule-name $r | Out-Null }
Write-Host "Enabled IoT rules: $($rules -join ', ')"

$o = Get-StackOutputs "pulselake"
& $AwsExe iam delete-role-policy --role-name $o["GuestRoleName"] --policy-name pulselake-kill-switch-deny --region $Region 2>$null
Invoke-Aws ssm put-parameter --name /pulselake/kill-status --value ARMED --type String --overwrite | Out-Null
Write-Host "Kill switch re-armed. Phones and dashboard can connect again." -ForegroundColor Green
& "$PSScriptRoot\status.ps1" -Region $Region
