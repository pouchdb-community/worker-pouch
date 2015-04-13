/*jshint expr:true */
'use strict';

var SocketPouch = require('../lib/client');

/*function WrappedSocketPouch(opts, callback) {
  var url = 'ws://localhost:8080';
  var name = opts.originalName;
  return new SocketPouch({url: url, name: name}, callback);
}

WrappedSocketPouch.valid = SocketPouch.valid;
WrappedSocketPouch.destroy = SocketPouch.destroy;

window.PouchDB.adapter('socket', WrappedSocketPouch);*/

window.PouchDB.adapter('socket', SocketPouch);
window.PouchDB.preferredAdapters = ['socket'];

window.PouchDB = window.PouchDB.defaults({
  url: 'ws://localhost:8080'
});