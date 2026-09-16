/* YouTube IFrame player wrapper plus the metadata lookups the queue needs. */
(function (global) {
  'use strict';

  var IFRAME_API = 'https://www.youtube.com/iframe_api';
  var apiPromise = null;

  /** Load the IFrame API once and resolve with the global `YT` namespace. */
  function loadIframeApi() {
    if (apiPromise) return apiPromise;

    apiPromise = new Promise(function (resolve, reject) {
      if (global.YT && global.YT.Player) return resolve(global.YT);

      var previous = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = function () {
        if (typeof previous === 'function') previous();
        resolve(global.YT);
      };

      var script = document.createElement('script');
      script.src = IFRAME_API;
      script.async = true;
      script.onerror = function () {
        reject(new Error('Could not load the YouTube player. Check your connection.'));
      };
      document.head.appendChild(script);
    });

    return apiPromise;
  }

  /**
   * Thin wrapper around YT.Player so the rest of the app never has to worry
   * about whether the player has finished booting.
   */
  function Player(elementId, handlers) {
    var self = this;
    this._player = null;
    this._pending = null;
    this._handlers = handlers || {};

    this.ready = loadIframeApi().then(function () {
      return new Promise(function (resolve) {
        self._player = new global.YT.Player(elementId, {
          host: 'https://www.youtube-nocookie.com',
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            playsinline: 1,
            rel: 0
          },
          events: {
            onReady: function () {
              resolve(self);
              if (self._pending) {
                var pending = self._pending;
                self._pending = null;
                self.load(pending.videoId, pending.autoplay);
              }
              if (self._handlers.onReady) self._handlers.onReady(self);
            },
            onStateChange: function (event) {
              if (self._handlers.onStateChange) self._handlers.onStateChange(event.data, self);
            },
            onError: function (event) {
              if (self._handlers.onError) self._handlers.onError(event.data, self);
            }
          }
        });
      });
    });
  }

  Player.prototype.load = function (videoId, autoplay) {
    if (!this._player || !this._player.loadVideoById) {
      this._pending = { videoId: videoId, autoplay: autoplay };
      return;
    }
    if (autoplay) this._player.loadVideoById(videoId);
    else this._player.cueVideoById(videoId);
  };

  Player.prototype.play = function () { if (this._player && this._player.playVideo) this._player.playVideo(); };
  Player.prototype.pause = function () { if (this._player && this._player.pauseVideo) this._player.pauseVideo(); };
  Player.prototype.stop = function () { if (this._player && this._player.stopVideo) this._player.stopVideo(); };

  Player.prototype.seekTo = function (seconds) {
    if (this._player && this._player.seekTo) this._player.seekTo(seconds, true);
  };

  Player.prototype.setVolume = function (value) {
    if (this._player && this._player.setVolume) this._player.setVolume(value);
  };

  Player.prototype.setMuted = function (muted) {
    if (!this._player || !this._player.mute) return;
    if (muted) this._player.mute();
    else this._player.unMute();
  };

  Player.prototype.currentTime = function () {
    return this._player && this._player.getCurrentTime ? this._player.getCurrentTime() || 0 : 0;
  };

  Player.prototype.duration = function () {
    return this._player && this._player.getDuration ? this._player.getDuration() || 0 : 0;
  };

  Player.prototype.state = function () {
    return this._player && this._player.getPlayerState ? this._player.getPlayerState() : -1;
  };

  Player.prototype.videoData = function () {
    if (!this._player || !this._player.getVideoData) return null;
    try {
      return this._player.getVideoData() || null;
    } catch (err) {
      return null;
    }
  };

  /* ---------- metadata ---------- */

  /** Title and channel for a single video — no API key required. */
  function fetchOEmbed(videoId) {
    var url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    return fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error('oEmbed lookup failed');
        return response.json();
      })
      .then(function (data) {
        return { title: data.title || videoId, author: data.author_name || '' };
      })
      .catch(function () {
        return { title: videoId, author: '' };
      });
  }

  function apiRequest(path, params, apiKey) {
    var url = new URL('https://www.googleapis.com/youtube/v3/' + path);
    Object.keys(params).forEach(function (key) { url.searchParams.set(key, params[key]); });
    url.searchParams.set('key', apiKey);

    return fetch(url.toString()).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          var reason = body && body.error && body.error.message ? body.error.message : 'request failed';
          throw new Error('YouTube API: ' + reason);
        }
        return body;
      });
    });
  }

  /** Keyword search. Requires a YouTube Data API key. */
  function search(query, apiKey, limit) {
    return apiRequest('search', {
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: String(limit || 10),
      q: query
    }, apiKey).then(function (body) {
      return (body.items || [])
        .filter(function (item) { return item.id && item.id.videoId; })
        .map(function (item) {
          return {
            videoId: item.id.videoId,
            title: decodeEntities(item.snippet.title),
            author: decodeEntities(item.snippet.channelTitle || '')
          };
        });
    });
  }

  /** Import the first page (up to 50 tracks) of a public playlist. */
  function playlistItems(playlistId, apiKey) {
    return apiRequest('playlistItems', {
      part: 'snippet,contentDetails',
      maxResults: '50',
      playlistId: playlistId
    }, apiKey).then(function (body) {
      return (body.items || [])
        .filter(function (item) {
          return item.contentDetails && item.contentDetails.videoId &&
            item.snippet.title !== 'Private video' && item.snippet.title !== 'Deleted video';
        })
        .map(function (item) {
          return {
            videoId: item.contentDetails.videoId,
            title: decodeEntities(item.snippet.title),
            author: decodeEntities((item.snippet.videoOwnerChannelTitle) || '')
          };
        });
    });
  }

  /** Durations (and titles) for up to 50 ids in one call. */
  function videoDetails(videoIds, apiKey) {
    if (!videoIds.length) return Promise.resolve([]);
    return apiRequest('videos', {
      part: 'snippet,contentDetails',
      id: videoIds.slice(0, 50).join(',')
    }, apiKey).then(function (body) {
      return (body.items || []).map(function (item) {
        return {
          videoId: item.id,
          title: decodeEntities(item.snippet.title),
          author: decodeEntities(item.snippet.channelTitle || ''),
          duration: global.PYT.utils.parseIsoDuration(item.contentDetails.duration)
        };
      });
    });
  }

  /* The API returns HTML-escaped titles ("Tom &amp; Jerry"). */
  function decodeEntities(text) {
    var element = document.createElement('textarea');
    element.innerHTML = String(text || '');
    return element.value;
  }

  global.PYT = global.PYT || {};
  global.PYT.youtube = {
    Player: Player,
    fetchOEmbed: fetchOEmbed,
    search: search,
    playlistItems: playlistItems,
    videoDetails: videoDetails,
    STATE: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }
  };
})(window);
