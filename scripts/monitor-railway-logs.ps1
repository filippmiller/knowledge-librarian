# Monitor Railway logs in real-time during testing
# Run this in a separate terminal while running Playwright tests

Write-Host "Railway Log Monitor" -ForegroundColor Cyan
Write-Host "===================" -ForegroundColor Cyan
Write-Host ""

# Check if railway CLI is installed
$railwayInstalled = Get-Command railway -ErrorAction SilentlyContinue

if (-not $railwayInstalled) {
    Write-Host "ERROR: Railway CLI not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Install it with: npm install -g @railway/cli" -ForegroundColor Yellow
    Write-Host "Then run: railway login" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Alternative: View logs at https://railway.app/project/your-project/deployments" -ForegroundColor Yellow
    exit 1
}

Write-Host "Railway CLI found" -ForegroundColor Green
Write-Host ""
Write-Host "Starting log stream..." -ForegroundColor Yellow
Write-Host "Watch for:" -ForegroundColor Yellow
Write-Host "  - OOM errors (out of memory)" -ForegroundColor Red
Write-Host "  - Batch progress messages" -ForegroundColor Cyan
Write-Host "  - Phase completion logs" -ForegroundColor Green
Write-Host "  - GC (garbage collection) logs" -ForegroundColor Magenta
Write-Host ""
Write-Host "Press Ctrl+C to stop monitoring" -ForegroundColor Gray
Write-Host "================================" -ForegroundColor Gray
Write-Host ""

# Stream logs with highlighting
railway logs --follow | ForEach-Object {
    $line = $_
    
    # Highlight different log types
    if ($line -match "error|Error|ERROR|OOM|out of memory") {
        Write-Host $line -ForegroundColor Red
    }
    elseif ($line -match "batch|Batch|BATCH") {
        Write-Host $line -ForegroundColor Cyan
    }
    elseif ($line -match "complete|Complete|COMPLETE|success") {
        Write-Host $line -ForegroundColor Green
    }
    elseif ($line -match "GC|garbage|memory") {
        Write-Host $line -ForegroundColor Magenta
    }
    elseif ($line -match "warning|Warning|WARN") {
        Write-Host $line -ForegroundColor Yellow
    }
    elseif ($line -match "phase|Phase|PHASE") {
        Write-Host $line -ForegroundColor Blue
    }
    else {
        Write-Host $line -ForegroundColor Gray
    }
}
