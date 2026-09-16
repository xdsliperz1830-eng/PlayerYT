/* Node smoke tests for the pure helpers in src/utils.js. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { URL, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils.js'), 'utf8'), sandbox);

const { parseInput, formatTime, parseIsoDuration, classifyInput, titleFromName } = sandbox.PYT.utils;

const linkCases = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ', null],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', null],
  ['  dQw4w9WgXcQ  ', 'dQw4w9WgXcQ', null],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijkl', 'dQw4w9WgXcQ', 'PLabcdefghijkl'],
  ['https://www.youtube.com/playlist?list=PLabcdefghijkl', null, 'PLabcdefghijkl']
];

linkCases.forEach(([input, videoId, playlistId]) => {
  const parsed = parseInput(input);
  assert.ok(parsed, `expected a parse result for ${input}`);
  assert.strictEqual(parsed.videoId, videoId, `videoId for ${input}`);
  assert.strictEqual(parsed.playlistId, playlistId, `playlistId for ${input}`);
});

[
  '',
  'lofi hip hop radio',
  'https://vimeo.com/123456',
  'https://www.youtube.com/watch?v=tooshort',
  'https://www.youtube.com/'
].forEach((input) => {
  assert.strictEqual(parseInput(input), null, `expected null for ${JSON.stringify(input)}`);
});

assert.strictEqual(formatTime(0), '0:00');
assert.strictEqual(formatTime(9), '0:09');
assert.strictEqual(formatTime(212), '3:32');
assert.strictEqual(formatTime(3725), '1:02:05');
assert.strictEqual(formatTime(-5), '0:00');
assert.strictEqual(formatTime(undefined), '0:00');

assert.strictEqual(parseIsoDuration('PT3M14S'), 194);
assert.strictEqual(parseIsoDuration('PT1H2M3S'), 3723);
assert.strictEqual(parseIsoDuration('PT45S'), 45);
assert.strictEqual(parseIsoDuration('nonsense'), 0);

// classifyInput routes the add box between YouTube, audio files and search
assert.strictEqual(classifyInput('').kind, 'empty');
assert.strictEqual(classifyInput('lofi beats').kind, 'search');
assert.strictEqual(classifyInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'youtube');
assert.strictEqual(classifyInput('dQw4w9WgXcQ').youtube.videoId, 'dQw4w9WgXcQ');

['https://example.com/song.mp3', 'https://cdn.example.com/a/b.flac?token=1',
 'https://example.com/set.m4a#t=10', 'https://example.com/x.opus'].forEach((link) => {
  const result = classifyInput(link);
  assert.strictEqual(result.kind, 'audio', `expected audio for ${link}`);
  assert.ok(result.src.startsWith('https://'), 'audio src keeps its url');
});

assert.strictEqual(classifyInput('https://example.com/page').kind, 'unknown-link');
assert.strictEqual(classifyInput('https://vimeo.com/123').kind, 'unknown-link');

assert.strictEqual(titleFromName('01 - Rhodes Groove.mp3'), '01 - Rhodes Groove');
assert.strictEqual(titleFromName('no-extension'), 'no-extension');
assert.strictEqual(titleFromName(''), 'Untitled');

console.log('utils: all assertions passed');
