import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CURRENT_SHELL = '20260807a';
const CURRENT_CACHE = `clear60-shell-v1-${CURRENT_SHELL}`;
const LEGACY_SHELL = 'migration-legacy';
const LEGACY_CACHE = `clear60-shell-v1-${LEGACY_SHELL}`;
const LEGACY_RUNS = 'clear60-migration-test/legacy-runs';

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.md': 'text/plain',
};

const legacyIndex = `<!doctype html>
<html lang="en" data-app-ready="loading">
<head><meta charset="utf-8"><title>Legacy 15:60</title></head>
<body>
  <main id="legacy-only">Legacy shell</main>
  <script type="module">
    const registration = await navigator.serviceWorker.register(
      './sw.js?shell=${LEGACY_SHELL}',
      { updateViaCache: 'none' },
    );
    await navigator.serviceWorker.ready;
    document.documentElement.dataset.legacyWorker = registration.active ? 'ready' : 'missing';
    await import('./app.js');
  </script>
</body>
</html>`;

/* This is intentionally incompatible with the current document. If an old
 * cache-first worker serves it during the upgrade, it leaves durable evidence
 * before throwing the same class of missing-selector error that broke 15:60. */
const legacyApp = `
const key = ${JSON.stringify(LEGACY_RUNS)};
localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0) + 1));
const legacyRoot = document.querySelector('#legacy-only');
if (!legacyRoot) throw new Error('Legacy app.js ran against the current shell');
legacyRoot.textContent = 'Legacy shell ready';
document.documentElement.dataset.appReady = 'legacy';
`;

const legacyWorker = `
const CACHE = ${JSON.stringify(LEGACY_CACHE)};
const SHELL = ['./', 'index.html', 'app.js'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (
      (await caches.open(CACHE)).match('index.html')
    )));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(request, { ignoreSearch: true })) || fetch(request);
  })());
});
`;

let phase = 'legacy';
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';

    if (url.pathname === '/sw.js' && url.searchParams.get('shell') === LEGACY_SHELL) {
      response.writeHead(200, { 'content-type': mime['.js'], 'cache-control': 'no-store' });
      response.end(legacyWorker);
      return;
    }
    if (phase === 'legacy' && relative === 'index.html') {
      response.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-store' });
      response.end(legacyIndex);
      return;
    }
    if (phase === 'legacy' && relative === 'app.js') {
      response.writeHead(200, { 'content-type': mime['.js'], 'cache-control': 'no-store' });
      response.end(legacyApp);
      return;
    }
    if (phase === 'failed-update' && relative === 'core.js') {
      response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('intentional migration-test failure');
      return;
    }

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

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await playwright.chromium.launch({ executablePath: playwright.chromium.executablePath() });

async function installLegacyShell(context) {
  phase = 'legacy';
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('html[data-app-ready="legacy"]').waitFor();
  await page.waitForFunction((shell) => {
    const script = navigator.serviceWorker.controller?.scriptURL;
    return script && new URL(script).searchParams.get('shell') === shell;
  }, LEGACY_SHELL);
  const state = await page.evaluate(async (key) => ({
    legacyRuns: Number(localStorage.getItem(key) || 0),
    caches: await caches.keys(),
  }), LEGACY_RUNS);
  assert.equal(state.legacyRuns, 1, 'the legacy fixture did not run exactly once');
  assert(state.caches.includes(LEGACY_CACHE), 'the legacy shell cache was not installed');
  return { page, baselineLegacyRuns: state.legacyRuns };
}

async function browserState(page) {
  return page.evaluate(async (key) => ({
    ready: document.documentElement.dataset.appReady,
    controller: navigator.serviceWorker.controller?.scriptURL || '',
    caches: await caches.keys(),
    legacyRuns: Number(localStorage.getItem(key) || 0),
    topic: document.querySelector('#topic-text')?.textContent || '',
  }), LEGACY_RUNS);
}

