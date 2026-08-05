import { TOPICS } from './topics.js';

export { TOPIC_CATALOG, TOPIC_CATEGORIES, TOPIC_RECORDS, TOPICS } from './topics.js';

export const APP_VERSION = '1.3.0';
export const SESSION_SCHEMA_VERSION = 3;
export const SESSION_KIND = 'clear60-session';
export const RESEARCH_SECONDS = 15 * 60;
export const PRESENTATION_SECONDS = 60;
export const DAILY_ROLL_LIMIT = 3;
export const STREAK_CALENDAR_DAYS = 16 * 7;

export function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('A valid date is required');
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function topicForDate(date = new Date(), offset = 0) {
  const shift = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  const index = (hash(`clear60-v2:${localDateKey(date)}`) + shift) % TOPICS.length;
  return TOPICS[(index + TOPICS.length) % TOPICS.length];
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

/* Topic rerolls are a deliberately tiny, date-scoped state machine. Keeping
 * this pure makes the three-roll rule equally reliable after reloads and
 * under the browser UI's animation lock. */
export function dailyRollState(input = {}, date = new Date()) {
  const today = localDateKey(date);
  const value = input && typeof input === 'object' ? input : {};
  const isToday = value.date === today;
  const rollsUsed = isToday ? boundedInteger(value.rollsUsed, 0, DAILY_ROLL_LIMIT) : 0;
  const offset = isToday ? boundedInteger(value.offset, 0, 1_000_000) : 0;
  return Object.freeze({
    version: 1,
    date: today,
    rollsUsed,
    rollsLeft: DAILY_ROLL_LIMIT - rollsUsed,
    offset,
  });
}

export function rollDailyTopic(input = {}, date = new Date()) {
  const state = dailyRollState(input, date);
  if (state.rollsLeft === 0) return state;
  const rollsUsed = state.rollsUsed + 1;
  return Object.freeze({
    version: 1,
    date: state.date,
    rollsUsed,
    rollsLeft: DAILY_ROLL_LIMIT - rollsUsed,
    offset: state.offset + 1,
  });
}

function dateFromLocalKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return localDateKey(date) === value ? date : null;
}

function shiftLocalDateKey(value, days) {
  const date = dateFromLocalKey(value);
  if (!date) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return localDateKey(date);
}

function completedDateKey(session) {
  if (!session?.completedAt) return null;
  const completed = new Date(session.completedAt);
  if (Number.isNaN(completed.getTime())) return null;
  const topicDate = dateFromLocalKey(session.topicDate);
  if (topicDate) return localDateKey(topicDate);
  return localDateKey(completed);
}

function completedDateSet(sessions, today = new Date()) {
  const todayKey = localDateKey(today);
  const dates = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const key = completedDateKey(session);
    if (key && key <= todayKey) dates.add(key);
  }
  return dates;
}

export function streakStats(sessions, today = new Date()) {
  const todayKey = localDateKey(today);
  const completedDates = [...completedDateSet(sessions, today)].sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const key of completedDates) {
    run = previous && shiftLocalDateKey(previous, 1) === key ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = key;
  }

  const last = completedDates.at(-1);
  const yesterday = shiftLocalDateKey(todayKey, -1);
  let currentStreak = 0;
  if (last === todayKey || last === yesterday) {
    const completed = new Set(completedDates);
    let cursor = last;
    while (cursor && completed.has(cursor)) {
      currentStreak++;
      cursor = shiftLocalDateKey(cursor, -1);
    }
  }

  return Object.freeze({ currentStreak, longestStreak, completedDates: Object.freeze(completedDates) });
}

export function streakCalendar(sessions, { today = new Date(), days = STREAK_CALENDAR_DAYS } = {}) {
  const todayKey = localDateKey(today);
  const length = boundedInteger(days, 1, 3660);
  const completed = completedDateSet(sessions, today);
  const first = shiftLocalDateKey(todayKey, -(length - 1));
  const result = [];
  for (let index = 0; index < length; index++) {
    const date = shiftLocalDateKey(first, index);
    result.push(Object.freeze({
      date,
      completed: completed.has(date),
      today: date === todayKey,
    }));
  }
  return Object.freeze(result);
}

export function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function timerSnapshot(durationMs, startedAt, now) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const elapsedMs = Math.min(duration, Math.max(0, Number(now) - Number(startedAt)));
  const remainingMs = Math.max(0, duration - elapsedMs);
  return Object.freeze({
    durationMs: duration,
    elapsedMs,
    remainingMs,
    progress: duration ? elapsedMs / duration : 1,
    done: remainingMs === 0,
  });
}

/* Deadline-based rather than decrement-based: background-tab throttling may
 * delay a paint, but it can never quietly turn sixty seconds into seventy. */
export class DeadlineTimer {
  constructor(durationMs, options = {}) {
    this.durationMs = Math.max(0, Number(durationMs) || 0);
    this.clock = options.clock || (() => performance.now());
    this.setInterval = options.setInterval || globalThis.setInterval.bind(globalThis);
    this.clearInterval = options.clearInterval || globalThis.clearInterval.bind(globalThis);
    this.onTick = options.onTick || (() => {});
    this.onDone = options.onDone || (() => {});
    this.interval = null;
    this.startedAt = null;
    this.last = timerSnapshot(this.durationMs, 0, 0);
    this.completed = false;
  }

