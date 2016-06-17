'use strict';

/* jshint worker:true */

// This file gets workerified. It's the main worker script used in blob URLs.
var registerWorkerPouch = require('./core');
var PouchDB = require('./pouchdb-idb-only');
registerWorkerPouch(self, PouchDB);