try {
  const currentIndex = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const currentWorker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  assert.match(currentIndex, new RegExp(`const shellStamp = '${CURRENT_SHELL}'`));
  assert.match(currentWorker, new RegExp(`clear60-shell-v1-${CURRENT_SHELL}`));

  {
    /* IDE previews and privacy-hardened WebViews can expose
     * navigator.serviceWorker while refusing registration. Playwright models
     * that case by resolving register() without a registration object. The
     * uncontrolled network page must still boot as an ordinary web app. */
    phase = 'current';
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('html[data-app-ready="true"]').waitFor({ timeout: 8_000 });
    const blocked = await browserState(page);
    assert.equal(blocked.controller, '', 'a blocked service worker unexpectedly controlled the page');
    assert.notEqual(blocked.topic, 'Loading today’s topic…',
      'the ordinary network app did not boot when service workers were blocked');
    assert.deepEqual(pageErrors, [], `blocked-worker page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `blocked-worker console errors: ${consoleErrors.join('\n')}`);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { page, baselineLegacyRuns } = await installLegacyShell(context);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    phase = 'current';
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-app-ready="true"]').waitFor({ timeout: 12_000 });
    const upgraded = await browserState(page);
    assert.equal(new URL(upgraded.controller).searchParams.get('shell'), CURRENT_SHELL,
      'the current worker did not take control before app startup');
    assert(upgraded.caches.includes(CURRENT_CACHE), 'the complete current shell was not cached');
    assert.equal(upgraded.legacyRuns, baselineLegacyRuns, 'legacy app.js ran in the current document');
    assert.notEqual(upgraded.topic, 'Loading today’s topic…', 'the current app did not finish booting');
    assert.deepEqual(pageErrors, [], `upgrade page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `upgrade console errors: ${consoleErrors.join('\n')}`);

    pageErrors.length = 0;
    consoleErrors.length = 0;
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('html[data-app-ready="true"]').waitFor({ timeout: 8_000 });
    const offline = await browserState(page);
    assert.equal(new URL(offline.controller).searchParams.get('shell'), CURRENT_SHELL);
    assert(offline.caches.includes(CURRENT_CACHE));
    assert.equal(offline.legacyRuns, baselineLegacyRuns, 'offline reload fell back to legacy JavaScript');
    assert.deepEqual(pageErrors, [], `offline page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `offline console errors: ${consoleErrors.join('\n')}`);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { page, baselineLegacyRuns } = await installLegacyShell(context);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

    phase = 'failed-update';
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-app-ready="failed"]').waitFor({ timeout: 12_000 });
    await page.getByRole('button', { name: 'Retry update' }).waitFor();
    const failed = await browserState(page);
    assert.equal(new URL(failed.controller).searchParams.get('shell'), LEGACY_SHELL,
      'a partial worker replaced the last complete controller');
    assert(failed.caches.includes(LEGACY_CACHE), 'a failed update deleted the last complete shell');
    assert(!failed.caches.includes(CURRENT_CACHE), 'a partial current cache was retained');
    assert.equal(failed.legacyRuns, baselineLegacyRuns, 'the fallback page executed incompatible legacy JS');
    assert.deepEqual(pageErrors, [], `failed-update page errors: ${pageErrors.join('\n')}`);

    phase = 'current';
    await page.getByRole('button', { name: 'Retry update' }).click();
    await page.locator('html[data-app-ready="true"]').waitFor({ timeout: 12_000 });
    const retried = await browserState(page);
    assert.equal(new URL(retried.controller).searchParams.get('shell'), CURRENT_SHELL);
    assert(retried.caches.includes(CURRENT_CACHE), 'retry did not install the complete current shell');
    assert.equal(retried.legacyRuns, baselineLegacyRuns, 'retry executed incompatible legacy JS');
    await context.close();
  }

  console.log('PASS  atomic old-shell migration, offline reload and failed-update retry');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
