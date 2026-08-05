import test from 'node:test';
import assert from 'node:assert/strict';
import { topicForDate } from '../web/core.js';
import {
  calendarReminderIcs,
  isReminderDue,
  nextReminderAt,
  validReminderTime,
} from '../web/notifications.js';

test('reminder times and due-on-resume state are deterministic', () => {
  assert.equal(validReminderTime('09:30'), true);
  assert.equal(validReminderTime('24:00'), false);
  const now = new Date(2026, 7, 5, 10, 0, 0);
  assert.equal(nextReminderAt(now, '09:00').getDate(), 6);
  assert.equal(isReminderDue(now, { enabled: true, time: '09:00', lastDelivered: '' }), true);
  assert.equal(isReminderDue(now, { enabled: true, time: '09:00', lastDelivered: '2026-08-05' }), false);
});

test('calendar export contains 90 dated events with their actual daily prompts', () => {
  const first = new Date(2026, 7, 5, 8, 0, 0);
  const calendar = calendarReminderIcs({
    time: '09:15',
    start: first,
    url: 'https://example.test/clear60/',
  });
  assert.equal((calendar.match(/BEGIN:VEVENT/g) || []).length, 90);
  assert.equal((calendar.match(/BEGIN:VALARM/g) || []).length, 90);
  assert.match(calendar, /DTSTART:20260805T091500/);
  const unfolded = calendar.replace(/\r\n[ \t]/g, '');
  const escapedTopic = topicForDate(first).replace(/,/g, '\\,').replace(/;/g, '\\;');
  assert.ok(unfolded.includes(escapedTopic));
  assert.ok(calendar.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75));
  assert.ok(!calendar.includes('RRULE:FREQ=DAILY'));
  assert.match(calendar, /UID:daily-2026-08-05@clear60\.local/);
});
