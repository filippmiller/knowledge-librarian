# Run full Playwright test with Railway log monitoring
# This script runs both the test and log monitor in parallel

Write-Host "Full Upload Test with Railway Monitoring" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
$playwrightInstalled = Test-Path "node_modules/@playwright"
if (-not $playwrightInstalled) {
    Write-Host "ERROR: Playwright not installed. Run: npm install" -ForegroundColor Red
    exit 1
}

Write-Host "Prerequisites OK" -ForegroundColor Green
Write-Host ""

# Create test-results directory
New-Item -ItemType Directory -Force -Path "test-results" | Out-Null

Write-Host "Test Plan:" -ForegroundColor Yellow
Write-Host "  1. Start Railway log monitoring" -ForegroundColor Gray
Write-Host "  2. Run Playwright full upload test" -ForegroundColor Gray
Write-Host "  3. Capture screenshots and logs" -ForegroundColor Gray
Write-Host "  4. Generate report" -ForegroundColor Gray
Write-Host ""

# Start Railway log monitor in background job
Write-Host "Starting Railway log monitor..." -ForegroundColor Cyan
$railwayJob = Start-Job -ScriptBlock {
    Set-Location $using:PWD
    & ".\scripts\monitor-railway-logs.ps1"
}

Start-Sleep -Seconds 2

if ($railwayJob.State -eq "Running") {
    Write-Host "Railway monitor started (Job ID: $($railwayJob.Id))" -ForegroundColor Green
} else {
    Write-Host "WARNING: Railway monitor not running - check Railway CLI" -ForegroundColor Yellow
    Write-Host "   Continuing with test anyway..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Starting Playwright test..." -ForegroundColor Cyan
Write-Host ""

# Run Playwright test
try {
    npx playwright test tests/full-upload-test.spec.ts --headed --reporter=list
    
    Write-Host ""
    Write-Host "Test completed!" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "Test failed!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
    # Stop Railway monitor
    if ($railwayJob) {
        Write-Host ""
        Write-Host "Stopping Railway monitor..." -ForegroundColor Yellow
        Stop-Job $railwayJob
        Remove-Job $railwayJob
    }
}

Write-Host ""
Write-Host "Test Results:" -ForegroundColor Cyan
Write-Host "  Screenshots: test-results/*.png" -ForegroundColor Gray
Write-Host "  Test report: See console output above" -ForegroundColor Gray
Write-Host ""

# Open test results folder
$openResults = Read-Host "Open test-results folder? (y/n)"
if ($openResults -eq 'y') {
    Invoke-Item "test-results"
}

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
