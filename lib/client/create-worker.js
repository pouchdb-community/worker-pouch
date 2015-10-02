'use strict';
/* global webkitURL */

module.exports = function createWorker(b64) {
  var createBlob = require('../shared/utils').createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([atob(b64)], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};