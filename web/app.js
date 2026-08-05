import {
  APP_VERSION,
  DeadlineTimer,
  PRESENTATION_SECONDS,
  RESEARCH_SECONDS,
  createSession,
  dailyRollState,
  formatClock,
  localDateKey,
  normalizeSession,
  rollDailyTopic,
  sessionSidecar,
  sidecarFilename,
  slugify,
  streakCalendar,
  streakStats,
  topicForDate,
} from './core.js';
import { createTarArchive } from './archive.js';
import {
  getSession,
  listSessions,
  listSessionsWithMedia,
  removeSession,
  requestPersistentStorage,
  saveSession,
  storageEstimate,
} from './storage.js';
import {
  calendarReminderIcs,
  deliverDailyReminder,
  disableReminders,
  enableReminders,
  loadReminderSettings,
  notifyTimerDone,
  reminderSupport,
  startReminderLoop,
  validReminderTime,
} from './notifications.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const stageOrder = ['prompt', 'research', 'present', 'review'];
const stageElements = {
  prompt: $('#prompt-stage'),
  research: $('#research-stage'),
  present: $('#presentation-stage'),
  review: $('#review-stage'),
};

let topicRollState = null;
let currentTopic = topicForDate();
let session = null;
let audioBlob = null;
let playbackUrl = '';
let mediaStream = null;
let recorder = null;
let recorderChunks = [];
let recorderStopped = null;
let recordingStartedAt = 0;
let recordingStoppedAt = 0;
let researchTimer = null;
let presentationTimer = null;
let endingPresentation = false;
let warningPlayed = false;
let researchWarningPlayed = false;
let toastTimeout = null;
let reviewSaveTimeout = null;
let wakeLock = null;
let wakeLockWanted = false;
let reminderLoopStop = null;
let activePhase = '';
let activeDeadline = 0;
let topicRolling = false;
let topicRollToken = 0;
let timerOnlyFallbackArmed = false;
let microphoneRequestPending = false;

const ACTIVE_KEY = 'clear60/active/v1';
const TOPIC_ROLL_KEY = 'clear60/topic-rolls/v1';
const TOPIC_ROLL_MS = 620;

function saveActiveDraft(phase, deadline = 0) {
  if (!session || !['research', 'present-setup', 'presenting'].includes(phase)) return;
  activePhase = phase;
  activeDeadline = Number(deadline) || 0;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({
      version: 1,
      phase,
      deadline: activeDeadline,
      researchWarningPlayed,
      savedAt: Date.now(),
      session,
    }));
  } catch { /* IndexedDB sessions and downloads remain available. */ }
}

function clearActiveDraft() {
  activePhase = '';
  activeDeadline = 0;
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* best effort */ }
}

function loadActiveDraft() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
    if (!value || value.version !== 1 || !['research', 'present-setup', 'presenting'].includes(value.phase)) return null;
    if (!Number.isFinite(value.savedAt) || Date.now() - value.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return {
      phase: value.phase,
      deadline: Number(value.deadline) || 0,
      researchWarningPlayed: value.researchWarningPlayed === true,
      session: normalizeSession(value.session),
    };
  } catch { return null; }
}

function showToast(message, milliseconds = 3600) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, milliseconds);
}

function updateTopicEverywhere() {
  $('#topic-text').textContent = currentTopic;
  $('#topic-text').setAttribute('aria-live', 'polite');
  $('#topic-text').setAttribute('aria-atomic', 'true');
  $$('[data-current-topic]').forEach((element) => { element.textContent = currentTopic; });
}

function loadTopicRollState(date = new Date()) {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(TOPIC_ROLL_KEY) || 'null'); } catch { /* reset below */ }
  const state = dailyRollState(stored, date);
  if (!stored || stored.date !== state.date
    || stored.rollsUsed !== state.rollsUsed || stored.offset !== state.offset) {
    try { localStorage.setItem(TOPIC_ROLL_KEY, JSON.stringify(state)); } catch { /* preference only */ }
  }
  return state;
}

function saveTopicRollState(state) {
  try { localStorage.setItem(TOPIC_ROLL_KEY, JSON.stringify(state)); } catch { /* best effort */ }
}

function updateTopicRollUi() {
  const button = $('#another-topic');
  const counter = $('#rolls-left');
  const left = topicRollState?.rollsLeft ?? 3;
  const unavailable = topicRolling || left === 0;
  button.disabled = unavailable;
  button.setAttribute('aria-disabled', String(unavailable));
  button.setAttribute('aria-busy', String(topicRolling));
  counter.setAttribute('aria-live', 'polite');
  counter.setAttribute('aria-atomic', 'true');
  counter.textContent = topicRolling
    ? 'rolling…'
    : left === 0
      ? 'today’s pick'
      : `${left} roll${left === 1 ? '' : 's'} left`;
}

function syncDailyTopic(date = new Date()) {
  topicRollState = loadTopicRollState(date);
  currentTopic = topicForDate(date, topicRollState.offset);
  updateTopicEverywhere();
  updateTopicRollUi();
}

