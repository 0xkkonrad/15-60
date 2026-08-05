import http from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const SHOTS = process.env.CLEAR60_QA_SHOTS || '/tmp/clear60-qa';
const mime = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const path = resolve(ROOT, relative);
    if (!path.startsWith(`${ROOT}/`) || !(await stat(path)).isFile()) throw new Error('not found');
    response.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});

await mkdir(SHOTS, { recursive: true });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await playwright.chromium.launch({ executablePath: playwright.chromium.executablePath() });
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function pageAudit(page, label, expectedPrimary = 1, selector = 'body') {
  const audit = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const shown = (element) => {
      if (!root?.contains(element)) return false;
      let ancestor = element;
      while (ancestor && ancestor instanceof HTMLElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
        if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
          const summary = ancestor.querySelector(':scope > summary');
          if (element !== summary && !summary?.contains(element)) return false;
        }
        if (ancestor === root) break;
        ancestor = ancestor.parentElement;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && rect.width > 0 && rect.height > 0;
    };
    const roots = [root, ...root.querySelectorAll('*')].filter((element) => element && shown(element));
    const interactive = roots.filter((element) => element.matches('button, input, textarea, summary, [tabindex]:not([tabindex="-1"])'));
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      primary: roots.filter((element) => element.classList.contains('primary-button')).map((element) => element.textContent.trim()),
      wrongFonts: roots.filter((element) => !getComputedStyle(element).fontFamily.includes('DM Mono')).slice(0, 12).map((element) => `${element.tagName}.${element.className}`),
      tinyType: roots.filter((element) => element.textContent.trim() && parseFloat(getComputedStyle(element).fontSize) < 12)
        .slice(0, 12).map((element) => `${element.tagName}.${element.id || element.className}:${getComputedStyle(element).fontSize}`),
      tinyTargets: interactive.map((element) => {
        const proxy = element.matches('input[type="checkbox"], input[type="radio"]') && element.closest('label')
          ? element.closest('label') : element;
        const rect = proxy.getBoundingClientRect();
        return { target: element.id || element.textContent.trim().slice(0, 30) || element.tagName, width: rect.width, height: rect.height };
      }).filter((item) => item.width < 40 || item.height < 40),
      clipped: roots.map((element) => {
        const rect = element.getBoundingClientRect();
        return { target: element.id || element.className || element.tagName, left: rect.left, right: rect.right, inCalendar: Boolean(element.closest('#streak-calendar')) };
      }).filter((item) => !item.inCalendar && (item.left < -1 || item.right > innerWidth + 1)).slice(0, 20),
    };
  }, selector);
  check(audit.scrollWidth <= audit.clientWidth + 1, `${label}: document overflows (${audit.scrollWidth} > ${audit.clientWidth})`);
  check(audit.primary.length === expectedPrimary, `${label}: expected ${expectedPrimary} dominant CTA, saw ${audit.primary.length}: ${audit.primary.join(', ')}`);
  check(audit.wrongFonts.length === 0, `${label}: non-mono fonts: ${audit.wrongFonts.join(', ')}`);
  check(audit.tinyType.length === 0, `${label}: visible type below 12px: ${audit.tinyType.join(', ')}`);
  check(audit.tinyTargets.length === 0, `${label}: undersized targets: ${JSON.stringify(audit.tinyTargets)}`);
  check(audit.clipped.length === 0, `${label}: clipped outside an intentional scroller: ${JSON.stringify(audit.clipped)}`);
  return audit;
}

