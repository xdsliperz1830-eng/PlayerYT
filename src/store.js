/* Queue state: tracks, order, playback preferences, and persistence. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'playeryt.state.v1';
  var REPEAT_MODES = ['off', 'all', 'one'];

  function Store() {
    this.tracks = [];
    this.currentUid = null;
    this.shuffle = false;
    this.repeat = 'off';
    this.volume = 80;
    this.muted = false;
    this.keepAwake = true;
    this._shuffleOrder = [];
    this._listeners = [];
    this._load();
  }

  Store.prototype.subscribe = function (listener) {
    this._listeners.push(listener);
    listener(this);
  };

  Store.prototype._emit = function () {
    this._save();
    for (var i = 0; i < this._listeners.length; i++) this._listeners[i](this);
  };

  /* ---------- queue mutation ---------- */

  /**
   * Add a track. Returns the stored track, or the existing one when the same
   * video is already queued (duplicates only clutter a music queue).
   */
  Store.prototype.add = function (track) {
    var existing = this.findByVideoId(track.videoId);
    if (existing) return existing;

    var entry = {
      uid: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      videoId: track.videoId,
      title: track.title || track.videoId,
      author: track.author || '',
      duration: track.duration || 0
    };
    this.tracks.push(entry);
    this._reshuffle();
    this._emit();
    return entry;
  };

  Store.prototype.addMany = function (list) {
    var added = [];
    for (var i = 0; i < list.length; i++) {
      if (this.findByVideoId(list[i].videoId)) continue;
      added.push(this.add(list[i]));
    }
    return added;
  };

  Store.prototype.remove = function (uid) {
    var index = this.indexOf(uid);
    if (index < 0) return;
    this.tracks.splice(index, 1);
    if (this.currentUid === uid) {
      var fallback = this.tracks[index] || this.tracks[index - 1] || null;
      this.currentUid = fallback ? fallback.uid : null;
    }
    this._reshuffle();
    this._emit();
  };

  Store.prototype.clear = function () {
    this.tracks = [];
    this.currentUid = null;
    this._shuffleOrder = [];
    this._emit();
  };

  /** Move a track to a new position (used by drag-and-drop reordering). */
  Store.prototype.move = function (uid, toIndex) {
    var from = this.indexOf(uid);
    if (from < 0) return;
    var target = Math.max(0, Math.min(this.tracks.length - 1, toIndex));
    if (from === target) return;
    var moved = this.tracks.splice(from, 1)[0];
    this.tracks.splice(target, 0, moved);
    this._emit();
  };

  Store.prototype.update = function (uid, patch) {
    var track = this.get(uid);
    if (!track) return;
    var changed = false;
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && track[key] !== patch[key]) {
        track[key] = patch[key];
        changed = true;
      }
    }
    if (changed) this._emit();
  };

  /* ---------- lookups ---------- */

  Store.prototype.get = function (uid) {
    for (var i = 0; i < this.tracks.length; i++) {
      if (this.tracks[i].uid === uid) return this.tracks[i];
    }
    return null;
  };

  Store.prototype.indexOf = function (uid) {
    for (var i = 0; i < this.tracks.length; i++) {
      if (this.tracks[i].uid === uid) return i;
    }
    return -1;
  };

  Store.prototype.findByVideoId = function (videoId) {
    for (var i = 0; i < this.tracks.length; i++) {
      if (this.tracks[i].videoId === videoId) return this.tracks[i];
    }
    return null;
  };

  Store.prototype.current = function () {
    return this.currentUid ? this.get(this.currentUid) : null;
  };

  /* ---------- playback order ---------- */

  Store.prototype.setCurrent = function (uid) {
    if (this.currentUid === uid) return;
    this.currentUid = uid;
    this._emit();
  };

  /**
   * The uid that follows the current one.
   * `auto` marks an advance caused by a track ending rather than a click, so
   * repeat-one only applies then; pressing next always moves on.
   */
  Store.prototype.nextUid = function (auto) {
    if (!this.tracks.length) return null;
    if (auto && this.repeat === 'one' && this.currentUid) return this.currentUid;
    return this._step(1);
  };

  Store.prototype.prevUid = function () {
    if (!this.tracks.length) return null;
    return this._step(-1);
  };

  Store.prototype._step = function (delta) {
    var order = this._order();
    if (!order.length) return null;

    var position = order.indexOf(this.currentUid);
    if (position < 0) return order[delta > 0 ? 0 : order.length - 1];

    var next = position + delta;
    if (next >= order.length) return this.repeat === 'all' ? order[0] : null;
    if (next < 0) return order[order.length - 1];
    return order[next];
  };

  Store.prototype._order = function () {
    if (!this.shuffle) return this.tracks.map(uidOf);
    var live = {};
    this.tracks.forEach(function (track) { live[track.uid] = true; });
    var order = this._shuffleOrder.filter(function (uid) { return live[uid]; });
    // Tracks added since the last shuffle land at the end of the rotation.
    this.tracks.forEach(function (track) {
      if (order.indexOf(track.uid) < 0) order.push(track.uid);
    });
    this._shuffleOrder = order;
    return order;
  };

  Store.prototype.setShuffle = function (on) {
    this.shuffle = !!on;
    if (this.shuffle) this._reshuffle();
    this._emit();
  };

  Store.prototype.cycleRepeat = function () {
    var index = REPEAT_MODES.indexOf(this.repeat);
    this.repeat = REPEAT_MODES[(index + 1) % REPEAT_MODES.length];
    this._emit();
  };

  Store.prototype.setVolume = function (value) {
    this.volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    this._emit();
  };

  Store.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    this._emit();
  };

  Store.prototype.setKeepAwake = function (on) {
    this.keepAwake = !!on;
    this._emit();
  };

  /** Fisher-Yates over the current uids, keeping the playing track first. */
  Store.prototype._reshuffle = function () {
    if (!this.shuffle) { this._shuffleOrder = []; return; }
    var uids = this.tracks.map(uidOf);
    for (var i = uids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = uids[i];
      uids[i] = uids[j];
      uids[j] = tmp;
    }
    if (this.currentUid) {
      var at = uids.indexOf(this.currentUid);
      if (at > 0) uids.splice(0, 0, uids.splice(at, 1)[0]);
    }
    this._shuffleOrder = uids;
  };

  function uidOf(track) { return track.uid; }

  /* ---------- persistence ---------- */

  Store.prototype._save = function () {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tracks: this.tracks,
        currentUid: this.currentUid,
        shuffle: this.shuffle,
        repeat: this.repeat,
        volume: this.volume,
        muted: this.muted,
        keepAwake: this.keepAwake
      }));
    } catch (err) {
      /* Storage can be full or blocked; the queue still works in memory. */
    }
  };

  Store.prototype._load = function () {
    var saved;
    try {
      saved = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      saved = null;
    }
    if (!saved || !Array.isArray(saved.tracks)) return;

    this.tracks = saved.tracks.filter(function (track) {
      return track && typeof track.videoId === 'string' && typeof track.uid === 'string';
    });
    this.currentUid = this.get(saved.currentUid) ? saved.currentUid : null;
    this.shuffle = !!saved.shuffle;
    this.repeat = REPEAT_MODES.indexOf(saved.repeat) >= 0 ? saved.repeat : 'off';
    this.volume = typeof saved.volume === 'number' ? saved.volume : 80;
    this.muted = !!saved.muted;
    this.keepAwake = saved.keepAwake !== false;
    if (this.shuffle) this._reshuffle();
  };

  global.PYT = global.PYT || {};
  global.PYT.Store = Store;
})(window);
