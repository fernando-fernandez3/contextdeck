import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';

const PORT = 4460;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CLI_ENTRY = path.resolve(process.cwd(), 'packages/cli/dist/index.js');
const LENS_IDS = ['catchup', 'brief', 'sessions', 'decisions', 'tasks', 'media'] as const;

let tmpRoot = '';
let serverProc: ChildProcess | null = null;
let initialLaunchUrl = '';
let usedInitialLaunchUrl = false;
let bearerToken = '';

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
  });
}

function getFreshLaunchUrl(): string {
  if (!usedInitialLaunchUrl && initialLaunchUrl) {
    usedInitialLaunchUrl = true;
    return initialLaunchUrl;
  }
  const out = runCli(['open', '--dir', tmpRoot, '--port', String(PORT)]);
  const match = out.match(/https?:\/\/\S+\/auth\?code=\S+/);
  if (!match) {
    throw new Error(`Failed to parse launch URL from cdeck open output: ${out}`);
  }
  return match[0];
}

async function authenticateViaLaunchUrl(page: Page): Promise<void> {
  const launchUrl = getFreshLaunchUrl();
  await page.goto(launchUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${BASE_URL}/`);
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Loading...');
  // AC8.4 / B1: auth token must NEVER be stored in localStorage or URL
  expect(page.url()).not.toContain('code=');
  expect(page.url()).not.toContain('token');
  const localStorageKeys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(localStorageKeys).toEqual([]);
}

async function waitForLensReady(page: Page, lensId: (typeof LENS_IDS)[number]): Promise<void> {
  await page.locator(`button[data-lens="${lensId}"]`).click();
  if (lensId === 'catchup') {
    await expect(page.locator('main')).toContainText(/Since you last looked|You're caught up\./);
  } else if (lensId === 'brief') {
    await expect(page.locator('main')).toContainText('Realtime Sync Engine v2');
  } else if (lensId === 'sessions') {
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15_000 });
  } else if (lensId === 'decisions') {
    const mmdSvg = page.locator('[data-mermaid-rendered="true"] svg').first();
    await expect(mmdSvg).toBeVisible({ timeout: 15_000 });
    await expect(mmdSvg).toContainText('ContextDeck Local Server');
  } else if (lensId === 'tasks') {
    await expect(page.locator('main')).toContainText('Backlog');
  } else if (lensId === 'media') {
    await expect(page.locator('main')).toContainText('Media & Mastery');
  }
}

async function startCliServer(dir: string): Promise<{ proc: ChildProcess; launchUrl: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [CLI_ENTRY, 'serve', '--dir', dir, '--port', String(PORT), '--host', '127.0.0.1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timed out waiting for cdeck serve.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = stdout.match(/Launch URL\s*:\s*(http:\/\/\S+\/auth\?code=\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, launchUrl: match[1] });
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cdeck serve exited early (${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

test.describe.serial('ContextDeck v0.2 Playwright Smoke & Isolation', () => {
  test.beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'contextdeck-e2e-'));
    runCli(['init', '--demo', '--dir', tmpRoot]);
    const started = await startCliServer(tmpRoot);
    serverProc = started.proc;
    initialLaunchUrl = started.launchUrl;
    bearerToken = (
      await fsp.readFile(path.join(tmpRoot, '.contextdeck', '.runtime', 'token'), 'utf8')
    ).trim();
  });

  test.afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          serverProc?.kill('SIGKILL');
          resolve();
        }, 5_000);
        serverProc!.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        serverProc!.kill('SIGTERM');
      });
    }
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('desktop & 390px phone: launch URL auth, all 6 lenses render with 0 console errors and 0 horizontal overflow', async ({
    browser,
  }) => {
    const screenshotDir = process.env.CONTEXTDECK_SCREENSHOT_DIR?.trim();
    if (screenshotDir) {
      await fsp.mkdir(screenshotDir, { recursive: true });
    }

    // --- Desktop 1440x900 ---
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktopPage = await desktopContext.newPage();
    const desktopErrors: string[] = [];
    desktopPage.on('console', (msg) => {
      if (msg.type() === 'error') desktopErrors.push(`console.error: ${msg.text()}`);
    });
    desktopPage.on('pageerror', (err) => {
      desktopErrors.push(`pageerror: ${err.message}`);
    });

    await authenticateViaLaunchUrl(desktopPage);
    await expect(desktopPage.locator('main')).toContainText('Since you last looked');

    for (const lensId of LENS_IDS) {
      await waitForLensReady(desktopPage, lensId);
      await desktopPage.waitForTimeout(250);
      if (screenshotDir) {
        await desktopPage.screenshot({
          path: path.join(screenshotDir, `desktop-${lensId}.png`),
          fullPage: false,
        });
      }
    }

    // H14: Desktop light/dark theme toggle changes computed background, keeps primary text contrast >= 4.5, and persists theme only
    await waitForLensReady(desktopPage, 'catchup');
    const darkColors = await desktopPage.evaluate(() => {
      const bodyStyle = window.getComputedStyle(document.body);
      return {
        bg: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        htmlClass: document.documentElement.className,
      };
    });
    expect(darkColors.htmlClass).toContain('dark');

    await desktopPage.locator('button[aria-label="Toggle theme"]').click();
    await desktopPage.waitForTimeout(200);
    const lightColors = await desktopPage.evaluate(() => {
      const parseRgb = (rgb: string): [number, number, number] => {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) throw new Error(`Unparseable rgb: ${rgb}`);
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      };
      const lum = ([r, g, b]: [number, number, number]): number => {
        const lin = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (c1: string, c2: string): number => {
        const l1 = lum(parseRgb(c1));
        const l2 = lum(parseRgb(c2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const bodyStyle = window.getComputedStyle(document.body);
      const heading = document.querySelector('main h2');
      const card = heading?.closest('section');
      const headingContrast =
        heading && card
          ? ratio(window.getComputedStyle(heading).color, window.getComputedStyle(card).backgroundColor)
          : ratio(bodyStyle.color, bodyStyle.backgroundColor);
      return {
        bg: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        htmlClass: document.documentElement.className,
        bodyContrast: ratio(bodyStyle.color, bodyStyle.backgroundColor),
        headingContrast,
        storageKeys: Object.keys(window.localStorage),
        storedTheme: window.localStorage.getItem('contextdeck_theme'),
      };
    });
    expect(lightColors.htmlClass).toContain('light');
    expect(lightColors.htmlClass).not.toContain('dark');
    expect(lightColors.bg).not.toBe(darkColors.bg);
    expect(lightColors.bodyContrast).toBeGreaterThanOrEqual(4.5);
    expect(lightColors.headingContrast).toBeGreaterThanOrEqual(4.5);
    expect(lightColors.storageKeys).toEqual(['contextdeck_theme']);
    expect(lightColors.storedTheme).toBe('light');

    if (screenshotDir) {
      await desktopPage.screenshot({
        path: path.join(screenshotDir, 'desktop-catchup-light.png'),
        fullPage: false,
      });
    }

    // Light theme persists across reload
    await desktopPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(desktopPage.locator('html')).toHaveClass(/\blight\b/);

    expect(desktopErrors).toEqual([]);
    await desktopContext.close();

    // --- Phone 390x844 ---
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phoneContext.newPage();
    const phoneErrors: string[] = [];
    phonePage.on('console', (msg) => {
      if (msg.type() === 'error') phoneErrors.push(`console.error: ${msg.text()}`);
    });
    phonePage.on('pageerror', (err) => {
      phoneErrors.push(`pageerror: ${err.message}`);
    });

    await authenticateViaLaunchUrl(phonePage);

    for (const lensId of LENS_IDS) {
      await waitForLensReady(phonePage, lensId);
      await phonePage.waitForTimeout(250);
      const scrollWidth = await phonePage.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `Horizontal overflow on phone lens "${lensId}"`).toBeLessThanOrEqual(390);
      if (screenshotDir) {
        await phonePage.screenshot({
          path: path.join(screenshotDir, `phone-${lensId}.png`),
          fullPage: false,
        });
      }
    }

    // Verify phone header overflow menu opens cleanly and toggles Light theme without horizontal scroll
    await waitForLensReady(phonePage, 'catchup');
    const phoneDarkBg = await phonePage.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    await phonePage.locator('button[aria-label="More actions"]').click();
    await expect(phonePage.getByRole('button', { name: 'Copy Context Pack' })).toBeVisible();
    await expect(phonePage.getByRole('button', { name: 'Paste Update' })).toBeVisible();
    await expect(phonePage.getByRole('button', { name: 'Light theme' })).toBeVisible();
    const overflowScrollWidth = await phonePage.evaluate(() => document.documentElement.scrollWidth);
    expect(overflowScrollWidth).toBeLessThanOrEqual(390);

    await phonePage.getByRole('button', { name: 'Light theme' }).click();
    await phonePage.waitForTimeout(200);
    const phoneLightState = await phonePage.evaluate(() => ({
      bg: window.getComputedStyle(document.body).backgroundColor,
      htmlClass: document.documentElement.className,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(phoneLightState.htmlClass).toContain('light');
    expect(phoneLightState.bg).not.toBe(phoneDarkBg);
    expect(phoneLightState.scrollWidth).toBeLessThanOrEqual(390);
    if (screenshotDir) {
      await phonePage.screenshot({
        path: path.join(screenshotDir, 'phone-catchup-light.png'),
        fullPage: false,
      });
    }

    expect(phoneErrors).toEqual([]);
    await phoneContext.close();
  });

  test('Catch up workflow: Queue refresh, Still accurate, Mark caught up, and CLI decision change detection', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await authenticateViaLaunchUrl(page);
    await expect(page.locator('main')).toContainText('Decisions changed');
    await expect(page.locator('main')).toContainText('Now out of date');

    // 1-tap Queue refresh on first stale artifact
    await page.getByRole('button', { name: 'Queue refresh' }).first().click();
    await expect(page.locator('main')).toContainText('Refreshing');

    // Confirm second stale artifact ("Still accurate")
    await page.getByRole('button', { name: 'Still accurate' }).last().click();
    await page.locator('input[placeholder="Optional note"]').fill('Verified accurate for WebSockets');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Still accurate' })).toHaveCount(1);

    // Mark caught up -> empty state
    await page.getByRole('button', { name: 'Mark caught up' }).click();
    await expect(page.locator('main')).toContainText("You're caught up.");

    // H17: Reload after Mark caught up MUST land on Brief with zero unseen badge
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('button[data-lens="brief"]')).toHaveClass(/border-indigo-500/);
    await expect(page.locator('main')).toContainText('Realtime Sync Engine v2');
    await expect(page.locator('header button[aria-label*="unseen updates"]')).toHaveCount(0);

    // Mutate board via real CLI after first visit (supersedes dec_003 -> makes quiz q1 & q2 stale, q3 stays fresh)
    runCli([
      'decision',
      'add',
      'Adopt HTTP/3 WebTransport',
      '--dir',
      tmpRoot,
      '--board',
      'realtime-sync-v2',
      '--supersedes',
      'dec_003',
      '--summary',
      'Upgrade transport for lower tail latency',
    ]);

    // Reload and confirm Catch up highlights the CLI change and unseen badge button shows exact count
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toContainText('Adopt HTTP/3 WebTransport');
    const unseenBadge = page.locator('header button[aria-label*="unseen updates"]');
    await expect(unseenBadge).toBeVisible();
    await expect(unseenBadge).toHaveAttribute('aria-label', '1 unseen updates');
    await expect(unseenBadge).toContainText('1');

    // H17: Open demo quiz -> q1 & q2 show Stale badge, q3 does not; submitting a 2nd attempt renders mastery trend SVG
    await waitForLensReady(page, 'media');
    await page.getByRole('button', { name: /Mental Model Check: Realtime Sync Engine v2/ }).click();
    await expect(page.locator('[data-question-id="q1"]')).toContainText('Stale');
    await expect(page.locator('[data-question-id="q2"]')).toContainText('Stale');
    await expect(page.locator('[data-question-id="q3"]')).not.toContainText('Stale');

    await page.locator('[data-question-id="q1"] button').nth(1).click();
    await page.locator('[data-question-id="q2"] button').nth(1).click();
    await page.locator('[data-question-id="q3"] button').nth(1).click();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    await expect(page.locator('main')).toContainText('2 attempts');
    await expect(page.locator('svg[aria-label="Mastery score trend"]')).toBeVisible();

    expect(errors).toEqual([]);
    await context.close();
  });

  test('browser isolation: XSS markdown blocked, HTML iframe cannot access API/parent, direct HTML file downloads', async ({
    browser,
  }) => {
    const authHeaders = {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Seed XSS markdown doc via REST API
    const xssRes = await fetch(`${BASE_URL}/api/boards/realtime-sync-v2/media`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'XSS Probe Doc',
        kind: 'doc',
        content:
          'Safe Markdown Heading\n\n<img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>',
      }),
    });
    expect(xssRes.status).toBe(201);

    // 2. Seed inline HTML probe artifact via REST API
    const htmlProbeRes = await fetch(`${BASE_URL}/api/boards/realtime-sync-v2/media`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Sandboxed HTML Probe',
        kind: 'html',
        content: `<!doctype html>
<html><body>
<div id="probe">pending</div>
<script>
(async () => {
  let parentBlocked = false;
  try {
    void window.parent.document.title;
  } catch (e) {
    parentBlocked = true;
  }
  let fetchBlocked = false;
  try {
    const res = await fetch('${BASE_URL}/api/boards', { credentials: 'include' });
    fetchBlocked = !res.ok;
  } catch (e) {
    fetchBlocked = true;
  }
  document.getElementById('probe').textContent = 'parentBlocked=' + parentBlocked + ';fetchBlocked=' + fetchBlocked;
})();
</script>
</body></html>`,
      }),
    });
    expect(htmlProbeRes.status).toBe(201);

    // 3. Seed file-backed HTML artifact via CLI
    const tmpHtmlPath = path.join(tmpRoot, 'untrusted.html');
    fs.writeFileSync(
      tmpHtmlPath,
      '<!doctype html><html><body><script>window.__htmlExec=1</script></body></html>',
    );
    const htmlFileJson = runCli([
      'media',
      'add',
      'HTML Attachment File',
      '--type',
      'html',
      '--file',
      tmpHtmlPath,
      '--dir',
      tmpRoot,
      '--board',
      'realtime-sync-v2',
    ]);
    const htmlFileArtifact = JSON.parse(htmlFileJson) as { id: string };

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    await authenticateViaLaunchUrl(page);

    // Verify XSS markdown doc renders sanitized text without executing script/onerror
    await waitForLensReady(page, 'media');
    await page.getByRole('button', { name: /XSS Probe Doc/ }).click();
    await expect(page.locator('main')).toContainText('Safe Markdown Heading');
    const xssFlag = await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss);
    expect(xssFlag).toBeUndefined();

    // Verify HTML artifact renders in sandbox="allow-scripts" (no allow-same-origin) and cannot read API or parent
    await page.getByRole('button', { name: /Sandboxed HTML Probe/ }).click();
    const iframeEl = page.locator('iframe[title="Sandboxed HTML Probe"]');
    await expect(iframeEl).toBeVisible();
    const sandboxAttr = await iframeEl.getAttribute('sandbox');
    expect(sandboxAttr).toBe('allow-scripts');
    const frame = page.frameLocator('iframe[title="Sandboxed HTML Probe"]');
    await expect(frame.locator('#probe')).toContainText('parentBlocked=true;fetchBlocked=true', {
      timeout: 10_000,
    });

    // Verify direct navigation to html-typed media file downloads instead of rendering HTML
    const downloadPage = await context.newPage();
    const fileUrl = `${BASE_URL}/api/boards/realtime-sync-v2/media/${htmlFileArtifact.id}/file`;
    const [download] = await Promise.all([
      downloadPage.waitForEvent('download'),
      downloadPage.goto(fileUrl).catch(() => {
        // Chromium throws net::ERR_ABORTED when navigation turns into an attachment download
      }),
    ]);
    expect(download.suggestedFilename()).toContain(htmlFileArtifact.id);
    await downloadPage.close();
    await context.close();
  });
});
