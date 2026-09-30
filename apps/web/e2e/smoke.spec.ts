/**
 * The shell renders, lays out without sideways scrolling, and admits a lost connection.
 *
 * Every assertion here is a measurement or a real request. The responsive check reads
 * `scrollWidth` and `clientWidth` off the document element rather than looking for a
 * CSS class, because a class says what was intended and the measurement says what
 * happened (F01-AC3).
 */

import { expect, test } from './fixtures.ts';

test.describe('application shell', () => {
  test('renders a mounted root with visible text', async ({ page, serverUrl }) => {
    const response = await page.goto(`${serverUrl}/`);
    expect(response?.status()).toBe(200);

    const root = page.locator('#root');
    await expect(root).toBeVisible();

    const text = (await root.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    await expect(root).toContainText('ShipLoop');
  });

  // F01-AC3: the page must not scroll sideways on a 375px phone or on a desktop.
  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    test(`does not scroll horizontally at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
      serverUrl,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${serverUrl}/`);
      await expect(page.locator('#root')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const measurement = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      }));

      expect(measurement.clientWidth).toBe(viewport.width);
      expect(measurement.scrollWidth).toBe(measurement.clientWidth);
    });
  }

  test('a failed request shows the disconnected state', async ({ page, serverUrl }) => {
    let intercepted = 0;
    await page.route('**/api/health', async (route) => {
      intercepted += 1;
      await route.abort('failed');
    });

    await page.goto(`${serverUrl}/`);

    const banner = page.locator('[role="status"][data-connected="false"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Disconnected');
    expect(intercepted).toBeGreaterThan(0);
  });
});