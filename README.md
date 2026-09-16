# PlayerYT

A browser music player for two kinds of track in one queue: YouTube videos played
as audio, and audio files from your own device or a direct URL. Paste a link (or
search, with an API key), build a playlist, and control it like a music app — the
video stays hidden behind a toggle unless you want to watch it.

File tracks keep playing when the screen locks. YouTube tracks cannot — see
[Playing with the screen off](#playing-with-the-screen-off).

No build step, no dependencies, no server-side component: three scripts, one
stylesheet, one HTML file.

## Running it

```bash
npm start           # serves the folder at http://localhost:8080
```

Any static server works (`npx http-server`, `python3 -m http.server`). Serve it
over `http://` or `https://` rather than opening `index.html` directly — the
YouTube IFrame player needs a real origin.

## Using it

| Action | How |
| --- | --- |
| Add a track | Paste a watch, `youtu.be`, Shorts, embed, or Music link — or a bare 11-character video id |
| Add your own audio | Press **Files** and pick tracks from the device, or paste a direct `.mp3` / `.m4a` / `.flac` / `.ogg` / `.wav` / `.opus` URL |
| Add a playlist | Paste a playlist link (needs an API key, imports up to 50 tracks) |
| Search by words | Type anything that isn't a link (needs an API key) |
| Play a queued track | Click it in the queue |
| Reorder the queue | Drag queue items |
| Watch the video | Press **Video** in the header |
| Stop the screen locking | Press **Keep awake** in the header (on by default) |

Keyboard: `Space` play/pause · `K`/`L` previous/next · `←`/`→` seek 5s ·
`S` shuffle · `R` repeat (off → all → one) · `M` mute · `V` video · `W` keep awake.

The queue, playback position in the list, volume, shuffle and repeat settings are
saved to `localStorage`, so a reload picks up where you left off. OS media keys
work through the Media Session API.

## Playing with the screen off

It depends on the source, and the difference is not something the app chooses.

**File tracks keep playing.** They run through an `<audio>` element, which is the
one media surface a mobile browser keeps alive when the screen locks. Lock the
phone, put it in a pocket, and the queue carries on with lock-screen controls
from the Media Session API. This is why the file source exists.

**YouTube tracks stop.** They play inside YouTube's own cross-origin embed, and
a locked screen suspends it. No page-level code can resume it: background
playback needs an entitlement only native apps can declare, and it is the
feature YouTube reserves for Premium in their own app. Forcing it would mean
circumventing their terms, so this app does not try.

For YouTube tracks the app does the next best thing, where the
[Screen Wake Lock API](https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API)
exists (Chrome, Edge, Safari 16.4+):

- **Keep awake** (header, on by default, `W`) holds a screen wake lock while a
  YouTube track plays, so the phone does not dim and auto-lock mid-album. It is
  released on pause and re-taken when the tab becomes visible, since browsers
  drop the lock whenever a page hides. File tracks skip the lock entirely — they
  do not need it, and holding it would only cost battery.
- Media Session metadata and position state are published for both sources, so
  OS controls show the track and a working scrubber.

### Where local files live

Files you add are copied into IndexedDB in the browser, so a queue survives a
reload and works offline. They never leave the device — this app has no backend.
Removing a track from the queue deletes its stored copy, and **Clear** empties
both the queue and the stored files.

## Optional: a YouTube Data API key

Playback and link-pasting need no key. Keyword search and playlist import do.

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3**.
3. Create an API key and (recommended) restrict it to that API and to the origin
   you serve the player from.
4. Paste it into **Settings** in the app.

The key is kept in this browser's `localStorage` and is only ever sent to
`googleapis.com` from your own browser. This app has no backend, so nothing is
stored or proxied anywhere else.

## Project layout

```
index.html        markup and the element ids the app binds to
assets/styles.css dark theme, layout, controls
src/utils.js      link/id parsing, time and ISO-8601 duration formatting
src/store.js      queue state, shuffle/repeat order, localStorage persistence
src/youtube.js    IFrame player wrapper, oEmbed + Data API lookups
src/audio.js      <audio> engine for files and direct URLs (survives a lock)
src/library.js    IndexedDB store holding local audio files
src/app.js        UI wiring: rendering, controls, shortcuts, media keys
server.js         zero-dependency static server for local development
test/utils.test.js assertions for the pure helpers (`npm test`)
```

## Notes and limits

- Some videos are not embeddable; the player reports the error and skips to the
  next track.
- Playback happens in YouTube's own iframe, so ads and YouTube's terms apply as
  they would on the site itself. Nothing is downloaded or re-hosted.
- Playlist import reads the first page (50 items) of a public playlist.
- Which audio formats play is up to the browser: MP3, AAC/M4A, WAV and Ogg/Opus
  are safe about everywhere; FLAC works in current Chrome, Edge, Firefox and
  Safari; ALAC and WMA generally do not.
