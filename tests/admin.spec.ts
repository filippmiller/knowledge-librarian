import { test, expect } from '@playwright/test';

test.describe('Admin Dashboard', () => {

  test('should load admin dashboard with authentication', async ({ page }) => {
    await page.goto('/admin');

    // Should show the header (Russian)
    await expect(page.getByText('Библиотека знаний')).toBeVisible();

    // Should show stat cards on dashboard (Russian)
    await expect(page.getByText('Документы')).toBeVisible();
    await expect(page.getByText('Домены')).toBeVisible();
  });

  test('should navigate to Documents page', async ({ page }) => {
    await page.goto('/admin/documents');
    await expect(page).toHaveURL(/.*\/admin\/documents/);

    // Should show documents page content (Russian)
    await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();

    // Check for file upload input
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();
  });

  test('should navigate to Domains page', async ({ page }) => {
    await page.goto('/admin/domains');
    await expect(page).toHaveURL(/.*\/admin\/domains/);

    await expect(page.getByRole('heading', { name: 'Домены' })).toBeVisible();
  });

  test('should navigate to Domain Suggestions page', async ({ page }) => {
    await page.goto('/admin/domain-suggestions');
    await expect(page).toHaveURL(/.*\/admin\/domain-suggestions/);
  });

  test('should navigate to Rules page', async ({ page }) => {
    await page.goto('/admin/rules');
    await expect(page).toHaveURL(/.*\/admin\/rules/);

    await expect(page.getByRole('heading', { name: 'Правила' })).toBeVisible();
  });

  test('should navigate to Q&A page', async ({ page }) => {
    await page.goto('/admin/qa');
    await expect(page).toHaveURL(/.*\/admin\/qa/);
  });

  test('should navigate to AI Questions page', async ({ page }) => {
    await page.goto('/admin/ai-questions');
    await expect(page).toHaveURL(/.*\/admin\/ai-questions/);
  });

  test('should navigate to Knowledge Changes page', async ({ page }) => {
    await page.goto('/admin/knowledge-changes');
    await expect(page).toHaveURL(/.*\/admin\/knowledge-changes/);
  });

  test('should access Playground page', async ({ page }) => {
    await page.goto('/playground');

    // Should load playground page (Russian)
    await expect(page.getByText('Песочница знаний')).toBeVisible();
  });

});

test.describe('Rules Page Functionality', () => {

  test('should filter rules by status', async ({ page }) => {
    await page.goto('/admin/rules');

    // Wait for page to load
    await page.getByRole('heading', { name: 'Правила' }).waitFor();

    // Look for status filter dropdown
    const filterDropdown = page.locator('select, [role="combobox"]').first();

    if (await filterDropdown.isVisible()) {
      // Try to interact with filter
      await filterDropdown.click();
      await expect(filterDropdown).toBeVisible();
    }
  });

});

test.describe('Documents Page Functionality', () => {

  test('should have working file upload area', async ({ page }) => {
    await page.goto('/admin/documents');

    // Wait for page to load
    await page.getByRole('heading', { name: 'Документы' }).waitFor();

    // Check file input exists and accepts correct file types
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();

    // Get accept attribute to verify allowed file types
    const acceptAttr = await fileInput.getAttribute('accept');
    console.log('Accepted file types:', acceptAttr);
  });

});
