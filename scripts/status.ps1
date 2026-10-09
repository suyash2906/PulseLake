<#
.SYNOPSIS
  Shows the money situation: real usage so far (AWS Budgets), current phase cap, kill-switch state.
#>
param([string]$Region = "ap-southeast-2")
. "$PSScriptRoot\common.ps1"
$script:Region = $Region

$account = Invoke-Aws sts get-caller-identity --query Account --output text
$budget = Invoke-Aws budgets describe-budget --account-id $account --budget-name pulselake-total-cap --output json | Out-String | ConvertFrom-Json
$spent = [double]$budget.Budget.CalculatedSpend.ActualSpend.Amount
$phase = Invoke-Aws ssm get-parameter --name /pulselake/phase --query Parameter.Value --output text
$kill = Invoke-Aws ssm get-parameter --name /pulselake/kill-status --query Parameter.Value --output text
$cap = if ($phase -eq "demo") { 22 } else { 9 }

Write-Host ""
Write-Host ("Real usage so far : `${0:N2} of `$25 total (AWS Budgets, can lag up to ~24 h)" -f $spent)
Write-Host ("Phase             : {0}  (kill switch at `${1})" -f $phase, $cap)
Write-Host ("Kill switch       : {0}" -f $kill)
if ($spent -ge $cap) { Write-Host "Over the phase cap!" -ForegroundColor Red }
