<#
.SYNOPSIS
  Wipes all TEST DATA before the demo, keeps the deployed system.
  Deletes: lake files (bronze/silver/athena results), Silver table + Gold views,
  device states + alert history (DynamoDB), device shadows, ETL/load-test status.
.EXAMPLE
  ./scripts/reset-data.ps1          # asks for confirmation
  ./scripts/reset-data.ps1 -Yes
#>
param(
    [string]$Region = "ap-southeast-2",
    [switch]$Yes
)
. "$PSScriptRoot\common.ps1"
$script:Region = $Region

if (-not $Yes) {
    $answer = Read-Host "This deletes ALL recorded data (lake, alerts, device states). Type RESET to continue"
    if ($answer -ne "RESET") { Write-Host "Cancelled."; exit 1 }
}
$o = Get-StackOutputs "pulselake"
$lake = $o["LakeBucketName"]
$db = $o["GlueDatabaseName"]

Write-Step "Emptying the data lake (bucket stays)"
foreach ($prefix in "bronze/", "silver/", "athena-results/", "errors/") {
    Invoke-Aws s3 rm "s3://$lake/$prefix" --recursive --only-show-errors | Out-Null
}

Write-Step "Dropping Silver table and Gold views (the ETL rebuilds them)"
foreach ($t in "silver_telemetry", "gold_device_hourly", "gold_fleet_health", "gold_alert_summary") {
    & $AwsExe glue delete-table --database-name $db --name $t --region $Region 2>$null
}

Write-Step "Clearing DynamoDB device states and alert history"
foreach ($table in @(@{ Name = "pulselake-devices"; Keys = @("deviceId") }, @{ Name = "pulselake-alerts"; Keys = @("pk", "sk") })) {
    $proj = ($table.Keys -join ",")
    $items = Invoke-Aws dynamodb scan --table-name $table.Name --projection-expression $proj --output json | Out-String | ConvertFrom-Json
    foreach ($item in $items.Items) {
        $key = @{}
        foreach ($k in $table.Keys) { $key[$k] = @{ S = $item.$k.S } }
        $keyFile = Join-Path $env:TEMP "pulselake-key.json"
        [IO.File]::WriteAllText($keyFile, ($key | ConvertTo-Json -Compress))
        Invoke-Aws dynamodb delete-item --table-name $table.Name --key "file://$keyFile" | Out-Null
    }
    Write-Host "  $($table.Name): deleted $($items.Items.Count) items"
}

Write-Step "Deleting device shadows"
$endpoint = Invoke-Aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
foreach ($thing in "PHONE_01", "PHONE_02", "PHONE_03", "PHONE_04") {
    & $AwsExe iot-data delete-thing-shadow --thing-name $thing --endpoint-url "https://$endpoint" --region $Region (Join-Path $env:TEMP "shadow-out.json") 2>$null | Out-Null
}

Write-Step "Resetting ETL and load-test status"
Invoke-Aws ssm put-parameter --name /pulselake/etl-status --value '{"state":"NEVER_RUN"}' --type String --overwrite | Out-Null
Invoke-Aws ssm put-parameter --name /pulselake/sim-status --value '{"state":"NEVER_RUN"}' --type String --overwrite | Out-Null

Write-Host ""
Write-Host "Clean slate. Reload the dashboard - everything starts from zero." -ForegroundColor Green
