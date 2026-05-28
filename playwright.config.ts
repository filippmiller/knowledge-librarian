import { defineConfig, devices } from '@playwright/test';

const adminUser = process.env.ADMIN_USER || 'filipp';
const adminPassword = process.env.ADMIN_PASSWORD;

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'https://avrora-library-production.up.railway.app',
    trace: 'on-first-retry',
    screenshot: 'on',
    httpCredentials: adminPassword
      ? {
          username: adminUser,
          password: adminPassword,
        }
      : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
