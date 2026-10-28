<#
.SYNOPSIS
  Deploys PulseLake end to end: budget guard -> main stack -> web app.
.EXAMPLE
  ./scripts/deploy.ps1 -AlertEmail you@example.com     # first time
  ./scripts/deploy.ps1                                 # later (email remembered)
  ./scripts/deploy.ps1 -WebOnly                        # only rebuild + upload the website
#>
param(
    [string]$Region = "ap-southeast-2",
    [string]$AlertEmail = "",
    [switch]$WebOnly
)
. "$PSScriptRoot\common.ps1"
$script:Region = $Region
Set-Location $Root

$settings = Get-Settings
if ($AlertEmail) { $settings | Add-Member -NotePropertyName AlertEmail -NotePropertyValue $AlertEmail -Force; Save-Settings $settings }
$AlertEmail = $settings.AlertEmail
if (-not $AlertEmail) { throw "First run needs -AlertEmail you@example.com" }

$account = Invoke-Aws sts get-caller-identity --query Account --output text
Write-Host "AWS account $account, region $Region" -ForegroundColor Green

if (-not $WebOnly) {
    Write-Step "1/4 Budget guard stack (pulselake-budget)"
    Invoke-Aws cloudformation deploy --template-file infra/budget.yaml --stack-name pulselake-budget `
        --parameter-overrides "AlertEmail=$AlertEmail" --no-fail-on-empty-changeset | Out-Host

    Write-Step "2/4 Packaging Lambda code"
    $artifacts = "pulselake-artifacts-$account-$Region"
    & $AwsExe s3api head-bucket --bucket $artifacts --region $Region 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Aws s3api create-bucket --bucket $artifacts --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
        Invoke-Aws s3api put-public-access-block --bucket $artifacts `
            --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
    }
    New-Item -ItemType Directory -Force (Join-Path $Root ".build") | Out-Null
    if (-not (Test-Path (Join-Path $Root "web/node_modules"))) {
        Push-Location (Join-Path $Root "web"); try { npm install | Out-Host } finally { Pop-Location }
    }
    # Node.js Lambdas (action dispatcher, Accuracy Lab) are TypeScript bundled with esbuild
    node (Join-Path $Root "scripts/build-lambdas.mjs") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Lambda bundling failed" }
    Invoke-Aws cloudformation package --template-file infra/pulselake.yaml --s3-bucket $artifacts --s3-prefix lambda `
        --output-template-file .build/packaged.yaml | Out-Null

    Write-Step "3/4 Main stack (pulselake) - first run takes ~5-10 min because of CloudFront"
    Invoke-Aws cloudformation deploy --template-file .build/packaged.yaml --stack-name pulselake `
        --capabilities CAPABILITY_NAMED_IAM --s3-bucket $artifacts --s3-prefix templates `
        --parameter-overrides "AlertEmail=$AlertEmail" --no-fail-on-empty-changeset | Out-Host
}

$o = Get-StackOutputs "pulselake"

# Web Push (VAPID) key pair, created once and kept as an encrypted SSM SecureString - never in git
$vapidName = "/pulselake/vapid"
$vapidJson = & $AwsExe ssm get-parameter --name $vapidName --with-decryption --query Parameter.Value --output text --region $Region 2>$null
if ($LASTEXITCODE -ne 0 -or -not $vapidJson) {
    Write-Step "Creating Web Push (VAPID) keys"
    Push-Location (Join-Path $Root "web")
    try { $keys = node -e "const w=require('web-push');console.log(JSON.stringify(w.generateVAPIDKeys()))" | ConvertFrom-Json } finally { Pop-Location }
    $vapidJson = [ordered]@{ publicKey = $keys.publicKey; privateKey = $keys.privateKey; subject = "mailto:$AlertEmail" } | ConvertTo-Json -Compress
    $tmp = Join-Path $Root ".build/vapid.json"
    [IO.File]::WriteAllText($tmp, $vapidJson)
    try { Invoke-Aws ssm put-parameter --name $vapidName --type SecureString --value "file://$tmp" --overwrite | Out-Null }
    finally { Remove-Item $tmp -Force }
}
$vapidPublic = ($vapidJson | ConvertFrom-Json).publicKey

if (-not $WebOnly) {
    # CloudFormation resets the IoT Rule SQL to its base; re-apply the user's Rules & Actions
    try {
        $compiled = Invoke-RestMethod -Method Post -Uri "$($o["AnalyticsUrl"].TrimEnd("/"))/rules/compile" -ContentType "application/json" -Body "{}"
        Write-Host "IoT Rule SQL compiled with $($compiled.userClauses) user rule condition(s)" -ForegroundColor DarkGray
    } catch { Write-Warning "Could not re-compile the rules: $($_.Exception.Message)" }
}

Write-Step "4/4 Website (dashboard + phone app + responder app)"
$iotEndpoint = Invoke-Aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
$config = [ordered]@{
    region         = $Region
    identityPoolId = $o["IdentityPoolId"]
    iotEndpoint    = $iotEndpoint
    analyticsUrl   = $o["AnalyticsUrl"].TrimEnd("/")
    webUrl         = $o["WebUrl"]
    deviceUrl      = "$($o["WebUrl"])/device.html"
    responderUrl   = "$($o["WebUrl"])/responder.html"
    vapidPublicKey = $vapidPublic
    escalationArn  = $o["EscalationStateMachineArn"]
}
New-Item -ItemType Directory -Force (Join-Path $Root "web/public") | Out-Null
[IO.File]::WriteAllText((Join-Path $Root "web/public/config.json"), ($config | ConvertTo-Json))

Push-Location (Join-Path $Root "web")
try {
    npm run build | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "web build failed" }
} finally { Pop-Location }

$bucket = "s3://$($o["WebBucketName"])"
# hashed assets are immutable; pages, config, service worker and manifest must always be fresh
Invoke-Aws s3 sync web/dist $bucket --only-show-errors --delete --exclude "*.html" --exclude "config.json" `
    --exclude "sw.js" --exclude "*.webmanifest" --cache-control "public,max-age=31536000,immutable" | Out-Host
Invoke-Aws s3 sync web/dist $bucket --only-show-errors --exclude "*" --include "*.html" --include "config.json" `
    --include "sw.js" --include "*.webmanifest" --cache-control "no-cache" | Out-Host
Invoke-Aws cloudfront create-invalidation --distribution-id $o["DistributionId"] --paths "/*" --query "Invalidation.Id" --output text | Out-Null

Write-Host ""
Write-Host "Dashboard (PC):    $($o["WebUrl"])" -ForegroundColor Green
Write-Host "Phone app:         $($o["WebUrl"])/device.html" -ForegroundColor Green
Write-Host "Responder app:     $($o["WebUrl"])/responder.html" -ForegroundColor Green
Write-Host "Analytics API:     $($o["AnalyticsUrl"])" -ForegroundColor DarkGray
