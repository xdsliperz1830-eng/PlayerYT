# PlayerYT

A browser music player that plays YouTube videos as an audio queue. Paste a link
(or search, with an API key), build a playlist, and control it like a music app —
the video stays hidden behind a toggle unless you want to watch it.

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
| Add a playlist | Paste a playlist link (needs an API key, imports up to 50 tracks) |
| Search by words | Type anything that isn't a link (needs an API key) |
| Play a queued track | Click it in the queue |
| Reorder the queue | Drag queue items |
| Watch the video | Press **Video** in the header |

Keyboard: `Space` play/pause · `K`/`L` previous/next · `←`/`→` seek 5s ·
`S` shuffle · `R` repeat (off → all → one) · `M` mute · `V` video.

The queue, playback position in the list, volume, shuffle and repeat settings are
saved to `localStorage`, so a reload picks up where you left off. OS media keys
work through the Media Session API.

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