async function rollTopic() {
  if (topicRolling) return;
  const now = new Date();
  const latest = loadTopicRollState(now);
  if (latest.date !== topicRollState?.date) {
    topicRollState = latest;
    currentTopic = topicForDate(now, latest.offset);
    updateTopicEverywhere();
  }
  if (latest.rollsLeft === 0) {
    topicRollState = latest;
    updateTopicRollUi();
    return;
  }

  topicRolling = true;
  const token = ++topicRollToken;
  const next = rollDailyTopic(latest, now);
  topicRollState = next;
  saveTopicRollState(next);
  const button = $('#another-topic');
  const start = $('#start-research');
  button.classList.add('is-rolling');
  start.disabled = true;
  updateTopicRollUi();
  signalCue('roll');
  button.dispatchEvent(new CustomEvent('clear60-topic-roll-start', { detail: next }));

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) await new Promise((resolve) => setTimeout(resolve, TOPIC_ROLL_MS));
  if (token !== topicRollToken) return;
  currentTopic = topicForDate(now, next.offset);
  updateTopicEverywhere();
  topicRolling = false;
  button.classList.remove('is-rolling');
  start.disabled = false;
  updateTopicRollUi();
  button.dispatchEvent(new CustomEvent('clear60-topic-roll-end', {
    detail: { ...next, topic: currentTopic },
  }));
}

