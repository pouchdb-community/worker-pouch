'use strict';

/* jshint worker:true */

var Promise = require('pouchdb-promise');
var errors = require('../shared/errors');
var workerUtils = require('./utils');
var decodeArgs = workerUtils.decodeArgs;
var dbs = {};
var allChanges = {};

var log = require('debug')('pouchdb:worker');

function registerWorkerPouch(self, pouchCreator) {

  function postMessage(msg, event) {
    if (typeof self.postMessage !== 'function') { // service worker
      event.ports[0].postMessage(msg);
    } else { // web worker
      self.postMessage(msg);
    }
  }

  function sendUncaughtError(clientId, data, event) {
    log(' -> sendUncaughtError', clientId, data);
    postMessage({
      type: 'uncaughtError',
      id: clientId,
      content: workerUtils.createError(data)
    }, event);
  }

  function sendError(clientId, messageId, data, event) {
    log(' -> sendError', clientId, messageId, data);
    postMessage({
      type: 'error',
      id: clientId,
      messageId: messageId,
      content: workerUtils.createError(data)
    }, event);
  }

  function sendSuccess(clientId, messageId, data, event) {
    log(' -> sendSuccess', clientId, messageId);
    postMessage({
      type: 'success',
      id: clientId,
      messageId: messageId,
      content: data
    }, event);
  }

  function sendUpdate(clientId, messageId, data, event) {
    log(' -> sendUpdate', clientId, messageId);
    postMessage({
      type: 'update',
      id: clientId,
      messageId: messageId,
      content: data
    }, event);
  }

  function dbMethod(clientId, methodName, messageId, args, event) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'}, event);
    }
    Promise.resolve().then(function () {
      return db[methodName].apply(db, args);
    }).then(function (res) {
      sendSuccess(clientId, messageId, res, event);
    }).catch(function (err) {
      sendError(clientId, messageId, err, event);
    });
  }

  function changes(clientId, messageId, args, event) {
    var opts = args[0];
    if (opts && typeof opts === 'object') {
      // just send all the docs anyway because we need to emit change events
      // TODO: be smarter about emitting changes without building up an array
      opts.returnDocs = true;
      opts.return_docs = true;
    }
    dbMethod(clientId, 'changes', messageId, args, event);
  }

  function getAttachment(clientId, messageId, args, event) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'}, event);
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
        return db.getAttachment.apply(db, args).then(function (buff) {
          sendSuccess(clientId, messageId, buff, event);
        });
      });
    }).catch(function (err) {
      sendError(clientId, messageId, err, event);
    });
  }

  function destroy(clientId, messageId, args, event) {
    var key = '$' + clientId;
    var db = dbs[key];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'}, event);
    }
    delete dbs[key];
    Promise.resolve().then(function () {
      return db.destroy.apply(db, args);
    }).then(function (res) {
      sendSuccess(clientId, messageId, res, event);
    }).catch(function (err) {
      sendError(clientId, messageId, err, event);
    });
  }

  function liveChanges(clientId, messageId, args, event) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'}, event);
    }
    Promise.resolve().then(function () {
      var changes = db.changes(args[0]);
      allChanges[messageId] = changes;
      changes.on('change', function (change) {
        sendUpdate(clientId, messageId, change, event);
      }).on('complete', function (change) {
        changes.removeAllListeners();
        delete allChanges[messageId];
        sendSuccess(clientId, messageId, change, event);
      }).on('error', function (change) {
        changes.removeAllListeners();
        delete allChanges[messageId];
        sendError(clientId, messageId, change, event);
      });
    });
  }

  function cancelChanges(messageId) {
    var changes = allChanges[messageId];
    if (changes) {
      changes.cancel();
    }
  }

  function addUncaughtErrorHandler(db, clientId, event) {
    return Promise.resolve().then(function () {
      db.on('error', function (err) {
        sendUncaughtError(clientId, err, event);
      });
    });
  }

  function createDatabase(clientId, messageId, args, event) {
    var key = '$' + clientId;
    var db = dbs[key];
    if (db) {
      return addUncaughtErrorHandler(db, clientId, event).then(function () {
        return sendSuccess(clientId, messageId, {ok: true, exists: true}, event);
      });
    }

    var name = typeof args[0] === 'string' ? args[0] : args[0].name;

    if (!name) {
      return sendError(clientId, messageId, {
        error: 'you must provide a database name'
      }, event);
    }

    db = dbs[key] = pouchCreator(args[0]);
    addUncaughtErrorHandler(db, clientId, event).then(function () {
      sendSuccess(clientId, messageId, {ok: true}, event);
    }).catch(function (err) {
      sendError(clientId, messageId, err, event);
    });
  }

  function onReceiveMessage(clientId, type, messageId, args, event) {
    log('onReceiveMessage', type, clientId, messageId, args, event);
    switch (type) {
      case 'createDatabase':
        return createDatabase(clientId, messageId, args, event);
      case 'id':
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
        return dbMethod(clientId, type, messageId, args, event);
      case 'changes':
        return changes(clientId, messageId, args, event);
      case 'getAttachment':
        return getAttachment(clientId, messageId, args, event);
      case 'liveChanges':
        return liveChanges(clientId, messageId, args, event);
      case 'cancelChanges':
        return cancelChanges(messageId);
      case 'destroy':
        return destroy(clientId, messageId, args, event);
      default:
        return sendError(clientId, messageId, {error: 'unknown API method: ' + type}, event);
    }
  }

  function handleMessage(message, clientId, event) {
    var type = message.type;
    var messageId = message.messageId;
    var args = decodeArgs(message.args);
    onReceiveMessage(clientId, type, messageId, args, event);
  }

  self.addEventListener('message', function (event) {
    if (!event.data || !event.data.id || !event.data.args ||
        !event.data.type || !event.data.messageId) {
      // assume this is not a message from worker-pouch
      // (e.g. the user is using the custom API instead)
      return;
    }
    var clientId = event.data.id;
    if (event.data.type === 'close') {
      log('closing worker', clientId);
      delete dbs['$' + clientId];
    } else {
      handleMessage(event.data, clientId, event);
    }
  });
}

module.exports = registerWorkerPouch;
