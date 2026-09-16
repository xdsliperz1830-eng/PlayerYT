/*
 * Playback for local files and direct audio URLs.
 *
 * This is deliberately an <audio> element rather than anything fancier: audio
 * elements are the one media surface a mobile browser keeps running when the
 * screen locks, which is the whole reason this source type exists.
 */
(function (global) {
  'use strict';

  var STATE = global.PYT.youtube.STATE;

  function AudioEngine(handlers) {
    var self = this;
    this._handlers = handlers || {};
    this._objectUrl = null;

    var element = new global.Audio();
    element.preload = 'auto';
    // No crossOrigin: this element never feeds a canvas or analyser, and asking
    // for CORS makes plain audio URLs fail on hosts that send no CORS headers.
    // In the document rather than detached: browsers treat an attached element
    // as page media, which is what keeps it alive behind a locked screen.
    element.setAttribute('data-role', 'file-player');
    document.body.appendChild(element);
    this.element = element;

    element.addEventListener('playing', function () { self._emit(STATE.PLAYING); });
    element.addEventListener('play', function () { self._emit(STATE.PLAYING); });
    element.addEventListener('pause', function () {
      if (!element.ended) self._emit(STATE.PAUSED);
    });
    element.addEventListener('waiting', function () { self._emit(STATE.BUFFERING); });
    element.addEventListener('ended', function () { self._emit(STATE.ENDED); });
    element.addEventListener('loadedmetadata', function () {
      if (self._handlers.onDuration) self._handlers.onDuration(element.duration || 0);
    });
    element.addEventListener('error', function () {
      if (self._handlers.onError) self._handlers.onError(mediaErrorCode(element), self);
    });

    this.ready = Promise.resolve(this);
  }

  function mediaErrorCode(element) {
    return element.error ? element.error.code : 0;
  }

  AudioEngine.prototype._emit = function (state) {
    if (this._handlers.onStateChange) this._handlers.onStateChange(state, this);
  };

  /**
   * `source` is either a URL or a Blob. Blobs get an object URL that is
   * revoked when the next track loads, so nothing leaks across a long queue.
   */
  AudioEngine.prototype.load = function (source, autoplay) {
    this._revoke();

    if (typeof source === 'string') {
      this.element.src = source;
    } else {
      this._objectUrl = global.URL.createObjectURL(source);
      this.element.src = this._objectUrl;
    }

    this.element.load();
    if (autoplay) this.play();
  };

  AudioEngine.prototype._revoke = function () {
    if (!this._objectUrl) return;
    global.URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
  };

  AudioEngine.prototype.play = function () {
    var self = this;
    var attempt = this.element.play();
    if (attempt && attempt.catch) {
      attempt.catch(function () {
        // Autoplay refused: report a pause so the button matches reality.
        self._emit(STATE.PAUSED);
      });
    }
  };

  AudioEngine.prototype.pause = function () { this.element.pause(); };

  AudioEngine.prototype.stop = function () {
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this._revoke();
  };

  AudioEngine.prototype.seekTo = function (seconds) {
    if (isFinite(this.element.duration)) this.element.currentTime = seconds;
  };

  AudioEngine.prototype.setVolume = function (value) {
    this.element.volume = Math.max(0, Math.min(1, value / 100));
  };

  AudioEngine.prototype.setMuted = function (muted) { this.element.muted = !!muted; };

  AudioEngine.prototype.currentTime = function () { return this.element.currentTime || 0; };

  AudioEngine.prototype.duration = function () {
    return isFinite(this.element.duration) ? this.element.duration : 0;
  };

  AudioEngine.prototype.state = function () {
    if (this.element.ended) return STATE.ENDED;
    if (!this.element.src) return STATE.UNSTARTED;
    if (this.element.paused) return STATE.PAUSED;
    return this.element.readyState < 3 ? STATE.BUFFERING : STATE.PLAYING;
  };

  AudioEngine.prototype.videoData = function () { return null; };

  global.PYT.AudioEngine = AudioEngine;
})(window);
