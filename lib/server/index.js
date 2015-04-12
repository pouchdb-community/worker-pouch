'use strict';

var PouchDB = require('pouchdb');
var Promise = require('bluebird');
var utils = require('../shared/utils');
var dbs = {};

function sendSuccess(socket, messageId, data) {
  console.log('sending success', messageId, data);
  socket.send(messageId + ':1:' + JSON.stringify(data));
}

function sendError(socket, messageId, data) {
  console.log('sending error', messageId, data);
  socket.send(messageId + ':0:' + JSON.stringify(data));
}

function dbMethod(socket, methodName, messageId, args) {
  Promise.resolve().then(function () {
    var db = dbs['$' + socket.id];
    return db[methodName].apply(db, args);
  }).then(function (res) {
    sendSuccess(socket, messageId, res);
  }).catch(function (err) {
    sendError(socket, messageId, err);
  });
}

function onReceiveMessage(socket, type, messageId, args) {
  console.log('onReceiveMessage', type, messageId, args);
  switch (type) {
    case 'createDatabase':
      dbs['$' + socket.id] = new PouchDB(args[0]);
      sendSuccess(socket, messageId, {ok: true});
      return;
    case 'id':
      sendSuccess(socket, messageId, socket.id);
      return;
    case 'info':
    case 'destroy':
      return dbMethod(socket, type, messageId, args);
  }
}

function socketPouchServer(port) {
  var engine = require('engine.io');
  var server = engine.listen(port);

  server.on('connection', function(socket) {
    socket.on('message', function (message) {
      var split = utils.parseMessage(message, 3);
      var type = split[0];
      var messageId = split[1];
      var args = JSON.parse(split[2]);
      onReceiveMessage(socket, type, messageId, args);
    });
  });
}

module.exports = socketPouchServer;