  start(elapsedMs = 0) {
    if (this.interval || this.completed) return this.last;
    const elapsed = Math.min(this.durationMs, Math.max(0, Number(elapsedMs) || 0));
    this.startedAt = this.clock() - elapsed;
    this.#tick();
    if (!this.completed) this.interval = this.setInterval(() => this.#tick(), 200);
    return this.last;
  }

  stop() {
    if (this.startedAt !== null && !this.completed) {
      this.last = timerSnapshot(this.durationMs, this.startedAt, this.clock());
      this.onTick(this.last);
    }
    if (this.interval) this.clearInterval(this.interval);
    this.interval = null;
    return this.last;
  }

  #tick() {
    this.last = timerSnapshot(this.durationMs, this.startedAt, this.clock());
    this.onTick(this.last);
    if (this.last.done && !this.completed) {
      this.completed = true;
      if (this.interval) this.clearInterval(this.interval);
      this.interval = null;
      this.onDone(this.last);
    }
  }
}

function cleanText(value, limit) {
  return String(value ?? '').replace(/\r\n?/g, '\n').slice(0, limit).trim();
}

const TOPIC_NAMES = new Set(TOPICS);

function normalizeTopic(value) {
  const text = cleanText(value, 240);
  const separator = text.indexOf(' — ');
  if (separator < 0) return text;
  const candidate = text.slice(0, separator).trim();
  return TOPIC_NAMES.has(candidate) ? candidate : text;
}

function normalizeSelfRating(value) {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function sessionId(now) {
  if (globalThis.crypto?.randomUUID) return `c60-${globalThis.crypto.randomUUID()}`;
  return `c60-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSession({ topic, topicDate, now = new Date(), id } = {}) {
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    kind: SESSION_KIND,
    appVersion: APP_VERSION,
    id: id || sessionId(new Date(createdAt)),
    topic: normalizeTopic(topic),
    topicDate: topicDate || localDateKey(new Date(createdAt)),
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    transcript: '',
    transcriptionSource: 'none',
    selfRating: null,
    futureNotes: '',
    timing: {
      researchTargetSeconds: RESEARCH_SECONDS,
      researchElapsedSeconds: 0,
      presentationTargetSeconds: PRESENTATION_SECONDS,
      presentationElapsedSeconds: 0,
      recordingDurationSeconds: 0,
    },
    media: {
      filename: '',
      type: '',
      sizeBytes: 0,
      source: 'none',
      kind: 'none',
    },
  };
}

function finiteSeconds(value, maximum = 24 * 60 * 60) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(maximum, Math.max(0, Math.round(n * 100) / 100)) : 0;
}

export function normalizeSession(input = {}) {
  const base = createSession({
    topic: input.topic,
    topicDate: input.topicDate,
    now: input.createdAt || new Date(),
    id: /^[a-zA-Z0-9-]{4,100}$/.test(String(input.id || '')) ? input.id : undefined,
  });
  const timing = input.timing || {};
  const media = input.media || {};
  const mediaType = cleanText(media.type, 100);
  const mediaIsAudio = mediaType.startsWith('audio/');
  const iso = (value, fallback) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  };
  return {
    ...base,
    updatedAt: iso(input.updatedAt, base.createdAt),
    completedAt: input.completedAt ? iso(input.completedAt, null) : null,
    transcript: cleanText(input.transcript, 30000),
    transcriptionSource: ['browser-speech-recognition', 'speech-recognition', 'manual', 'uploaded', 'none']
      .includes(input.transcriptionSource) ? input.transcriptionSource : 'none',
    selfRating: normalizeSelfRating(input.selfRating),
    futureNotes: cleanText(input.futureNotes, 5000),
    timing: {
      researchTargetSeconds: finiteSeconds(timing.researchTargetSeconds || RESEARCH_SECONDS),
      researchElapsedSeconds: finiteSeconds(timing.researchElapsedSeconds),
      presentationTargetSeconds: finiteSeconds(timing.presentationTargetSeconds || PRESENTATION_SECONDS),
      presentationElapsedSeconds: finiteSeconds(timing.presentationElapsedSeconds),
      recordingDurationSeconds: finiteSeconds(timing.recordingDurationSeconds),
    },
    media: {
      filename: mediaIsAudio ? cleanText(media.filename, 180) : '',
      type: mediaIsAudio ? mediaType : '',
      sizeBytes: mediaIsAudio ? Math.max(0, Math.round(Number(media.sizeBytes) || 0)) : 0,
      source: mediaIsAudio && ['recorded', 'uploaded'].includes(media.source) ? media.source : 'none',
      kind: mediaIsAudio ? 'audio' : 'none',
    },
  };
}

export function sessionSidecar(session) {
  const clean = normalizeSession(session);
  return {
    ...clean,
    exportedAt: new Date().toISOString(),
    evaluatorHint: 'Assess concise structure, pace, filler language, clarity, and whether the answer fits 60 seconds.',
  };
}

export function slugify(value, fallback = 'practice') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);
  return slug || fallback;
}

export function sidecarFilename(session) {
  return `clear60-${session.topicDate || localDateKey()}-${slugify(session.topic)}.json`;
}
