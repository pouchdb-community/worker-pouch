'use strict';

var Promise = require('pouchdb/extras/promise');
var createWorker = require('./create-worker');

module.exports = function isSupportedBrowser() {
  return Promise.resolve().then(function () {
    // synchronously throws in IE/Edge
    var worker = createWorker('' +
      'self.onmessage = function () {' +
      '  self.postMessage({' +
      '    hasIndexedDB: (typeof indexedDB !== "undefined")' +
      '  });' +
      '};');

    return new Promise(function (resolve, reject) {

      function listener(e) {
        cleanup();
        if (e.data.hasIndexedDB) {
          resolve();
          return;
        }
        reject();
      }

      function errorListener() {
        cleanup();
        reject();
      }

      function cleanup() {
        worker.removeEventListener('error', errorListener);
        worker.removeEventListener('message', listener);
      }

      worker.addEventListener('error', errorListener);
      worker.addEventListener('message', listener);
      worker.postMessage({});
    });
  }).then(function () {
    return true;
  }, function (err) {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err);
    }
    return false;
  });
};