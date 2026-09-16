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
  var audio = null;
  var seeking = false;
  var ticker = null;
  var statusTimer = null;
  var wakeLock = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    bindControls();
    bindQueue();
    bindAddForm();
    bindSettings();
    bindKeyboard();
    bindWakeLock();

    store.subscribe(render);

    // A file track restored from a previous session needs its blob back.
    var restored = store.current();
    if (restored && isFileTrack(restored)) loadFileTrack(restored, false);

    player = new youtube.Player('yt-player', {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError
    });

    audio = new global.PYT.AudioEngine({
      onStateChange: onPlayerStateChange,
      onError: onAudioError,
      onDuration: onAudioDuration
    });
    audio.setVolume(store.volume);
    audio.setMuted(store.muted);

    player.ready.catch(function (err) {
      setStatus(err.message, true);
    });
  }

  /* Which engine owns playback right now: YouTube's iframe, or the audio element. */
  function engine(track) {
    var current = track || store.current();
    return current && current.kind === 'audio' ? audio : player;
  }

  function isFileTrack(track) {
    return !!track && track.kind === 'audio';
  }

  function cacheElements() {
    [
      'add-form', 'add-input', 'add-button', 'video-toggle', 'settings-toggle',
      'settings-panel', 'api-key', 'api-key-save', 'api-key-clear', 'video-frame',
      'now-playing', 'np-art', 'np-title', 'np-author', 'seek', 'time-current',
      'time-total', 'shuffle', 'prev', 'play', 'next', 'repeat', 'mute', 'volume',
      'queue-list', 'queue-count', 'queue-empty', 'clear-queue', 'status',
      'queue-item-template', 'awake-toggle', 'file-input', 'file-button', 'np-cover'
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
    if (current && !isFileTrack(current)) player.load(current.videoId, false);
    setStatus(store.tracks.length ? 'Queue restored — press play' : 'Ready');
  }

  function onPlayerStateChange(state, source) {
    if (source && source !== engine()) return;
    updatePlayButton(state === STATE.PLAYING || state === STATE.BUFFERING);

    if (state === STATE.PLAYING) {
      startTicker();
      captureLiveMetadata();
      updateMediaSession();
      holdScreenAwake();
    } else {
      stopTicker();
      updateProgress();
      if (state !== STATE.BUFFERING) releaseScreen();
    }

    if (state === STATE.ENDED) advance(1, true);
  }

  function onPlayerError(code) {
    var current = store.current();
    var name = current ? current.title : 'This track';
    setStatus(name + ' cannot be played here (error ' + code + ') — skipping', true);
    advance(1, true);
  }

  function onAudioError() {
    var current = store.current();
    if (!current || !isFileTrack(current)) return;
    setStatus('Could not play ' + current.title + ' — the file may have moved or be an unsupported format', true);
    advance(1, true);
  }

  function onAudioDuration(seconds) {
    var current = store.current();
    if (current && isFileTrack(current) && seconds) {
      store.update(current.uid, { duration: Math.round(seconds) });
    }
  }

  /* Once playback starts the player knows the real title; keep the queue honest. */
  function captureLiveMetadata() {
    var current = store.current();
    if (!current || isFileTrack(current)) return;
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

    // Silence whichever engine is not about to play.
    (isFileTrack(track) ? player : audio).pause();
    store.setCurrent(uid);

    if (!isFileTrack(track)) {
      player.load(track.videoId, autoplay !== false);
      updateMediaSession();
      return;
    }

    loadFileTrack(track, autoplay !== false);
  }

  /* Local files live in IndexedDB; remote ones are just a URL. */
  function loadFileTrack(track, autoplay) {
    if (track.src.indexOf('idb:') !== 0) {
      audio.load(track.src, autoplay);
      updateMediaSession();
      return;
    }

    global.PYT.library.get(track.src.slice(4))
      .then(function (blob) {
        if (!blob) throw new Error('missing');
        if (store.currentUid !== track.uid) return;
        audio.load(blob, autoplay);
        updateMediaSession();
      })
      .catch(function () {
        setStatus(track.title + ' is no longer stored on this device — removing it', true);
        store.remove(track.uid);
      });
  }

  function togglePlay() {
    if (!store.tracks.length) {
      setStatus('Add something to the queue first');
      return;
    }
    var current = store.current();
    if (!current) {
      playTrack(store.tracks[0].uid, true);
      return;
    }
    if (isFileTrack(current) && !audio.element.currentSrc && !audio.element.src) {
      loadFileTrack(current, true);
      return;
    }
    var active = engine();
    var state = active.state();
    if (state === STATE.PLAYING || state === STATE.BUFFERING) active.pause();
    else active.play();
  }

  function advance(direction, auto) {
    // Restart the track instead of stepping back when we're well into it.
    if (direction < 0 && engine().currentTime() > 3) {
      engine().seekTo(0);
      return;
    }

    var uid = direction > 0 ? store.nextUid(auto) : store.prevUid();
    if (!uid) {
      updatePlayButton(false);
      setStatus('End of queue');
      return;
    }
    if (auto && uid === store.currentUid) {
      engine().seekTo(0);
      engine().play();
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
    var input = utils.classifyInput(value);

    if (input.kind === 'youtube') {
      if (input.youtube.playlistId) return addPlaylist(input.youtube);
      return addVideo(input.youtube.videoId);
    }
    if (input.kind === 'audio') return addAudioUrl(input.src);
    if (input.kind === 'unknown-link') {
      return Promise.reject(new Error('That link is neither a YouTube video nor an audio file'));
    }
    return addBySearch(input.query);
  }

  /* A direct link to an audio file: plays through the audio element. */
  function addAudioUrl(src) {
    var existing = store.findBySrc(src);
    if (existing) return Promise.resolve('Already in the queue: ' + existing.title);

    var name = src.split('/').pop().split('?')[0];
    var track = store.add({
      kind: 'audio',
      src: src,
      title: utils.titleFromName(decodeURIComponent(name)),
      author: 'Audio file'
    });

    if (!store.currentUid) playTrack(track.uid, false);
    return Promise.resolve('Added ' + track.title + ' — plays with the screen locked');
  }

  /* Files picked from the device, stored so the queue survives a reload. */
  function addFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (file) {
      return /^audio\//.test(file.type) || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(file.name);
    });

    if (!list.length) {
      setStatus('Those files are not audio the browser can play', true);
      return;
    }

    setStatus('Storing ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '…');

    Promise.all(list.map(function (file) {
      return global.PYT.library.put(file).then(function (key) {
        return store.add({
          kind: 'audio',
          src: 'idb:' + key,
          title: utils.titleFromName(file.name),
          author: 'On this device'
        });
      });
    }))
      .then(function (added) {
        if (!store.currentUid && added.length) playTrack(added[0].uid, false);
        setStatus('Added ' + added.length + ' file' + (added.length === 1 ? '' : 's') +
          ' — these keep playing with the screen locked');
      })
      .catch(function (err) {
        setStatus(err.message || 'Could not store those files', true);
      });
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
      applyMuted();
    });

    el.volume.addEventListener('input', function () {
      store.setVolume(el.volume.value);
      player.setVolume(store.volume);
      audio.setVolume(store.volume);
      if (store.muted && store.volume > 0) {
        store.setMuted(false);
        applyMuted();
      }
    });

    el.seek.addEventListener('pointerdown', function () { seeking = true; });
    el.seek.addEventListener('input', function () {
      var duration = engine().duration();
      el.timeCurrent.textContent = utils.formatTime(duration * (el.seek.value / 1000));
    });
    el.seek.addEventListener('change', function () {
      var duration = engine().duration();
      seeking = false;
      if (duration) engine().seekTo(duration * (el.seek.value / 1000));
    });

    el.awakeToggle.addEventListener('click', function () {
      store.setKeepAwake(!store.keepAwake);
      if (store.keepAwake) {
        holdScreenAwake();
        setStatus('The screen will stay on while a track plays');
      } else {
        releaseScreen();
        setStatus('The screen can lock normally again');
      }
    });

    el.fileButton.addEventListener('click', function () { el.fileInput.click(); });

    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });

    el.videoToggle.addEventListener('click', function () {
      var visible = el.videoFrame.getAttribute('data-visible') !== 'true';
      el.videoFrame.setAttribute('data-visible', String(visible));
      el.videoToggle.setAttribute('aria-pressed', String(visible));
    });
  }

  function applyMuted() {
    player.setMuted(store.muted);
    audio.setMuted(store.muted);
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
          applyMuted();
          break;
        case 'v': el.videoToggle.click(); break;
        case 'w': el.awakeToggle.click(); break;
        case 'arrowright': engine().seekTo(engine().currentTime() + 5); break;
        case 'arrowleft': engine().seekTo(Math.max(0, engine().currentTime() - 5)); break;
        default: return;
      }
    });
  }

  /* ---------- queue ---------- */

  function bindQueue() {
    el.clearQueue.addEventListener('click', function () {
      if (!store.tracks.length) return;
      store.tracks.forEach(forgetFile);
      store.clear();
      player.stop();
      audio.stop();
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
    el.awakeToggle.setAttribute('aria-pressed', String(state.keepAwake));
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
      el.npCover.setAttribute('data-kind', 'youtube');
      el.timeTotal.textContent = '0:00';
      return;
    }
    el.npTitle.textContent = current.title;
    el.npAuthor.textContent = current.author || '';
    el.npCover.setAttribute('data-kind', current.kind);
    if (isFileTrack(current)) el.npArt.removeAttribute('src');
    else el.npArt.src = utils.thumbnailUrl(current.videoId);
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

    node.querySelector('.qi-cover').setAttribute('data-kind', track.kind);
    if (!isFileTrack(track)) node.querySelector('.qi-art').src = utils.thumbnailUrl(track.videoId);

    node.querySelector('.qi-title').textContent = track.title;
    node.querySelector('.qi-author').textContent = track.author || '';
    node.querySelector('.qi-duration').textContent = track.duration ? utils.formatTime(track.duration) : '';

    node.querySelector('.qi-main').addEventListener('click', function () {
      playTrack(track.uid, true);
    });

    node.querySelector('.qi-remove').addEventListener('click', function () {
      var wasCurrent = store.currentUid === track.uid;
      var wasPlaying = engine(track).state() === STATE.PLAYING;
      forgetFile(track);
      store.remove(track.uid);
      if (wasCurrent) {
        var next = store.current();
        if (next) playTrack(next.uid, wasPlaying);
        else { player.stop(); audio.stop(); updatePlayButton(false); }
      }
    });

    addDragHandlers(node);
    return node;
  }

  /* Dropping a queued file also drops the blob backing it. */
  function forgetFile(track) {
    if (isFileTrack(track) && track.src.indexOf('idb:') === 0) {
      global.PYT.library.remove(track.src.slice(4));
    }
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
    var active = engine();
    var duration = active.duration();
    var current = active.currentTime();

    el.timeTotal.textContent = utils.formatTime(duration);
    if (seeking) return;

    el.timeCurrent.textContent = utils.formatTime(current);
    el.seek.value = duration ? String(Math.round((current / duration) * 1000)) : '0';
    updatePositionState(current, duration);
  }

  /* Feeds the lock-screen scrubber where the platform shows one. */
  function updatePositionState(current, duration) {
    if (!('mediaSession' in global.navigator) || !global.navigator.mediaSession.setPositionState) return;
    if (!duration || current > duration) return;

    try {
      global.navigator.mediaSession.setPositionState({
        duration: duration,
        position: current,
        playbackRate: 1
      });
    } catch (err) {
      /* Position state is advisory; ignore rejections. */
    }
  }

  function updatePlayButton(playing) {
    el.play.textContent = playing ? '⏸' : '▶';
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /* ---------- keeping the screen alive ---------- */

  /*
   * A locked screen suspends the embedded player, and nothing in a web page
   * can resume it — background playback is YouTube's own paid feature. What a
   * page may do is ask the OS not to dim and lock while a track is playing,
   * which covers the usual case of the phone idling on a desk mid-album.
   */
  function holdScreenAwake() {
    if (!store.keepAwake || wakeLock || !('wakeLock' in global.navigator)) return;
    // File tracks survive a locked screen on their own; no need to burn battery.
    if (isFileTrack(store.current())) return;

    global.navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {
      /* Denied on a hidden page or an unsupported browser; playback is fine. */
    });
  }

  function releaseScreen() {
    if (!wakeLock) return;
    var lock = wakeLock;
    wakeLock = null;
    lock.release().catch(function () {});
  }

  /* A wake lock is dropped whenever the tab hides, so take it again on return. */
  function bindWakeLock() {
    if (!('wakeLock' in global.navigator)) return;
    el.awakeToggle.hidden = false;

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (engine().state() === STATE.PLAYING) holdScreenAwake();
    });
  }

  /* ---------- OS media keys ---------- */

  function updateMediaSession() {
    if (!('mediaSession' in global.navigator)) return;
    var current = store.current();
    if (!current) return;

    try {
      global.navigator.mediaSession.metadata = new global.MediaMetadata({
        title: current.title,
        artist: current.author || (isFileTrack(current) ? 'Audio file' : 'YouTube'),
        album: 'PlayerYT',
        artwork: isFileTrack(current)
          ? []
          : [{ src: utils.thumbnailUrl(current.videoId), sizes: '320x180', type: 'image/jpeg' }]
      });
      global.navigator.mediaSession.setActionHandler('play', function () { engine().play(); });
      global.navigator.mediaSession.setActionHandler('pause', function () { engine().pause(); });
      global.navigator.mediaSession.setActionHandler('nexttrack', function () { advance(1, false); });
      global.navigator.mediaSession.setActionHandler('previoustrack', function () { advance(-1, false); });
      global.navigator.mediaSession.setActionHandler('seekto', function (details) {
        if (details && typeof details.seekTime === 'number') engine().seekTo(details.seekTime);
      });
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
