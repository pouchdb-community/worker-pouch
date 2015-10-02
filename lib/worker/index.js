'use strict';

/* jshint worker:true */

var Promise = require('bluebird');
var errors = require('../shared/errors');
var workerUtils = require('./utils');
var safeEval = require('./safe-eval');
var makePouchCreator = require('./make-pouch-creator');
var dbs = {};
var allChanges = {};

var log = require('debug')('pouchdb:worker');

function destringifyArgs(args) {
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

function sendError(socketId, messageId, data) {
  log(' -> sendError', socketId, messageId, data);
  self.postMessage({
    type: 'error',
    id: socketId,
    messageId: messageId,
    content: workerUtils.createError(data)
  });
}

function sendSuccess(socketId, messageId, data) {
  log(' -> sendSuccess', socketId, messageId);
  self.postMessage({
    type: 'success',
    id: socketId,
    messageId: messageId,
    content: data
  });
}

function sendBinarySuccess(socketId, messageId, type, blob) {
  log(' -> sendBinarySuccess', socketId, messageId);
  self.postMessage({
    type: 'success',
    id: socketId,
    messageId: messageId,
    content: blob
  });
}

function sendUpdate(socketId, messageId, data) {
  log(' -> sendUpdate', socketId, messageId);
  self.postMessage({
    type: 'update',
    id: socketId,
    messageId: messageId,
    content: data
  });
}

function dbMethod(socketId, methodName, messageId, args) {
  var db = dbs['$' + socketId];
  if (!db) {
    return sendError(socketId, messageId, {error: 'db not found'});
  }
  Promise.resolve().then(function () {
    return db;
  }).then(function (res) {
    var db = res.pouch;
    return db[methodName].apply(db, args);
  }).then(function (res) {
    sendSuccess(socketId, messageId, res);
  }).catch(function (err) {
    sendError(socketId, messageId, err);
  });
}

function getAttachment(socketId, messageId, args) {
  var db = dbs['$' + socketId];
  if (!db) {
    return sendError(socketId, messageId, {error: 'db not found'});
  }

  Promise.resolve().then(function () {
    return db;
  }).then(function (res) {
    var db = res.pouch;
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
        sendBinarySuccess(socketId, messageId, type, buff);
      });
    });
  }).catch(function (err) {
    sendError(socketId, messageId, err);
  });
}

function destroy(socketId, messageId, args) {
  var key = '$' + socketId;
  var db = dbs[key];
  if (!db) {
    return sendError(socketId, messageId, {error: 'db not found'});
  }
  delete dbs[key];

  Promise.resolve().then(function () {
    return db;
  }).then(function (res) {
    var db = res.pouch;
    return db.destroy.apply(db, args);
  }).then(function (res) {
    sendSuccess(socketId, messageId, res);
  }).catch(function (err) {
    sendError(socketId, messageId, err);
  });
}

function liveChanges(socketId, messageId, args) {
  var db = dbs['$' + socketId];
  if (!db) {
    return sendError(socketId, messageId, {error: 'db not found'});
  }
  Promise.resolve().then(function () {
    return db;
  }).then(function (res) {
    var db = res.pouch;
    var changes = db.changes(args[0]);
    allChanges[messageId] = changes;
    changes.on('change', function (change) {
      sendUpdate(socketId, messageId, change);
    }).on('complete', function (change) {
      changes.removeAllListeners();
      delete allChanges[messageId];
      sendSuccess(socketId, messageId, change);
    }).on('error', function (change) {
      changes.removeAllListeners();
      delete allChanges[messageId];
      sendError(socketId, messageId, change);
    });
  });
}

function cancelChanges(messageId) {
  var changes = allChanges[messageId];
  if (changes) {
    changes.cancel();
  }
}

function createDatabase(socketId, messageId, args, pouchCreator) {
  var key = '$' + socketId;
  var db = dbs[key];
  if (db) {
    return sendError(socketId, messageId, {
      error: "file_exists",
      reason: "The database could not be created, the file already exists."
    });
  }

  var name = typeof args[0] === 'string' ? args[0] : args[0].name;

  if (!name) {
    return sendError(socketId, messageId, {
      error: 'you must provide a database name'
    });
  }

  dbs[key] = pouchCreator(args);
  pouchCreator(args).then(function () {
    sendSuccess(socketId, messageId, {ok: true});
  }).catch(function (err) {
    sendError(socketId, messageId, err);
  });
}

function onReceiveMessage(socketId, type, messageId, args, pouchCreator) {
  log('onReceiveMessage', type, socketId, messageId, args);
  switch (type) {
    case 'createDatabase':
      return createDatabase(socketId, messageId, args, pouchCreator);
    case 'id':
      sendSuccess(socketId, messageId, socketId);
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
      return dbMethod(socketId, type, messageId, args);
    case 'getAttachment':
      return getAttachment(socketId, messageId, args);
    case 'liveChanges':
      return liveChanges(socketId, messageId, args);
    case 'cancelChanges':
      return cancelChanges(messageId);
    case 'destroy':
      return destroy(socketId, messageId, args);
    default:
      return sendError(socketId, messageId, {error: 'unknown API method: ' + type});
  }
}

function onReceiveMessage(message, socketId, pouchCreator) {
  try {
    var type = message.type;
    var messageId = message.messageId;
    var args = destringifyArgs(message.args);
    onReceiveMessage(socketId, type, messageId, args, pouchCreator);
  } catch (err) {
    log('invalid message, ignoring', err);
  }
}

var options = {};
var pouchCreator = makePouchCreator(options);

self.onmessage = function (event) {
  var socketId = event.data.id;
  if (event.data.type === 'close') {
    log('closing socket', socketId);
    delete dbs['$' + socketId];
  } else {
    onReceiveMessage(event.data, socketId, pouchCreator);
  }
};