'use strict';

/* jshint worker:true */

var registerWorkerPouch = require('../../worker');
var PouchDB = require('pouchdb');
// using in-memory so it will work in PhantomJS
require('pouchdb/extras/memory');
var pouchCreator = function (opts) {
  opts.adapter = 'memory';
  return new PouchDB(opts);
};
registerWorkerPouch(self, pouchCreator);