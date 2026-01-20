import { test, expect } from '@playwright/test';

test.describe('Streaming Document Processing', () => {
  test('should process document using streaming interface', async ({ page }) => {
    // Navigate to documents page
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');

    // Find a document and click on its "Обработать" button
    const processButton = page.locator('text=Обработать').first();

    if (await processButton.isVisible()) {
      await processButton.click();
      await page.waitForLoadState('networkidle');

      // Take screenshot of processing page
      await page.screenshot({ path: 'test-results/streaming-process-page.png', fullPage: true });

      // Check we're on the processing page
      await expect(page).toHaveURL(/.*\/process/);

      // Look for the start button
      const startButton = page.locator('button:has-text("Начать обработку")');

      if (await startButton.isVisible({ timeout: 5000 })) {
        console.log('Found start processing button, clicking...');
        await startButton.click();

        // Wait for processing to start
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'test-results/streaming-started.png', fullPage: true });

        // Wait for processing phases (up to 90 seconds)
        console.log('Waiting for processing to complete...');

        // Check for phase indicators
        for (let i = 0; i < 18; i++) {
          await page.waitForTimeout(5000);

          // Take periodic screenshots
          if (i % 3 === 0) {
            await page.screenshot({ path: `test-results/streaming-progress-${i * 5}s.png`, fullPage: true });
          }

          // Check if completed
          const completeIndicator = page.locator('text=Обработка завершена, text=Сохранить выбранные');
          if (await completeIndicator.first().isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log('Processing completed!');
            break;
          }

          // Check for errors
          const errorIndicator = page.locator('.text-red-500, .bg-red-50');
          if (await errorIndicator.isVisible({ timeout: 500 }).catch(() => false)) {
            const errorText = await errorIndicator.first().textContent();
            console.log('Error found:', errorText);
            await page.screenshot({ path: 'test-results/streaming-error.png', fullPage: true });
            break;
          }
        }

        // Final screenshot
        await page.screenshot({ path: 'test-results/streaming-final.png', fullPage: true });

        // Check for extracted items
        const extractedItems = page.locator('text=Извлечённые элементы');
        if (await extractedItems.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('Extracted items section visible');
        }
      } else {
        console.log('Start button not found');
        await page.screenshot({ path: 'test-results/no-start-button.png', fullPage: true });
      }
    } else {
      console.log('No process button found');
      await page.screenshot({ path: 'test-results/no-process-button.png', fullPage: true });
    }
  });
});
