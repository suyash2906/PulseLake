<#
.SYNOPSIS
  Deletes EVERYTHING PulseLake created (run after the evaluation). Data in the lake is lost.
.EXAMPLE
  ./scripts/teardown.ps1            # asks for confirmation
  ./scripts/teardown.ps1 -KeepBudget  # keep the budget alerts stack
#>
param(
    [string]$Region = "ap-southeast-2",
    [switch]$KeepBudget,
    [switch]$Yes
)
. "$PSScriptRoot\common.ps1"
$script:Region = $Region

if (-not $Yes) {
    $answer = Read-Host "This deletes the whole PulseLake deployment and all lake data. Type DELETE to continue"
    if ($answer -ne "DELETE") { Write-Host "Cancelled."; exit 1 }
}
$account = Invoke-Aws sts get-caller-identity --query Account --output text

function Clear-Bucket([string]$name) {
    & $AwsExe s3api head-bucket --bucket $name --region $Region 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Emptying s3://$name"
        Invoke-Aws s3 rm "s3://$name" --recursive | Out-Null
    }
}

Write-Step "Emptying buckets"
Clear-Bucket "pulselake-web-$account-$Region"
Clear-Bucket "pulselake-lake-$account-$Region"

Write-Step "Deleting stack pulselake (CloudFront deletion takes a few minutes)"
Invoke-Aws cloudformation delete-stack --stack-name pulselake | Out-Null
Invoke-Aws cloudformation wait stack-delete-complete --stack-name pulselake | Out-Null

if (-not $KeepBudget) {
    Write-Step "Deleting stack pulselake-budget"
    Invoke-Aws cloudformation delete-stack --stack-name pulselake-budget | Out-Null
    Invoke-Aws cloudformation wait stack-delete-complete --stack-name pulselake-budget | Out-Null
}

Write-Step "Deleting artifacts bucket"
Clear-Bucket "pulselake-artifacts-$account-$Region"
& $AwsExe s3api delete-bucket --bucket "pulselake-artifacts-$account-$Region" --region $Region 2>$null

Write-Host "PulseLake removed. Nothing left that can cost money." -ForegroundColor Green
