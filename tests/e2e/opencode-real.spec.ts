import { test, expect, Page } from '@playwright/test';

const REAL_SITE_URL = process.env.AIEC_REAL_SITE_URL;

interface RpcResponse<T> {
  type: 'response';
  id: string;
  data: T;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  harnesses?: string[];
}

interface StatsSummary {
  totalSessions: number;
  totalWorkspaces: number;
  totalRequests: number;
}

interface HarnessBreakdown {
  labels: string[];
  requests: number[];
}

async function rpc<T>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ method: rpcMethod, params: rpcParams }) => {
    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'request', id: `opencode-real-${rpcMethod}`, method: rpcMethod, params: rpcParams }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const message = await response.json() as RpcResponse<unknown>;
    return message.data;
  }, { method, params }) as Promise<T>;
}

async function waitForDashboardWithOpenCode(page: Page): Promise<void> {
  await page.goto(REAL_SITE_URL!, { waitUntil: 'load' });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const content = document.querySelector('#content');
    const harnessSelect = document.querySelector<HTMLSelectElement>('#harness-filter');
    const hasOpenCode = Array.from(harnessSelect?.options ?? []).some(option => option.value === 'OpenCode' || option.textContent?.trim() === 'OpenCode');
    const contentText = content?.textContent?.toLowerCase() ?? '';
    return Boolean(
      content
      && harnessSelect
      && hasOpenCode
      && contentText.includes('requests')
      && !document.querySelector('.loading-screen, .loading-spinner, .error-boundary'),
    );
  }, { timeout: 120_000 });
}

function parseCompactNumber(value: string | undefined): number {
  const text = (value ?? '').trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)([KM])?$/i.exec(text);
  if (!match) return Number.NaN;
  const base = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  if (suffix === 'M') return base * 1_000_000;
  if (suffix === 'K') return base * 1_000;
  return base;
}

test.describe('OpenCode real local site', () => {
  test.skip(!REAL_SITE_URL, 'requires AIEC_REAL_SITE_URL; use npm run test:e2e:opencode');

  test('loads real OpenCode data and supports dashboard filtering', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await waitForDashboardWithOpenCode(page);

    const workspaces = await rpc<WorkspaceSummary[]>(page, 'getWorkspaces');
    expect(workspaces.some(workspace => workspace.harnesses?.includes('OpenCode'))).toBe(true);

    const stats = await rpc<StatsSummary>(page, 'getStats', { harness: 'OpenCode' });
    expect(stats.totalSessions).toBeGreaterThan(0);
    expect(stats.totalRequests).toBeGreaterThan(0);
    expect(stats.totalWorkspaces).toBeGreaterThan(0);

    const harnessBreakdown = await rpc<HarnessBreakdown>(page, 'getHarnessBreakdown', { harness: 'OpenCode' });
    expect(harnessBreakdown.labels).toEqual(['OpenCode']);
    expect(harnessBreakdown.requests[0]).toBeGreaterThan(0);

    await page.selectOption('#harness-filter', 'OpenCode');
    await expect(page.locator('#harness-filter')).toHaveValue('OpenCode');
    await page.waitForFunction(() => {
      const content = document.querySelector('#content');
      const harnessTags = Array.from(document.querySelectorAll('.dash-harness-tag')).map(element => element.textContent?.trim());
      const contentText = content?.textContent?.toLowerCase() ?? '';
      return Boolean(
        content
        && !document.querySelector('.loading-screen, .loading-spinner, .error-boundary')
        && contentText.includes('requests')
        && harnessTags.length === 1
        && harnessTags[0] === 'OpenCode',
      );
    }, { timeout: 60_000 });

    const dashboard = await page.evaluate(() => {
      const stats = Array.from(document.querySelectorAll('.dash-stat')).map(element => ({
        label: element.querySelector('.dash-stat-lbl')?.textContent?.trim(),
        value: element.querySelector('.dash-stat-val')?.textContent?.trim(),
      }));
      const harnesses = Array.from(document.querySelectorAll('.dash-harness-tag')).map(element => element.textContent?.trim()).filter(Boolean);
      return { stats, harnesses };
    });

    const sessionsText = dashboard.stats.find(stat => stat.label === 'Sessions')?.value;
    const requestsText = dashboard.stats.find(stat => stat.label === 'Requests')?.value;
    const workspacesText = dashboard.stats.find(stat => stat.label === 'Workspaces')?.value;
    expect(parseCompactNumber(sessionsText)).toBeGreaterThan(0);
    expect(parseCompactNumber(requestsText)).toBeGreaterThan(0);
    expect(parseCompactNumber(workspacesText)).toBeGreaterThan(0);
    expect(dashboard.harnesses).toEqual(['OpenCode']);
    expect(pageErrors).toEqual([]);
  });
});
