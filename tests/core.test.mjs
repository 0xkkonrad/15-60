import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_ROLL_LIMIT,
  DeadlineTimer,
  PRESENTATION_SECONDS,
  RESEARCH_SECONDS,
  STREAK_CALENDAR_DAYS,
  TOPICS,
  TOPIC_CATALOG,
  TOPIC_CATEGORIES,
  TOPIC_RECORDS,
  createSession,
  dailyRollState,
  formatClock,
  localDateKey,
  normalizeSession,
  rollDailyTopic,
  sessionSidecar,
  sidecarFilename,
  streakCalendar,
  streakStats,
  topicForDate,
} from '../web/core.js';

test('daily prompts are stable for a local date and rotate on request', () => {
  const date = new Date(2026, 7, 5, 12, 0, 0);
  assert.equal(localDateKey(date), '2026-08-05');
  assert.equal(topicForDate(date), topicForDate(new Date(2026, 7, 5, 23, 59, 0)));
  assert.notEqual(topicForDate(date), topicForDate(date, 1));
});

test('topic catalog contains 12 named concepts in each requested discipline', () => {
  const expectedCategories = [
    'economics',
    'political-theory',
    'strategy-and-game-theory',
    'biology',
    'medicine-and-public-health',
    'earth-and-climate',
    'physics',
    'chemistry-and-materials',
    'mathematics',
    'statistics-and-measurement',
    'cognition-and-reasoning',
    'paradoxes',
    'philosophy',
    'linguistics',
    'anthropology-and-sociology',
    'history',
    'art-and-architecture',
    'music-and-narrative-craft',
    'technology-and-engineering',
  ];
  assert.deepEqual(TOPIC_CATEGORIES, expectedCategories);
  assert.deepEqual(Object.keys(TOPIC_CATALOG), expectedCategories);
  assert.ok(Object.values(TOPIC_CATALOG).every((prompts) => prompts.length === 12));
  assert.equal(TOPICS.length, 228);
  assert.equal(TOPIC_RECORDS.length, TOPICS.length);

  assert.equal(new Set(TOPICS).size, TOPICS.length, 'concept names must be unique');
  assert.ok(TOPICS.every((topic) => !topic.includes(' — ') && !topic.endsWith('?')));
  assert.ok(TOPICS.every((topic) => topic.length <= 80), 'topic names must remain glanceable');
  for (const concept of ['Coase theorem', 'Japonisme', 'Ship of Theseus']) {
    assert.ok(TOPICS.includes(concept), `missing requested exemplar: ${concept}`);
  }
  assert.ok(TOPICS.includes('Wave–particle duality'));
});

test('legacy catalog prompts migrate to names without altering arbitrary historical topics', () => {
  const legacy = normalizeSession({
    topic: 'Wave–particle duality — How can the same quantum object produce both localized detections and wave-like interference?',
  });
  assert.equal(legacy.topic, 'Wave–particle duality');
  assert.equal(normalizeSession({ topic: 'My topic — keep this text' }).topic, 'My topic — keep this text');
});

test('topic stream interleaves disciplines so all three rolls change field', () => {
  TOPIC_RECORDS.forEach((record, index) => {
    assert.equal(record.category, TOPIC_CATEGORIES[index % TOPIC_CATEGORIES.length]);
    assert.equal(record.prompt, TOPICS[index]);
  });

  const date = new Date(2026, 7, 5, 12);
  const categories = Array.from({ length: DAILY_ROLL_LIMIT + 1 }, (_, offset) => {
    const prompt = topicForDate(date, offset);
    return TOPIC_RECORDS[TOPICS.indexOf(prompt)].category;
  });
  assert.equal(new Set(categories).size, DAILY_ROLL_LIMIT + 1);
});

test('daily topic rolls run exactly 3 → 2 → 1 → 0 and persist their chosen offset', () => {
  const today = new Date(2026, 7, 5, 12);
  let state = dailyRollState(null, today);
  assert.equal(state.rollsLeft, DAILY_ROLL_LIMIT);
  assert.equal(state.offset, 0, 'the initial daily topic is not a roll');

  state = rollDailyTopic(state, today);
  assert.deepEqual([state.rollsUsed, state.rollsLeft, state.offset], [1, 2, 1]);
  state = rollDailyTopic(state, today);
  assert.deepEqual([state.rollsUsed, state.rollsLeft, state.offset], [2, 1, 2]);
  state = rollDailyTopic(state, today);
  assert.deepEqual([state.rollsUsed, state.rollsLeft, state.offset], [3, 0, 3]);

  const fourth = rollDailyTopic(state, today);
  assert.deepEqual(fourth, state, 'a fourth activation cannot move the topic');
  assert.deepEqual(dailyRollState(JSON.parse(JSON.stringify(state)), today), state, 'reload restores the choice');
});

test('daily topic rolls reset on the next local date and clamp damaged saved data', () => {
  const today = new Date(2026, 7, 5, 23, 59);
  const tomorrow = new Date(2026, 7, 6, 0, 1);
  const spent = { date: '2026-08-05', rollsUsed: 99, offset: -9 };
  assert.deepEqual(dailyRollState(spent, today), {
    version: 1, date: '2026-08-05', rollsUsed: 3, rollsLeft: 0, offset: 0,
  });
  assert.deepEqual(dailyRollState(spent, tomorrow), {
    version: 1, date: '2026-08-06', rollsUsed: 0, rollsLeft: 3, offset: 0,
  });
});

