import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS } from '../web/topics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');
const read = (name) => readFileSync(join(WEB, name), 'utf8');

test('manifest is installable and ships conventional and maskable PNGs', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.id, './', 'installed identity must stay scoped to /15-60/');
  for (const expected of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable.png', 512],
  ]) {
    const [name, size] = expected;
    assert.ok(manifest.icons.some((icon) => icon.src === name));
    const png = readFileSync(join(WEB, name));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('service worker precaches every local shell member and has its own identity', () => {
  const worker = read('sw.js');
  const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(worker)?.[1] || '';
  const members = [...shellBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(members.length >= 12);
  for (const member of members.filter((name) => name !== './')) {
    assert.ok(existsSync(join(WEB, member)), `missing cached shell member: ${member}`);
  }
  assert.ok(members.includes('topics.js'), 'the offline shell must include the concept catalog');
  assert.ok(members.includes('archive.js'), 'the offline shell must include history export');
  assert.match(worker, /clear60-shell-v1/);
  assert.ok(!worker.includes('munin-'));
  assert.ok(!worker.includes('architects-daughter'), 'single-font shell must not cache the removed handwriting face');
  assert.match(worker, /request\.destination === 'script' \|\| request\.destination === 'style'/,
    'executable shell assets must refresh online instead of mixing generations');
  assert.match(worker, /proposed\.origin === scope\.origin/);
});

test('page exposes the complete accessible practice and local-save loop', () => {
  const html = read('index.html');
  const app = read('app.js');
  for (const id of [
    'start-research', 'research-time', 'start-presentation', 'presentation-time',
    'another-topic', 'rolls-left', 'audio-file', 'download-json', 'self-rating',
    'future-notes', 'export-history', 'research-warning',
    'download-audio', 'local-save-status', 'done-session', 'discard-session',
    'streaks-view', 'streak-calendar', 'current-streak',
    'longest-streak', 'download-calendar', 'haptics-enabled', 'review-player', 'playback-toggle',
    'playback-position',
  ]) assert.ok(html.includes(`id="${id}"`), `missing UI contract: ${id}`);
  assert.match(html, /class="export-card"/);
  assert.match(html, /id="download-audio"[^>]*>Download audio</);
  assert.match(html, /id="download-json"[^>]*>Download review data</);
  assert.match(html, /id="done-session"[^>]*>Done</);
  assert.match(html, /id="discard-session"[^>]*>Delete this take</);
  assert.match(app, /new DeadlineTimer\(RESEARCH_SECONDS/);
  assert.match(app, /new DeadlineTimer\(PRESENTATION_SECONDS/);
  assert.match(app, /MediaRecorder/);
  assert.match(app, /audio\/webm;codecs=opus/);
  assert.match(app, /getUserMedia\(\{\s*audio:/);
  assert.doesNotMatch(`${html}\n${app}`, /(?:webkit)?SpeechRecognition|processLocally|speech-optin|live-transcript/i,
    'remote-capable or experimental transcript UI/code must not ship');
  assert.match(app, /navigator\.vibrate/);
  assert.match(app, /clear60\/active\/v1/);
  assert.match(app, /clear60\/topic-rolls\/v1/);
  assert.match(html, /id="audio-file"[^>]+accept="audio\/\*"/);
  assert.ok(!html.includes('id="research-notes"'), 'research stage must stay input-free');
  assert.ok(!html.includes('class="research-guide"'), 'the research stage must be timer-only');
  assert.doesNotMatch(html, />01<|>02</, 'numbered research instructions must not return');
  assert.match(app, /snapshot\.remainingMs <= 60_000/);
  assert.match(read('app.css'), /#research-dial\.urgent[^}]*--timer-ink:\s*var\(--alert\)/);
  assert.ok(!html.includes('id="custom-topic"'), 'custom topics must not return');
  assert.ok(!html.includes('id="enable-microphone"'), 'presentation must have one start CTA');
  assert.ok(!html.includes('id="theme-button"'), 'the paper theme must be singular');
  assert.ok(!/<audio[^>]+controls/i.test(html), 'native audio chrome must not replace the doodle control language');
  assert.ok(!/font-size:\s*\.75rem/.test(read('app.css')), 'helper text must remain at least 12px at the 15px root size');
  assert.match(read('app.css'), /\.topic-lockup h2,\s*\.stage-topic\s*\{\s*overflow-wrap:\s*anywhere;/,
    'long concept names must wrap under browser zoom');
  assert.ok(!/class="setting-section" open/.test(html), 'settings sections should start collapsed');
  assert.match(html, /data-clear60-app/);
  assert.match(html, /updateViaCache:\s*'none'/);
  assert.match(html, /navigator\.serviceWorker\.controller\?\.scriptURL/);
  assert.match(app, /dataset\.appReady\s*=\s*'true'/);
  assert.ok(!/>\s*History\b/i.test(html), 'History must be renamed to Streaks');
  assert.ok(!/\b(?:camera|video)\b/i.test(`${html}\n${app}`), 'audio-only flow must not retain camera or video UI/code');
});

test('takes stay local and completed calendar marks reopen IndexedDB audio', () => {
  const html = read('index.html');
  const app = read('app.js');
  const storage = read('storage.js');
  const worker = read('sw.js');
  const productSource = `${html}\n${app}\n${storage}\n${worker}`;

  assert.ok(!existsSync(join(WEB, 'drive.js')), 'removed Drive module must not ship');
  assert.doesNotMatch(productSource, /(?:klaudia|google\s*drive|gdrive|googleapis\.com|oauth|upload-drive|navigator\.share)/i,
    'Drive, OAuth and share integrations must not return');

  assert.match(storage, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(storage, /const SESSIONS = 'sessions'/);
  assert.match(storage, /const MEDIA = 'media'/);
  assert.match(storage, /export async function getSession/);
  assert.match(storage, /export async function listSessionsWithMedia/);
  assert.match(storage, /export async function removeSession/);
  assert.match(app, /createTarArchive/);
  assert.match(app, /clear60-history-export/);
  assert.match(app, /document\.createElement\(savedTakeId \? 'button' : 'time'\)/,
    'only completed days with saved takes should become buttons');
  assert.match(app, /cell\.addEventListener\('click', \(\) => openSavedTake\(savedTakeId\)\)/);
  assert.match(app, /const saved = await getSession\(id\)/);
  assert.match(app, /audioBlob = saved\.mediaBlob/);
  assert.match(app, /setPlayback\(audioBlob\)/);
});

test('human-readable topic catalog contains every shipped concept exactly once', () => {
  const documented = readFileSync(join(ROOT, 'TOPICS.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));
  assert.equal(documented.length, TOPICS.length);
  assert.equal(new Set(documented).size, TOPICS.length);
  assert.deepEqual(new Set(documented), new Set(TOPICS));
});
