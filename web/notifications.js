import { localDateKey, topicForDate } from './core.js';

const KEY = 'clear60/reminders/v1';
const DEFAULTS = Object.freeze({ enabled: false, time: '09:00', lastDelivered: '' });

export function validReminderTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

export function loadReminderSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      enabled: value.enabled === true,
      time: validReminderTime(value.time) ? value.time : DEFAULTS.time,
      lastDelivered: /^\d{4}-\d{2}-\d{2}$/.test(value.lastDelivered) ? value.lastDelivered : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(settings) {
  const safe = {
    enabled: settings.enabled === true,
    time: validReminderTime(settings.time) ? settings.time : DEFAULTS.time,
    lastDelivered: /^\d{4}-\d{2}-\d{2}$/.test(settings.lastDelivered) ? settings.lastDelivered : '',
  };
  localStorage.setItem(KEY, JSON.stringify(safe));
  return safe;
}

export function reminderSupport() {
  return 'Notification' in globalThis && !!navigator.serviceWorker;
}

export async function enableReminders(time) {
  if (!reminderSupport()) return { ok: false, reason: 'unsupported', settings: loadReminderSettings() };
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    return { ok: false, reason: 'user-gesture-required', settings: loadReminderSettings() };
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: permission, settings: write({ ...loadReminderSettings(), enabled: false }) };
  }
  return {
    ok: true,
    reason: 'enabled',
    settings: write({ ...loadReminderSettings(), enabled: true, time }),
  };
}

export function disableReminders() {
  return write({ ...loadReminderSettings(), enabled: false });
}

function dueAt(date, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const due = new Date(date);
  due.setHours(hours, minutes, 0, 0);
  return due;
}

export function nextReminderAt(now = new Date(), time = DEFAULTS.time) {
  const current = now instanceof Date ? new Date(now) : new Date(now);
  if (!validReminderTime(time) || Number.isNaN(current.getTime())) throw new TypeError('Valid date and time required');
  const next = dueAt(current, time);
  if (next <= current) next.setDate(next.getDate() + 1);
  return next;
}

export function isReminderDue(now = new Date(), settings = loadReminderSettings()) {
  if (!settings.enabled || !validReminderTime(settings.time)) return false;
  const date = localDateKey(now);
  return now >= dueAt(now, settings.time) && settings.lastDelivered !== date;
}

async function registration() {
  if (!navigator.serviceWorker) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function deliverDailyReminder(topic, now = new Date()) {
  const settings = loadReminderSettings();
  if (!isReminderDue(now, settings) || !reminderSupport() || Notification.permission !== 'granted') {
    return { shown: false, reason: 'not-due' };
  }
  const reg = await registration();
  if (!reg) return { shown: false, reason: 'no-worker' };
  const date = localDateKey(now);
  try {
    await reg.showNotification('Your 15:60 prompt is ready', {
      body: String(topic || 'Research one idea, then make it clear in sixty seconds.').slice(0, 180),
      icon: new URL('icon.svg', reg.scope).href,
      badge: new URL('icon.svg', reg.scope).href,
      tag: `clear60-daily-${date}`,
      renotify: false,
      data: { kind: 'daily', url: new URL('index.html#today', reg.scope).href },
    });
    write({ ...settings, lastDelivered: date });
    return { shown: true, reason: 'shown' };
  } catch {
    return { shown: false, reason: 'show-failed' };
  }
}

export async function notifyTimerDone(title, body, tag) {
  if (!globalThis.document?.hidden || !reminderSupport() || Notification.permission !== 'granted') {
    return false;
  }
  const reg = await registration();
  if (!reg) return false;
  try {
    await reg.showNotification(String(title).slice(0, 80), {
      body: String(body).slice(0, 180),
      icon: new URL('icon.svg', reg.scope).href,
      tag: `clear60-timer-${String(tag || 'done').replace(/[^a-z0-9-]/gi, '')}`,
      data: { kind: 'timer', url: new URL('index.html#today', reg.scope).href },
    });
    return true;
  } catch {
    return false;
  }
}

/* Browsers do not wake a static PWA on a schedule. This loop covers an open
 * app and catches up when it resumes; the calendar export below is the honest,
 * durable path when no push service exists. */
export function startReminderLoop(topicForToday, onCheck = () => {}) {
  let timeout = null;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    const settings = loadReminderSettings();
    const result = await deliverDailyReminder(topicForToday(), new Date());
    onCheck(result);
    if (timeout) clearTimeout(timeout);
    if (settings.enabled) {
      const delay = Math.min(2_147_000_000, Math.max(1000, nextReminderAt(new Date(), settings.time) - new Date()));
      timeout = setTimeout(check, delay);
    }
  };
  const resume = () => { if (!document.hidden) check(); };
  globalThis.document?.addEventListener('visibilitychange', resume);
  globalThis.addEventListener?.('focus', resume);
  check();
  return () => {
    stopped = true;
    if (timeout) clearTimeout(timeout);
    globalThis.document?.removeEventListener('visibilitychange', resume);
    globalThis.removeEventListener?.('focus', resume);
  };
}

function icsEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function pad(value) { return String(value).padStart(2, '0'); }

function localIcsDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

function utcIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function utf8Bytes(character) {
  const point = character.codePointAt(0);
  if (point <= 0x7f) return 1;
  if (point <= 0x7ff) return 2;
  if (point <= 0xffff) return 3;
  return 4;
}

/* RFC 5545 content lines are limited to 75 UTF-8 octets. Continuation lines
 * begin with one space, which calendar readers remove when unfolding. */
function foldIcsLine(line) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const character of line) {
    const size = utf8Bytes(character);
    if (bytes + size > 75) {
      chunks.push(chunk);
      chunk = ` ${character}`;
      bytes = 1 + size;
    } else {
      chunk += character;
      bytes += size;
    }
  }
  chunks.push(chunk);
  return chunks.join('\r\n');
}

export function calendarReminderIcs({ time = DEFAULTS.time, start = new Date(), url = '', days = 90 } = {}) {
  if (!validReminderTime(time)) throw new TypeError('A valid reminder time is required');
  const startDate = start instanceof Date ? new Date(start) : new Date(start);
  if (Number.isNaN(startDate.getTime())) throw new TypeError('A valid start date is required');
  const horizon = Math.min(365, Math.max(1, Math.round(Number(days) || 90)));
  const first = dueAt(startDate, time);
  if (first < startDate) first.setDate(first.getDate() + 1);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//15:60//Daily practice//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:15:60 daily prompts',
  ];
  const stamp = utcIcsDate(new Date());
  for (let day = 0; day < horizon; day++) {
    const at = new Date(first);
    at.setDate(first.getDate() + day);
    const date = localDateKey(at);
    const topic = topicForDate(at);
    const description = `Today's prompt: ${topic}\n\nResearch for 15 minutes, then make it clear in 60 seconds.${url ? `\n\nOpen 15:60: ${url}` : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:daily-${date}@clear60.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${localIcsDate(at)}`,
      'DURATION:PT16M',
      `SUMMARY:${icsEscape(`15:60: ${topic}`)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      'BEGIN:VALARM',
      'TRIGGER:PT0M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(topic)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(foldIcsLine).join('\r\n');
}

export const reminderIdentity = Object.freeze({ key: KEY });
