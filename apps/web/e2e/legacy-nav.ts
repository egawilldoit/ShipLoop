/**
 * Reaching a retired owner surface from a browser spec.
 *
 * The MVP navigation offers four surfaces, and the pages this suite proves are deliberately not
 * among them: each one still has browser evidence behind it, and deleting a page while its spec
 * stayed would turn a green suite into a claim about work nobody ran. So they stay mounted and are
 * addressed instead of clicked.
 *
 * `location.hash` rather than a click on a navigation button, for two reasons. A hidden nav entry
 * is still navigation, and a spec that has to click one is the reason a hidden entry keeps coming
 * back. And a spec that drives the address the way a bookmark or a shared link would is testing
 * what an owner who already knows the address actually gets.
 *
 * The heading assertion stays in the spec rather than here, so each test still proves the surface
 * it asked for is the one on screen.
 */

import type { Page } from '@playwright/test';

export async function openLegacy(page: Page, section: string): Promise<void> {
  await page.evaluate((value: string) => {
    window.location.hash = `#/legacy/${value}`;
  }, section);
}

/** The four MVP surfaces, addressed the same way, for specs that want a known starting point. */
export async function openSurface(page: Page, hash: string): Promise<void> {
  await page.evaluate((value: string) => {
    window.location.hash = value;
  }, hash);
}