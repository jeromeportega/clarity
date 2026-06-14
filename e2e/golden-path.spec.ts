import { expect, test } from '@playwright/test';

// READ-ONLY golden-path smoke against the live demo household. The demo gates
// every mutation behind a token, so this spec only navigates and asserts that
// the two core surfaces render — it never attempts a confirm/edit. Assertions use
// role/text + regex (not brittle CSS selectors) so they survive markup churn.
test.describe('golden path', () => {
  test('review queue renders with at least one queue item', async ({ page }) => {
    await page.goto('/');

    // The Review Queue heading is present.
    await expect(
      page.getByRole('heading', { name: /review queue/i }),
    ).toBeVisible();

    // At least one real queue item/row is shown. The demo household surfaces
    // items such as "Wireless Headphones" / "WHOLE FOODS", plus unmatched /
    // ambiguous rows — assert that any one of these is visible.
    const queueItem = page
      .getByText(/wireless headphones|whole foods|unmatched|ambiguous/i)
      .first();
    await expect(queueItem).toBeVisible();
  });

  test('true-spend renders a category breakdown', async ({ page }) => {
    await page.goto('/true-spend');

    // The True Spend surface is present.
    await expect(
      page.getByRole('heading', { name: /true spend/i }),
    ).toBeVisible();

    // A category breakdown is rendered — assert a known category label shows.
    const category = page.getByText(/groceries|electronics/i).first();
    await expect(category).toBeVisible();
  });
});
