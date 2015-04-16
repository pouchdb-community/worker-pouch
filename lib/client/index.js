'use strict';

var utils = require('../shared/utils');
var uuid = require('./uuid');
var errors = require('./errors');
var log = require('debug')('pouchdb:socket');
var Socket = require('engine.io-client');
var blobUtil = require('blob-util');
var isBrowser = typeof process === 'undefined' || process.browser;
var buffer = require('../shared/buffer');
var instances = {};

function preprocessAttachments(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return utils.Promise.resolve();
  }

  return utils.Promise.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      if (isBrowser) {
        return new utils.Promise(function (resolve) {
          utils.readAsBinaryString(attachment.data, function (binary) {
            attachment.data = utils.btoa(binary);
            resolve();
          });
        });
      } else {
        attachment.data = attachment.data.toString('base64');
      }
    }
  }));
}

function stringifyArgs(args) {
  var funcArgs = ['filter', 'map', 'reduce'];
  args.forEach(function (arg) {
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      funcArgs.forEach(function (funcArg) {
        if (funcArg in arg && typeof arg[funcArg] === 'function') {
          arg[funcArg] = {
            type: 'func',
            func: arg[funcArg].toString()
          };
        }
      });
    }
  });
  return JSON.stringify(args);
}

// Implements the PouchDB API for dealing with CouchDB instances over WS
function SocketPouch(opts, callback) {
  var api = this;

  if (typeof opts === 'string') {
    var slashIdx = utils.lastIndexOf(opts, '/');
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    };
  } else {
    opts = utils.clone(opts);
  }

  log('constructor called', opts);

  if (!opts.url || !opts.name) {
    var optsErrMessage = 'Error: you must provide a web socket ' +
      'url and database name.';
    console.log(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  var socket = api._socket = new Socket(opts.url);
  socket.binaryType = 'blob';
  api._callbacks = {};
  api._changesListeners = {};
  api._name = opts.originalName;
  instances['$' + opts.originalName] = api;

  function sendMessage(type, args, callback) {
    var messageId = uuid();
    api._callbacks[messageId] = callback;
    var stringArgs = stringifyArgs(args);
    socket.send(type + ':' + messageId + ':' + stringArgs);
  }

  socket.once('open', function () {
    api._socketOpened = true;
    sendMessage('createDatabase', [{
      name: api._name,
      auto_compaction: !!opts.auto_compaction
    }], function (err) {
      if (err) {
        return callback(err);
      }
      callback(null, api);
    });
  });

  socket.on('message', function (res) {
    var split = utils.parseMessage(res, 3);
    var messageId = split[0];
    var messageType = split[1];
    var content = JSON.parse(split[2]);
    var cb = api._callbacks[messageId];
    log('message', messageId, messageType, content);

    if (messageType === '0') { // error
      delete api._callbacks[messageId];
      cb(content);
    } else if (messageType === '1') { // success
      delete api._callbacks[messageId];
      cb(null, content);
    } else { // update, i.e. changes
      api._changesListeners[messageId](content);
    }
  });

  socket.once('error', function (err) {
    callback(err);
  });

  api.type = function () {
    return 'socket';
  };

  api._id = utils.adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = utils.adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = utils.adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  api.remove =
    utils.adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);

      sendMessage('remove', [doc._id, rev], callback);
  });

  api.getAttachment =
    utils.adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    utils.adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    utils.adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
                                                type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      if (typeof type === 'undefined') {
        type = blob;
        blob = rev;
        rev = null;
      }

      if (typeof blob === 'string') {
        var binary;
        try {
          binary = utils.atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        if (isBrowser) {
          blob = utils.createBlob([utils.fixBinary(binary)], {type: type});
        } else {
          blob = binary ? new buffer(binary, 'binary') : '';
        }
      }

      // TODO: don't use base64
      if (isBrowser) {
        blobUtil.blobToBase64String(blob).then(function (b64) {
          sendMessage('putAttachment',
            [docId, attachmentId, rev, b64, type], callback);
        }).catch(callback);
      } else {
        sendMessage('putAttachment',
          [docId, attachmentId, rev, blob.toString('base64'), type], callback);
      }

    });

  api.put = utils.adapterFun('put', utils.getArguments(function (args) {
    var temp, temptype, opts;
    var doc = args.shift();
    var id = '_id' in doc;
    var callback = args.pop();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT));
    }

    doc = utils.clone(doc);

    preprocessAttachments(doc).then(function () {
      while (true) {
        temp = args.shift();
        temptype = typeof temp;
        if (temptype === "string" && !id) {
          doc._id = temp;
          id = true;
        } else if (temptype === "string" && id && !('_rev' in doc)) {
          doc._rev = temp;
        } else if (temptype === "object") {
          opts = utils.clone(temp);
        }
        if (!args.length) {
          break;
        }
      }
      opts = opts || {};

      sendMessage('put', [doc, opts], callback);
    }).catch(callback);

  }));

  api.post = utils.adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = utils.clone(opts);

    sendMessage('post', [doc, opts], callback);
  });

  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback);
  };

  api._allDocs = utils.adapterFun('allDocs', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  });

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      socket.send('liveChanges' + ':' + messageId + ':' + JSON.stringify([opts]));
      return {
        cancel: function () {
          socket.send('cancelChanges' + ':' + messageId + ':' + JSON.stringify([]));
        }
      };
    }

    // just send all the docs anyway because we need to emit change events
    // TODO: be smarter about emitting changes without building up an array
    var returnDocs = 'returnDocs' in opts ? opts.returnDocs : true;
    opts.returnDocs = true;
    sendMessage('changes', [opts], function (err, res) {
      if (err) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (!returnDocs) {
        res.results = [];
      }
      opts.complete(null, res);
      callback(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = utils.adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._close = function (callback) {

    function close() {
      if (api._socketClosed) {
        return callback();
      }
      api._socketClosed = true;
      socket.once('close', function (msg) {
        log('closed', msg);
        callback();
      });
      socket.close();
    }
    if (api._socketOpened) {
      return close();
    }
    socket.once('open', close);
  };

  api.destroy = utils.adapterFun('destroy', function (callback) {
    sendMessage('destroy', [], function (err, res) {
      delete instances['$' + name];
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      api._close(function (err) {
        if (err) {
          api.emit('error', err);
          return callback(err);
        }
        api.emit('destroyed');
        api._close(function () {
          callback(null, res);
        });
      });
    });
  });
}

// Delete the SocketPouch specified by the given name.
SocketPouch.destroy = utils.toPromise(function (name, opts, callback) {
  opts = opts || {};
  if (typeof opts === 'function') {
    callback = opts;
  }
  var instance = instances['$' + name];
  if (instance) {
    instance.destroy(callback);
  } else {
    callback(null, {ok: true});
  }
});

// SocketPouch is a valid adapter.
SocketPouch.valid = function () {
  return true;
};

module.exports = SocketPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('socket', module.exports);
}
