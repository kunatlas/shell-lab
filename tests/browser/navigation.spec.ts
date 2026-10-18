import { test, expect } from '@playwright/test';

test('sidebar groups all 25 scenarios and keeps every node when collapsed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await expect(page.locator('[data-topic]')).toHaveCount(25);
  await expect(page.locator('.scenario-group')).toHaveCount(4);

  const counts = await page.locator('.scenario-group').evaluateAll((groups) => groups.map((group) => ({
    id: (group as HTMLElement).dataset.group,
    count: group.querySelectorAll('[data-topic]').length,
  })));
  expect(counts).toEqual([
    { id: 'diagnose', count: 7 },
    { id: 'files', count: 7 },
    { id: 'release', count: 6 },
    { id: 'remote', count: 5 },
  ]);

  const toggle = page.locator('[data-group-toggle="files"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const controls = await toggle.getAttribute('aria-controls');
  await expect(page.locator(`#${controls}`)).toHaveCount(1);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-topic="find"]')).toBeHidden();
  await expect(page.locator('[data-topic]')).toHaveCount(25);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-topic="find"]')).toBeVisible();
});

test('scenario filter narrows groups without removing topic nodes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开练习列表' }).click();
  const filter = page.locator('#scenario-filter');

  await filter.fill('ssh');
  await expect(page.locator('#scenario-count')).toHaveText('5 / 25');
  await expect(page.locator('[data-topic]')).toHaveCount(25);
  await expect(page.locator('[data-topic="ssh"]')).toBeVisible();
  await expect(page.locator('[data-topic="logs"]')).toBeHidden();
  await expect(page.locator('.scenario-group[data-group="diagnose"]')).toBeHidden();
  await expect(page.locator('[data-group-toggle="remote"]')).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: 'test-results/navigation-filtered.png', fullPage: true });

  await filter.fill('jq');
  await expect(page.locator('#scenario-count')).toHaveText('1 / 25');
  await expect(page.locator('[data-topic="json"]')).toBeVisible();

  await filter.fill('zzzz');
  await expect(page.locator('#scenario-count')).toHaveText('0 / 25');
  await expect(page.locator('#scenario-empty')).toBeVisible();

  await filter.fill('');
  await expect(page.locator('#scenario-count')).toHaveText('25');
  await expect(page.locator('[data-topic="logs"]')).toBeVisible();
  await expect(page.locator('#scenario-empty')).toBeHidden();
});

test('mobile drawer opens, filters, and closes with Escape without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: '打开练习列表' });

  await menu.click();
  await expect(page.locator('#sidebar')).toHaveClass(/is-open/);
  await expect(page.locator('#scenario-filter')).toBeVisible();
  await page.locator('#scenario-filter').fill('scp');
  await expect(page.locator('#scenario-count')).toHaveText('3 / 25');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).not.toHaveClass(/is-open/);
  await expect(menu).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('command palette opens with Control+K and preselects a scenario', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+K');
  const palette = page.locator('#palette');
  const input = page.locator('#palette-input');
  await expect(palette).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill('日志');
  await expect(page.getByRole('option', { name: /应用日志排查/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/palette.png', fullPage: false });
  await page.keyboard.press('Enter');

  await expect(palette).toBeHidden();
  await expect(page.locator('#dialog')).toBeVisible();
  await expect(page.locator('input[name="topic"][value="logs"]')).toBeChecked();
});

test('command palette restores focus when closed with Escape', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '搜索场景或命令' });
  await trigger.click();
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('generator groups all options and filtering keeps the DOM count stable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await page.getByRole('button', { name: /生成开发实战/ }).click();
  await expect(page.locator('#dialog')).toBeVisible();
  await expect(page.locator('.topic-group')).toHaveCount(4);
  await expect(page.locator('.topic-option')).toHaveCount(25);

  const counts = await page.locator('.topic-group').evaluateAll((groups) => groups.map((group) => group.querySelectorAll('.topic-option').length));
  expect(counts).toEqual([7, 7, 6, 5]);
  await page.screenshot({ path: 'test-results/generator-grouped.png', fullPage: false });

  await page.locator('#generator-filter').fill('ssh');
  await expect(page.locator('.topic-option')).toHaveCount(25);
  await expect(page.locator('.topic-option[data-topic-option="ssh"]')).toBeVisible();
  await expect(page.locator('.topic-option[data-topic-option="logs"]')).toBeHidden();
  await expect(page.locator('.topic-group[data-group="diagnose"]')).toBeHidden();

  await page.locator('#generator-filter').fill('');
  await expect(page.locator('.topic-option[data-topic-option="logs"]')).toBeVisible();
});
