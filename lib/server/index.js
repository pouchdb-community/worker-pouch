'use strict';

var PouchDB = require('pouchdb');
var Promise = require('bluebird');
var uuid = require('../shared/uuid');
var errors = require('../shared/errors');
var utils = require('../shared/utils');
var serverUtils = require('./utils');
var safeEval = require('./safe-eval');
var dbs = {};
var allChanges = {};

var log = require('debug')('pouchdb:socket');

function destringifyArgs(argsString) {
  var args = JSON.parse(argsString);
  var funcArgs = ['filter', 'map', 'reduce'];
  args.forEach(function (arg) {
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      funcArgs.forEach(function (funcArg) {
        if (funcArg in arg && arg[funcArg].type === 'func' && arg[funcArg].func) {
          arg[funcArg] = safeEval(arg[funcArg].func);
        }
      });
    }
  });
  return args;
}

function sendError(socket, messageId, data) {
  log(' -> sendError', socket.id, messageId, data);
  socket.send(messageId + ':0:' + JSON.stringify(serverUtils.createError(data)));
}

function sendSuccess(socket, messageId, data) {
  log(' -> sendSuccess', socket.id, messageId);
  socket.send(messageId + ':1:' + JSON.stringify(data));
}

function sendBinarySuccess(socket, messageId, type, buff) {
  log(' -> sendBinarySuccess', socket.id, messageId);
  var blobUuid = uuid();
  socket.send(messageId + ':3:' + JSON.stringify({type: type, uuid: blobUuid}));
  socket.send(Buffer.concat([
    new Buffer(blobUuid, 'utf8'),
    buff]));
}

function sendUpdate(socket, messageId, data) {
  log(' -> sendUpdate', socket.id, messageId);
  socket.send(messageId + ':2:' + JSON.stringify(data));
}

function dbMethod(socket, methodName, messageId, args) {
  var db = dbs['$' + socket.id];
  if (!db) {
    return sendError(socket, messageId, {error: 'db not found'});
  }
  db[methodName].apply(db, args).then(function (res) {
    sendSuccess(socket, messageId, res);
  }).catch(function (err) {
    sendError(socket, messageId, err);
  });
}

function getAttachment(socket, messageId, args) {
  var db = dbs['$' + socket.id];
  if (!db) {
    return sendError(socket, messageId, {error: 'db not found'});
  }

  Promise.resolve().then(function () {
    var docId = args[0];
    var attId = args[1];
    var opts = args[2];
    if (typeof opts !== 'object') {
      opts = {};
    }
    return db.get(docId, opts).then(function (doc) {
      if (!doc._attachments || !doc._attachments[attId]) {
        throw errors.MISSING_DOC;
      }
      var type = doc._attachments[attId].content_type;
      return db.getAttachment.apply(db, args).then(function (buff) {
        sendBinarySuccess(socket, messageId, type, buff);
      });
    });
  }).catch(function (err) {
    sendError(socket, messageId, err);
  });
}

function destroy(socket, messageId, args) {
  var key = '$' + socket.id;
  var db = dbs[key];
  if (!db) {
    return sendError(socket, messageId, {error: 'db not found'});
  }
  delete dbs[key];

  db.destroy.apply(db, args).then(function (res) {
    sendSuccess(socket, messageId, res);
  }).catch(function (err) {
    sendError(socket, messageId, err);
  });
}

function liveChanges(socket, messageId, args) {
  var db = dbs['$' + socket.id];
  if (!db) {
    return sendError(socket, messageId, {error: 'db not found'});
  }
  var changes = db.changes(args[0]);
  allChanges[messageId] = changes;
  changes.on('change', function (change) {
    sendUpdate(socket, messageId, change);
  }).on('complete', function (change) {
    changes.removeAllListeners();
    delete allChanges[messageId];
    sendSuccess(socket, messageId, change);
  }).on('error', function (change) {
    changes.removeAllListeners();
    delete allChanges[messageId];
    sendError(socket, messageId, change);
  });
}

function cancelChanges(messageId) {
  var changes = allChanges[messageId];
  if (changes) {
    changes.cancel();
  }
}

function createDatabase(socket, messageId, args) {
  var key = '$' + socket.id;
  var db = dbs[key];
  if (db) {
    return sendError(socket, messageId, {
      error: "file_exists",
      reason: "The database could not be created, the file already exists."
    });
  }
  dbs[key] = new PouchDB(args[0]);
  dbs[key].then(function () {
    sendSuccess(socket, messageId, {ok: true});
  }).catch(function (err) {
    sendError(socket, messageId, err);
  });
}

function onReceiveMessage(socket, type, messageId, args) {
  log('onReceiveMessage', type, socket.id, messageId, args);
  switch (type) {
    case 'createDatabase':
      return createDatabase(socket, messageId, args);
    case 'id':
      sendSuccess(socket, messageId, socket.id);
      return;
    case 'info':
    case 'put':
    case 'allDocs':
    case 'bulkDocs':
    case 'post':
    case 'get':
    case 'remove':
    case 'revsDiff':
    case 'compact':
    case 'viewCleanup':
    case 'removeAttachment':
    case 'putAttachment':
    case 'query':
    case 'changes':
      return dbMethod(socket, type, messageId, args);
    case 'getAttachment':
      return getAttachment(socket, messageId, args);
    case 'liveChanges':
      return liveChanges(socket, messageId, args);
    case 'cancelChanges':
      return cancelChanges(messageId);
    case 'destroy':
      return destroy(socket, messageId, args);
    default:
      return sendError(socket, messageId, {error: 'unknown API method: ' + type});
  }
}

function onReceiveTextMessage(message, socket) {
  try {
    var split = utils.parseMessage(message, 3);
    var type = split[0];
    var messageId = split[1];
    var args = destringifyArgs(split[2]);
    onReceiveMessage(socket, type, messageId, args);
  } catch (err) {
    log('invalid message, ignoring', err);
  }
}

function onReceiveBinaryMessage(message, socket) {
  try {
    var headerLen = parseInt(message.slice(0, 16).toString('utf8'), 10);
    var header = JSON.parse(message.slice(16, 16 + headerLen).toString('utf8'));
    var body = message.slice(16 + headerLen);
    header.args[header.blobIndex] = body;
    onReceiveMessage(socket, header.messageType, header.messageId, header.args);
  } catch (err) {
    log('invalid message, ignoring', err);
  }
}

function socketPouchServer(port) {
  var engine = require('engine.io');
  var server = engine.listen(port);

  server.on('connection', function(socket) {
    socket.on('message', function (message) {
      if (typeof message !== 'string') {
        return onReceiveBinaryMessage(message, socket);
      }
      onReceiveTextMessage(message, socket);
    }).on('close', function () {
      log('closing socket', socket.id);
      socket.removeAllListeners();
      delete dbs['$' + socket.id];
    }).on('error', function (err) {
      log('socket threw an error', err);
      socket.removeAllListeners();
      delete dbs['$' + socket.id];
    });
  });
}

module.exports = socketPouchServer;