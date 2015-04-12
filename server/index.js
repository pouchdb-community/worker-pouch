'use strict';

var PouchDB = require('pouchdb');
var dbs = {};

function sendSuccess(socket, messageId, data) {
  socket.send(messageId + ':1:' + JSON.stringify(data));
}

function sendError(socket, messageId, data) {
  socket.send(messageId + ':0:' + JSON.stringify(data));
}

function onReceiveMessage(socket, type, messageId, message) {
  console.log('onReceiveMessage', type, messageId, message);
  switch (type) {
    case 'createDatabase':
      dbs[socket.id] = new PouchDB(message);
      sendSuccess(socket, messageId, {ok: true});
      return;
    case 'info':
      dbs[socket.id].info().then(function (res) {
        sendSuccess(socket, messageId, res);
      }).catch(function (err) {
        sendError(socket, messageId, err);
      });
      return;
  }
}

function socketPouchServer(port) {
  var engine = require('engine.io');
  var server = engine.listen(port);

  server.on('connection', function(socket) {
    socket.on('message', function (message) {
      var split = message.split(':');
      var type = split[0];
      var messageId = split[1];
      var content = split[2];
      onReceiveMessage(socket, type, messageId, content);
    });
  });
}

module.exports = socketPouchServer;