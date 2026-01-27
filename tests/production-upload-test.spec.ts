import { test, expect } from '@playwright/test';
import path from 'path';

// Production test for document upload and processing
test.describe('Production Document Upload Test', () => {
  test.use({
    baseURL: 'https://avrora-library-production.up.railway.app',
    // Set up HTTP Basic Auth
    httpCredentials: {
      username: 'filippmiller@gmail.com',
      password: 'Airbus380+',
    },
  });

  test('Upload and process sample document', async ({ page }) => {
    // Set longer timeout for production environment
    test.setTimeout(300000); // 5 minutes

    // Log all console messages
    page.on('console', msg => {
      console.log(`[Browser Console ${msg.type()}]: ${msg.text()}`);
    });
    
    // Log all network errors
    page.on('requestfailed', request => {
      console.log(`[Network Error]: ${request.url()} - ${request.failure()?.errorText}`);
    });

    // Go to admin panel with Basic Auth
    console.log('Navigating to admin panel...');
    await page.goto('/admin');
    await page.waitForLoadState('networkidle');
    
    // Navigate to documents page
    console.log('Navigating to documents page...');
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/01-documents-page-before.png' });
    
    // Find file upload input and upload a sample document
    const sampleDocPath = path.resolve(__dirname, '../sample/Инструкция по СОН МВД СПб.docx');
    console.log('Uploading document from:', sampleDocPath);
    
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(sampleDocPath);
    
    // Wait for upload to complete and document to appear in the list
    console.log('Waiting for upload to complete...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'test-results/02-after-upload.png' });
    
    // Reload the page to ensure document appears
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/03-after-reload.png' });
    
    // Look for the uploaded document in the list
    console.log('Looking for uploaded document...');
    const documentLink = page.locator('a:has-text("Инструкция по СОН МВД СПб")').first();
    
    // Wait for the document to appear with extended timeout
    await expect(documentLink).toBeVisible({ timeout: 30000 });
    console.log('Document found in list!');
    
    // Click on the document link to go to its page
    await documentLink.click();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/04-document-page.png' });
    
    // Find and click the "Терминал" button to open processing modal
    const terminalButton = page.locator('button:has-text("Терминал")');
    if (await terminalButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Clicking Terminal button...');
      await terminalButton.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'test-results/05-terminal-modal.png' });
      
      // Look for "Запустить" (Start) button
      const startButton = page.locator('button:has-text("Запустить")');
      if (await startButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('Clicking Start button...');
        await startButton.click();
        
        // Monitor processing with detailed logging
        const startTime = Date.now();
        const maxWaitTime = 240000; // 4 minutes
        let lastScreenshot = 0;
        
        while (Date.now() - startTime < maxWaitTime) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          
          // Take screenshots every 15 seconds
          if (elapsed - lastScreenshot >= 15) {
            lastScreenshot = elapsed;
            await page.screenshot({ 
              path: `test-results/06-processing-${elapsed}s.png`,
              fullPage: true 
            });
            console.log(`[${elapsed}s] Screenshot taken`);
          }
          
          // Check for completion
          const completeText = page.locator('text=ОБРАБОТКА ЗАВЕРШЕНА');
          if (await completeText.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`Processing completed successfully after ${elapsed}s!`);
            await page.screenshot({ path: 'test-results/07-processing-complete.png', fullPage: true });
            break;
          }
          
          // Check for disconnection/reconnection messages
          const disconnectedText = page.locator('text=Соединение потеряно');
          if (await disconnectedText.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`[${elapsed}s] WARNING: Connection lost detected!`);
          }
          
          // Check for reconnection
          const reconnectingText = page.locator('text=Переподключение');
          if (await reconnectingText.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`[${elapsed}s] INFO: Reconnecting...`);
          }
          
          // Check for fatal errors
          const errorText = page.locator('text=КРИТИЧЕСКАЯ ОШИБКА');
          if (await errorText.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`[${elapsed}s] FATAL ERROR detected!`);
            await page.screenshot({ path: 'test-results/08-fatal-error.png', fullPage: true });
            break;
          }
          
          await page.waitForTimeout(1000);
        }
        
        // Final screenshot
        await page.screenshot({ path: 'test-results/09-final-state.png', fullPage: true });
        console.log('Test completed');
      } else {
        console.log('Start button not found');
        await page.screenshot({ path: 'test-results/no-start-button.png' });
      }
    } else {
      console.log('Terminal button not found - looking for process button...');
      const processButton = page.locator('button:has-text("Обработать"), button:has-text("Переобработать")');
      if (await processButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('Found process button, clicking...');
        await processButton.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'test-results/process-button-clicked.png' });
      } else {
        console.log('No process or terminal button found');
        await page.screenshot({ path: 'test-results/no-buttons-found.png' });
      }
    }
  });
});
