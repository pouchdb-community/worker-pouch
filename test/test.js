/*jshint expr:true */
'use strict';

var WorkerPouch = require('../lib/client');

window.PouchDB = require('pouchdb-browser');

window.PouchDB.adapter('worker', WorkerPouch);
window.PouchDB.preferredAdapters = ['worker'];

window.workerPouch = WorkerPouch;
