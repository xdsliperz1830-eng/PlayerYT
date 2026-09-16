/* Small helpers shared across the app. Attached to window.PYT. */
(function (global) {
  'use strict';

  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  var PLAYLIST_ID = /^[A-Za-z0-9_-]{12,42}$/;

  /**
   * Pull a video id and/or playlist id out of anything a user is likely to
   * paste: a watch URL, a youtu.be share link, a /shorts or /embed path, a
   * bare 11-character id, or a link that only carries a playlist.
   * Returns null when the input carries neither id.
   */
  function parseInput(raw) {
    var text = String(raw || '').trim();
    if (!text) return null;

    if (VIDEO_ID.test(text)) return { videoId: text, playlistId: null };

    var url = toUrl(text);
    if (!url) return null;

    var host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    var isYouTube =
      host === 'youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'youtu.be';
    if (!isYouTube) return null;

    var videoId = null;
    var segments = url.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be') {
      videoId = segments[0] || null;
    } else if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') {
      videoId = segments[1] || null;
    } else {
      videoId = url.searchParams.get('v');
    }

    if (videoId && !VIDEO_ID.test(videoId)) videoId = null;

    var playlistId = url.searchParams.get('list');
    if (playlistId && !PLAYLIST_ID.test(playlistId)) playlistId = null;

    if (!videoId && !playlistId) return null;
    return { videoId: videoId, playlistId: playlistId };
  }

  function toUrl(text) {
    try {
      return new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text);
    } catch (err) {
      return null;
    }
  }

  /** Seconds -> "m:ss" (or "h:mm:ss" past an hour). */
  function formatTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(secs);
    return minutes + ':' + pad(secs);
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /** ISO 8601 duration ("PT3M14S") -> seconds. */
  function parseIsoDuration(value) {
    var match = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(value || ''));
    if (!match) return 0;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  var AUDIO_EXTENSION = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|webm)(\?|#|$)/i;

  /**
   * Work out what the add box was given: a YouTube link or id, a playable
   * audio URL, or plain words to search for.
   */
  function classifyInput(raw) {
    var text = String(raw || '').trim();
    if (!text) return { kind: 'empty' };

    var youtube = parseInput(text);
    if (youtube) return { kind: 'youtube', youtube: youtube };

    if (/^https?:\/\//i.test(text)) {
      var url = toUrl(text);
      if (url && AUDIO_EXTENSION.test(url.pathname)) return { kind: 'audio', src: url.href };
      return { kind: 'unknown-link', src: text };
    }

    return { kind: 'search', query: text };
  }

  /** "01 - Rhodes Groove.mp3" -> "01 - Rhodes Groove" */
  function titleFromName(name) {
    return String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'Untitled';
  }

  function thumbnailUrl(videoId) {
    return 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg';
  }

  global.PYT = global.PYT || {};
  global.PYT.utils = {
    parseInput: parseInput,
    classifyInput: classifyInput,
    titleFromName: titleFromName,
    formatTime: formatTime,
    parseIsoDuration: parseIsoDuration,
    thumbnailUrl: thumbnailUrl,
    VIDEO_ID: VIDEO_ID
  };
})(window);
