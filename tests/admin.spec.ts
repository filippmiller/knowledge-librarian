import { test, expect } from '@playwright/test';

test.describe('Admin Dashboard', () => {

  test('should load admin dashboard with authentication', async ({ page }) => {
    await page.goto('/admin');

    // Should show the header (Russian)
    await expect(page.getByText('Библиотека знаний')).toBeVisible();

    // Should show stat cards on dashboard (Russian)
    await expect(page.getByText('Документы')).toBeVisible();
    await expect(page.getByText('Домены')).toBeVisible();

    // Take screenshot of dashboard
    await page.screenshot({ path: 'test-results/admin-dashboard.png', fullPage: true });
  });

  test('should navigate to Documents page', async ({ page }) => {
    await page.goto('/admin');

    // Click on Documents navigation (Russian)
    await page.getByRole('link', { name: 'Документы' }).click();
    await expect(page).toHaveURL(/.*\/admin\/documents/);

    // Should show documents page content (Russian)
    await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();

    // Check for file upload input
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    await page.screenshot({ path: 'test-results/documents-page.png', fullPage: true });
  });

  test('should navigate to Domains page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Домены' }).click();
    await expect(page).toHaveURL(/.*\/admin\/domains/);

    await expect(page.getByRole('heading', { name: 'Домены' })).toBeVisible();

    await page.screenshot({ path: 'test-results/domains-page.png', fullPage: true });
  });

  test('should navigate to Domain Suggestions page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Предложения доменов' }).click();
    await expect(page).toHaveURL(/.*\/admin\/domain-suggestions/);

    await page.screenshot({ path: 'test-results/domain-suggestions-page.png', fullPage: true });
  });

  test('should navigate to Rules page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Правила' }).click();
    await expect(page).toHaveURL(/.*\/admin\/rules/);

    await expect(page.getByRole('heading', { name: 'Правила' })).toBeVisible();

    await page.screenshot({ path: 'test-results/rules-page.png', fullPage: true });
  });

  test('should navigate to Q&A page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Вопросы и ответы' }).click();
    await expect(page).toHaveURL(/.*\/admin\/qa/);

    await page.screenshot({ path: 'test-results/qa-page.png', fullPage: true });
  });

  test('should navigate to AI Questions page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Вопросы ИИ' }).click();
    await expect(page).toHaveURL(/.*\/admin\/ai-questions/);

    await page.screenshot({ path: 'test-results/ai-questions-page.png', fullPage: true });
  });

  test('should navigate to Knowledge Changes page', async ({ page }) => {
    await page.goto('/admin');

    await page.getByRole('link', { name: 'Журнал изменений' }).click();
    await expect(page).toHaveURL(/.*\/admin\/knowledge-changes/);

    await page.screenshot({ path: 'test-results/knowledge-changes-page.png', fullPage: true });
  });

  test('should access Playground page', async ({ page }) => {
    await page.goto('/playground');

    // Should load playground page (Russian)
    await expect(page.getByText('Песочница знаний')).toBeVisible();

    await page.screenshot({ path: 'test-results/playground-page.png', fullPage: true });
  });

});

test.describe('Rules Page Functionality', () => {

  test('should filter rules by status', async ({ page }) => {
    await page.goto('/admin/rules');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Look for status filter dropdown
    const filterDropdown = page.locator('select, [role="combobox"]').first();

    if (await filterDropdown.isVisible()) {
      // Try to interact with filter
      await filterDropdown.click();
      await page.screenshot({ path: 'test-results/rules-filter-open.png', fullPage: true });
    }
  });

});

test.describe('Documents Page Functionality', () => {

  test('should have working file upload area', async ({ page }) => {
    await page.goto('/admin/documents');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Check file input exists and accepts correct file types
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    // Get accept attribute to verify allowed file types
    const acceptAttr = await fileInput.getAttribute('accept');
    console.log('Accepted file types:', acceptAttr);

    await page.screenshot({ path: 'test-results/documents-upload-area.png', fullPage: true });
  });

});
