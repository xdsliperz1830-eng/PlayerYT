/* Local audio files, kept as blobs in IndexedDB so a queue survives a reload. */
(function (global) {
  'use strict';

  var DB_NAME = 'playeryt';
  var DB_VERSION = 1;
  var STORE = 'files';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('This browser cannot store local files'));
        return;
      }

      var request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB unavailable')); };
    });

    return dbPromise;
  }

  function transact(mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var request = work(tx.objectStore(STORE));
        tx.onabort = function () { reject(tx.error || new Error('Storage transaction failed')); };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  /** Store a File and return the key a queue entry refers to it by. */
  function put(file) {
    var key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return transact('readwrite', function (store) {
      return store.put(file, key);
    }).then(function () { return key; });
  }

  function get(key) {
    return transact('readonly', function (store) { return store.get(key); });
  }

  function remove(key) {
    return transact('readwrite', function (store) { return store.delete(key); })
      .catch(function () { /* a missing file is already gone */ });
  }

  global.PYT = global.PYT || {};
  global.PYT.library = { put: put, get: get, remove: remove };
})(window);
