import { test, expect } from '@playwright/test';

test.describe('Reprocess Document', () => {
  test('should reprocess document using streaming interface', async ({ page }) => {
    // Navigate directly to the first document's process page
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');

    // Get the first document's ID from the page
    const docLink = page.locator('a[href*="/admin/documents/"]').first();
    const href = await docLink.getAttribute('href');
    console.log('Document link:', href);

    if (href) {
      // Navigate to the process page for this document
      const processUrl = href + '/process';
      console.log('Navigating to:', processUrl);
      await page.goto(processUrl);
      await page.waitForLoadState('networkidle');

      // Wait for page to fully load
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'test-results/reprocess-page.png', fullPage: true });

      // Look for "Начать обработку" button
      const startButton = page.locator('button:has-text("Начать обработку")');

      if (await startButton.isVisible({ timeout: 5000 })) {
        console.log('Starting processing...');
        await startButton.click();

        // Monitor processing for up to 3 minutes
        for (let i = 0; i < 36; i++) {
          await page.waitForTimeout(5000);

          // Take periodic screenshots
          if (i % 6 === 0) {
            await page.screenshot({
              path: `test-results/reprocess-${i * 5}s.png`,
              fullPage: true
            });
          }

          // Check for completion
          const saveButton = page.locator('button:has-text("Сохранить выбранные")');
          if (await saveButton.isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log('Processing complete! Save button visible.');
            await page.screenshot({ path: 'test-results/reprocess-complete.png', fullPage: true });

            // Check how many items were extracted
            const itemsHeader = page.locator('text=/Извлечённые элементы \\(\\d+\\)/');
            if (await itemsHeader.isVisible()) {
              const text = await itemsHeader.textContent();
              console.log('Extracted:', text);
            }
            break;
          }

          // Check for error
          const error = page.locator('.bg-red-50, .text-red-600').first();
          if (await error.isVisible({ timeout: 500 }).catch(() => false)) {
            const errorText = await error.textContent();
            console.log('ERROR:', errorText?.slice(0, 200));
            await page.screenshot({ path: 'test-results/reprocess-error.png', fullPage: true });
            break;
          }
        }

        // Final screenshot
        await page.screenshot({ path: 'test-results/reprocess-final.png', fullPage: true });
      } else {
        console.log('Start button not found');
        await page.screenshot({ path: 'test-results/no-start-button-reprocess.png', fullPage: true });
      }
    }
  });
});