function showStage(name) {
  const previousFocus = document.activeElement;
  for (const [key, element] of Object.entries(stageElements)) element.hidden = key !== name;
  const active = stageOrder.indexOf(name);
  $$('[data-progress]').forEach((item, index) => {
    item.classList.toggle('current', index === active);
    item.classList.toggle('done', index < active);
    if (index === active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (previousFocus && previousFocus !== document.body && previousFocus !== document.documentElement) {
    const heading = stageElements[name]?.querySelector('h2');
    if (heading) {
      heading.tabIndex = -1;
      requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    }
  }
}

function navigate(view) {
  const target = view === 'history' ? 'streaks' : view;
  const today = target !== 'streaks';
  $('#today-view').hidden = !today;
  $('#streaks-view').hidden = today;
  $$('[data-nav]').forEach((button) => {
    const active = button.dataset.nav === (today ? 'today' : 'streaks');
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (!today) renderStreaks();
  document.title = today ? '15:60 — make one idea clear' : 'Streaks — 15:60';
  const hash = today ? '' : '#streaks';
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  scrollTo({ top: 0, behavior: 'auto' });
}

function updateDial(dial, label, snapshot, urgentThresholdMs = 10_000) {
  dial.style.setProperty('--progress', String(snapshot.progress));
  label.textContent = formatClock(snapshot.remainingMs);
  dial.setAttribute('aria-label', `${formatClock(snapshot.remainingMs)} remaining`);
  dial.classList.toggle('urgent', snapshot.remainingMs > 0 && snapshot.remainingMs <= urgentThresholdMs);
}

function soundEnabled() {
  try { return localStorage.getItem('clear60/sound/v1') !== 'off'; } catch { return true; }
}

function hapticsEnabled() {
  try { return localStorage.getItem('clear60/haptics/v1') !== 'off'; } catch { return true; }
}

function playHaptic(kind) {
  if (!hapticsEnabled() || typeof navigator.vibrate !== 'function') return;
  const pattern = kind === 'finish' ? [35, 45, 35, 45, 70]
    : kind === 'warning' ? [40, 55, 40]
      : [30];
  try { navigator.vibrate(pattern); } catch { /* optional tactile cue */ }
}

function playCue(kind) {
  if (!soundEnabled()) return;
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return;
  try {
    const context = playCue.context || (playCue.context = new AudioContext());
    if (context.state === 'suspended') context.resume();
    const tones = kind === 'finish' ? [523.25, 659.25, 783.99]
      : kind === 'warning' ? [659.25, 523.25]
        : [440, 587.33];
    tones.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const starts = context.currentTime + index * .13;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, starts);
      gain.gain.exponentialRampToValueAtTime(.15, starts + .018);
      gain.gain.exponentialRampToValueAtTime(.0001, starts + .18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(starts);
      oscillator.stop(starts + .2);
    });
  } catch { /* A cue is helpful, never a prerequisite. */ }
}

function signalCue(kind) {
  playCue(kind);
  playHaptic(kind);
}

async function holdWakeLock() {
  if (!navigator.wakeLock?.request) return;
  wakeLockWanted = true;
  if (wakeLock && !wakeLock.released) return;
  try {
    const granted = await navigator.wakeLock.request('screen');
    if (wakeLockWanted) wakeLock = granted;
    else granted.release();
  } catch { /* optional */ }
}

function releaseWakeLock() {
  wakeLockWanted = false;
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

function newPractice() {
  clearActiveDraft();
  session = createSession({ topic: currentTopic, topicDate: localDateKey() });
  audioBlob = null;
  researchWarningPlayed = false;
  $('#research-warning').textContent = '';
  $('#research-time').textContent = '15:00';
  $('#presentation-time').textContent = '1:00';
  $('#research-dial').style.setProperty('--progress', '0');
  $('#research-dial').classList.remove('urgent');
  $('#presentation-dial').style.setProperty('--progress', '0');
}

function beginResearchTimer(elapsedMs = 0) {
  researchTimer = new DeadlineTimer(RESEARCH_SECONDS * 1000, {
    onTick: (snapshot) => {
      updateDial($('#research-dial'), $('#research-time'), snapshot, 60_000);
      if (!researchWarningPlayed && snapshot.remainingMs > 0 && snapshot.remainingMs <= 60_000) {
        researchWarningPlayed = true;
        $('#research-warning').textContent = 'One minute left.';
        saveActiveDraft('research', activeDeadline);
        signalCue('warning');
      }
    },
    onDone: (snapshot) => {
      session.timing.researchElapsedSeconds = snapshot.elapsedMs / 1000;
      signalCue('finish');
      notifyTimerDone('Research time is up', 'Your sixty-second presentation starts when you are ready.', 'research');
      preparePresentation();
    },
  });
  researchTimer.start(elapsedMs);
}

function startResearch() {
  if (topicRolling) return;
  const latest = loadTopicRollState();
  if (latest.date !== topicRollState?.date) syncDailyTopic();
  newPractice();
  showStage('research');
  signalCue('start');
  holdWakeLock();
  saveActiveDraft('research', Date.now() + RESEARCH_SECONDS * 1000);
  beginResearchTimer();
}

function preparePresentation() {
  if (!session) return;
  if (researchTimer) {
    const snapshot = researchTimer.stop();
    session.timing.researchElapsedSeconds = snapshot.elapsedMs / 1000;
    researchTimer = null;
  }
  $('#research-dial').classList.remove('urgent');
  releaseWakeLock();
  updateTopicEverywhere();
  resetStudioUi();
  saveActiveDraft('present-setup');
  showStage('present');
}

function resetStudioUi() {
  timerOnlyFallbackArmed = false;
  microphoneRequestPending = false;
  $('#audio-shell').classList.remove('mic-ready', 'recording', 'timer-only-ready');
  $('#audio-state-title').textContent = 'Ready when you are';
  $('#audio-state-copy').textContent = 'Start asks for the microphone, then begins your minute.';
  $('#media-status').textContent = 'Your recording stays on this device. Download a copy anytime.';
  $('#studio-controls').hidden = false;
  $('#present-actions').hidden = true;
  $('#recording-badge').hidden = true;
  $('#ten-second-badge').hidden = true;
  $('#start-presentation').disabled = false;
  $('#start-presentation').textContent = 'Start 60 seconds';
  $('#presentation-dial').style.setProperty('--progress', '0');
  $('#presentation-dial').classList.remove('urgent');
  $('#presentation-time').textContent = '1:00';
  endingPresentation = false;
  warningPlayed = false;
}

function armTimerOnlyFallback(message) {
  timerOnlyFallbackArmed = true;
  microphoneRequestPending = false;
  stopMediaStream();
  $('#audio-shell').classList.remove('mic-ready');
  $('#audio-shell').classList.add('timer-only-ready');
  $('#audio-state-title').textContent = 'Timer-only is ready';
  $('#audio-state-copy').textContent = 'Tap once more to begin without recording.';
  $('#media-status').textContent = message;
  $('#start-presentation').disabled = false;
  $('#start-presentation').textContent = 'Start timer only';
}

function recorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

function audioExtension(type) {
  const mime = String(type || '').toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aac')) return 'aac';
  return 'webm';
}

function attachedAudioType(file) {
  const declared = String(file?.type || '').toLowerCase().split(';')[0].trim();
  if (declared.startsWith('audio/')) return declared;
  const extension = String(file?.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  return ({
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    webm: 'audio/webm',
  })[extension] || '';
}

function startRecorder() {
  if (!mediaStream || !globalThis.MediaRecorder) return false;
  try {
    const mimeType = recorderMime();
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    recorderChunks = [];
    recordingStartedAt = 0;
    recordingStoppedAt = 0;
    recorderStopped = new Promise((resolve) => {
      recorder.ondataavailable = (event) => { if (event.data?.size) recorderChunks.push(event.data); };
      recorder.onstop = () => {
        recordingStoppedAt = performance.now();
        resolve(new Blob(recorderChunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
      };
    });
    recorder.start(1000);
    recordingStartedAt = performance.now();
    $('#audio-shell').classList.add('recording');
    $('#audio-state-title').textContent = 'Recording your minute';
    $('#audio-state-copy').textContent = 'Keep going. The chime will land at zero.';
    $('#recording-badge').hidden = false;
    return true;
  } catch {
    recorder = null;
    recorderStopped = null;
    return false;
  }
}

async function startPresentation() {
  if (!session || presentationTimer || microphoneRequestPending) return;
  const button = $('#start-presentation');

  if (!mediaStream && !timerOnlyFallbackArmed) {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      armTimerOnlyFallback('Microphone recording is unavailable here. Tap again for the timer, then attach audio afterward.');
      return;
    }
    microphoneRequestPending = true;
    button.disabled = true;
    button.textContent = 'Asking for microphone…';
    $('#audio-state-title').textContent = 'Microphone permission';
    $('#audio-state-copy').textContent = 'Use the browser prompt to allow this take.';
    $('#media-status').textContent = 'Waiting for microphone permission…';
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      microphoneRequestPending = false;
      $('#audio-shell').classList.add('mic-ready');
      $('#media-status').textContent = 'Recording stays in this browser. Download a copy anytime.';
    } catch (error) {
      armTimerOnlyFallback(error?.name === 'NotAllowedError'
        ? 'Microphone permission was not granted. Tap again for the timer, then attach audio afterward.'
        : 'The microphone could not start. Tap again for the timer, then attach audio afterward.');
      return;
    }
  }

  if (mediaStream && !startRecorder()) {
    armTimerOnlyFallback('Recording could not start. Tap again for the timer, then attach audio afterward.');
    return;
  }

  if (!mediaStream) {
    $('#audio-shell').classList.remove('timer-only-ready');
    $('#audio-state-title').textContent = 'Your minute is running';
    $('#audio-state-copy').textContent = 'Timer only. Attach audio when you finish.';
  }

  button.disabled = true;
  $('#studio-controls').hidden = true;
  $('#present-actions').hidden = false;
  endingPresentation = false;
  signalCue('start');
  holdWakeLock();
  saveActiveDraft('presenting', Date.now() + PRESENTATION_SECONDS * 1000);
  beginPresentationTimer();
}

function beginPresentationTimer(elapsedMs = 0) {
  presentationTimer = new DeadlineTimer(PRESENTATION_SECONDS * 1000, {
    onTick: (snapshot) => {
      updateDial($('#presentation-dial'), $('#presentation-time'), snapshot);
      if (!warningPlayed && snapshot.remainingMs > 0 && snapshot.remainingMs <= 10_000) {
        warningPlayed = true;
        $('#ten-second-badge').hidden = false;
        signalCue('warning');
      }
    },
    onDone: (snapshot) => finishPresentation(snapshot),
  });
  presentationTimer.start(elapsedMs);
}

async function stopRecorder() {
  if (!recorder || recorder.state === 'inactive') return recorderStopped ? recorderStopped : null;
  try { recorder.stop(); } catch { return null; }
  return recorderStopped;
}

function stopMediaStream() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

async function finishPresentation(snapshot) {
  if (endingPresentation || !session) return;
  endingPresentation = true;
  const finalSnapshot = snapshot || presentationTimer?.stop();
  presentationTimer = null;
  session.timing.presentationElapsedSeconds = (finalSnapshot?.elapsedMs || 0) / 1000;
  const hadRecorder = !!recorder;
  signalCue('finish');
  const recorded = await stopRecorder();
  session.timing.recordingDurationSeconds = hadRecorder && recordingStartedAt
    ? Math.min(session.timing.presentationElapsedSeconds,
      Math.max(0, (recordingStoppedAt - recordingStartedAt) / 1000))
    : 0;
  if (recorded?.size) {
    audioBlob = recorded;
    const type = recorded.type || 'audio/webm';
    const extension = audioExtension(type);
    session.media = {
      filename: `clear60-${session.topicDate}-${slugify(session.topic)}.${extension}`,
      type,
      sizeBytes: recorded.size,
      source: 'recorded',
      kind: 'audio',
    };
  }
  recorder = null;
  recorderStopped = null;
  recorderChunks = [];
  recordingStartedAt = 0;
  recordingStoppedAt = 0;
  stopMediaStream();
  releaseWakeLock();
  $('#audio-shell').classList.remove('recording');
  $('#recording-badge').hidden = true;
  const finished = new Date().toISOString();
  session.completedAt = finished;
  session.updatedAt = finished;
  notifyTimerDone('Your minute is complete', 'Listen back and leave yourself one note for next time.', 'presentation');
  setLocalSaveStatus('Saving on this device…', 'saving');
  await persistCurrent(audioBlob);
  clearActiveDraft();
  renderReview();
  showStage('review');
}

function setLocalSaveStatus(message, state = 'saved') {
  const status = $('#local-save-status');
  if (!status) return;
  status.dataset.state = state;
  const label = status.querySelector('span');
  if (label) label.textContent = message;
}

async function persistCurrent(blob = undefined) {
  if (!session) return null;
  session.updatedAt = new Date().toISOString();
  try {
    const result = await saveSession(session, blob);
    if (result.fallback && blob instanceof Blob) {
      setLocalSaveStatus('Practice saved, but not the audio. Download it before leaving.', 'warning');
      showToast('Session details were saved, but this browser refused local audio storage. Download the audio before leaving.');
    } else {
      setLocalSaveStatus(
        audioBlob instanceof Blob
          ? 'Saved in 15:60 on this device.'
          : 'Practice saved. No audio attached.',
        'saved',
      );
    }
    await updateStreaks();
    return result;
  } catch {
    setLocalSaveStatus('Could not save here. Download a copy before leaving.', 'error');
    showToast('This browser could not save the session. Download the review files before leaving.', 6000);
    return null;
  }
}

function setPlayback(blob) {
  const player = $('#review-audio');
  player.pause();
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  playbackUrl = '';
  if (blob instanceof Blob) {
    playbackUrl = URL.createObjectURL(blob);
    player.src = playbackUrl;
    player.load();
    $('#review-player').hidden = false;
    $('#playback-empty').hidden = true;
  } else {
    player.removeAttribute('src');
    player.load();
    $('#review-player').hidden = true;
    $('#playback-empty').hidden = false;
  }
  $('#attach-audio').textContent = blob instanceof Blob ? 'Replace audio' : 'Attach audio';
  syncPlaybackUi();
  $('#download-audio').disabled = !(blob instanceof Blob);
}

function playbackClock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function syncPlaybackUi() {
  const player = $('#review-audio');
  const position = $('#playback-position');
  const duration = Number.isFinite(player.duration) ? Math.max(0, player.duration) : 0;
  const current = Math.min(duration || Infinity, Math.max(0, Number(player.currentTime) || 0));
  position.max = String(duration);
  position.value = String(current);
  position.style.setProperty('--played', `${duration ? (current / duration) * 100 : 0}%`);
  position.setAttribute('aria-valuetext', `${playbackClock(current)} of ${playbackClock(duration)}`);
  $('#playback-time').textContent = `${playbackClock(current)} / ${playbackClock(duration)}`;
  $('#playback-toggle').classList.toggle('is-playing', !player.paused && !player.ended);
  $('#playback-toggle').setAttribute('aria-label', player.paused || player.ended ? 'Play audio' : 'Pause audio');
}

async function togglePlayback() {
  const player = $('#review-audio');
  if (player.paused || player.ended) {
    try {
      await player.play();
    } catch {
      showToast('This audio could not play in the browser. You can still download it.');
    }
  } else {
    player.pause();
  }
  syncPlaybackUi();
}

function renderReview() {
  if (!session) return;
  currentTopic = session.topic;
  updateTopicEverywhere();
  $$('input[name="self-rating"]').forEach((input) => {
    input.checked = Number(input.value) === session.selfRating;
  });
  $('#future-notes').value = session.futureNotes || '';
  setPlayback(audioBlob);
}

function syncSessionFromReview() {
  if (!session) return;
  const selectedRating = $('input[name="self-rating"]:checked');
  session.selfRating = selectedRating ? Number(selectedRating.value) : null;
  session.futureNotes = $('#future-notes').value.trim();
  session.updatedAt = new Date().toISOString();
}

function scheduleReviewSave() {
  syncSessionFromReview();
  clearTimeout(reviewSaveTimeout);
  reviewSaveTimeout = setTimeout(() => persistCurrent(), 600);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadReviewJson() {
  if (!session) return;
  syncSessionFromReview();
  persistCurrent();
  downloadBlob(
    new Blob([`${JSON.stringify(sessionSidecar(session), null, 2)}\n`], { type: 'application/json' }),
    sidecarFilename(session),
  );
  showToast('Review data downloaded.');
}

async function exportEntireHistory() {
  const button = $('#export-history');
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Preparing archive…';
  try {
    if (session?.completedAt) {
      syncSessionFromReview();
      await persistCurrent();
    }
    const rows = await listSessionsWithMedia();
    if (!rows.length) {
      showToast('There is no saved history to export.');
      return;
    }

    const exportedAt = new Date().toISOString();
    const entries = [];
    const manifestSessions = [];
    let audioCount = 0;
    for (const row of rows) {
      const storedSession = row.session;
      const folder = `sessions/${storedSession.id}`;
      const metadataFile = `${folder}/session.json`;
      const hasAudio = row.mediaBlob instanceof Blob && row.mediaBlob.size > 0;
      const extension = audioExtension(row.mediaBlob?.type || storedSession.media.type);
      const audioFile = hasAudio ? `${folder}/take.${extension}` : null;
      const sidecar = sessionSidecar(storedSession);
      sidecar.exportedAt = exportedAt;
      sidecar.media = {
        ...sidecar.media,
        originalFilename: sidecar.media.filename,
        filename: hasAudio ? `take.${extension}` : sidecar.media.filename,
        includedInArchive: hasAudio,
      };
      entries.push({ name: metadataFile, data: `${JSON.stringify(sidecar, null, 2)}\n` });
      if (hasAudio) {
        entries.push({ name: audioFile, data: row.mediaBlob });
        audioCount++;
      }
      manifestSessions.push({ id: storedSession.id, metadataFile, audioFile });
    }

    const manifest = {
      kind: 'clear60-history-export',
      formatVersion: 1,
      appVersion: APP_VERSION,
      exportedAt,
      sessionCount: rows.length,
      audioCount,
      sessions: manifestSessions,
    };
    entries.unshift({ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });
    const archive = createTarArchive(entries, { modifiedAt: new Date(exportedAt) });
    downloadBlob(archive, `15-60-history-${localDateKey()}.tar`);
    showToast(`Exported ${rows.length} practice${rows.length === 1 ? '' : 's'} with ${audioCount} audio file${audioCount === 1 ? '' : 's'}.`);
  } catch {
    showToast('The history archive could not be created. Your local saves are unchanged.', 6000);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Export all history';
  }
}

async function audioDuration(blob) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (value) => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(Number.isFinite(value) ? value : 0);
    };
    const timeout = setTimeout(() => done(0), 5000);
    audio.onloadedmetadata = () => { clearTimeout(timeout); done(audio.duration); };
    audio.onerror = () => { clearTimeout(timeout); done(0); };
    audio.preload = 'metadata';
    audio.src = url;
  });
}

async function attachAudio(file) {
  if (!session || !(file instanceof Blob)) return;
  const type = attachedAudioType(file);
  if (!type || !file.size) {
    showToast('Choose a non-empty audio file such as WAV, MP3, M4A, OGG, or WebM.');
    return;
  }
  audioBlob = file;
  const duration = await audioDuration(file);
  session.media = {
    filename: file.name || `clear60-${session.topicDate}-${slugify(session.topic)}.${audioExtension(type)}`,
    type,
    sizeBytes: file.size,
    source: 'uploaded',
    kind: 'audio',
  };
  if (duration) session.timing.recordingDurationSeconds = Math.round(duration * 100) / 100;
  setPlayback(audioBlob);
  await persistCurrent(audioBlob);
  showToast('Audio attached to this local session.');
}

function calendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function syncStreakScrollEdges() {
  const calendar = $('#streak-calendar');
  const frame = calendar.closest('.calendar-frame');
  const maximum = Math.max(0, calendar.scrollWidth - calendar.clientWidth);
  frame.classList.toggle('can-scroll-left', calendar.scrollLeft > 2);
  frame.classList.toggle('can-scroll-right', calendar.scrollLeft < maximum - 2);
}

async function renderStreaks() {
  const rows = await listSessions();
  const stats = streakStats(rows);
  const days = streakCalendar(rows);
  const savedTakeByDate = new Map();
  for (const row of rows) {
    if (row.completedAt && row.topicDate && !savedTakeByDate.has(row.topicDate)) {
      savedTakeByDate.set(row.topicDate, row.id);
    }
  }
  const current = $('#current-streak');
  const longest = $('#longest-streak');
  const navCount = $('#streak-nav-count');
  current.textContent = String(stats.currentStreak);
  longest.textContent = String(stats.longestStreak);
  navCount.textContent = String(stats.currentStreak);
  navCount.hidden = stats.currentStreak === 0;
  $('#streak-empty').hidden = stats.completedDates.length > 0;

  const calendar = $('#streak-calendar');
  calendar.replaceChildren();
  calendar.tabIndex = 0;
  calendar.setAttribute('role', 'region');
  calendar.setAttribute('aria-label', 'Recent practice calendar. Scroll sideways for earlier months.');

  const months = new Map();
  for (const day of days) {
    const month = day.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(day);
  }

  const longDate = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const monthDate = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  for (const [month, monthDays] of months) {
    const card = document.createElement('section');
    card.className = 'streak-month';
    const heading = document.createElement('h2');
    heading.className = 'streak-month-label';
    heading.textContent = monthDate.format(calendarDate(`${month}-01`));
    card.append(heading);

    const weekdayRow = document.createElement('div');
    weekdayRow.className = 'streak-weekdays';
    weekdayRow.setAttribute('aria-hidden', 'true');
    for (const weekday of weekdays) {
      const label = document.createElement('span');
      label.textContent = weekday;
      weekdayRow.append(label);
    }
    card.append(weekdayRow);

    const grid = document.createElement('div');
    grid.className = 'streak-month-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', heading.textContent);
    const firstWeekday = (calendarDate(monthDays[0].date).getDay() + 6) % 7;
    for (let index = 0; index < firstWeekday; index++) {
      const placeholder = document.createElement('span');
      placeholder.className = 'streak-day-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      grid.append(placeholder);
    }
    for (const day of monthDays) {
      const date = calendarDate(day.date);
      const savedTakeId = savedTakeByDate.get(day.date);
      const cell = document.createElement(savedTakeId ? 'button' : 'time');
      if (savedTakeId) {
        cell.type = 'button';
        cell.dataset.sessionId = savedTakeId;
        cell.addEventListener('click', () => openSavedTake(savedTakeId));
      }
      cell.className = `streak-day ${day.completed ? 'is-complete' : 'is-empty'}${day.today ? ' is-today' : ''}`;
      if (!savedTakeId) cell.dateTime = day.date;
      cell.dataset.date = day.date;
      const status = day.completed ? 'practiced' : day.today ? 'not practiced yet' : 'no practice';
      cell.setAttribute('aria-label', `${day.today ? 'Today, ' : ''}${longDate.format(date)}: ${status}${savedTakeId ? '. Open saved take' : ''}`);
      cell.title = cell.getAttribute('aria-label');
      const mark = document.createElement('span');
      mark.className = 'streak-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = day.completed ? 'X' : '';
      cell.append(mark);
      grid.append(cell);
    }
    card.append(grid);
    calendar.append(card);
  }

  requestAnimationFrame(() => {
    const lastMonth = calendar.lastElementChild;
    calendar.scrollLeft = lastMonth
      ? Math.max(0, lastMonth.offsetLeft + lastMonth.offsetWidth - calendar.clientWidth + 2)
      : 0;
    syncStreakScrollEdges();
  });
}

async function openSavedTake(id) {
  if (activePhase) {
    showToast('Finish the current practice before opening a saved take.');
    return;
  }
  const saved = await getSession(id);
  if (!saved) {
    showToast('That saved take is no longer available on this device.');
    await updateStreaks();
    return;
  }
  session = saved.session;
  audioBlob = saved.mediaBlob;
  currentTopic = session.topic;
  renderReview();
  setLocalSaveStatus(
    audioBlob instanceof Blob
      ? 'Saved in 15:60 on this device.'
      : 'Practice details are saved, but there is no local audio.',
    audioBlob instanceof Blob ? 'saved' : 'warning',
  );
  navigate('today');
  showStage('review');
}

async function updateStreaks() {
  await renderStreaks();
}

function restartReminderLoop() {
  reminderLoopStop?.();
  reminderLoopStop = startReminderLoop(() => topicForDate(), () => syncReminderUi());
}

async function restoreActivePractice() {
  const active = loadActiveDraft();
  if (!active) return false;
  session = active.session;
  currentTopic = session.topic;
  activePhase = active.phase;
  activeDeadline = active.deadline;
  researchWarningPlayed = active.researchWarningPlayed;
  updateTopicEverywhere();

  if (active.phase === 'research') {
    const elapsed = Math.min(RESEARCH_SECONDS * 1000, Math.max(0,
      RESEARCH_SECONDS * 1000 - (active.deadline - Date.now())));
    if (elapsed >= RESEARCH_SECONDS * 1000) {
      session.timing.researchElapsedSeconds = RESEARCH_SECONDS;
      preparePresentation();
      showToast('Research time ended while the app was away. Your prompt was restored.');
    } else {
      showStage('research');
      if (researchWarningPlayed && active.deadline - Date.now() <= 60_000) {
        $('#research-warning').textContent = 'One minute left.';
      }
      holdWakeLock();
      beginResearchTimer(elapsed);
      showToast('Research timer restored.');
    }
    return true;
  }

  if (active.phase === 'present-setup') {
    resetStudioUi();
    showStage('present');
    showToast('Your researched prompt was restored.');
    return true;
  }

  const elapsed = Math.min(PRESENTATION_SECONDS * 1000, Math.max(0,
    PRESENTATION_SECONDS * 1000 - (active.deadline - Date.now())));
  resetStudioUi();
  if (elapsed >= PRESENTATION_SECONDS * 1000) {
    await finishPresentation({ elapsedMs: PRESENTATION_SECONDS * 1000, remainingMs: 0, progress: 1, done: true });
    showToast('The minute ended while 15:60 was away. The timer result was restored; no interrupted recording was kept.');
  } else {
    showStage('present');
    $('#studio-controls').hidden = true;
    $('#present-actions').hidden = false;
    $('#audio-state-title').textContent = 'Timer restored';
    $('#audio-state-copy').textContent = 'The interrupted recording was not kept. Attach audio after the timer.';
    holdWakeLock();
    beginPresentationTimer(elapsed);
    showToast('The 60-second timer resumed. An interrupted audio recording cannot be recovered.');
  }
  return true;
}

function openSettings() {
  syncSettingsUi();
  if ($('#settings-dialog').showModal) $('#settings-dialog').showModal();
  else $('#settings-dialog').setAttribute('open', '');
}

function syncReminderUi() {
  const reminder = loadReminderSettings();
  $('#reminder-time').value = reminder.time;
  $('#disable-reminders').disabled = !reminder.enabled;
  $('#notification-status').textContent = reminder.enabled
    ? `Browser reminder enabled for ${reminder.time}. It is delivered while the app remains active or when the app next resumes after it is due.`
    : reminderSupport()
      ? 'Browser reminder is off. Calendar is the dependable no-server option because it does not rely on an inactive browser.'
      : 'This browser does not support PWA notifications. Use the downloadable calendar reminder.';
  const summary = $('#reminder-summary');
  if (summary) {
    summary.textContent = reminder.enabled
      ? `Best-effort browser reminder is on for ${reminder.time}; the 90-day prompt calendar remains the reliable option.`
      : 'Choose a reminder time. 15:60 can remind you while it is open and whenever you next resume it.';
  }
}

function syncSettingsUi() {
  syncReminderUi();
  $('#sound-enabled').checked = soundEnabled();
  const hapticsSupported = typeof navigator.vibrate === 'function';
  $('#haptics-enabled').checked = hapticsSupported && hapticsEnabled();
  $('#haptics-enabled').disabled = !hapticsSupported;
  $('#haptics-note').textContent = hapticsSupported
    ? 'Available on this device'
    : 'Not available here';
  renderStorageEstimate();
  renderInstallButton();
}

async function renderStorageEstimate() {
  const estimate = await storageEstimate();
  if (!estimate) return;
  const mb = (value) => `${(value / 1024 / 1024).toFixed(value > 100 * 1024 * 1024 ? 0 : 1)} MB`;
  $('#storage-summary').textContent = estimate.quota
    ? `${mb(estimate.usage)} used of about ${mb(estimate.quota)} available here. ${estimate.persisted ? 'Protected from automatic browser cleanup.' : 'The browser may clear it under storage pressure.'}`
    : 'Recordings save automatically in this browser. They do not sync to other devices.';
  $('#persist-storage').disabled = estimate.persisted;
  $('#persist-storage').textContent = estimate.persisted ? 'Local saves protected' : 'Protect local saves';
}

function renderInstallButton() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const available = !standalone && Boolean(globalThis.__clear60InstallPrompt);
  $('#install-setting').hidden = !available;
  $('#install-app').hidden = !available;
}

