import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Document Processing', () => {
  test('should upload document and navigate to processing page', async ({ page }) => {
    // Navigate to documents page
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');

    // Take screenshot before upload
    await page.screenshot({ path: 'test-results/before-upload.png', fullPage: true });

    // Upload document
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    const documentPath = 'C:\\dev\\translation\\documents\\Инструкция_по_продаже_миграционных_услуг_с_ценами.docx';
    await fileInput.setInputFiles(documentPath);

    // Wait for upload to complete
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle');

    // Take screenshot after upload
    await page.screenshot({ path: 'test-results/after-upload.png', fullPage: true });

    // Check if document appears in the list (look for the filename or title)
    const docRow = page.locator('text=Инструкция').first();
    await expect(docRow).toBeVisible({ timeout: 10000 });

    console.log('Document uploaded successfully');
  });

  test('should process uploaded document', async ({ page }) => {
    // Navigate to documents page
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');

    // Find the document row with "Инструкция" in the name
    const docLink = page.locator('a:has-text("Инструкция")').first();

    if (await docLink.isVisible()) {
      // Click on "Обработать" button for this document
      const docRow = page.locator('tr', { has: page.locator('text=Инструкция') }).first();
      const processButton = docRow.locator('text=Обработать');

      if (await processButton.isVisible()) {
        await processButton.click();
        await page.waitForLoadState('networkidle');

        // Take screenshot of processing page
        await page.screenshot({ path: 'test-results/processing-page.png', fullPage: true });

        // Check we're on the processing page
        await expect(page).toHaveURL(/.*\/process/);

        // Look for processing UI elements
        const startButton = page.locator('text=Начать обработку');
        if (await startButton.isVisible()) {
          console.log('Found start processing button');

          // Click to start processing
          await startButton.click();

          // Wait for processing to start
          await page.waitForTimeout(5000);

          // Take screenshot during processing
          await page.screenshot({ path: 'test-results/processing-in-progress.png', fullPage: true });

          // Wait for processing phases (up to 2 minutes)
          await page.waitForTimeout(30000);

          // Take screenshot after some processing
          await page.screenshot({ path: 'test-results/processing-progress.png', fullPage: true });

          // Check for any error messages
          const errorElement = page.locator('.text-red-500, .text-red-600, .bg-red-50');
          if (await errorElement.isVisible()) {
            const errorText = await errorElement.textContent();
            console.log('Error found:', errorText);
          }

          // Check for extracted items
          const extractedItems = page.locator('text=Извлечённые элементы');
          if (await extractedItems.isVisible()) {
            console.log('Extracted items section visible');
          }
        }
      } else {
        console.log('Process button not found, taking screenshot');
        await page.screenshot({ path: 'test-results/no-process-button.png', fullPage: true });
      }
    } else {
      console.log('Document not found in list');
      await page.screenshot({ path: 'test-results/document-not-found.png', fullPage: true });
    }
  });
});
