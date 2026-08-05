# 15:60

Research one idea for 15 minutes. Say it in 60 seconds. Listen back, save the
take locally, and optionally export it for a separate local evaluator.

**[Open the live app](https://kkonrad.com/15-60/)**

15:60 is a local-first, installable PWA with no production build step. Its
architecture takes the useful constraints from KeepClub — static deployment,
versioned device storage, separate metadata/media records, an explicit offline
shell, and contract-focused tests — while keeping a distinct storage and cache
identity.

## Run locally

Clone the repository, then serve the static app (localhost is a secure context
for microphone access, service workers, and notifications):

```sh
git clone https://github.com/0xkkonrad/15-60.git
cd 15-60
python3 -m http.server 8777 --directory web
```

Open:

```text
http://localhost:8777/
```

There is no build command. Deploy the files under `web/` together, over HTTPS.

## The practice loop

1. A deterministic topic is selected from 228 named concepts across 19
   disciplines for each local calendar date. You can roll for a replacement up
   to three times; the interleaved catalog makes all four choices come from
   different fields. The app shows only the concept name—no leading question,
   custom-topic form, or research notebook.
2. The research timer uses an absolute deadline, not a decrementing counter,
   so a throttled tab cannot lengthen 15 minutes. This stage is deliberately
   just the topic, a large timer, and its controls. At 1:00 it turns red and
   plays one warning cue; its deadline and warning state survive a reload.
3. The 60-second timer can run alone or alongside a local `MediaRecorder`
   audio take. A screen wake lock is requested when supported. An interrupted
   audio recording cannot survive a page close; the deadline still resumes and
   the app says that plainly.
4. Review adds an optional 1–5 self-rating and one note for next time. Both
   autosave and remain editable when a completed take is reopened.
5. Completed session metadata and its optional audio Blob are saved
   automatically in separate IndexedDB stores. A completed X in Streaks is a
   button that reopens the saved take and audio for that day.
6. Audio and review-data downloads create deterministic companion files. They
   are both the durable backup and the bridge to the external Codex evaluator.
   **Export all history** creates one TAR containing every session JSON and all
   available audio files without base64 inflation.
7. Generated timer sounds and feature-detected vibration patterns mark start,
   the final research minute, the presentation’s final ten seconds, and finish.
   Sound and haptics have separate settings.

## Topic catalog

The catalog contains recognizable, researchable concepts rather than generic
discussion starters. Entries are names only—for example Coase theorem, Ship of
Theseus, Japonisme, Noether’s theorem, the prevention paradox, and the Byzantine
Generals problem. The complete human-readable list is in [TOPICS.md](TOPICS.md);
the app’s offline data and category order live in `web/topics.js`.

### Why there is no in-app transcript

The browser’s ordinary speech-recognition API may send audio to a vendor
service. Guaranteed on-device recognition remains experimental and its
language-pack APIs previously proved unsafe in an embedded Chromium renderer.
Bundling Whisper would add a large model and runtime to this small static PWA.
15:60 therefore ships no recognition code or transcript UI. Legacy transcript
fields are preserved when old sessions are opened or exported, so existing
data is not discarded.

The JSON sidecar contract is versioned:

```json
{
  "schemaVersion": 3,
  "kind": "clear60-session",
  "topic": "Wave–particle duality",
  "selfRating": 4,
  "futureNotes": "Pause before the example.",
  "timing": {
    "researchTargetSeconds": 900,
    "researchElapsedSeconds": 900,
    "presentationTargetSeconds": 60,
    "presentationElapsedSeconds": 60,
    "recordingDurationSeconds": 60
  },
  "media": {
    "filename": "clear60-….webm",
    "type": "audio/webm;codecs=opus",
    "sizeBytes": 123456,
    "source": "recorded",
    "kind": "audio"
  }
}
```

The optional Codex review skill used by the maintainer is intentionally not
part of this PWA or repository. Give any compatible local analysis tool a
downloaded session JSON and adjacent audio file, or extract both from the
history TAR. The app itself never downloads a speech model or sends a take to
an evaluator.

## Notifications without pretending

Browsers never shipped a general Notification Triggers API, and a static PWA
has no server capable of waking a closed browser. 15:60 therefore implements
the useful subset honestly:

- permission is requested only from an explicit button press;
- a best-effort timer delivers while the app remains active;
- an overdue reminder is delivered when the app next opens or resumes; and
- a downloaded 90-day calendar contains 90 dated events, each with the actual
  deterministic topic for that day and a display alarm.

The prompt calendar is the reliable, no-backend reminder. Generate another one
near the end of its horizon. True indefinite push scheduling would require a
backend, push subscription storage, and a privacy/deployment decision that is
deliberately out of scope here.

## Local data and privacy

- IndexedDB database `clear60` automatically holds session metadata in one store
  and audio Blobs in another. This lets Streaks load without reading every take;
  selecting a completed X fetches and reopens that day's saved take.
- Versioned `clear60/...` localStorage keys hold small preferences, reminder
  state, and the active-practice checkpoint.
- The PWA sends no app analytics and has no application backend.
- Audio recording stays local. The app contains no speech-recognition or
  transcription integration.
- Browser storage belongs to the exact origin: different hosts or ports have
  separate saves. Private browsing, clearing site data, or storage-pressure
  eviction can remove it.
- **Protect local saves** in Settings requests persistent storage. The browser
  decides whether to grant it, so it reduces eviction risk rather than creating
  a permanent backup.
- **Download audio**, **Download review data**, and **Export all history** are
  the durable backups. A history export is an ordinary TAR containing JSON and
  byte-identical audio files, so it can be inspected without this app.

## Repository map

- `web/index.html` — minimal semantic application shell and settings copy
- `web/app.css` — monochrome typewriter-and-ballpoint visual system
- `web/fonts/` — bundled DM Mono files with OFL notices
- `web/app.js` — practice orchestration and browser integrations
- `web/archive.js` — dependency-free streaming-friendly TAR export
- `web/topics.js` — 19-category, 228-concept offline prompt catalog
- `web/core.js` — pure topic selection, timers, and session schema
- `web/storage.js` — IndexedDB metadata/media boundary
- `web/notifications.js` — due-on-resume reminders and prompt calendar
- `web/sw.js` / `web/manifest.webmanifest` — install and offline shell
- `TOPICS.md` — complete human-readable concept list
- `tests/` — dependency-free contracts plus an optional real-browser smoke
- `LICENSE` — MIT license for the app source
- `THIRD_PARTY_NOTICES.md` — bundled font licensing

`15:60` is the public brand. The existing `clear60` storage keys, database name,
cache name, JSON `kind`, and filename prefix remain compatibility identities so
installed data and evaluator handoffs continue to work across the rename.

Before deploying a change to any precached file, bump the synchronized shell
stamp in `web/index.html`, `web/app.js`, `web/sw.js`, and
`tests/update-migration.mjs`. The worker fills the new cache before deleting
the previous complete generation, avoiding a mixed offline shell during
updates.

## Test

The fast suite needs Node 20 or newer and has no runtime dependencies:

```sh
npm test
```

For the browser suites, install the locked development dependencies and a
Playwright Chromium binary:

```sh
npm install
npx playwright install chromium
npm run test:browser
npm run test:update
npm run test:adversarial
```

## Deploy

Deploy the contents of `web/` together on any HTTPS static host. All asset,
manifest, shortcut, and service-worker URLs are relative, so the PWA works at
the domain root or under a path such as `/15-60/`. Browser data is
origin-specific: moving the app to another host starts a separate local data
store.