async function installApp() {
  const prompt = globalThis.__clear60InstallPrompt;
  if (!prompt) return;
  prompt.prompt();
  await prompt.userChoice;
  globalThis.__clear60InstallPrompt = null;
  renderInstallButton();
}

function updateConnection() {
  $('#connection-bar').hidden = navigator.onLine;
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js?shell=20260805t', { updateViaCache: 'none' });
    if (!registration) return;
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showToast('A 15:60 update is ready for the next open.');
      });
    });
  } catch {
    showToast('Offline installation is unavailable on this address. Use HTTPS or localhost.', 5000);
  }
}

function bindEvents() {
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
  $('#streak-calendar').addEventListener('scroll', syncStreakScrollEdges, { passive: true });
  $('#streak-calendar').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const calendar = event.currentTarget;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (event.key === 'Home') calendar.scrollTo({ left: 0, behavior });
    else if (event.key === 'End') calendar.scrollTo({ left: calendar.scrollWidth, behavior });
    else calendar.scrollBy({
      left: (event.key === 'ArrowLeft' ? -1 : 1) * Math.max(220, calendar.clientWidth * .86),
      behavior,
    });
  });
  $$('#settings-dialog details.setting-section').forEach((section) => {
    section.addEventListener('toggle', () => {
      if (!section.open) return;
      $$('#settings-dialog details.setting-section').forEach((other) => {
        if (other !== section) other.open = false;
      });
    });
  });
  $('#another-topic').addEventListener('click', rollTopic);
  $('#start-research').addEventListener('click', startResearch);
  $('#finish-research').addEventListener('click', preparePresentation);
  $('#cancel-research').addEventListener('click', () => {
    researchTimer?.stop();
    researchTimer = null;
    releaseWakeLock();
    clearActiveDraft();
    session = null;
    showStage('prompt');
  });
  $('#start-presentation').addEventListener('click', startPresentation);
  $('#stop-presentation').addEventListener('click', () => finishPresentation(presentationTimer?.stop()));
  $('#playback-toggle').addEventListener('click', togglePlayback);
  $('#playback-position').addEventListener('input', (event) => {
    const duration = $('#review-audio').duration;
    if (Number.isFinite(duration)) $('#review-audio').currentTime = Math.min(duration, Math.max(0, Number(event.target.value) || 0));
    syncPlaybackUi();
  });
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended']) {
    $('#review-audio').addEventListener(event, syncPlaybackUi);
  }
  $('#attach-audio').addEventListener('click', () => $('#audio-file').click());
  $('#audio-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) attachAudio(file);
    event.target.value = '';
  });
  $$('input[name="self-rating"]').forEach((input) => input.addEventListener('change', () => {
    syncSessionFromReview();
    clearTimeout(reviewSaveTimeout);
    persistCurrent();
  }));
  $('#future-notes').addEventListener('input', scheduleReviewSave);
  $('#download-json').addEventListener('click', downloadReviewJson);
  $('#download-audio').addEventListener('click', () => {
    if (audioBlob) {
      downloadBlob(audioBlob, session.media.filename);
      showToast('Audio downloaded.');
    }
  });
  $('#done-session').addEventListener('click', async () => {
    syncSessionFromReview();
    await persistCurrent(audioBlob);
    session = null;
    audioBlob = null;
    setPlayback(null);
    syncDailyTopic();
    showStage('prompt');
    navigate('streaks');
  });
  $('#discard-session').addEventListener('click', async () => {
    if (!session || !confirm('Delete this take and its locally saved audio?')) return;
    await removeSession(session.id);
    clearActiveDraft();
    session = null;
    audioBlob = null;
    setPlayback(null);
    syncDailyTopic();
    showStage('prompt');
    await updateStreaks();
  });
  $('#settings-button').addEventListener('click', openSettings);
  $('#sound-enabled').addEventListener('change', (event) => {
    try { localStorage.setItem('clear60/sound/v1', event.target.checked ? 'on' : 'off'); } catch { /* preference only */ }
    if (event.target.checked) playCue('start');
  });
  $('#haptics-enabled').addEventListener('change', (event) => {
    try { localStorage.setItem('clear60/haptics/v1', event.target.checked ? 'on' : 'off'); } catch { /* preference only */ }
    if (event.target.checked) playHaptic('start');
  });
  $('#enable-reminders').addEventListener('click', async () => {
    const result = await enableReminders($('#reminder-time').value);
    syncSettingsUi();
    if (result.ok) {
      await deliverDailyReminder(currentTopic);
      restartReminderLoop();
      showToast('Browser reminder enabled. Add the calendar reminder for reliable delivery when 15:60 is closed.');
    } else if (result.reason === 'denied') showToast('Notifications are blocked in browser settings. The calendar reminder still works.');
    else showToast('Browser notifications are unavailable here. The calendar reminder still works.');
  });
  $('#disable-reminders').addEventListener('click', () => { disableReminders(); restartReminderLoop(); syncSettingsUi(); showToast('Browser reminder turned off.'); });
  $('#download-calendar').addEventListener('click', () => {
    const time = $('#reminder-time').value;
    if (!validReminderTime(time)) {
      showToast('Choose a valid reminder time first.');
      $('#reminder-time').focus();
      return;
    }
    const ics = calendarReminderIcs({ time, url: location.href.split('#')[0] });
    downloadBlob(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), 'clear60-daily-reminder.ics');
    showToast('90-day prompt calendar downloaded. Open it to add the dated prompts to your calendar.');
  });
  $('#persist-storage').addEventListener('click', async () => {
    const persisted = await requestPersistentStorage();
    showToast(persisted ? 'Local saves are protected from automatic browser cleanup.' : 'The browser did not grant protection. Downloads remain the durable backup.');
    renderStorageEstimate();
  });
  $('#export-history').addEventListener('click', exportEntireHistory);
  $('#install-app').addEventListener('click', installApp);
  addEventListener('clear60-install-ready', renderInstallButton);
  addEventListener('online', updateConnection);
  addEventListener('offline', updateConnection);
  addEventListener('pagehide', () => {
    if (session && activePhase) saveActiveDraft(activePhase, activeDeadline);
    stopMediaStream();
    releaseWakeLock();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (researchTimer || presentationTimer)) holdWakeLock();
  });
}

async function boot() {
  try { localStorage.removeItem('clear60/drive/v1'); } catch { /* retired remote-handoff preference */ }
  $('#today-date').textContent = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date());
  syncDailyTopic();
  bindEvents();
  updateConnection();
  await updateStreaks();
  registerWorker();
  restartReminderLoop();
  const restored = await restoreActivePractice();
  if (location.hash === '#streaks' || location.hash === '#history') navigate('streaks');
  else if (!restored) showStage('prompt');
}

await boot();
document.documentElement.dataset.appReady = 'true';
