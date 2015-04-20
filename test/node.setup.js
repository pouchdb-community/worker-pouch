/*jshint expr:true */
'use strict';

var SocketPouch = require('../lib/client');

global.PouchDB = require('pouchdb');
global.testUtils = require('../node_modules/pouchdb/tests/integration/utils');
global.should = require('chai').should();

global.PouchDB.adapter('socket', SocketPouch);
global.PouchDB.preferredAdapters = ['socket'];

global.PouchDB = global.PouchDB.defaults({
  url: 'ws://localhost:8080'
});