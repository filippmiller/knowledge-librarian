# Check all prerequisites for running full document processing test

Write-Host "Checking Prerequisites" -ForegroundColor Cyan
Write-Host "======================" -ForegroundColor Cyan
Write-Host ""

$allGood = $true

# Check Node.js
Write-Host "Checking Node.js..." -NoNewline
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVersion = node --version
    Write-Host " OK $nodeVersion" -ForegroundColor Green
} else {
    Write-Host " MISSING" -ForegroundColor Red
    $allGood = $false
}

# Check npm
Write-Host "Checking npm..." -NoNewline
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
    $npmVersion = npm --version
    Write-Host " OK $npmVersion" -ForegroundColor Green
} else {
    Write-Host " MISSING" -ForegroundColor Red
    $allGood = $false
}

# Check package.json
Write-Host "Checking package.json..." -NoNewline
if (Test-Path "package.json") {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " MISSING" -ForegroundColor Red
    $allGood = $false
}

# Check node_modules
Write-Host "Checking node_modules..." -NoNewline
if (Test-Path "node_modules") {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " MISSING (run: npm install)" -ForegroundColor Red
    $allGood = $false
}

# Check Playwright
Write-Host "Checking Playwright..." -NoNewline
if (Test-Path "node_modules/@playwright") {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " MISSING (run: npm install)" -ForegroundColor Red
    $allGood = $false
}

# Check Railway CLI
Write-Host "Checking Railway CLI..." -NoNewline
$railway = Get-Command railway -ErrorAction SilentlyContinue
if ($railway) {
    Write-Host " OK" -ForegroundColor Green
    
    # Check Railway auth
    Write-Host "Checking Railway auth..." -NoNewline
    try {
        $railwayStatus = railway whoami 2>&1
        if ($railwayStatus -match "logged in|authenticated") {
            Write-Host " OK" -ForegroundColor Green
        } else {
            Write-Host " NOT AUTHENTICATED (run: railway login)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host " NOT AUTHENTICATED (run: railway login)" -ForegroundColor Yellow
    }
} else {
    Write-Host " OPTIONAL (install: npm install -g @railway/cli)" -ForegroundColor Yellow
}

# Check test document
Write-Host "Checking sample docs..." -NoNewline
if (Test-Path "sample") {
    $sampleFiles = Get-ChildItem "sample" -Filter "*.docx" -ErrorAction SilentlyContinue
    if ($sampleFiles) {
        Write-Host " OK ($($sampleFiles.Count) file(s))" -ForegroundColor Green
    } else {
        Write-Host " WARNING (no docx files)" -ForegroundColor Yellow
    }
} else {
    Write-Host " WARNING (no sample dir)" -ForegroundColor Yellow
}

# Check test-results directory
Write-Host "Checking test-results..." -NoNewline
if (Test-Path "test-results") {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " Creating..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path "test-results" | Out-Null
    Write-Host " OK (created)" -ForegroundColor Green
}

# Check scripts
Write-Host "Checking scripts..." -NoNewline
if (Test-Path "scripts\run-full-test-with-monitoring.ps1") {
    Write-Host " OK" -ForegroundColor Green
} else {
    Write-Host " MISSING" -ForegroundColor Red
    $allGood = $false
}

Write-Host ""
Write-Host "================================" -ForegroundColor Gray

if ($allGood) {
    Write-Host "All critical prerequisites met!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Ready to run:" -ForegroundColor Cyan
    Write-Host "  .\scripts\run-full-test-with-monitoring.ps1" -ForegroundColor Yellow
} else {
    Write-Host "Some prerequisites missing" -ForegroundColor Red
    Write-Host ""
    Write-Host "Install missing items and run again" -ForegroundColor Yellow
}

Write-Host ""