function silentWav(seconds = 0.5, sampleRate = 8000) {
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

async function seedStreaks(page) {
  await page.evaluate(async () => {
    const core = await import('./core.js');
    const storage = await import('./storage.js');
    const now = new Date();
    for (const delta of [0, 1, 2, 4, 7, 8, 14, 22, 31, 42, 57, 73, 90, 108]) {
      const day = new Date(now);
      day.setDate(day.getDate() - delta);
      const session = core.createSession({
        topic: `Seed practice ${delta}`,
        topicDate: core.localDateKey(day),
        now: day,
        id: `qa-streak-${delta}`,
      });
      session.completedAt = day.toISOString();
      session.updatedAt = day.toISOString();
      session.timing.presentationElapsedSeconds = 60;
      await storage.saveSession(session, null);
    }
  });
}

try {
  for (const viewport of [
    { width: 320, height: 568, name: '320' },
    { width: 390, height: 844, name: '390' },
    { width: 768, height: 1024, name: '768' },
    { width: 1440, height: 900, name: '1440' },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await pageAudit(page, `${viewport.name}/prompt`);
    await page.waitForTimeout(280);
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-prompt.png`, fullPage: true });

    await page.evaluate(() => {
      const topic = 'How should a thoughtful team explain a complicated, emotionally loaded decision without losing the one concrete fact that makes the conclusion trustworthy or overwhelming the listener with every possible qualification?';
      document.querySelector('#topic-text').textContent = topic;
    });
    await pageAudit(page, `${viewport.name}/long-topic`);
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-long-topic.png`, fullPage: true });

    await page.getByRole('button', { name: 'Open settings' }).click();
    await pageAudit(page, `${viewport.name}/settings`, 0, '#settings-dialog');
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-settings.png`, fullPage: false });
    await page.keyboard.press('Escape');
    check(!(await page.locator('#settings-dialog').isVisible()), `${viewport.name}: Escape did not close Settings`);

    await seedStreaks(page);
    await page.getByRole('button', { name: /Streaks/ }).click();
    await page.locator('.streak-month').last().waitFor();
    await page.waitForTimeout(180);
    await pageAudit(page, `${viewport.name}/streaks`, 0);
    const calendar = page.locator('#streak-calendar');
    const latestEdges = await page.locator('.calendar-frame').evaluate((element) => ({
      left: element.classList.contains('can-scroll-left'),
      right: element.classList.contains('can-scroll-right'),
    }));
    check(latestEdges.left && !latestEdges.right, `${viewport.name}: latest Streak month has untruthful edge fades ${JSON.stringify(latestEdges)}`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-streaks.png`, fullPage: true });
    const before = await calendar.evaluate((element) => element.scrollLeft);
    await calendar.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    const after = await calendar.evaluate((element) => element.scrollLeft);
    check(after < before, `${viewport.name}: keyboard did not scroll the streak calendar toward earlier days`);
    await calendar.evaluate((element) => element.blur());
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-streaks-keyboard.png`, fullPage: true });
    check(errors.length === 0, `${viewport.name}: page errors: ${errors.join('; ')}`);
    await context.close();
  }

  const flowContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const flow = await flowContext.newPage();
  await flow.goto(base, { waitUntil: 'networkidle' });
  await flow.getByRole('button', { name: /Start 15 minutes/i }).click();
  await pageAudit(flow, 'flow/research');
  await flow.waitForTimeout(300);
  await flow.screenshot({ path: `${SHOTS}/flow-research.png`, fullPage: true });
  await flow.getByRole('button', { name: /Ready for 60 seconds/i }).click();
  await pageAudit(flow, 'flow/present');
  await flow.waitForTimeout(300);
  await flow.screenshot({ path: `${SHOTS}/flow-present.png`, fullPage: true });
  await flow.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('No microphone', 'NotAllowedError'); },
    });
  });
  await flow.locator('#start-presentation').click();
  await flow.getByRole('button', { name: /Start timer only/i }).waitFor();
  await pageAudit(flow, 'flow/mic-denied');
  await flow.waitForTimeout(100);
  await flow.screenshot({ path: `${SHOTS}/flow-mic-denied.png`, fullPage: true });
  await flow.getByRole('button', { name: /Start timer only/i }).click();
  check((await flow.locator('#audio-state-title').textContent()) === 'Your minute is running', 'flow/recording: timer-only copy stayed armed after the timer began');
  await pageAudit(flow, 'flow/recording', 0);
  await flow.evaluate(() => scrollTo(0, 0));
  await flow.waitForTimeout(120);
  await flow.screenshot({ path: `${SHOTS}/flow-recording.png`, fullPage: true });
  await flow.getByRole('button', { name: /Finish early/i }).click();
  await flow.locator('#review-stage:not([hidden])').waitFor();
  await pageAudit(flow, 'flow/review');
  await flow.waitForTimeout(300);
  await flow.screenshot({ path: `${SHOTS}/flow-review.png`, fullPage: true });
  await flow.locator('#audio-file').setInputFiles({ name: 'qa-take.wav', mimeType: 'audio/wav', buffer: silentWav() });
  await flow.locator('#review-player:not([hidden])').waitFor();
  check(await flow.locator('#review-audio').evaluate((audio) => audio.hidden && !audio.controls), 'flow/review-player: native audio chrome is visible');
  await pageAudit(flow, 'flow/review-player');
  await flow.waitForTimeout(180);
  await flow.screenshot({ path: `${SHOTS}/flow-review-player.png`, fullPage: true });
  await flow.locator('.export-card > summary').click();
  await pageAudit(flow, 'flow/review-export-open');
  await flow.screenshot({ path: `${SHOTS}/flow-review-export-open.png`, fullPage: true });
  await flowContext.close();

  const zoomContext = await browser.newContext({ viewport: { width: 768, height: 700 } });
  const zoom = await zoomContext.newPage();
  await zoom.goto(base, { waitUntil: 'networkidle' });
  await zoom.evaluate(() => {
    document.documentElement.style.zoom = '2';
    document.querySelector('#topic-text').textContent = 'Why does a clear explanation need one memorable example, one trustworthy fact, and enough restraint to stop before the listener loses the point?';
  });
  await pageAudit(zoom, '200%-zoom');
  await zoom.screenshot({ path: `${SHOTS}/200-percent-zoom.png`, fullPage: true });
  await zoomContext.close();

  const reduceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const reduce = await reduceContext.newPage();
  await reduce.goto(base, { waitUntil: 'networkidle' });
  const started = Date.now();
  await reduce.locator('#another-topic').click();
  await reduce.waitForFunction(() => document.querySelector('#another-topic').getAttribute('aria-busy') === 'false');
  const elapsed = Date.now() - started;
  const animation = await reduce.locator('.dice-icon').evaluate((element) => getComputedStyle(element).animationName);
  check(elapsed < 250, `reduced motion: topic roll took ${elapsed}ms`);
  check(animation === 'none', `reduced motion: dice still animates (${animation})`);
  await reduce.screenshot({ path: `${SHOTS}/reduced-motion.png`, fullPage: true });
  await reduceContext.close();

  const forcedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, forcedColors: 'active' });
  const forced = await forcedContext.newPage();
  await forced.goto(base, { waitUntil: 'networkidle' });
  await pageAudit(forced, 'forced-colors');
  await forced.screenshot({ path: `${SHOTS}/forced-colors.png`, fullPage: true });
  await forcedContext.close();
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

if (failures.length) {
  console.error(`FAIL\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  hostile layouts, states, motion, keyboard, targets and type at ${SHOTS}`);
}
