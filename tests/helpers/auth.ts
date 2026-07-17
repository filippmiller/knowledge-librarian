import { Page } from '@playwright/test';

const adminUser = process.env.ADMIN_USER || 'filipp';
const adminPassword = process.env.ADMIN_PASSWORD;

export async function login(page: Page): Promise<void> {
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD environment variable is required for tests');
  }

  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.fill('input[name="username"]', adminUser);
  await page.fill('input[name="password"]', adminPassword);
  await page.click('button[type="submit"]');

  // Wait for redirect to admin area
  await page.waitForURL(/.*\/admin.*/, { timeout: 10000 });
}