test('streak stats deduplicate practice days and keep a current run alive through yesterday', () => {
  const completed = (topicDate, completedAt = `${topicDate}T12:00:00`) => ({ topicDate, completedAt });
  const sessions = [
    completed('2026-07-29'),
    completed('2026-07-30'),
    completed('2026-08-01'),
    completed('2026-08-02'),
    completed('2026-08-03'),
    completed('2026-08-04'),
    completed('2026-08-04', '2026-08-04T18:00:00'),
    { topicDate: 'broken', completedAt: '2026-07-31T23:30:00' },
    completed('2026-08-06'), // A future/corrupt completion never changes today's streak.
    { topicDate: '2026-08-05', completedAt: null },
  ];
  const stats = streakStats(sessions, new Date(2026, 7, 5, 9));
  assert.equal(stats.currentStreak, 7);
  assert.equal(stats.longestStreak, 7);
  assert.equal(stats.completedDates.filter((date) => date === '2026-08-04').length, 1);
  assert.ok(!stats.completedDates.includes('2026-08-06'));
  assert.equal(streakStats(sessions, new Date(2026, 7, 8, 9)).currentStreak, 0);
});

test('streak calendar returns an inclusive, deterministic 16-week local-date range', () => {
  const sessions = [{ topicDate: '2026-08-05', completedAt: '2026-08-05T08:00:00' }];
  const days = streakCalendar(sessions, { today: new Date(2026, 7, 5, 9) });
  assert.equal(days.length, STREAK_CALENDAR_DAYS);
  assert.equal(days[0].date, '2026-04-16');
  assert.deepEqual(days.at(-1), { date: '2026-08-05', completed: true, today: true });
  assert.equal(days.filter((day) => day.completed).length, 1);
});

test('clock formatting rounds up so the first frame says 15:00', () => {
  assert.equal(formatClock(RESEARCH_SECONDS * 1000), '15:00');
  assert.equal(formatClock(60_000), '1:00');
  assert.equal(formatClock(1), '0:01');
  assert.equal(formatClock(0), '0:00');
});

test('deadline timer restores elapsed time and cannot drift when ticks are late', () => {
  let now = 1_000;
  let intervalCallback;
  let done = 0;
  const ticks = [];
  const timer = new DeadlineTimer(1_000, {
    clock: () => now,
    setInterval: (callback) => { intervalCallback = callback; return 1; },
    clearInterval: () => {},
    onTick: (snapshot) => ticks.push(snapshot),
    onDone: () => { done++; },
  });
  timer.start(400);
  assert.equal(ticks.at(-1).remainingMs, 600);
  now = 1_900;
  intervalCallback();
  assert.equal(ticks.at(-1).remainingMs, 0);
  assert.equal(ticks.at(-1).elapsedMs, 1_000);
  assert.equal(done, 1);
});

test('sidecar has a versioned evaluator contract and no browser Blob', () => {
  const session = createSession({
    id: 'c60-test-session',
    topic: 'Why do clear explanations work?',
    topicDate: '2026-08-05',
    now: new Date('2026-08-05T10:00:00Z'),
  });
  session.transcript = 'Um, one clear idea is easier to remember.';
  session.transcriptionSource = 'browser-speech-recognition';
  session.selfRating = 4;
  session.futureNotes = 'Pause before the example.';
  session.timing.researchElapsedSeconds = 900;
  session.timing.presentationElapsedSeconds = 60;
  session.timing.recordingDurationSeconds = 59.84;
  session.media = { filename: 'take.webm', type: 'audio/webm;codecs=opus', sizeBytes: 1234, source: 'recorded', kind: 'audio' };
  const clean = normalizeSession(session);
  const sidecar = sessionSidecar({ ...clean, audioBlob: new Blob(['not exported']) });
  assert.equal(sidecar.schemaVersion, 3);
  assert.equal(sidecar.kind, 'clear60-session');
  assert.equal(sidecar.transcriptionSource, 'browser-speech-recognition');
  assert.equal(sidecar.selfRating, 4);
  assert.equal(sidecar.futureNotes, 'Pause before the example.');
  assert.deepEqual(sidecar.timing, {
    researchTargetSeconds: 900,
    researchElapsedSeconds: 900,
    presentationTargetSeconds: 60,
    presentationElapsedSeconds: 60,
    recordingDurationSeconds: 59.84,
  });
  assert.equal(sidecar.audioBlob, undefined);
  assert.equal(sidecar.researchNotes, undefined);
  assert.deepEqual(sidecar.media, {
    filename: 'take.webm',
    type: 'audio/webm;codecs=opus',
    sizeBytes: 1234,
    source: 'recorded',
    kind: 'audio',
  });
  assert.match(sidecarFilename(sidecar), /^clear60-2026-08-05-.+\.json$/);
});

test('self-rating and future notes normalize safely for old and damaged sessions', () => {
  assert.deepEqual(
    [normalizeSession({ selfRating: 1 }).selfRating, normalizeSession({ selfRating: 5 }).selfRating],
    [1, 5],
  );
  for (const value of [null, 0, 6, 2.5, 'not a rating']) {
    assert.equal(normalizeSession({ selfRating: value }).selfRating, null);
  }
  assert.equal(normalizeSession({ futureNotes: '  next time\r\npause  ' }).futureNotes, 'next time\npause');
});
