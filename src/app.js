/* UI wiring: queue rendering, controls, keyboard shortcuts, media keys. */
(function (global) {
  'use strict';

  var utils = global.PYT.utils;
  var youtube = global.PYT.youtube;
  var STATE = youtube.STATE;
  var API_KEY_STORAGE = 'playeryt.apikey';

  var el = {};
  var store = new global.PYT.Store();
  var player = null;
  var seeking = false;
  var ticker = null;
  var statusTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    bindControls();
    bindQueue();
    bindAddForm();
    bindSettings();
    bindKeyboard();

    store.subscribe(render);

    player = new youtube.Player('yt-player', {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError
    });

    player.ready.catch(function (err) {
      setStatus(err.message, true);
    });
  }

  function cacheElements() {
    [
      'add-form', 'add-input', 'add-button', 'video-toggle', 'settings-toggle',
      'settings-panel', 'api-key', 'api-key-save', 'api-key-clear', 'video-frame',
      'now-playing', 'np-art', 'np-title', 'np-author', 'seek', 'time-current',
      'time-total', 'shuffle', 'prev', 'play', 'next', 'repeat', 'mute', 'volume',
      'queue-list', 'queue-count', 'queue-empty', 'clear-queue', 'status',
      'queue-item-template'
    ].forEach(function (id) {
      el[camel(id)] = document.getElementById(id);
    });
  }

  function camel(id) {
    return id.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
  }

  /* ---------- player callbacks ---------- */

  function onPlayerReady() {
    player.setVolume(store.volume);
    player.setMuted(store.muted);
    var current = store.current();
    if (current) player.load(current.videoId, false);
    setStatus(store.tracks.length ? 'Queue restored — press play' : 'Ready');
  }

  function onPlayerStateChange(state) {
    updatePlayButton(state === STATE.PLAYING || state === STATE.BUFFERING);

    if (state === STATE.PLAYING) {
      startTicker();
      captureLiveMetadata();
      updateMediaSession();
    } else {
      stopTicker();
      updateProgress();
    }

    if (state === STATE.ENDED) advance(1, true);
  }

  function onPlayerError(code) {
    var current = store.current();
    var name = current ? current.title : 'This track';
    setStatus(name + ' cannot be played here (error ' + code + ') — skipping', true);
    advance(1, true);
  }

  /* Once playback starts the player knows the real title; keep the queue honest. */
  function captureLiveMetadata() {
    var current = store.current();
    var data = player.videoData();
    if (!current || !data || data.video_id !== current.videoId) return;

    store.update(current.uid, {
      title: data.title || current.title,
      author: data.author || current.author,
      duration: Math.round(player.duration()) || current.duration
    });
  }

  /* ---------- playback ---------- */

  function playTrack(uid, autoplay) {
    var track = store.get(uid);
    if (!track) return;
    store.setCurrent(uid);
    player.load(track.videoId, autoplay !== false);
    updateMediaSession();
  }

  function togglePlay() {
    if (!store.tracks.length) {
      setStatus('Add something to the queue first');
      return;
    }
    if (!store.current()) {
      playTrack(store.tracks[0].uid, true);
      return;
    }
    var state = player.state();
    if (state === STATE.PLAYING || state === STATE.BUFFERING) player.pause();
    else player.play();
  }

  function advance(direction, auto) {
    // Restart the track instead of stepping back when we're well into it.
    if (direction < 0 && player.currentTime() > 3) {
      player.seekTo(0);
      return;
    }

    var uid = direction > 0 ? store.nextUid(auto) : store.prevUid();
    if (!uid) {
      updatePlayButton(false);
      setStatus('End of queue');
      return;
    }
    if (auto && uid === store.currentUid) {
      player.seekTo(0);
      player.play();
      return;
    }
    playTrack(uid, true);
  }

  /* ---------- adding tracks ---------- */

  function bindAddForm() {
    el.addForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = el.addInput.value.trim();
      if (!value) return;

      el.addButton.disabled = true;
      handleAdd(value)
        .then(function (message) {
          el.addInput.value = '';
          setStatus(message);
        })
        .catch(function (err) {
          setStatus(err.message, true);
        })
        .then(function () {
          el.addButton.disabled = false;
        });
    });
  }

  function handleAdd(value) {
    var parsed = utils.parseInput(value);

    if (parsed && parsed.playlistId) return addPlaylist(parsed);
    if (parsed && parsed.videoId) return addVideo(parsed.videoId);
    if (/^https?:\/\//i.test(value) || value.indexOf('youtu') === 0) {
      return Promise.reject(new Error('That link does not contain a YouTube video or playlist id'));
    }
    return addBySearch(value);
  }

  function addVideo(videoId) {
    var existing = store.findByVideoId(videoId);
    if (existing) return Promise.resolve('Already in the queue: ' + existing.title);

    var track = store.add({ videoId: videoId, title: videoId });
    var wasEmpty = store.tracks.length === 1;

    return youtube.fetchOEmbed(videoId).then(function (meta) {
      store.update(track.uid, { title: meta.title, author: meta.author });
      if (wasEmpty && !store.currentUid) playTrack(track.uid, false);
      return 'Added ' + meta.title;
    });
  }

  function addPlaylist(parsed) {
    var apiKey = getApiKey();
    if (!apiKey) {
      if (parsed.videoId) {
        return addVideo(parsed.videoId).then(function (message) {
          return message + ' (add an API key in Settings to import the whole playlist)';
        });
      }
      return Promise.reject(new Error('Importing a playlist needs a YouTube Data API key — add one in Settings'));
    }

    return youtube.playlistItems(parsed.playlistId, apiKey).then(function (items) {
      if (!items.length) throw new Error('That playlist is empty or private');
      var added = store.addMany(items);
      hydrateDurations(added);
      if (!store.currentUid && store.tracks.length) playTrack(store.tracks[0].uid, false);
      return 'Imported ' + added.length + ' track' + (added.length === 1 ? '' : 's');
    });
  }

  function addBySearch(query) {
    var apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(new Error('Searching needs a YouTube Data API key — add one in Settings, or paste a video link'));
    }

    return youtube.search(query, apiKey, 1).then(function (results) {
      if (!results.length) throw new Error('No results for "' + query + '"');
      var existing = store.findByVideoId(results[0].videoId);
      if (existing) return 'Already in the queue: ' + existing.title;

      var track = store.add(results[0]);
      hydrateDurations([track]);
      if (!store.currentUid) playTrack(track.uid, false);
      return 'Added ' + track.title;
    });
  }

  /* Durations are cosmetic, so a failed lookup is not worth surfacing. */
  function hydrateDurations(tracks) {
    var apiKey = getApiKey();
    if (!apiKey || !tracks.length) return;

    youtube.videoDetails(tracks.map(function (t) { return t.videoId; }), apiKey)
      .then(function (details) {
        details.forEach(function (detail) {
          var match = store.findByVideoId(detail.videoId);
          if (match) store.update(match.uid, { duration: detail.duration, title: detail.title, author: detail.author });
        });
      })
      .catch(function () {});
  }

  /* ---------- controls ---------- */

  function bindControls() {
    el.play.addEventListener('click', togglePlay);
    el.next.addEventListener('click', function () { advance(1, false); });
    el.prev.addEventListener('click', function () { advance(-1, false); });

    el.shuffle.addEventListener('click', function () { store.setShuffle(!store.shuffle); });
    el.repeat.addEventListener('click', function () { store.cycleRepeat(); });

    el.mute.addEventListener('click', function () {
      store.setMuted(!store.muted);
      player.setMuted(store.muted);
    });

    el.volume.addEventListener('input', function () {
      store.setVolume(el.volume.value);
      player.setVolume(store.volume);
      if (store.muted && store.volume > 0) {
        store.setMuted(false);
        player.setMuted(false);
      }
    });

    el.seek.addEventListener('pointerdown', function () { seeking = true; });
    el.seek.addEventListener('input', function () {
      var duration = player.duration();
      el.timeCurrent.textContent = utils.formatTime(duration * (el.seek.value / 1000));
    });
    el.seek.addEventListener('change', function () {
      var duration = player.duration();
      seeking = false;
      if (duration) player.seekTo(duration * (el.seek.value / 1000));
    });

    el.videoToggle.addEventListener('click', function () {
      var visible = el.videoFrame.getAttribute('data-visible') !== 'true';
      el.videoFrame.setAttribute('data-visible', String(visible));
      el.videoToggle.setAttribute('aria-pressed', String(visible));
    });
  }

  function bindSettings() {
    el.apiKey.value = getApiKey();

    el.settingsToggle.addEventListener('click', function () {
      el.settingsPanel.hidden = !el.settingsPanel.hidden;
      if (!el.settingsPanel.hidden) el.apiKey.focus();
    });

    el.apiKeySave.addEventListener('click', function () {
      var key = el.apiKey.value.trim();
      try {
        if (key) global.localStorage.setItem(API_KEY_STORAGE, key);
        else global.localStorage.removeItem(API_KEY_STORAGE);
      } catch (err) {
        setStatus('This browser blocked local storage — the key will be forgotten on reload', true);
      }
      setStatus(key ? 'API key saved — search and playlist import are enabled' : 'API key cleared');
      el.settingsPanel.hidden = true;
    });

    el.apiKeyClear.addEventListener('click', function () {
      el.apiKey.value = '';
      try { global.localStorage.removeItem(API_KEY_STORAGE); } catch (err) {}
      setStatus('API key cleared');
    });
  }

  function getApiKey() {
    try {
      return global.localStorage.getItem(API_KEY_STORAGE) || '';
    } catch (err) {
      return '';
    }
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'l': advance(1, false); break;
        case 'k': advance(-1, false); break;
        case 's': store.setShuffle(!store.shuffle); break;
        case 'r': store.cycleRepeat(); break;
        case 'm':
          store.setMuted(!store.muted);
          player.setMuted(store.muted);
          break;
        case 'v': el.videoToggle.click(); break;
        case 'arrowright': player.seekTo(player.currentTime() + 5); break;
        case 'arrowleft': player.seekTo(Math.max(0, player.currentTime() - 5)); break;
        default: return;
      }
    });
  }

  /* ---------- queue ---------- */

  function bindQueue() {
    el.clearQueue.addEventListener('click', function () {
      if (!store.tracks.length) return;
      store.clear();
      player.stop();
      updatePlayButton(false);
      setStatus('Queue cleared');
    });
  }

  function render(state) {
    renderNowPlaying(state);
    renderQueue(state);

    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    el.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    el.repeat.textContent = state.repeat === 'one' ? 'Repeat 1' : 'Repeat';
    el.mute.setAttribute('aria-pressed', String(state.muted));
    el.mute.textContent = state.muted || state.volume === 0 ? '🔇' : '🔊';
    if (document.activeElement !== el.volume) el.volume.value = state.volume;
  }

  function renderNowPlaying(state) {
    var current = state.current();
    if (!current) {
      el.npTitle.textContent = state.tracks.length ? 'Ready when you are' : 'Nothing queued yet';
      el.npAuthor.textContent = state.tracks.length ? 'Press play to start the queue' : 'Add a track to get started';
      el.npArt.removeAttribute('src');
      el.timeTotal.textContent = '0:00';
      return;
    }
    el.npTitle.textContent = current.title;
    el.npAuthor.textContent = current.author || '';
    el.npArt.src = utils.thumbnailUrl(current.videoId);
    if (current.duration) el.timeTotal.textContent = utils.formatTime(current.duration);
  }

  function renderQueue(state) {
    el.queueList.textContent = '';
    el.queueCount.textContent = String(state.tracks.length);
    el.queueEmpty.hidden = state.tracks.length > 0;

    state.tracks.forEach(function (track) {
      el.queueList.appendChild(buildQueueItem(track, track.uid === state.currentUid));
    });
  }

  function buildQueueItem(track, isActive) {
    var node = el.queueItemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.uid = track.uid;
    node.dataset.active = String(isActive);

    var art = node.querySelector('.qi-art');
    art.src = utils.thumbnailUrl(track.videoId);
    art.alt = '';

    node.querySelector('.qi-title').textContent = track.title;
    node.querySelector('.qi-author').textContent = track.author || '';
    node.querySelector('.qi-duration').textContent = track.duration ? utils.formatTime(track.duration) : '';

    node.querySelector('.qi-main').addEventListener('click', function () {
      playTrack(track.uid, true);
    });

    node.querySelector('.qi-remove').addEventListener('click', function () {
      var wasCurrent = store.currentUid === track.uid;
      store.remove(track.uid);
      if (wasCurrent) {
        var next = store.current();
        if (next) playTrack(next.uid, player.state() === STATE.PLAYING);
        else { player.stop(); updatePlayButton(false); }
      }
    });

    addDragHandlers(node);
    return node;
  }

  function addDragHandlers(node) {
    node.addEventListener('dragstart', function (event) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', node.dataset.uid);
      node.classList.add('dragging');
    });

    node.addEventListener('dragend', function () {
      node.classList.remove('dragging');
    });

    node.addEventListener('dragover', function (event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-target');
    });

    node.addEventListener('dragleave', function () {
      node.classList.remove('drop-target');
    });

    node.addEventListener('drop', function (event) {
      event.preventDefault();
      node.classList.remove('drop-target');
      var uid = event.dataTransfer.getData('text/plain');
      if (uid && uid !== node.dataset.uid) store.move(uid, store.indexOf(node.dataset.uid));
    });
  }

  /* ---------- progress ---------- */

  function startTicker() {
    stopTicker();
    ticker = global.setInterval(updateProgress, 250);
    updateProgress();
  }

  function stopTicker() {
    if (ticker) global.clearInterval(ticker);
    ticker = null;
  }

  function updateProgress() {
    var duration = player.duration();
    var current = player.currentTime();

    el.timeTotal.textContent = utils.formatTime(duration);
    if (seeking) return;

    el.timeCurrent.textContent = utils.formatTime(current);
    el.seek.value = duration ? String(Math.round((current / duration) * 1000)) : '0';
  }

  function updatePlayButton(playing) {
    el.play.textContent = playing ? '⏸' : '▶';
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /* ---------- OS media keys ---------- */

  function updateMediaSession() {
    if (!('mediaSession' in global.navigator)) return;
    var current = store.current();
    if (!current) return;

    try {
      global.navigator.mediaSession.metadata = new global.MediaMetadata({
        title: current.title,
        artist: current.author || 'YouTube',
        album: 'PlayerYT',
        artwork: [{ src: utils.thumbnailUrl(current.videoId), sizes: '320x180', type: 'image/jpeg' }]
      });
      global.navigator.mediaSession.setActionHandler('play', function () { player.play(); });
      global.navigator.mediaSession.setActionHandler('pause', function () { player.pause(); });
      global.navigator.mediaSession.setActionHandler('nexttrack', function () { advance(1, false); });
      global.navigator.mediaSession.setActionHandler('previoustrack', function () { advance(-1, false); });
    } catch (err) {
      /* Media Session support varies; controls simply stay unavailable. */
    }
  }

  /* ---------- status line ---------- */

  function setStatus(message, isError) {
    el.status.textContent = message;
    el.status.classList.toggle('error', !!isError);
    if (statusTimer) global.clearTimeout(statusTimer);
    statusTimer = global.setTimeout(function () {
      el.status.textContent = store.tracks.length ? store.tracks.length + ' in queue' : 'Ready';
      el.status.classList.remove('error');
    }, 6000);
  }
})(window);
