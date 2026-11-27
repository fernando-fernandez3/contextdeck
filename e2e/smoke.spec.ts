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
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations?: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations?.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
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

async function getCspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
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
    expect(await getCspViolations(desktopPage)).toEqual([]);
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
    expect(await getCspViolations(phonePage)).toEqual([]);
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
    expect(await getCspViolations(page)).toEqual([]);
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

  test('R2-8: light theme maintains >= 4.5 contrast on QuizRunner selected/correct/incorrect options, light Sessions controls, and light Excalidraw canvas', async ({
    browser,
  }) => {
    const screenshotDir = process.env.CONTEXTDECK_SCREENSHOT_DIR?.trim();
    if (screenshotDir) {
      await fsp.mkdir(screenshotDir, { recursive: true });
    }

    const measureContrast = async (page: Page, selector: string, index: number) =>
      page.evaluate(
        ({ sel, idx }) => {
          const toSrgb = (cssColor: string): [number, number, number] => {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('No 2d canvas context');
            ctx.fillStyle = cssColor;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b];
          };
          const lum = ([r, g, b]: [number, number, number]): number => {
            const lin = (v: number) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
          };
          const ratio = (c1: string, c2: string): number => {
            const l1 = lum(toSrgb(c1));
            const l2 = lum(toSrgb(c2));
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          };
          const el = document.querySelectorAll(sel)[idx] as HTMLElement | undefined;
          if (!el) throw new Error(`Element not found: ${sel}[${idx}]`);
          const cs = window.getComputedStyle(el);
          return {
            color: cs.color,
            bg: cs.backgroundColor,
            rgbColor: toSrgb(cs.color),
            rgbBg: toSrgb(cs.backgroundColor),
            contrast: ratio(cs.color, cs.backgroundColor),
          };
        },
        { sel: selector, idx: index },
      );

    // --- Desktop light theme check + screenshots ---
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktopPage = await desktopCtx.newPage();
    const errors: string[] = [];
    desktopPage.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    desktopPage.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await authenticateViaLaunchUrl(desktopPage);
    await desktopPage.locator('button[aria-label="Toggle theme"]').click();
    await expect(desktopPage.locator('html')).toHaveClass(/\blight\b/);

    // 1. Media & Mastery: select quiz, check selected, correct, and incorrect option contrast >= 4.5
    await waitForLensReady(desktopPage, 'media');
    await desktopPage.getByRole('button', { name: /Mental Model Check: Realtime Sync Engine v2/ }).click();
    await expect(desktopPage.locator('[data-question-id="q1"]')).toBeVisible();

    // Select q1[1] (correct), q2[0] (incorrect), q3[1] (correct)
    await desktopPage.locator('[data-question-id="q1"] button').nth(1).click();
    await desktopPage.waitForTimeout(250);
    const selectedMetric = await measureContrast(desktopPage, '[data-question-id="q1"] button', 1);
    expect(
      selectedMetric.contrast,
      `Selected quiz option contrast too low: ${JSON.stringify(selectedMetric)}`,
    ).toBeGreaterThanOrEqual(4.5);

    await desktopPage.locator('[data-question-id="q2"] button').nth(0).click();
    await desktopPage.locator('[data-question-id="q3"] button').nth(1).click();
    await desktopPage.getByRole('button', { name: 'Submit answers' }).click();
    await expect(desktopPage.locator('main')).toContainText('Score: 2 / 3');
    await desktopPage.waitForTimeout(250);

    const correctMetric = await measureContrast(desktopPage, '[data-question-id="q1"] button', 1);
    const incorrectMetric = await measureContrast(desktopPage, '[data-question-id="q2"] button', 0);
    expect(
      correctMetric.contrast,
      `Correct quiz option contrast too low: ${JSON.stringify(correctMetric)}`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      incorrectMetric.contrast,
      `Incorrect quiz option contrast too low: ${JSON.stringify(incorrectMetric)}`,
    ).toBeGreaterThanOrEqual(4.5);

    if (screenshotDir) {
      await desktopPage.screenshot({
        path: path.join(screenshotDir, 'desktop-media-light.png'),
        fullPage: false,
      });
    }

    // 2. Sessions: React Flow controls must use light surface, not hardcoded dark bg-zinc-900
    await waitForLensReady(desktopPage, 'sessions');
    await desktopPage.waitForTimeout(250);
    const controlsBg = await desktopPage.evaluate(() => {
      const btn = document.querySelector('.react-flow__controls-button') ?? document.querySelector('.react-flow__controls');
      if (!btn) return null;
      const bg = window.getComputedStyle(btn).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? { bg, r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : { bg, r: 0, g: 0, b: 0 };
    });
    expect(controlsBg).not.toBeNull();
    expect(controlsBg!.r, `Sessions controls stayed dark: ${JSON.stringify(controlsBg)}`).toBeGreaterThan(200);
    if (screenshotDir) {
      await desktopPage.screenshot({
        path: path.join(screenshotDir, 'desktop-sessions-light.png'),
        fullPage: false,
      });
    }

    // 3. Excalidraw canvas: must follow html.light (not dark theme)
    await waitForLensReady(desktopPage, 'decisions');
    await desktopPage.getByRole('button', { name: /Mental Model Whiteboard \(Excalidraw\)/ }).click();
    const excalidrawRoot = desktopPage.locator('.excalidraw').first();
    await expect(excalidrawRoot).toBeVisible({ timeout: 15_000 });
    await desktopPage.waitForTimeout(350);
    const excalidrawTheme = await excalidrawRoot.evaluate((el) => ({
      isDarkClass: el.classList.contains('theme--dark'),
      bg: window.getComputedStyle(el).backgroundColor,
    }));
    expect(excalidrawTheme.isDarkClass, 'Excalidraw stayed in dark theme').toBe(false);
    if (screenshotDir) {
      await desktopPage.screenshot({
        path: path.join(screenshotDir, 'desktop-excalidraw-light.png'),
        fullPage: false,
      });
    }

    expect(errors).toEqual([]);
    expect(await getCspViolations(desktopPage)).toEqual([]);
    await desktopCtx.close();

    // --- Phone 390x844 light-theme screenshots & overflow checks ---
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phonePage = await phoneCtx.newPage();
    const phoneErrors: string[] = [];
    phonePage.on('console', (msg) => {
      if (msg.type() === 'error') phoneErrors.push(`console.error: ${msg.text()}`);
    });
    phonePage.on('pageerror', (err) => phoneErrors.push(`pageerror: ${err.message}`));

    await authenticateViaLaunchUrl(phonePage);
    await phonePage.locator('button[aria-label="More actions"]').click();
    await phonePage.getByRole('button', { name: 'Light theme' }).click();
    await expect(phonePage.locator('html')).toHaveClass(/\blight\b/);

    // Phone Media & Mastery (quiz answered)
    await waitForLensReady(phonePage, 'media');
    await phonePage.getByRole('button', { name: /Mental Model Check: Realtime Sync Engine v2/ }).click();
    await phonePage.locator('[data-question-id="q1"] button').nth(1).click();
    await phonePage.locator('[data-question-id="q2"] button').nth(0).click();
    await phonePage.locator('[data-question-id="q3"] button').nth(1).click();
    await phonePage.getByRole('button', { name: 'Submit answers' }).click();
    await expect(phonePage.locator('main')).toContainText('Score: 2 / 3');
    expect(await phonePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (screenshotDir) {
      await phonePage.screenshot({
        path: path.join(screenshotDir, 'phone-media-light.png'),
        fullPage: false,
      });
    }

    // Phone Sessions
    await waitForLensReady(phonePage, 'sessions');
    await phonePage.waitForTimeout(250);
    expect(await phonePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (screenshotDir) {
      await phonePage.screenshot({
        path: path.join(screenshotDir, 'phone-sessions-light.png'),
        fullPage: false,
      });
    }

    // Phone Excalidraw canvas
    await waitForLensReady(phonePage, 'decisions');
    await phonePage.getByRole('button', { name: /Mental Model Whiteboard \(Excalidraw\)/ }).click();
    await expect(phonePage.locator('.excalidraw').first()).toBeVisible({ timeout: 15_000 });
    await phonePage.waitForTimeout(350);
    expect(await phonePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (screenshotDir) {
      await phonePage.screenshot({
        path: path.join(screenshotDir, 'phone-excalidraw-light.png'),
        fullPage: false,
      });
    }

    expect(phoneErrors).toEqual([]);
    expect(await getCspViolations(phonePage)).toEqual([]);
    await phoneCtx.close();
  });

  test('R3-1: sanitized Mermaid SVG triggers zero external requests', async ({ browser }) => {
    const authHeaders = {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    };

    // Seed an adversarial Mermaid diagram with CSS escape directives via REST API
    const diagRes = await fetch(`${BASE_URL}/api/boards/realtime-sync-v2/diagrams`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'R3-1 Adversarial Mermaid',
        kind: 'mermaid',
        content: [
          '%%{init: {"themeCSS": ".node rect { background: \\\\\\\\75rl(\\"https://evil.example/mmd-themecss\\"); }"}}%%',
          'flowchart LR',
          '  A[Alpha] --> B[Beta]',
        ].join('\n'),
      }),
    });
    expect(diagRes.status).toBe(201);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const externalRequests: string[] = [];
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith(BASE_URL) || reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl.startsWith('about:')) {
        await route.continue();
        return;
      }
      externalRequests.push(reqUrl);
      await route.abort();
    });

    await authenticateViaLaunchUrl(page);

    // Render the adversarial Mermaid diagram through the real Decisions lens
    await waitForLensReady(page, 'decisions');
    await page.getByRole('button', { name: /R3-1 Adversarial Mermaid/ }).click();
    await expect(page.locator('[data-mermaid-rendered="true"] svg').first()).toContainText('Alpha', {
      timeout: 15_000,
    });
    await page.waitForTimeout(250);

    // Also run all 7 Neon R3-1 vectors + custom property + non-<a> external href through sanitizeMermaidSvg
    // and render the sanitized SVGs inside the real page (using JSDOM-backed DOMPurify matching unit tests)
    const { JSDOM } = await import('../packages/web/node_modules/jsdom/lib/api.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const prevGlobals = {
      window: (globalThis as Record<string, unknown>).window,
      document: (globalThis as Record<string, unknown>).document,
      DOMParser: (globalThis as Record<string, unknown>).DOMParser,
      Node: (globalThis as Record<string, unknown>).Node,
      Element: (globalThis as Record<string, unknown>).Element,
    };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      DOMParser: dom.window.DOMParser,
      Node: dom.window.Node,
      Element: dom.window.Element,
    });
    let sanitizedSvgs: string[] = [];
    try {
      const { sanitizeMermaidSvg } = await import('../packages/web/src/security.ts');
      const vectors = [
        '<svg width="100" height="100"><style>.a{background:\\\\75rl("https://evil.example/hit-style-url")}</style><foreignObject width="100" height="100"><div class="a">x</div></foreignObject></svg>',
        '<svg width="100" height="100"><style>@\\\\69mport "https://evil.example/hit-at-import";</style></svg>',
        '<svg width="100" height="100"><foreignObject width="100" height="100"><div style="background:\\\\75rl(https://evil.example/hit-inline-style)">x</div></foreignObject></svg>',
        '<svg width="100" height="100"><style>.b{background-image:\\\\69mage-set("https://evil.example/hit-image-set" 1x)}</style><foreignObject width="100" height="100"><div class="b">x</div></foreignObject></svg>',
        '<svg width="100" height="100"><style>@import "https://evil.example/hit-brace}css";</style></svg>',
        '<svg width="100" height="100"><foreignObject width="100" height="100"><table background="https://evil.example/hit-table-bg"><tr><td background="https://evil.example/hit-td-bg">x</td></tr></table></foreignObject></svg>',
        '<svg width="100" height="100"><style>:root { --u: \\\\75rl("https://evil.example/hit-custom-prop"); } .c { background: var(--u); }</style><foreignObject width="100" height="100"><div class="c">x</div></foreignObject></svg>',
        '<svg width="100" height="100"><defs><pattern id="p" href="https://evil.example/hit-pattern"/><linearGradient id="g" xlink:href="https://evil.example/hit-grad"/></defs><rect width="100" height="100" fill="url(#p)"/></svg>',
      ];
      sanitizedSvgs = vectors.map((v) => sanitizeMermaidSvg(v));
    } finally {
      for (const [k, v] of Object.entries(prevGlobals)) {
        if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
        else (globalThis as Record<string, unknown>)[k] = v;
      }
    }

    for (const html of sanitizedSvgs) {
      await page.evaluate((markup) => {
        const host = document.createElement('div');
        host.setAttribute('data-r3-1-probe', 'true');
        host.innerHTML = markup;
        document.body.appendChild(host);
      }, html);
    }
    await page.waitForTimeout(400);

    expect(externalRequests, `External requests triggered: ${JSON.stringify(externalRequests)}`).toEqual([]);
    expect(await getCspViolations(page)).toEqual([]);
    expect(errors).toEqual([]);

    // Check real SPA HTML response carries strict CSP header
    const docRes = await page.request.get(`${BASE_URL}/`);
    const csp = docRes.headers()['content-security-policy'] ?? '';
    expect(csp, 'SPA HTML response missing Content-Security-Policy').toContain("default-src 'self'");
    expect(csp).toMatch(/img-src\s+'self'\s+data:\s+blob:/);
    expect(csp).not.toMatch(/img-src[^;]*(?:\*|https?:)/i);
    await context.close();
  });

  test('R4-1: external https video plays under WEB_UI_CSP', async ({ browser }) => {
    // 0.5s 64x36 solid-indigo VP9 MP4 (faststart, 952 bytes) playable by headless Chromium
    const TINY_VP9_MP4 = Buffer.from(
      'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAydtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAB9AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACUXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAACQAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAfQAAAAAAAEAAAAAAcltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAAUAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAF0bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABNHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAQAAkAEgAAABIAAAAAAAAAAEYTGF2YzYwLjMxLjEwMiBsaWJ2cHgtdnA5AAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABOIAAABlAAAAAYc3R0cwAAAAAAAAABAAAABQAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAABQAAAAEAAAAoc3RzegAAAAAAAAAAAAAABQAAACkAAAAPAAAADwAAAA8AAAAPAAAAFHN0Y28AAAAAAAAAAQAAA1MAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAAAbW1kYXSCSYNCAAPwAjYAOCQcGEIAADBgAAATv//20NAAI////+6V6f///atAAIYAQJKcAElAAAMgAABUcIYAQJKcAErAAAMgAABUcIYAQJKcAEnAAAMgAABUcIYAQJKcAEigAAMgAABUcA==',
      'base64',
    );
    const VIDEO_URL = 'https://media.example.test/tutorial.mp4';

    const authHeaders = {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    };
    const addRes = await fetch(`${BASE_URL}/api/boards/realtime-sync-v2/media`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Remote video repro',
        kind: 'video',
        externalUrl: VIDEO_URL,
      }),
    });
    expect(addRes.status).toBe(201);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const videoRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.route(VIDEO_URL, async (route) => {
      videoRequests.push(route.request().url());
      const rangeHeader = route.request().headers()['range'];
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Math.min(Number(match[2]), TINY_VP9_MP4.length - 1) : TINY_VP9_MP4.length - 1;
        const chunk = TINY_VP9_MP4.subarray(start, end + 1);
        await route.fulfill({
          status: 206,
          contentType: 'video/mp4',
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${TINY_VP9_MP4.length}`,
            'Content-Length': String(chunk.length),
          },
          body: chunk,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'video/mp4',
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(TINY_VP9_MP4.length),
        },
        body: TINY_VP9_MP4,
      });
    });

    await authenticateViaLaunchUrl(page);
    await waitForLensReady(page, 'media');
    await page.getByRole('button', { name: /Remote video repro/ }).click();

    const videoEl = page.locator(`video[src="${VIDEO_URL}"]`);
    await expect(videoEl).toBeVisible({ timeout: 10_000 });
    expect(await videoEl.getAttribute('preload')).toBe('none');

    // Before clicking play: zero requests to the external video URL and zero media-src CSP violations
    await page.waitForTimeout(300);
    expect(videoRequests, 'External video fetched before user pressed play').toEqual([]);
    const violationsBefore = await getCspViolations(page);
    expect(violationsBefore.filter((v) => v.includes('media-src'))).toEqual([]);

    // Click play on the video element (and ensure playback starts cleanly)
    await videoEl.click();
    await videoEl.evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      if (v.paused && !v.ended) {
        await v.play();
      }
    });

    await expect
      .poll(() => videoRequests.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const playbackState = await videoEl.evaluate((el) => {
      const v = el as HTMLVideoElement;
      return {
        errorCode: v.error?.code ?? null,
        readyState: v.readyState,
        paused: v.paused,
        ended: v.ended,
        currentTime: v.currentTime,
      };
    });
    expect(playbackState.errorCode).toBeNull();
    expect(playbackState.readyState).toBeGreaterThanOrEqual(2);
    expect(playbackState.paused === false || playbackState.ended || playbackState.currentTime > 0).toBe(true);

    const violationsAfter = await getCspViolations(page);
    expect(violationsAfter.filter((v) => v.includes('media-src'))).toEqual([]);
    expect(violationsAfter).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });
});
