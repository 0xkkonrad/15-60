import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const mime = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await playwright.chromium.launch({
  executablePath: playwright.chromium.executablePath(),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({
  acceptDownloads: true,
  permissions: ['microphone'],
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const waitForApp = (target) => target.locator('html[data-app-ready="true"]').waitFor({ timeout: 10000 });

function tarFiles(buffer) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
    const name = field(0, 100);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(124, 12) || '0', 8);
    const start = offset + 512;
    files.set(path, buffer.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await waitForApp(page);

  if (await page.locator('#custom-topic').count()) throw new Error('custom-topic controls were not removed');
  const originalTopic = await page.locator('#topic-text').textContent();
  if (originalTopic.includes(' — ') || originalTopic.endsWith('?')) throw new Error('topic still includes a research question');
  await page.evaluate(() => {
    const button = document.querySelector('#another-topic');
    button.click();
    button.click();
    button.click();
    button.click();
  });
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('clear60/topic-rolls/v1') || 'null');
    return state?.rollsUsed === 1 && document.querySelector('#another-topic')?.getAttribute('aria-busy') === 'false';
  });
  for (let expected = 2; expected <= 3; expected++) {
    await page.locator('#another-topic').click();
    await page.waitForFunction((used) => {
      const state = JSON.parse(localStorage.getItem('clear60/topic-rolls/v1') || 'null');
      return state?.rollsUsed === used && document.querySelector('#another-topic')?.getAttribute('aria-busy') === 'false';
    }, expected);
  }
  const rolledTopic = await page.locator('#topic-text').textContent();
  if (rolledTopic === originalTopic) throw new Error('three rolls did not change the topic');
  if (!(await page.locator('#another-topic').isDisabled())) throw new Error('fourth topic roll is still enabled');
  if (!/today.s pick/i.test(await page.locator('#rolls-left').textContent())) throw new Error('spent-roll state is unclear');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  if ((await page.locator('#topic-text').textContent()) !== rolledTopic) throw new Error('rolled topic did not persist across reload');
  const restoredRollState = await page.evaluate(() => JSON.parse(localStorage.getItem('clear60/topic-rolls/v1')));
  if (restoredRollState.rollsUsed !== 3 || restoredRollState.offset !== 3) throw new Error('roll limit was not persisted');

  await page.getByRole('button', { name: /Start (?:the )?15(?:-minute research| minutes)/i }).click();
  const researchBeforeReload = await page.locator('#research-time').textContent();
  await page.waitForTimeout(450);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await page.locator('#research-stage:not([hidden])').waitFor();
  if (!(await page.locator('#research-time').textContent()) || researchBeforeReload === '0:00') throw new Error('active research timer was not restored');
  if (await page.locator('textarea#research-notes').count()) throw new Error('research stage unexpectedly contains notes');
  if (await page.locator('.research-guide').count()) throw new Error('numbered research guide was not removed');
  await page.getByRole('button', { name: /ready (?:to present|for 60 seconds)/i }).click();
  if (await page.locator('#enable-microphone').count()) throw new Error('presentation has more than one start CTA');
  await page.getByRole('button', { name: /Start 60 seconds|Record 60 seconds/i }).click();
  await page.locator('#recording-badge:not([hidden])').waitFor();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: /Finish early/i }).click();
  await page.locator('#review-stage:not([hidden])').waitFor();
  await page.locator('#review-player:not([hidden])').waitFor();
  if (await page.locator('#review-audio').evaluate((audio) => audio.controls || !audio.hidden)) throw new Error('native audio chrome escaped the doodle player');
  if (!(await page.getByRole('button', { name: /Play audio/i }).isVisible())) throw new Error('accessible doodle player is unavailable');
  if (!(await page.getByRole('button', { name: /Replace audio/i }).isVisible())) throw new Error('attached-audio action does not explain that it replaces the take');
  if (await page.locator('#download-audio').isDisabled()) throw new Error('recorded audio is not available for download');
  await page.locator('#audio-file').setInputFiles({
    name: 'not-audio.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not audio'),
  });
  await page.getByText(/Choose a non-empty audio file/i).waitFor();
  await page.locator('input[name="self-rating"][value="4"]').check();
  await page.locator('#future-notes').fill('Pause before the concrete example.');
  await page.waitForTimeout(700);

  await page.locator('.export-card > summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download review data' }).click();
  const download = await downloadPromise;
  const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
  if (payload.kind !== 'clear60-session' || payload.schemaVersion !== 3) throw new Error('review JSON contract changed');
  if (payload.selfRating !== 4 || !payload.futureNotes.includes('concrete example')) throw new Error('reflection fields were not exported');
  if (typeof payload.timing.presentationElapsedSeconds !== 'number') throw new Error('presentation duration missing');
  if ('researchNotes' in payload) throw new Error('removed research notes leaked into the review JSON');
  if (payload.media.kind !== 'audio' || !payload.media.type.startsWith('audio/')) throw new Error('audio metadata missing from review JSON');
  const secondSessionId = await page.evaluate(async () => {
    const core = await import('./core.js');
    const storage = await import('./storage.js');
    const older = new Date(Date.now() - 60 * 60 * 1000);
    const second = core.createSession({ topic: 'Coase theorem', topicDate: core.localDateKey(), now: older });
    second.completedAt = older.toISOString();
    second.updatedAt = older.toISOString();
    second.selfRating = 2;
    second.futureNotes = 'Use a concrete transaction-cost example.';
    await storage.saveSession(second, null);
    return second.id;
  });

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.locator('#data-heading').click();
  const historyDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all history' }).click();
  const historyDownload = await historyDownloadPromise;
  if (!historyDownload.suggestedFilename().endsWith('.tar')) throw new Error('history export is not a TAR archive');
  const historyFiles = tarFiles(await readFile(await historyDownload.path()));
  const historyManifest = JSON.parse(historyFiles.get('manifest.json').toString('utf8'));
  if (historyManifest.kind !== 'clear60-history-export' || historyManifest.sessionCount !== 2 || historyManifest.audioCount !== 1) {
    throw new Error(`history manifest is incomplete: ${JSON.stringify(historyManifest)}`);
  }
  if (!historyManifest.sessions.every((entry) => historyFiles.has(entry.metadataFile))) throw new Error('history archive omitted session metadata');
  const historyEntry = historyManifest.sessions.find((entry) => entry.audioFile);
  const historySession = JSON.parse(historyFiles.get(historyEntry.metadataFile).toString('utf8'));
  if (historySession.selfRating !== 4 || historySession.futureNotes !== 'Pause before the concrete example.') throw new Error('history lost reflection data');
  if (!historyEntry.audioFile || !historyFiles.get(historyEntry.audioFile)?.length) throw new Error('history archive omitted local audio');
  await page.keyboard.press('Escape');
  await page.evaluate(async (id) => {
    const { removeSession } = await import('./storage.js');
    await removeSession(id);
  }, secondSessionId);

  await page.locator('#local-save-status[data-state="saved"]').waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#streaks-view:not([hidden])').waitFor();
  if (await page.locator('#current-streak').textContent() !== '1') throw new Error('completed practice did not start a streak');
  const completedTake = page.locator('button.streak-day.is-complete');
  if (await completedTake.count() !== 1) throw new Error('completed day is not one reopenable calendar button');
  const savedSessionId = await completedTake.getAttribute('data-session-id');
  if (!savedSessionId) throw new Error('completed calendar button does not identify its saved take');
  const storedTake = await page.evaluate(async (id) => {
    const { getSession } = await import('./storage.js');
    const saved = await getSession(id);
    return {
      id: saved?.session?.id || '',
      selfRating: saved?.session?.selfRating ?? null,
      futureNotes: saved?.session?.futureNotes || '',
      mediaSize: saved?.mediaBlob?.size || 0,
      mediaType: saved?.mediaBlob?.type || '',
    };
  }, savedSessionId);
  if (storedTake.id !== savedSessionId || storedTake.mediaSize < 1 || !storedTake.mediaType.startsWith('audio/')) {
    throw new Error(`IndexedDB did not retain the completed take and audio: ${JSON.stringify(storedTake)}`);
  }
  if (storedTake.selfRating !== 4 || !storedTake.futureNotes.includes('concrete example')) throw new Error('IndexedDB did not retain reflection fields');
  if (await page.getByText(/^History$/i).count()) throw new Error('History is still visible');

  await completedTake.click();
  await page.locator('#review-stage:not([hidden])').waitFor();
  await page.locator('#review-player:not([hidden])').waitFor();
  if (!(await page.locator('input[name="self-rating"][value="4"]').isChecked())) throw new Error('reopened take lost self-rating');
  if ((await page.locator('#future-notes').inputValue()) !== 'Pause before the concrete example.') throw new Error('reopened take lost future note');
  if (!(await page.locator('#review-audio').getAttribute('src'))?.startsWith('blob:')) {
    throw new Error('reopened calendar take did not restore its local audio URL');
  }
  if (await page.getByRole('button', { name: 'Download audio' }).isDisabled()) {
    throw new Error('reopened calendar take cannot download its saved audio');
  }
  const reopenedAudioPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download audio' }).click();
  const reopenedAudio = await reopenedAudioPromise;
  if ((await stat(await reopenedAudio.path())).size < 1) throw new Error('reopened audio download is empty');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete this take' }).click();
  await page.locator('#prompt-stage:not([hidden])').waitFor();
  const deletedTake = await page.evaluate(async (id) => {
    const { getSession } = await import('./storage.js');
    return getSession(id);
  }, savedSessionId);
  if (deletedTake !== null) throw new Error('Delete left the saved session or audio in IndexedDB');
  await page.locator('[data-nav="streaks"]').first().click();
  await page.waitForFunction((id) => !document.querySelector(`[data-session-id="${id}"]`), savedSessionId);
  if (await page.locator('button.streak-day.is-complete').count()) throw new Error('deleted take remains reopenable in Streaks');
  await page.locator('[data-nav="today"]').first().click();
  await page.locator('#prompt-stage:not([hidden])').waitFor();
  const activeDraft = await page.evaluate(() => localStorage.getItem('clear60/active/v1'));
  if (activeDraft !== null) throw new Error('completed active draft was not cleared');

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'load' });
    await waitForApp(page);
  }
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await page.locator('#prompt-stage:not([hidden])').waitFor();

  const fallbackContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForApp(fallbackPage);
    await fallbackPage.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => { throw new DOMException('No microphone', 'NotAllowedError'); },
      });
    });
    await fallbackPage.getByRole('button', { name: /Start (?:the )?15(?:-minute research| minutes)/i }).click();
    await fallbackPage.getByRole('button', { name: /ready (?:to present|for 60 seconds)/i }).click();
    await fallbackPage.locator('#start-presentation').click();
    await fallbackPage.getByRole('button', { name: /Start timer only/i }).waitFor();
    if (!(await fallbackPage.locator('#present-actions').isHidden())) throw new Error('mic denial unexpectedly started the timer');
    if ((await fallbackPage.locator('#presentation-time').textContent()) !== '1:00') throw new Error('mic denial consumed presentation time');
    await fallbackPage.getByRole('button', { name: /Start timer only/i }).click();
    await fallbackPage.locator('#present-actions:not([hidden])').waitFor();
    if ((await fallbackPage.locator('#audio-state-title').textContent()) !== 'Your minute is running') throw new Error('timer-only UI retained its armed state after starting');
    await fallbackPage.getByRole('button', { name: /Finish early/i }).click();
    await fallbackPage.locator('#review-stage:not([hidden])').waitFor();
  } finally {
    await fallbackContext.close();
  }

  const warningContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await warningContext.addInitScript(() => {
      if (sessionStorage.getItem('clear60-warning-seeded')) return;
      sessionStorage.setItem('clear60-warning-seeded', 'true');
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      localStorage.setItem('clear60/active/v1', JSON.stringify({
        version: 1,
        phase: 'research',
        deadline: Date.now() + 59_000,
        researchWarningPlayed: false,
        savedAt: Date.now(),
        session: { topic: 'Wave–particle duality', topicDate: date, createdAt: now.toISOString() },
      }));
    });
    const warningPage = await warningContext.newPage();
    await warningPage.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForApp(warningPage);
    await warningPage.locator('#research-dial.urgent').waitFor();
    if ((await warningPage.locator('#research-warning').textContent()) !== 'One minute left.') throw new Error('one-minute research warning was not announced');
    const warnedDraft = await warningPage.evaluate(() => JSON.parse(localStorage.getItem('clear60/active/v1')));
    if (warnedDraft.researchWarningPlayed !== true) throw new Error('research warning was not checkpointed');
  } finally {
    await warningContext.close();
  }

  const flashContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const flashPage = await flashContext.newPage();
    await flashPage.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForApp(flashPage);
    await flashPage.addInitScript(() => {
      globalThis.__presentationStageFlashed = false;
      const scan = () => {
        const stage = document.querySelector('#presentation-stage');
        if (stage && !stage.hidden) globalThis.__presentationStageFlashed = true;
      };
      new MutationObserver(scan).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'], childList: true });
      addEventListener('DOMContentLoaded', scan);
    });
    await flashPage.evaluate(async () => {
      const { createSession, localDateKey } = await import('./core.js');
      const expired = createSession({ topic: 'Wave–particle duality', topicDate: localDateKey() });
      localStorage.setItem('clear60/active/v1', JSON.stringify({
        version: 1,
        phase: 'presenting',
        deadline: Date.now() - 1000,
        savedAt: Date.now(),
        session: expired,
      }));
    });
    await flashPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(flashPage);
    await flashPage.locator('#review-stage:not([hidden])').waitFor();
    if (await flashPage.evaluate(() => globalThis.__presentationStageFlashed)) {
      throw new Error('expired presentation restore flashed the microphone stage');
    }
  } finally {
    await flashContext.close();
  }

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('PASS  topics, timers, reflection/history export, mic-flash regression, local audio and offline reload');
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
