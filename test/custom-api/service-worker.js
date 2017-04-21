'use strict';

var registerWorkerPouch = require('../../worker');
// using in-memory so it will work in PhantomJS
var PouchDB = require('pouchdb-memory');
var pouchCreator = function (opts) {
  opts.adapter = 'memory';
  return new PouchDB(opts);
};
registerWorkerPouch(self, pouchCreator);

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim()); // activate right now
});

