import { test, expect } from '@playwright/test';
import path from 'path';

const adminUser = process.env.ADMIN_USER || 'filipp';
const adminPassword = process.env.ADMIN_PASSWORD;

test.skip(
  !process.env.RUN_PRODUCTION_MUTATION_TESTS,
  'Production mutation test: uploads/processes documents. Set RUN_PRODUCTION_MUTATION_TESTS=1 to run.'
);
test.skip(
  process.env.RUN_PRODUCTION_MUTATION_TESTS === '1' && !adminPassword,
  'ADMIN_PASSWORD is required for production mutation tests.'
);

// Full document upload and processing test with quality verification
test.describe('Full Document Processing Test', () => {
  test.use({
    baseURL: 'https://avrora-library-production.up.railway.app',
    httpCredentials: {
      username: adminUser,
      password: adminPassword ?? '',
    },
  });

  test('Upload, process, and verify knowledge extraction', async ({ page }) => {
    test.setTimeout(600000); // 10 minutes for full processing

    // Track all network requests and responses
    const failedRequests: string[] = [];
    const serverErrors: Array<{ url: string; status: number; text: string }> = [];
    
    page.on('requestfailed', request => {
      const failure = `${request.method()} ${request.url()} - ${request.failure()?.errorText}`;
      failedRequests.push(failure);
      console.log(`[Request Failed]: ${failure}`);
    });

    page.on('response', async response => {
      const url = response.url();
      const status = response.status();
      
      // Log SSE stream events
      if (url.includes('/process-stream')) {
        console.log(`[SSE Response]: ${status} for ${url}`);
      }
      
      // Capture server errors
      if (status >= 500) {
        try {
          const text = await response.text();
          serverErrors.push({ url, status, text });
          console.log(`[Server Error ${status}]: ${url}`);
          console.log(`Response body: ${text.slice(0, 500)}`);
        } catch {
          console.log(`[Server Error ${status}]: ${url} (couldn't read body)`);
        }
      }
      
      // Capture OOM or memory errors
      if (status === 429 || status === 503) {
        console.log(`⚠️ [Resource Limit?]: ${status} on ${url}`);
      }
    });

    // Log all console messages
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      
      // Always log errors and warnings
      if (type === 'error' || type === 'warning') {
        console.log(`[Console ${type}]: ${text}`);
      }
      
      // Log processing progress
      if (text.includes('Phase') || text.includes('batch') || text.includes('Batch')) {
        console.log(`[Console log]: ${text}`);
      }
      
      // Log OOM indicators
      if (text.toLowerCase().includes('memory') || text.toLowerCase().includes('oom')) {
        console.log(`🔴 [Memory Issue]: ${text}`);
      }
    });

    // Step 1: Navigate to documents page
    console.log('\n=== STEP 1: Navigate to Documents ===');
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/full-test-01-documents.png' });
    console.log('Documents page loaded');

    // Step 2: Upload document
    console.log('\n=== STEP 2: Upload Document ===');
    const sampleDocPath = path.resolve(__dirname, '../sample/Инструкция по услугам Олега.docx');
    console.log('Uploading:', sampleDocPath);
    
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(sampleDocPath);
    
    // Wait for upload response
    await page.waitForTimeout(3000);
    console.log('Document uploaded, waiting for processing dialog...');

    // Step 3: Wait for processing terminal to appear
    console.log('\n=== STEP 3: Monitor Processing ===');
    
    // Wait for Librarian Terminal to appear (modal with processing)
    const terminalSelector = 'text=LIBRARIAN AI TERMINAL';
    try {
      await page.waitForSelector(terminalSelector, { timeout: 10000 });
      console.log('Librarian Terminal opened');
      await page.screenshot({ path: 'test-results/full-test-02-terminal-start.png' });
    } catch {
      console.log('Terminal not found, taking screenshot of current state');
      await page.screenshot({ path: 'test-results/full-test-02-no-terminal.png' });
    }

    // Monitor processing phases
    const phases = [
      'Классификация доменов',
      'Извлечение знаний',
      'Разбиение на чанки',
    ];

    for (const phase of phases) {
      console.log(`Waiting for phase: ${phase}...`);
      try {
        await page.waitForSelector(`text=${phase}`, { timeout: 120000 });
        console.log(`✓ Phase started: ${phase}`);
        await page.screenshot({ path: `test-results/full-test-phase-${phases.indexOf(phase)}.png` });
      } catch {
        console.log(`⚠ Phase not detected: ${phase}`);
      }
    }

    // Wait for completion (look for COMPLETED status or success message)
    console.log('\n=== STEP 4: Wait for Completion ===');
    let processingCompleted = false;
    try {
      await page.waitForSelector('text=COMPLETED', { timeout: 300000 }); // 5 min
      console.log('✓ Processing completed successfully!');
      processingCompleted = true;
    } catch {
      console.log('⚠️ Completion status not found within timeout');
      
      // Check for error messages in the UI
      const errorText = await page.locator('text=/error|ошибка|failed/i').first().textContent().catch(() => null);
      if (errorText) {
        console.log(`🔴 Error found in UI: ${errorText}`);
      }
    }
    
    await page.screenshot({ path: 'test-results/full-test-03-completion.png' });

    // Report network issues
    if (failedRequests.length > 0) {
      console.log('\n🔴 Failed Requests:');
      failedRequests.forEach(req => console.log(`  - ${req}`));
    }
    
    if (serverErrors.length > 0) {
      console.log('\n🔴 Server Errors:');
      serverErrors.forEach(err => {
        console.log(`  - ${err.status} ${err.url}`);
        console.log(`    ${err.text.slice(0, 200)}`);
      });
    }
    
    if (!processingCompleted) {
      console.log('\n⚠️ Processing did not complete - check Railway logs for OOM or timeout');
      // Continue test to capture current state
    }

    // Close terminal if open
    const closeButton = page.locator('button:has-text("×"), button:has-text("Закрыть")').first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(1000);
    }

    // Reload documents page
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/full-test-04-documents-final.png' });

    // Step 5: Verify extracted knowledge
    console.log('\n=== STEP 5: Verify Extracted Knowledge ===');

    // Check Rules
    console.log('\n--- Checking Rules ---');
    await page.click('text=Правила');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/full-test-05-rules.png' });
    
    const rulesCount = await page.locator('table tbody tr').count();
    console.log(`Found ${rulesCount} rules extracted`);

    // Check Q&A pairs
    console.log('\n--- Checking Q&A Pairs ---');
    await page.click('text=Вопросы и ответы');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/full-test-06-qa.png' });
    
    const qaCount = await page.locator('table tbody tr, .qa-item, [class*="qa"]').count();
    console.log(`Found ${qaCount} Q&A pairs extracted`);

    // Check Domains
    console.log('\n--- Checking Domains ---');
    await page.click('text=Домены');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/full-test-07-domains.png' });

    // Final summary
    console.log('\n=== TEST COMPLETE ===');
    console.log('Screenshots saved in test-results/');
    console.log('Review screenshots for quality assessment');
    console.log('\n--- Final Statistics ---');
    console.log(`Rules extracted: ${rulesCount}`);
    console.log(`Q&A pairs: ${qaCount}`);
    console.log(`Failed requests: ${failedRequests.length}`);
    console.log(`Server errors: ${serverErrors.length}`);
    console.log(`Processing completed: ${processingCompleted ? '✅ YES' : '❌ NO'}`);
    
    // Assertions
    if (!processingCompleted) {
      console.log('\n⚠️ WARNING: Processing incomplete - likely OOM or timeout on Railway');
      console.log('Check Railway logs: https://railway.app/project/<your-project>/deployments');
    }
    
    expect(processingCompleted).toBe(true);
    expect(rulesCount).toBeGreaterThan(0);
  });
});
