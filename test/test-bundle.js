(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var utils = require('../shared/utils');
var clientUtils = require('./utils');
var uuid = require('./../shared/uuid');
var errors = require('../shared/errors');
var log = require('debug')('pouchdb:worker:client');
var preprocessAttachments = clientUtils.preprocessAttachments;
var encodeArgs = clientUtils.encodeArgs;
var adapterFun = clientUtils.adapterFun;

// Implements the PouchDB API for dealing with PouchDB instances over WW
function WorkerPouch(opts, callback) {
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

  // Aspirational. once https://github.com/pouchdb/pouchdb/issues/5200
  // is resolved, you'll be able to directly pass in a worker here instead of
  // a function that returns a worker.
  var worker = (opts.worker && typeof opts.worker === 'function') ?
    opts.worker() : opts.worker;
  if (!worker || (!worker.postMessage && (!worker.controller || !worker.controller.postMessage))) {
    var workerOptsErrMessage =
      'Error: you must provide a valid `worker` in `new PouchDB()`';
    console.error(workerOptsErrMessage);
    return callback(new Error(workerOptsErrMessage));
  }

  if (!opts.name) {
    var optsErrMessage = 'Error: you must provide a database name.';
    console.error(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  function handleUncaughtError(content) {
    try {
      api.emit('error', content);
    } catch (err) {
      // TODO: it's weird that adapters should have to handle this themselves
      console.error(
        'The user\'s map/reduce function threw an uncaught error.\n' +
        'You can debug this error by doing:\n' +
        'myDatabase.on(\'error\', function (err) { debugger; });\n' +
        'Please double-check your map/reduce function.');
      console.error(content);
    }
  }

  function onReceiveMessage(message) {
    var messageId = message.messageId;
    var messageType = message.type;
    var content = message.content;

    if (messageType === 'uncaughtError') {
      handleUncaughtError(content);
      return;
    }

    var cb = api._callbacks[messageId];

    if (!cb) {
      log('duplicate message (ignoring)', messageId, messageType, content);
      return;
    }

    log('receive message', api._instanceId, messageId, messageType, content);

    if (messageType === 'error') {
      delete api._callbacks[messageId];
      cb(content);
    } else if (messageType === 'success') {
      delete api._callbacks[messageId];
      cb(null, content);
    } else { // 'update'
      api._changesListeners[messageId](content);
    }
  }

  function workerListener(e) {
    if (e.data.id === api._instanceId) {
      onReceiveMessage(e.data);
    }
  }

  function postMessage(message) {
    /* istanbul ignore if */
    if (typeof worker.controller !== 'undefined') {
      // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      var channel = new MessageChannel();
      channel.port1.onmessage = workerListener;
      worker.controller.postMessage(message, [channel.port2]);
    } else {
      // web worker
      worker.postMessage(message);
    }
  }

  function sendMessage(type, args, callback) {
    if (api._destroyed) {
      return callback(new Error('this db was destroyed'));
    } else if (api._closed) {
      return callback(new Error('this db was closed'));
    }
    var messageId = uuid();
    log('send message', api._instanceId, messageId, type, args);
    api._callbacks[messageId] = callback;
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  function sendRawMessage(messageId, type, args) {
    log('send message', api._instanceId, messageId, type, args);
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  api.type = function () {
    return 'worker';
  };

  api._id = adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  // hacky code necessary due to implicit breaking change in
  // https://github.com/pouchdb/pouchdb/commits/0ddeae6b
  api._get = function (id, opts, callback) {
    api.get(id, opts, function (err, doc) {
      if (err) {
        return callback(err);
      }
      callback(null, {doc: doc});
    });
  };

  api.remove =
    adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
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
    adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
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
          binary = atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], {type: type});
      }

      var args = [docId, attachmentId, rev, blob, type];
      sendMessage('putAttachment', args, callback);
    });

  api.put = adapterFun('put', utils.getArguments(function (args) {
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

  api.post = adapterFun('post', function (doc, opts, callback) {
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

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  };

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      sendRawMessage(messageId, 'liveChanges', [opts]);
      return {
        cancel: function () {
          sendRawMessage(messageId, 'cancelChanges', []);
        }
      };
    }

    sendMessage('changes', [opts], function (err, res) {
      if (err) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (opts.returnDocs === false || opts.return_docs === false) {
        res.results = [];
      }
      opts.complete(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._query = adapterFun('query', function (fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var funEncoded = fun;
    if (typeof fun === 'function') {
      funEncoded = {map: fun};
    }
    sendMessage('query', [funEncoded, opts], callback);
  });

  api._viewCleanup = adapterFun('viewCleanup', function (callback) {
    sendMessage('viewCleanup', [], callback);
  });

  api._close = function (callback) {
    api._closed = true;
    callback();
  };

  api.destroy = adapterFun('destroy', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('destroy', [], function (err, res) {
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      api._destroyed = true;
      worker.removeEventListener('message', workerListener);
      api.emit('destroyed');
      callback(null, res);
    });
  });

  // api.name was added in pouchdb 6.0.0
  api._instanceId = api.name || opts.originalName;
  api._callbacks = {};
  api._changesListeners = {};

  worker.addEventListener('message', workerListener);

  var workerOpts = {
    name: api._instanceId,
    auto_compaction: !!opts.auto_compaction
  };
  if (opts.revs_limit) {
    workerOpts.revs_limit = opts.revs_limit;
  }

  sendMessage('createDatabase', [workerOpts], function (err) {
    if (err) {
      return callback(err);
    }
    callback(null, api);
  });
}

// WorkerPouch is a valid adapter.
WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

module.exports = WorkerPouch;

},{"../shared/errors":6,"../shared/utils":8,"./../shared/uuid":9,"./utils":5,"debug":12}],2:[function(require,module,exports){
'use strict';
/* global webkitURL */

module.exports = function createWorker(code) {
  var createBlob = require('../shared/utils').createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([code], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};
},{"../shared/utils":8}],3:[function(require,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker

var extend = require('js-extend').extend;
var WorkerPouchCore = require('./core');
var createWorker = require('./create-worker');
var isSupportedBrowser = require('./is-supported-browser');
var workerCode = require('../workerified');

function WorkerPouch(opts, callback) {

  var worker = window.__pouchdb_global_worker; // cache so there's only one
  if (!worker) {
    try {
      worker = createWorker(workerCode);
      worker.addEventListener('error', function (e) {
        if ('console' in global && 'warn' in console) {
          console.warn('worker threw an error', e.error);
        }
      });
      window.__pouchdb_global_worker = worker;
    } catch (e) {
      if ('console' in global && 'info' in console) {
        console.info('This browser is not supported by WorkerPouch. ' +
          'Please use isSupportedBrowser() to check.', e);
      }
      return callback(new Error('browser unsupported by worker-pouch'));
    }
  }

  var _opts = extend({
    worker: function () { return worker; }
  }, opts);

  WorkerPouchCore.call(this, _opts, callback);
}

WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

WorkerPouch.isSupportedBrowser = isSupportedBrowser;

module.exports = WorkerPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('worker', module.exports);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"../workerified":10,"./core":1,"./create-worker":2,"./is-supported-browser":4,"js-extend":17}],4:[function(require,module,exports){
(function (global){
'use strict';

var Promise = require('pouchdb-promise');
var createWorker = require('./create-worker');

module.exports = function isSupportedBrowser() {
  return Promise.resolve().then(function () {
    // synchronously throws in IE/Edge
    var worker = createWorker('' +
      'self.onmessage = function () {' +
      '  self.postMessage({' +
      '    hasIndexedDB: (typeof indexedDB !== "undefined")' +
      '  });' +
      '};');

    return new Promise(function (resolve, reject) {

      function listener(e) {
        worker.terminate();
        if (e.data.hasIndexedDB) {
          resolve();
          return;
        }
        reject();
      }

      function errorListener() {
        worker.terminate();
        reject();
      }

      worker.addEventListener('error', errorListener);
      worker.addEventListener('message', listener);
      worker.postMessage({});
    });
  }).then(function () {
    return true;
  }, function (err) {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err);
    }
    return false;
  });
};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./create-worker":2,"pouchdb-promise":25}],5:[function(require,module,exports){
(function (process){
'use strict';

var utils = require('../shared/utils');
var log = require('debug')('pouchdb:worker:client');
var isBrowser = typeof process === 'undefined' || process.browser;

exports.preprocessAttachments = function preprocessAttachments(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return utils.Promise.resolve();
  }

  return utils.Promise.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      if (isBrowser) {
        return new utils.Promise(function (resolve) {
          utils.readAsBinaryString(attachment.data, function (binary) {
            attachment.data = btoa(binary);
            resolve();
          });
        });
      } else {
        attachment.data = attachment.data.toString('base64');
      }
    }
  }));
};

function encodeObjectArg(arg) {
  // these can't be encoded by normal structured cloning
  var funcKeys = ['filter', 'map', 'reduce'];
  var keysToRemove = ['onChange', 'processChange', 'complete'];
  var clonedArg = {};
  Object.keys(arg).forEach(function (key) {
    if (keysToRemove.indexOf(key) !== -1) {
      return;
    }
    if (funcKeys.indexOf(key) !== -1 && typeof arg[key] === 'function') {
      clonedArg[key] = {
        type: 'func',
        func: arg[key].toString()
      };
    } else {
      clonedArg[key] = arg[key];
    }
  });
  return clonedArg;
}

exports.encodeArgs = function encodeArgs(args) {
  var result = [];
  args.forEach(function (arg) {
    if (arg === null || typeof arg !== 'object' ||
        Array.isArray(arg) || arg instanceof Blob || arg instanceof Date) {
      result.push(arg);
    } else {
      result.push(encodeObjectArg(arg));
    }
  });
  return result;
};

exports.padInt = function padInt(i, len) {
  var res = i.toString();
  while (res.length < len) {
    res = '0' + res;
  }
  return res;
};


exports.adapterFun = function adapterFun(name, callback) {

  function logApiCall(self, name, args) {
    if (!log.enabled) {
      return;
    }
    // db.name was added in pouch 6.0.0
    var dbName = self.name || self._db_name;
    var logArgs = [dbName, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = [dbName, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      log.apply(null, responseArgs);
      origCallback(err, res);
    };
  }


  return utils.toPromise(utils.getArguments(function (args) {
    if (this._closed) {
      return utils.Promise.reject(new Error('database is closed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new utils.Promise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
};
}).call(this,require('_process'))
},{"../shared/utils":8,"_process":26,"debug":12}],6:[function(require,module,exports){
"use strict";

var inherits = require('inherits');
inherits(PouchError, Error);

function PouchError(opts) {
  Error.call(opts.reason);
  this.status = opts.status;
  this.name = opts.error;
  this.message = opts.reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  });
};

exports.UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: "Name or password is incorrect."
});

exports.MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: "Missing JSON list of 'docs'"
});

exports.MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
});

exports.REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
});

exports.INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
});

exports.MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
});

exports.RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
});

exports.NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
});

exports.UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
});

exports.BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
});

exports.INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
});

exports.QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
});

exports.DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
});

exports.BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
});

exports.NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
});

exports.DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
});

exports.IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
});

exports.WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
});

exports.LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
});

exports.FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
});

exports.INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
});

exports.FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
});

exports.MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
});

exports.error = function (error, reason, name) {
  function CustomPouchError(reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (var p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    /* jshint ignore:end */
    if (name !== undefined) {
      this.name = name;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
};

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
exports.getErrorTypeByProp = function (prop, value, reason) {
  var errors = exports;
  var keys = Object.keys(errors).filter(function (key) {
    var error = errors[key];
    return typeof error !== 'function' && error[prop] === value;
  });
  var key = reason && keys.filter(function (key) {
      var error = errors[key];
      return error.message === reason;
    })[0] || keys[0];
  return (key) ? errors[key] : null;
};

exports.generateErrorFromResponse = function (res) {
  var error, errName, errType, errMsg, errReason;
  var errors = exports;

  errName = (res.error === true && typeof res.name === 'string') ?
    res.name :
    res.error;
  errReason = res.reason;
  errType = errors.getErrorTypeByProp('name', errName, errReason);

  if (res.missing ||
    errReason === 'missing' ||
    errReason === 'deleted' ||
    errName === 'not_found') {
    errType = errors.MISSING_DOC;
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = errors.DOC_VALIDATION;
    errMsg = errReason;
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.

    // attachment errors.
    if (errReason.indexOf('unknown stub attachment') === 0) {
      errType = errors.MISSING_STUB;
      errMsg = errReason;
    } else {
      errType = errors.BAD_REQUEST;
    }
  }

  // fallback to error by statys or unknown error.
  if (!errType) {
    errType = errors.getErrorTypeByProp('status', res.status, errReason) ||
    errors.UNKNOWN_ERROR;
  }

  error = errors.error(errType, errReason, errName);

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg;
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id;
  }
  if (res.status) {
    error.status = res.status;
  }
  if (res.statusText) {
    error.name = res.statusText;
  }
  if (res.missing) {
    error.missing = res.missing;
  }

  return error;
};

},{"inherits":16}],7:[function(require,module,exports){
'use strict';

function isBinaryObject(object) {
  return object instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  var target = new ArrayBuffer(buff.byteLength);
  var targetArray = new Uint8Array(target);
  var sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  // Blob
  return object.slice(0, object.size, object.type);
}

module.exports = function clone(object) {
  var newObject;
  var i;
  var len;

  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  newObject = {};
  for (i in object) {
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
};

},{}],8:[function(require,module,exports){
(function (process,global){
'use strict';

var Promise = require('pouchdb-promise');

exports.lastIndexOf = function lastIndexOf(str, char) {
  for (var i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i;
    }
  }
  return -1;
};

exports.clone = require('./pouchdb-clone');

/* istanbul ignore next */
exports.once = function once(fun) {
  var called = false;
  return exports.getArguments(function (args) {
    if (called) {
      if ('console' in global && 'trace' in console) {
        console.trace();
      }
      throw new Error('once called  more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
};
/* istanbul ignore next */
exports.getArguments = function getArguments(fun) {
  return function () {
    var len = arguments.length;
    var args = new Array(len);
    var i = -1;
    while (++i < len) {
      args[i] = arguments[i];
    }
    return fun.call(this, args);
  };
};
/* istanbul ignore next */
exports.toPromise = function toPromise(func) {
  //create the function we will be returning
  return exports.getArguments(function (args) {
    var self = this;
    var tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    // if the last argument is a function, assume its a callback
    var usedCB;
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        process.nextTick(function () {
          tempCB(err, resp);
        });
      };
    }
    var promise = new Promise(function (fulfill, reject) {
      try {
        var callback = exports.once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        func.apply(self, args);
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    promise.cancel = function () {
      return this;
    };
    return promise;
  });
};

exports.inherits = require('inherits');
exports.Promise = Promise;

var binUtil = require('pouchdb-binary-util');

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./pouchdb-clone":7,"_process":26,"inherits":16,"pouchdb-binary-util":20,"pouchdb-promise":25}],9:[function(require,module,exports){
"use strict";

// BEGIN Math.uuid.js

/*!
 Math.uuid.js (v1.4)
 http://www.broofa.com
 mailto:robert@broofa.com

 Copyright (c) 2010 Robert Kieffer
 Dual licensed under the MIT and GPL licenses.
 */

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix. 
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
var chars = (
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
'abcdefghijklmnopqrstuvwxyz'
).split('');
function getValue(radix) {
  return 0 | Math.random() * radix;
}
function uuid(len, radix) {
  radix = radix || chars.length;
  var out = '';
  var i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
  }
  // rfc4122, version 4 form
  // Fill in random data.  At i==19 set the high bits of clock sequence as
  // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
      case 8:
      case 13:
      case 18:
      case 23:
        out += '-';
        break;
      case 19:
        out += chars[(getValue(16) & 0x3) | 0x8];
        break;
      default:
        out += chars[getValue(16)];
    }
  }

  return out;
}



module.exports = uuid;


},{}],10:[function(require,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function e(t,n,r){function o(s,a){if(!n[s]){if(!t[s]){var u=\"function\"==typeof require&&require;if(!a&&u)return u(s,!0);if(i)return i(s,!0);var c=new Error(\"Cannot find module '\"+s+\"'\");throw c.code=\"MODULE_NOT_FOUND\",c}var f=n[s]={exports:{}};t[s][0].call(f.exports,function(e){var n=t[s][1][e];return o(n||e)},f,f.exports,e,t,n,r)}return n[s].exports}for(var i=\"function\"==typeof require&&require,s=0;s<r.length;s++)o(r[s]);return o}({1:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}e(12)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),s=r&&i.filter(function(e){return o[e].message===r})[0]||i[0];return s?o[s]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,s,a=n;return r=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,s=e.reason,o=a.getErrorTypeByProp(\"name\",r,s),e.missing||\"missing\"===s||\"deleted\"===s||\"not_found\"===r?o=a.MISSING_DOC:\"doc_validation\"===r?(o=a.DOC_VALIDATION,i=s):\"bad_request\"===r&&o.message!==s&&(0===s.indexOf(\"unknown stub attachment\")?(o=a.MISSING_STUB,i=s):o=a.BAD_REQUEST),o||(o=a.getErrorTypeByProp(\"status\",e.status,s)||a.UNKNOWN_ERROR),t=a.error(o,s,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],2:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){\"function\"!=typeof e.postMessage?n.ports[0].postMessage(t):e.postMessage(t)}function r(e,t,r){f(\" -> sendUncaughtError\",e,t),n({type:\"uncaughtError\",id:e,content:s.createError(t)},r)}function l(e,t,r,o){f(\" -> sendError\",e,t,r),n({type:\"error\",id:e,messageId:t,content:s.createError(r)},o)}function d(e,t,r,o){f(\" -> sendSuccess\",e,t),n({type:\"success\",id:e,messageId:t,content:r},o)}function h(e,t,r,o){f(\" -> sendUpdate\",e,t),n({type:\"update\",id:e,messageId:t,content:r},o)}function p(e,t,n,r,i){var s=u[\"$\"+e];if(!s)return l(e,n,{error:\"db not found\"},i);o.resolve().then(function(){return s[t].apply(s,r)}).then(function(t){d(e,n,t,i)}).catch(function(t){l(e,n,t,i)})}function v(e,t,n,r){var o=n[0];o&&\"object\"==typeof o&&(o.returnDocs=!0,o.return_docs=!0),p(e,\"changes\",t,n,r)}function y(e,t,n,r){var s=u[\"$\"+e];if(!s)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=n[0],a=n[1],u=n[2];return\"object\"!=typeof u&&(u={}),s.get(o,u).then(function(o){if(!o._attachments||!o._attachments[a])throw i.MISSING_DOC;return s.getAttachment.apply(s,n).then(function(n){d(e,t,n,r)})})}).catch(function(n){l(e,t,n,r)})}function g(e,t,n,r){var i=\"$\"+e,s=u[i];if(!s)return l(e,t,{error:\"db not found\"},r);delete u[i],o.resolve().then(function(){return s.destroy.apply(s,n)}).then(function(n){d(e,t,n,r)}).catch(function(n){l(e,t,n,r)})}function m(e,t,n,r){var i=u[\"$\"+e];if(!i)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=i.changes(n[0]);c[t]=o,o.on(\"change\",function(n){h(e,t,n,r)}).on(\"complete\",function(n){o.removeAllListeners(),delete c[t],d(e,t,n,r)}).on(\"error\",function(n){o.removeAllListeners(),delete c[t],l(e,t,n,r)})})}function _(e){var t=c[e];t&&t.cancel()}function b(e,t,n){return o.resolve().then(function(){e.on(\"error\",function(e){r(t,e,n)})})}function w(e,n,r,o){var i=\"$\"+e,s=u[i];return s?b(s,e,o).then(function(){return d(e,n,{ok:!0,exists:!0},o)}):(\"string\"==typeof r[0]?r[0]:r[0].name)?(s=u[i]=t(r[0]),void b(s,e,o).then(function(){d(e,n,{ok:!0},o)}).catch(function(t){l(e,n,t,o)})):l(e,n,{error:\"you must provide a database name\"},o)}function k(e,t,n,r,o){switch(f(\"onReceiveMessage\",t,e,n,r,o),t){case\"createDatabase\":return w(e,n,r,o);case\"id\":return void d(e,n,e,o);case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return p(e,t,n,r,o);case\"changes\":return v(e,n,r,o);case\"getAttachment\":return y(e,n,r,o);case\"liveChanges\":return m(e,n,r,o);case\"cancelChanges\":return _(n);case\"destroy\":return g(e,n,r,o);default:return l(e,n,{error:\"unknown API method: \"+t},o)}}function E(e,t,n){k(t,e.type,e.messageId,a(e.args),n)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete u[\"$\"+t]):E(e.data,t,e)}})}var o=e(37),i=e(1),s=e(6),a=s.decodeArgs,u={},c={},f=e(8)(\"pouchdb:worker\");t.exports=r},{1:1,37:37,6:6,8:8}],3:[function(e,t,n){\"use strict\";var r=e(2),o=e(4);r(self,o)},{2:2,4:4}],4:[function(e,t,n){\"use strict\";t.exports=e(25).plugin(e(17)).plugin(e(16)).plugin(e(34)).plugin(e(38))},{16:16,17:17,25:25,34:34,38:38}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window||void 0===window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document&&\"WebkitAppearance\"in document.documentElement.style||\"undefined\"!=typeof window&&window&&window.console&&(console.firebug||console.exception&&console.table)||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){var e;try{e=n.storage.debug}catch(e){}return!e&&void 0!==r&&\"env\"in r&&(e=r.env.DEBUG),e}n=t.exports=e(9),n.log=s,n.formatArgs=i,n.save=a,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(41))},{41:41,9:9}],9:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r);e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),s=0;s<i.length;s++)i[s]=arguments[s];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var a=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(\"string\"==typeof e?e:\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(14),n.names=[],n.skips=[],n.formatters={};var c},{14:14}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function s(e){return\"object\"==typeof e&&null!==e}function a(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||e<0||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,u,c;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||s(this._events.error)&&!this._events.error.length)){if((t=arguments[1])instanceof Error)throw t;var f=new Error('Uncaught, unspecified \"error\" event. ('+t+\")\");throw f.context=t,f}if(n=this._events[e],a(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:i=Array.prototype.slice.call(arguments,1),n.apply(this,i)}else if(s(n))for(i=Array.prototype.slice.call(arguments,1),c=n.slice(),r=c.length,u=0;u<r;u++)c[u].apply(this,i);return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");return this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?s(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,s(this._events[e])&&!this._events[e].warned&&(n=a(this._maxListeners)?r.defaultMaxListeners:this._maxListeners)&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace()),this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,a;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(s(n)){for(a=i;a-- >0;)if(n[a]===t||n[a].listener&&n[a].listener===t){r=a;break}if(r<0)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else if(n)for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){return this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.prototype.listenerCount=function(e){if(this._events){var t=this._events[e];if(o(t))return 1;if(t)return t.length}return 0},r.listenerCount=function(e,t){return e.listenerCount(t)}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var s=0,a=new i(n),u=e.document.createTextNode(\"\");a.observe(u,{characterData:!0}),o=function(){u.data=s=++s%2}}else if(e.setImmediate||void 0===e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var c=new e.MessageChannel;c.port1.onmessage=n,o=function(){c.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function s(e,t,n){p(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function a(e){var t=e&&e.then;if(e&&(\"object\"==typeof e||\"function\"==typeof e)&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,s=c(o);\"error\"===s.status&&n(s.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=new Array(n),s=0,a=-1,u=new this(r);++a<n;)!function(e,r){function a(e){i[r]=e,++s!==n||o||(o=!0,v.resolve(u,i))}t.resolve(e).then(a,function(e){o||(o=!0,v.reject(u,e))})}(e[a],a);return u}function h(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=-1,s=new this(r);++i<n;)!function(e){t.resolve(e).then(function(e){o||(o=!0,v.resolve(s,e))},function(e){o||(o=!0,v.reject(s,e))})}(e[i]);return s}var p=e(11),v={},y=[\"REJECTED\"],g=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===g||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){s(n,this.state===g?e:t,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){s(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){s(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(a,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=g,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],14:[function(e,t,n){function r(e){if(e=String(e),!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,c,\"hour\")||s(e,u,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,u=60*a,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],15:[function(e,t,n){\"use strict\";function r(){this.promise=new l(function(e){e()})}function o(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function i(e,t){return o(e)+o(t)+\"undefined\"}function s(e,t,n,r,o,s){var a,u=i(n,r);if(!o&&(a=e._cachedViews=e._cachedViews||{},a[u]))return a[u];var c=e.info().then(function(i){function c(e){e.views=e.views||{};var n=t;-1===n.indexOf(\"/\")&&(n=t+\"/\"+t);var r=e.views[n]=e.views[n]||{};if(!r[f])return r[f]=!0,e}var f=i.db_name+\"-mrview-\"+(o?\"temp\":y.stringMd5(u));return h.upsert(e,\"_local/\"+s,c).then(function(){return e.registerDependentDatabase(f).then(function(t){var o=t.db;o.auto_compaction=!0;var i={name:f,db:o,sourceDB:e,adapter:e.adapter,mapFun:n,reduceFun:r};return i.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return i.seq=e?e.seq:0,a&&i.db.once(\"destroyed\",function(){delete a[u]}),i})})})});return a&&(a[u]=c),c}function a(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function u(e){return 1===e.length&&/^1-/.test(e[0].rev)}function c(e,t){try{e.emit(\"error\",t)}catch(e){h.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),h.guardedConsole(\"error\",t)}}function f(e,t,n,o){function i(e,t,n){try{t(n)}catch(t){c(e,t)}}function f(e,t,n,r,o){try{return{output:t(n,r,o)}}catch(t){return c(e,t),{error:t}}}function y(e,t){var n=v.collate(e.key,t.key);return 0!==n?n:v.collate(e.value,t.value)}function w(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function k(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function E(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=p.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function S(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&E(t),t}}function O(e,t,n,r){var o=t[e];void 0!==o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function A(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function j(e){return e.group_level=A(e.group_level),e.limit=A(e.limit),e.skip=A(e.skip),e}function I(e){if(e){if(\"number\"!=typeof e)return new g.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new g.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}function D(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(void 0!==e[n]&&void 0!==e[r]&&v.collate(e[n],e[r])>0)throw new g.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&!1!==e.reduce){if(e.include_docs)throw new g.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new g.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=I(e[t]);if(n)throw n})}function x(e,t,n){var r,o=[],i=\"GET\";if(O(\"reduce\",n,o),O(\"include_docs\",n,o),O(\"attachments\",n,o),O(\"limit\",n,o),O(\"descending\",n,o),O(\"group\",n,o),O(\"group_level\",n,o),O(\"skip\",n,o),O(\"stale\",n,o),O(\"conflicts\",n,o),O(\"startkey\",n,o,!0),O(\"start_key\",n,o,!0),O(\"endkey\",n,o,!0),O(\"end_key\",n,o,!0),O(\"inclusive_end\",n,o),O(\"key\",n,o,!0),o=o.join(\"&\"),o=\"\"===o?\"\":\"?\"+o,void 0!==n.keys){var s=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));s.length+o.length+1<=2e3?o+=(\"?\"===o[0]?\"&\":\"?\")+s:(i=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var u=a(t);return e.request({method:i,url:\"_design/\"+u[0]+\"/_view/\"+u[1]+o,body:r}).then(S(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.request({method:\"POST\",url:\"_temp_view\"+o,body:r}).then(S(n))}function C(e,t,n){return new l(function(r,o){e._query(t,n,function(e,t){if(e)return o(e);r(t)})})}function R(e){return new l(function(t,n){e._viewCleanup(function(e,r){if(e)return n(e);t(r)})})}function q(e){return function(t){if(404===t.status)return e;throw t}}function T(e,t,n){function r(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):l.resolve({rows:[]})}function o(e,t){for(var n=[],r=new d.Set,o=0,i=t.rows.length;o<i;o++){var s=t.rows[o],a=s.doc;if(a&&(n.push(a),r.add(a._id),a._deleted=!c.has(a._id),!a._deleted)){var u=c.get(a._id);\"value\"in u&&(a.value=u.value)}}var f=g.mapToKeysArray(c);return f.forEach(function(e){if(!r.has(e)){var t={_id:e},o=c.get(e);\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=g.uniq(f.concat(e.keys)),n.push(e),n}var i=\"_local/doc_\"+e,s={_id:i,keys:[]},a=n.get(e),c=a[0],f=a[1];return function(){return u(f)?l.resolve(s):t.db.get(i).catch(q(s))}().then(function(e){return r(e).then(function(t){return o(e,t)})})}function B(e,t,n){return e.db.get(\"_local/lastSeq\").catch(q({_id:\"_local/lastSeq\",seq:0})).then(function(r){var o=g.mapToKeysArray(t);return l.all(o.map(function(n){return T(n,e,t)})).then(function(t){var o=h.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function L(e){var t=\"string\"==typeof e?e:e.name,n=m[t];return n||(n=m[t]=new r),n}function N(e){return g.sequentialize(L(e),function(){return M(e)})()}function M(e){function n(e,t){var n={id:l._id,key:v.normalizeKey(e)};void 0!==t&&null!==t&&(n.value=v.normalizeKey(t)),f.push(n)}function o(t,n){return function(){return B(e,t,n)}}function s(){return e.sourceDB.changes({conflicts:!0,include_docs:!0,style:\"all_docs\",since:p,limit:b}).then(a)}function a(e){var t=e.results;if(t.length){var n=u(t);if(g.add(o(n,p)),!(t.length<b))return s()}}function u(t){for(var n=new d.Map,r=0,o=t.length;r<o;r++){var s=t[r];if(\"_\"!==s.doc._id[0]){f=[],l=s.doc,l._deleted||i(e.sourceDB,h,l),f.sort(y);var a=c(f);n.set(s.doc._id,[a,s.changes])}p=s.seq}return n}function c(e){for(var t,n=new d.Map,r=0,o=e.length;r<o;r++){var i=e[r],s=[i.key,i.id];r>0&&0===v.collate(i.key,t)&&s.push(r),n.set(v.toIndexableString(s),i),t=i.key}return n}var f,l,h=t(e.mapFun,n),p=e.seq||0,g=new r;return s().then(function(){return g.finish()}).then(function(){e.seq=p})}function $(e,t,r){0===r.group_level&&delete r.group_level;var o=r.group||r.group_level,i=n(e.reduceFun),s=[],a=isNaN(r.group_level)?Number.POSITIVE_INFINITY:r.group_level;t.forEach(function(e){var t=s[s.length-1],n=o?e.key:null;if(o&&Array.isArray(n)&&(n=n.slice(0,a)),t&&0===v.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);s.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var u=0,c=s.length;u<c;u++){var l=s[u],d=f(e.sourceDB,i,l.keys,l.values,!1);if(d.error&&d.error instanceof g.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:w(t,r.limit,r.skip)}}function F(e,t){return g.sequentialize(L(e),function(){return P(e,t)})()}function P(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=v.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?$(e,n,t):{total_rows:o,offset:s,rows:n},t.include_docs){var a=g.uniq(n.map(k));return e.sourceDB.allDocs({keys:a,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t=new d.Map;return e.rows.forEach(function(e){t.set(e.id,e.doc)}),n.forEach(function(e){var n=k(e),r=t.get(n);r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&!1!==t.reduce,s=t.skip||0;if(void 0===t.keys||t.keys.length||(t.limit=0,delete t.keys),void 0!==t.keys){var a=t.keys,u=a.map(function(e){return n({startkey:v.toIndexableString([e]),endkey:v.toIndexableString([e,{}])})});return l.all(u).then(h.flatten).then(r)}var c,f,p={descending:t.descending};if(\"start_key\"in t&&(c=t.start_key),\"startkey\"in t&&(c=t.startkey),\"end_key\"in t&&(f=t.end_key),\"endkey\"in t&&(f=t.endkey),void 0!==c&&(p.startkey=t.descending?v.toIndexableString([c,{}]):v.toIndexableString([c])),void 0!==f){var y=!1!==t.inclusive_end;t.descending&&(y=!y),p.endkey=v.toIndexableString(y?[f,{}]:[f])}if(void 0!==t.key){var m=v.toIndexableString([t.key]),_=v.toIndexableString([t.key,{}]);p.descending?(p.endkey=m,p.startkey=_):(p.startkey=m,p.endkey=_)}return i||(\"number\"==typeof t.limit&&(p.limit=t.limit),p.skip=s),n(p).then(r)}function U(e){return e.request({method:\"POST\",url:\"_view_cleanup\"})}function G(t){return t.get(\"_local/\"+e).then(function(e){var n=new d.Map;Object.keys(e.views).forEach(function(e){var t=a(e),r=\"_design/\"+t[0],o=t[1],i=n.get(r);i||(i=new d.Set,n.set(r,i)),i.add(o)});var r={keys:g.mapToKeysArray(n),include_docs:!0};return t.allDocs(r).then(function(r){var o={};r.rows.forEach(function(t){var r=t.key.substring(8);n.get(t.key).forEach(function(n){var i=r+\"/\"+n;e.views[i]||(i=n);var s=Object.keys(e.views[i]),a=t.doc&&t.doc.views&&t.doc.views[n];s.forEach(function(e){o[e]=o[e]||a})})});var i=Object.keys(o).filter(function(e){return!o[e]}),s=i.map(function(e){return g.sequentialize(L(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return l.all(s).then(function(){return{ok:!0}})})},q({ok:!0}))}function z(t,n,r){if(\"function\"==typeof t._query)return C(t,n,r);if(h.isRemote(t))return x(t,n,r);if(\"string\"!=typeof n)return D(r,n),_.add(function(){return s(t,\"temp_view/temp_view\",n.map,n.reduce,!0,e).then(function(e){return g.fin(N(e).then(function(){return F(e,r)}),function(){return e.db.destroy()})})}),_.finish();var i=n,u=a(i),c=u[0],f=u[1];return t.get(\"_design/\"+c).then(function(n){var a=n.views&&n.views[f];if(!a)throw new g.NotFoundError(\"ddoc \"+n._id+\" has no view named \"+f);return o(n,f),D(r,a),s(t,i,a.map,a.reduce,!1,e).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&h.nextTick(function(){N(e)}),F(e,r)):N(e).then(function(){return F(e,r)})})})}function K(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?j(t):{},\"function\"==typeof e&&(e={map:e});var o=l.resolve().then(function(){return z(r,e,t)});return g.promisedCallback(o,n),o}return{query:K,viewCleanup:g.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?R(e):h.isRemote(e)?U(e):G(e)})}}var l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),d=e(24),h=e(40),p=e(20),v=e(23),y=e(35),g=e(33);r.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},r.prototype.finish=function(){return this.promise};var m={},_=new r,b=50;t.exports=f},{20:20,23:23,24:24,33:33,35:35,37:37,40:40}],16:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){return new p(function(n,r){function o(){f++,e[l++]().then(s,a)}function i(){++d===h?c?r(c):n():u()}function s(){f--,i()}function a(e){f--,c=c||e,i()}function u(){for(;f<t&&l<h;)o()}var c,f=0,l=0,d=0,h=e.length;u()})}function i(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];n.data=m.base64StringToBlobOrBuffer(n.data,n.content_type)})}function s(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function a(e){return e._attachments&&Object.keys(e._attachments)?p.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];if(n.data&&\"string\"!=typeof n.data)return new p(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e\n})})):p.resolve()}function u(e){if(!e.prefix)return!1;var t=v.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}function c(e,t){if(u(t)){var n=t.name.substr(t.prefix.length);e=t.prefix+encodeURIComponent(n)}var r=v.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var o=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=o.pop(),-1===r.db.indexOf(\"%\")&&(r.db=encodeURIComponent(r.db)),r.path=o.join(\"/\"),r}function f(e,t){return l(e,e.db+\"/\"+t)}function l(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function d(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function h(e,t){function n(e,t,n){var r=e.ajax||{},o=v.assign(v.clone(j),r,t),i=v.clone(j.headers||{});return o.headers=v.assign(i,r.headers,t.headers||{}),S.constructor.listeners(\"debug\").length&&S.constructor.emit(\"debug\",[\"http\",o.method,o.url]),S._ajax(o,n)}function r(e,t){return new p(function(r,o){n(e,t,function(e,t){if(e)return o(e);r(t)})})}function u(e,t){return v.adapterFun(e,g(function(e){h().then(function(){return t.apply(this,e)}).catch(function(t){e.pop()(t)})}))}function h(){return e.skipSetup||e.skip_setup?p.resolve():C||(C=r({},{method:\"GET\",url:A}).catch(function(e){return e&&e.status&&404===e.status?(v.explainError(404,\"PouchDB is just detecting if the remote exists.\"),r({},{method:\"PUT\",url:A})):p.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||p.reject(e)}),C.catch(function(){C=null}),C)}function E(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}var S=this,O=c(e.name,e),A=f(O,\"\");e=v.clone(e);var j=e.ajax||{};if(e.auth||O.auth){var I=e.auth||O.auth,D=I.username+\":\"+I.password,x=m.btoa(unescape(encodeURIComponent(D)));j.headers=j.headers||{},j.headers.Authorization=\"Basic \"+x}S._ajax=y;var C;v.nextTick(function(){t(null,S)}),S._remote=!0,S.type=function(){return\"http\"},S.id=u(\"id\",function(e){n({},{method:\"GET\",url:l(O,\"\")},function(t,n){var r=n&&n.uuid?n.uuid+O.db:f(O,\"\");e(null,r)})}),S.request=u(\"request\",function(e,t){e.url=f(O,e.url),n({},e,t)}),S.compact=u(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e),n(e,{url:f(O,\"_compact\"),method:\"POST\"},function(){function n(){S.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0}):setTimeout(n,e.interval||200)})}n()})}),S.bulkGet=v.adapterFun(\"bulkGet\",function(e,t){function r(t){var r={};e.revs&&(r.revs=!0),e.attachments&&(r.attachments=!0),e.latest&&(r.latest=!0),n(e,{url:f(O,\"_bulk_get\"+d(r)),method:\"POST\",body:{docs:e.docs}},t)}function o(){for(var n=w,r=Math.ceil(e.docs.length/n),o=0,s=new Array(r),a=0;a<r;a++){var u=v.pick(e,[\"revs\",\"attachments\",\"latest\"]);u.ajax=j,u.docs=e.docs.slice(a*n,Math.min(e.docs.length,(a+1)*n)),v.bulkGetShim(i,u,function(e){return function(n,i){s[e]=i.results,++o===r&&t(null,{results:v.flatten(s)})}}(a))}}var i=this,s=l(O,\"\"),a=k[s];\"boolean\"!=typeof a?r(function(e,n){e?(k[s]=!1,v.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),o()):(k[s]=!0,t(null,n))}):a?r(t):o()}),S._info=function(e){h().then(function(){n({},{method:\"GET\",url:f(O,\"\")},function(t,n){if(t)return e(t);n.host=f(O,\"\"),e(null,n)})}).catch(e)},S.get=u(\"get\",function(e,t,n){function i(e){function n(n){var o=i[n],a=s(e._id)+\"/\"+E(n)+\"?rev=\"+e._rev;return r(t,{method:\"GET\",url:f(O,a),binary:!0}).then(function(e){return t.binary?e:new p(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete o.stub,delete o.length,o.data=e})}var i=e._attachments,a=i&&Object.keys(i);if(i&&a.length){return o(a.map(function(e){return function(){return n(e)}}),5)}}function a(e){return Array.isArray(e)?p.all(e.map(function(e){if(e.ok)return i(e.ok)})):i(e)}\"function\"==typeof t&&(n=t,t={}),t=v.clone(t);var u={};t.revs&&(u.revs=!0),t.revs_info&&(u.revs_info=!0),t.latest&&(u.latest=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),u.open_revs=t.open_revs),t.rev&&(u.rev=t.rev),t.conflicts&&(u.conflicts=t.conflicts),e=s(e);var c={method:\"GET\",url:f(O,e+d(u))};r(t,c).then(function(e){return p.resolve().then(function(){if(t.attachments)return a(e)}).then(function(){n(null,e)})}).catch(n)}),S.remove=u(\"remove\",function(e,t,r,o){var i;\"string\"==typeof t?(i={_id:e,_rev:t},\"function\"==typeof r&&(o=r,r={})):(i=e,\"function\"==typeof t?(o=t,r={}):(o=r,r=t));var a=i._rev||r.rev;n(r,{method:\"DELETE\",url:f(O,s(i._id))+\"?rev=\"+a},o)}),S.getAttachment=u(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var i=r.rev?\"?rev=\"+r.rev:\"\";n(r,{method:\"GET\",url:f(O,s(e))+\"/\"+E(t)+i,binary:!0},o)}),S.removeAttachment=u(\"removeAttachment\",function(e,t,r,o){n({},{method:\"DELETE\",url:f(O,s(e)+\"/\"+E(t))+\"?rev=\"+r},o)}),S.putAttachment=u(\"putAttachment\",function(e,t,r,o,i,a){\"function\"==typeof i&&(a=i,i=o,o=r,r=null);var u=s(e)+\"/\"+E(t),c=f(O,u);if(r&&(c+=\"?rev=\"+r),\"string\"==typeof o){var l;try{l=m.atob(o)}catch(e){return a(_.createError(_.BAD_ARG,\"Attachment is not a valid base64 string\"))}o=l?m.binaryStringToBlobOrBuffer(l,i):\"\"}n({},{headers:{\"Content-Type\":i},method:\"PUT\",url:c,processData:!1,body:o,timeout:j.timeout||6e4},a)}),S._bulkDocs=function(e,t,r){e.new_edits=t.new_edits,h().then(function(){return p.all(e.docs.map(a))}).then(function(){n(t,{method:\"POST\",url:f(O,\"_bulk_docs\"),timeout:t.timeout,body:e},function(e,t){if(e)return r(e);t.forEach(function(e){e.ok=!0}),r(null,t)})}).catch(r)},S._put=function(e,t,r){h().then(function(){return a(e)}).then(function(){n(t,{method:\"PUT\",url:f(O,s(e._id)),body:e},function(e,t){if(e)return r(e);r(null,t)})}).catch(r)},S.allDocs=u(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e);var n,o={},s=\"GET\";e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),e.include_docs&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.key&&(o.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(o.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(o.endkey=JSON.stringify(e.endkey)),void 0!==e.inclusive_end&&(o.inclusive_end=!!e.inclusive_end),void 0!==e.limit&&(o.limit=e.limit),void 0!==e.skip&&(o.skip=e.skip);var a=d(o);void 0!==e.keys&&(s=\"POST\",n={keys:e.keys}),r(e,{method:s,url:f(O,\"_all_docs\"+a),body:n}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.rows.forEach(i),t(null,n)}).catch(t)}),S._changes=function(e){var t=\"batch_size\"in e?e.batch_size:b;e=v.clone(e),e.timeout=\"timeout\"in e?e.timeout:\"timeout\"in j?j.timeout:3e4;var r,o=e.timeout?{timeout:e.timeout-5e3}:{},s=void 0!==e.limit&&e.limit;r=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var a=s;if(e.style&&(o.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.continuous&&(o.feed=\"longpoll\"),e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),\"heartbeat\"in e?e.heartbeat&&(o.heartbeat=e.heartbeat):e.continuous&&(o.heartbeat=1e4),e.filter&&\"string\"==typeof e.filter&&(o.filter=e.filter),e.view&&\"string\"==typeof e.view&&(o.filter=\"_view\",o.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var u in e.query_params)e.query_params.hasOwnProperty(u)&&(o[u]=e.query_params[u]);var c,l=\"GET\";e.doc_ids?(o.filter=\"_doc_ids\",l=\"POST\",c={doc_ids:e.doc_ids}):e.selector&&(o.filter=\"_selector\",l=\"POST\",c={selector:e.selector});var p,y,g=function(r,i){if(!e.aborted){o.since=r,\"object\"==typeof o.since&&(o.since=JSON.stringify(o.since)),e.descending?s&&(o.limit=a):o.limit=!s||a>t?t:a;var u={method:l,url:f(O,\"_changes\"+d(o)),timeout:e.timeout,body:c};y=r,e.aborted||h().then(function(){p=n(e,u,i)}).catch(i)}},m={results:[]},_=function(n,o){if(!e.aborted){var u=0;if(o&&o.results){u=o.results.length,m.last_seq=o.last_seq;({}).query=e.query_params,o.results=o.results.filter(function(t){a--;var n=v.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&i(t),r&&m.results.push(t),e.onChange(t)),n})}else if(n)return e.aborted=!0,void e.complete(n);o&&o.last_seq&&(y=o.last_seq);var c=s&&a<=0||o&&u<t||e.descending;(!e.continuous||s&&a<=0)&&c?e.complete(null,m):v.nextTick(function(){g(y,_)})}};return g(e.since||0,_),{cancel:function(){e.aborted=!0,p&&p.abort()}}},S.revsDiff=u(\"revsDiff\",function(e,t,r){\"function\"==typeof t&&(r=t,t={}),n(t,{method:\"POST\",url:f(O,\"_revs_diff\"),body:e},r)}),S._close=function(e){e()},S._destroy=function(e,t){n(e,{url:f(O,\"\"),method:\"DELETE\"},function(e,n){if(e&&e.status&&404!==e.status)return t(e);t(null,n)})}}var p=r(e(37)),v=e(40),y=r(e(19)),g=r(e(7)),m=e(20),_=e(30),b=25,w=50,k={};h.valid=function(){return!0};var E=function(e){e.adapter(\"http\",h,!1),e.adapter(\"https\",h,!1)};t.exports=E},{19:19,20:20,30:30,37:37,40:40,7:7}],17:[function(e,t,n){\"use strict\";function r(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(x.createError(x.IDB_ERROR,n,t.type))}}function o(e,t,n){return{data:q.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function i(e){if(!e)return null;var t=q.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function s(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function a(e,t,n,r){n?r(e?\"string\"!=typeof e?e:T.base64StringToBlobOrBuffer(e,t):T.blob([\"\"],{type:t})):e?\"string\"!=typeof e?T.readAsBinaryString(e,function(e){r(T.btoa(e))}):r(e):r(\"\")}function u(e,t,n,r){function o(){++a===s.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest;n.objectStore(M).get(i).onsuccess=function(e){r.body=e.target.result.body,o()}}var s=Object.keys(e._attachments||{});if(!s.length)return r&&r();var a=0;s.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function c(e,t){return R.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return R.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new R(function(s){a(o,i,t,function(t){e.doc._attachments[n]=I.assign(I.pick(r,[\"digest\",\"content_type\"]),{data:t}),s()})})}}))}}))}function f(e,t,n){function r(){--c||o()}function o(){i.length&&i.forEach(function(e){u.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1)).onsuccess=function(t){t.target.result||a.delete(e)}})}var i=[],s=n.objectStore(N),a=n.objectStore(M),u=n.objectStore($),c=e.length;e.forEach(function(e){var n=s.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();s.delete(t),u.index(\"seq\").openCursor(IDBKeyRange.only(t)).onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),u.delete(t.primaryKey),t.continue()}else r()}}})}function l(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}function d(e,t,n,s,a,u){function c(){var e=[L,N,M,P,$,F],t=l(a,e,\"readwrite\");if(t.error)return u(t.error);S=t.txn,S.onabort=r(u),S.ontimeout=r(u),S.oncomplete=y,O=S.objectStore(L),A=S.objectStore(N),I=S.objectStore(M),R=S.objectStore($),q=S.objectStore(F),q.get(F).onsuccess=function(e){B=e.target.result,p()},m(function(e){if(e)return Z=!0,u(e);v()})}function d(){V=!0,p()}function h(){C.processDocs(e.revs_limit,U,s,H,S,W,_,n,d)}function p(){B&&V&&(B.docCount+=Q,q.put(B))}function v(){function e(){++n===U.length&&h()}function t(t){var n=i(t.target.result);n&&H.set(n.id,n),e()}if(U.length)for(var n=0,r=0,o=U.length;r<o;r++){var s=U[r];if(s._id&&C.isLocalId(s._id))e();else{var a=O.get(s.metadata.id);a.onsuccess=t}}}function y(){Z||(G.notify(s._meta.name),u(null,W))}function g(e,t){I.get(e).onsuccess=function(n){if(n.target.result)t();else{var r=x.createError(x.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function m(e){function t(){++o===n.length&&e(r)}var n=[];if(U.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){g(e,function(e){e&&!r&&(r=e),t()})})}function _(e,t,n,r,o,i,s,a){e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;if(u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0),u._attachments&&Object.keys(u._attachments).length)return w(e,t,n,o,s,a);Q+=i,p(),b(e,t,n,o,s,a)}function b(e,t,n,r,i,a){function u(i){var a=e.stemmedRevs||[];r&&s.auto_compaction&&(a=a.concat(D.compactTree(e.metadata))),a&&a.length&&f(a,e.metadata.id,S),h.seq=i.target.result;var u=o(h,t,n);O.put(u).onsuccess=l}function c(e){e.preventDefault(),e.stopPropagation(),A.index(\"_doc_id_rev\").getKey(d._doc_id_rev).onsuccess=function(e){A.put(d,e.target.result).onsuccess=u}}function l(){W[i]={ok:!0,id:h.id,rev:h.rev},H.set(e.metadata.id,e.metadata),k(e,h.seq,a)}var d=e.data,h=e.metadata;d._doc_id_rev=h.id+\"::\"+h.rev,delete d._id,delete d._rev;var p=A.put(d);p.onsuccess=u,p.onerror=c}function w(e,t,n,r,o,i){function s(){c===f.length&&b(e,t,n,r,o,i)}function a(){c++,s()}var u=e.data,c=0,f=Object.keys(u._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)c++,s();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);E(r.digest,o,a)}})}function k(e,t,n){function r(){++o===i.length&&n()}var o=0,i=Object.keys(e.data._attachments||{});if(!i.length)return n();for(var s=0;s<i.length;s++)!function(n){var o=e.data._attachments[n].digest,i=R.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}(i[s])}function E(e,t,n){I.count(e).onsuccess=function(r){if(r.target.result)return n();var o={digest:e,body:t};I.put(o).onsuccess=n}}for(var S,O,A,I,R,q,T,B,U=t.docs,z=0,K=U.length;z<K;z++){var J=U[z];J._id&&C.isLocalId(J._id)||(J=U[z]=C.parseDoc(J,n.new_edits),J.error&&!T&&(T=J))}if(T)return u(T);var V=!1,Q=0,W=new Array(U.length),H=new j.Map,Z=!1,Y=s._meta.blobSupport?\"blob\":\"base64\";C.preprocessAttachments(U,Y,function(e){if(e)return u(e);c()})}function h(e,t,n,r,o){function i(e){f=e.target.result,c&&o(c,f,l)}function s(e){c=e.target.result,f&&o(c,f,l)}function a(){if(!c.length)return o();var n,a=c[c.length-1];if(t&&t.upper)try{n=IDBKeyRange.bound(a,t.upper,!0,t.upperOpen)}catch(e){if(\"DataError\"===e.name&&0===e.code)return o()}else n=IDBKeyRange.lowerBound(a,!0);t=n,c=null,f=null,e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s}function u(e){var t=e.target.result;if(!t)return o();o([t.key],[t.value],t)}var c,f,l,d=\"function\"==typeof e.getAll&&\"function\"==typeof e.getAllKeys&&r>1&&!n;d?(l={continue:a},e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s):n?e.openCursor(t,\"prev\").onsuccess=u:e.openCursor(t).onsuccess=u}function p(e,t,n){function r(e){var t=e.target.result;t?(o.push(t.value),t.continue()):n({target:{result:o}})}if(\"function\"==typeof e.getAll)return void(e.getAll(t).onsuccess=n);var o=[];e.openCursor(t).onsuccess=r}function v(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}function y(e,t,n){function o(t,n,r){var o=t.id+\"::\"+r;$.get(o).onsuccess=function(r){if(n.doc=s(r.target.result),e.conflicts){var o=D.collectConflicts(t);o.length&&(n.doc._conflicts=o)}u(n.doc,e,C)}}function a(t,n){var r={id:n.id,key:n.id,value:{rev:t}},i=n.deleted;\"ok\"===e.deleted?(P.push(r),i?(r.value.deleted=!0,r.doc=null):e.include_docs&&o(n,r,t)):!i&&k--<=0&&(P.push(r),e.include_docs&&o(n,r,t))}function f(e){for(var t=0,n=e.length;t<n&&P.length!==E;t++){var r=e[t],o=i(r);a(o.winningRev,o)}}function d(e,t,n){n&&(f(t),P.length<E&&n.continue())}function y(t){var n=t.target.result;e.descending&&(n=n.reverse()),f(n)}function g(){n(null,{total_rows:R,offset:e.skip,rows:P})}function m(){e.attachments?c(P,e.binary).then(g):g()}var _=\"startkey\"in e&&e.startkey,b=\"endkey\"in e&&e.endkey,w=\"key\"in e&&e.key,k=e.skip||0,E=\"number\"==typeof e.limit?e.limit:-1,S=!1!==e.inclusive_end,O=v(_,b,S,w,e.descending),A=O&&O.error;if(A&&(\"DataError\"!==A.name||0!==A.code))return n(x.createError(x.IDB_ERROR,A.name,A.message));var j=[L,N,F];e.attachments&&j.push(M);var I=l(t,j,\"readonly\");if(I.error)return n(I.error);var C=I.txn;C.oncomplete=m,C.onabort=r(n);var R,q=C.objectStore(L),T=C.objectStore(N),B=C.objectStore(F),$=T.index(\"_doc_id_rev\"),P=[];return B.get(F).onsuccess=function(e){R=e.target.result.docCount},A||0===E?void 0:-1===E?p(q,O,y):void h(q,O,e.descending,E+k,d)}function g(e){return new R(function(t){var n=T.blob([\"\"]);e.objectStore(U).put(n,\"key\").onsuccess=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)},e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)}}).catch(function(){return!1})}function m(e,t){e.objectStore(L).index(\"deletedOrLocal\").count(IDBKeyRange.only(\"0\")).onsuccess=function(e){t(e.target.result)}}function _(e,t,n,r){try{e(t,n)}catch(t){r.emit(\"error\",t)}}function b(){!z&&K.length&&(z=!0,K.shift()())}function w(e,t,n){K.push(function(){e(function(e,r){_(t,e,r,n),z=!1,I.nextTick(function(){b(n)})})}),b()}function k(e,t,n,o){function a(t,n,r){function o(t,n){var r=e.processChange(n,t,e);m=r.seq=t.seq;var o=D(r);if(\"object\"==typeof o)return e.complete(o);o&&(A++,b&&O.push(r),e.attachments&&e.include_docs?u(n,e,w,function(){c([r],e.binary).then(function(){e.onChange(r)})}):e.onChange(r))}function i(){for(var e=0,t=a.length;e<t&&A!==_;e++){var n=a[e];if(n){o(f[e],n)}}A!==_&&r.continue()}if(r&&t.length){var a=new Array(t.length),f=new Array(t.length),l=0;n.forEach(function(e,n){d(s(e),t[n],function(e,r){f[n]=e,a[n]=r,++l===t.length&&i()})})}}function f(e,t,n,r){if(n.seq!==t)return r();if(n.winningRev===e._rev)return r(n,e);var o=e._id+\"::\"+n.winningRev;S.get(o).onsuccess=function(e){r(n,s(e.target.result))}}function d(e,t,n){if(g&&!g.has(e._id))return n();var r=x.get(e._id);if(r)return f(e,t,r,n);E.get(e._id).onsuccess=function(o){r=i(o.target.result),x.set(e._id,r),f(e,t,r,n)}}function p(){e.complete(null,{results:O,last_seq:m})}function v(){!e.continuous&&e.attachments?c(O).then(p):p()}if(e=I.clone(e),e.continuous){var y=n+\":\"+I.uuid();return G.addListener(n,y,t,e),G.notify(n),{cancel:function(){G.removeListener(n,y)}}}var g=e.doc_ids&&new j.Set(e.doc_ids);e.since=e.since||0;var m=e.since,_=\"limit\"in e?e.limit:-1;0===_&&(_=1);var b;b=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var w,k,E,S,O=[],A=0,D=I.filterChange(e),x=new j.Map,C=[L,N];e.attachments&&C.push(M);var R=l(o,C,\"readonly\");if(R.error)return e.complete(R.error);w=R.txn,w.onabort=r(e.complete),w.oncomplete=v,k=w.objectStore(N),E=w.objectStore(L),S=k.index(\"_doc_id_rev\"),h(k,e.since&&!e.descending?IDBKeyRange.lowerBound(e.since,!0):null,e.descending,_,a)}function E(e,t){var n=this;w(function(t){S(n,e,t)},t,n.constructor)}function S(e,t,n){function u(e){var t=e.createObjectStore(L,{keyPath:\"id\"});e.createObjectStore(N,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(M,{keyPath:\"digest\"}),e.createObjectStore(F,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(U),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(P,{keyPath:\"_id\"});var n=e.createObjectStore($,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function c(e,t){var n=e.objectStore(L);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=D.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r.continue()}else t()}}function h(e){e.createObjectStore(P,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function p(e,t){var n=e.objectStore(P),r=e.objectStore(L),o=e.objectStore(N);r.openCursor().onsuccess=function(e){var i=e.target.result;if(i){var s=i.value,a=s.id,u=D.isLocalId(a),c=D.winningRev(s);if(u){var f=a+\"::\"+c,l=a+\"::\",d=a+\"::~\",h=o.index(\"_doc_id_rev\"),p=IDBKeyRange.bound(l,d,!1,!1),v=h.openCursor(p);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o.delete(v.primaryKey),v.continue()}else r.delete(i.primaryKey),i.continue()}}else i.continue()}else t&&t()}}function v(e){var t=e.createObjectStore($,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function _(e,t){var n=e.objectStore(N),r=e.objectStore(M),o=e.objectStore($);r.count().onsuccess=function(e){if(!e.target.result)return t();n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,s=Object.keys(r._attachments||{}),a={},u=0;u<s.length;u++)a[r._attachments[s[u]].digest]=!0;var c=Object.keys(a);for(u=0;u<c.length;u++){var f=c[u];o.put({seq:i,digestSeq:f+\"::\"+i})}n.continue()}}}function b(e){function t(e){return e.data?i(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(N),r=e.objectStore(L);r.openCursor().onsuccess=function(e){function i(){var e=o(a,a.winningRev,a.deleted);r.put(e).onsuccess=function(){s.continue()}}var s=e.target.result;if(s){var a=t(s.value);if(a.winningRev=a.winningRev||D.winningRev(a),a.seq)return i();!function(){var e=a.id+\"::\",t=a.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return a.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t.continue()}}()}}}var w=t.name,E=null;e._meta=null,e._remote=!1,e.type=function(){return\"idb\"},e._id=I.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){d(t,n,r,e,E,o)},e._get=function(e,t,n){function r(){n(u,{doc:o,metadata:a,ctx:c})}var o,a,u,c=t.ctx;if(!c){var f=l(E,[L,N,M],\"readonly\");if(f.error)return n(f.error);c=f.txn}c.objectStore(L).get(e).onsuccess=function(e){if(!(a=i(e.target.result)))return u=x.createError(x.MISSING_DOC,\"missing\"),r();var n;if(t.rev)n=t.latest?D.latest(t.rev,a):t.rev;else{n=a.winningRev;if(D.isDeleted(a))return u=x.createError(x.MISSING_DOC,\"deleted\"),r()}var f=c.objectStore(N),l=a.id+\"::\"+n;f.index(\"_doc_id_rev\").get(l).onsuccess=function(e){if(o=e.target.result,o&&(o=s(o)),!o)return u=x.createError(x.MISSING_DOC,\"missing\"),r();r()}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var s=l(E,[L,N,M],\"readonly\");if(s.error)return o(s.error);i=s.txn}var u=n.digest,c=n.content_type;i.objectStore(M).get(u).onsuccess=function(e){a(e.target.result.body,c,r.binary,function(e){o(null,e)})}},e._info=function(t){var n,r,o=l(E,[F,N],\"readonly\");if(o.error)return t(o.error);var i=o.txn;i.objectStore(F).get(F).onsuccess=function(e){r=e.target.result.docCount},i.objectStore(N).openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result;n=t?t.key:0},i.oncomplete=function(){t(null,{doc_count:r,update_seq:n,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(e,t){y(e,E,t)},e._changes=function(t){k(t,e,w,E)},e._close=function(e){E.close(),J.delete(w),e()},e._getRevisionTree=function(e,t){var n=l(E,[L],\"readonly\");if(n.error)return t(n.error);n.txn.objectStore(L).get(e).onsuccess=function(e){var n=i(e.target.result);n?t(null,n.rev_tree):t(x.createError(x.MISSING_DOC))}},e._doCompaction=function(e,t,n){var s=[L,N,M,$],a=l(E,s,\"readwrite\");if(a.error)return n(a.error);var u=a.txn;u.objectStore(L).get(e).onsuccess=function(n){var r=i(n.target.result);D.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var s=n+\"-\"+r;-1!==t.indexOf(s)&&(i.status=\"missing\")}),f(t,e,u);var s=r.winningRev,a=r.deleted;u.objectStore(L).put(o(r,s,a))},u.onabort=r(n),u.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=l(E,[P],\"readonly\");if(n.error)return t(n.error);var o=n.txn,i=o.objectStore(P).get(e);i.onerror=r(t),i.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(x.createError(x.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var o=e._rev,i=e._id;e._rev=o?\"0-\"+(parseInt(o.split(\"-\")[1],10)+1):\"0-1\";var s,a=t.ctx;if(!a){var u=l(E,[P],\"readwrite\");if(u.error)return n(u.error);a=u.txn,a.onerror=r(n),a.oncomplete=function(){s&&n(null,s)}}var c,f=a.objectStore(P);o?(c=f.get(i),c.onsuccess=function(r){var i=r.target.result;if(i&&i._rev===o){f.put(e).onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)}}else n(x.createError(x.REV_CONFLICT))}):(c=f.add(e),c.onerror=function(e){n(x.createError(x.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},c.onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var o=t.ctx;if(!o){var i=l(E,[P],\"readwrite\");if(i.error)return n(i.error);o=i.txn,o.oncomplete=function(){s&&n(null,s)}}var s,a=e._id,u=o.objectStore(P),c=u.get(a);c.onerror=r(n),c.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(u.delete(a),s={ok:!0,id:a,rev:\"0-0\"},t.ctx&&n(null,s)):n(x.createError(x.MISSING_DOC))}},e._destroy=function(e,t){G.removeAllListeners(w);var n=V.get(w);n&&n.result&&(n.result.close(),J.delete(w));var o=indexedDB.deleteDatabase(w);o.onsuccess=function(){V.delete(w),I.hasLocalStorage()&&w in localStorage&&delete localStorage[w],t(null,{ok:!0})},o.onerror=r(t)};var S=J.get(w);if(S)return E=S.idb,e._meta=S.global,I.nextTick(function(){n(null,e)});var j;j=t.storage?O(w,t.storage):indexedDB.open(w,B),V.set(w,j),j.onupgradeneeded=function(e){function t(){var e=o[i-1];i++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return u(n);var r=e.currentTarget.transaction;e.oldVersion<3&&h(n),e.oldVersion<4&&v(n);var o=[c,p,_,b],i=e.oldVersion;t()},j.onsuccess=function(t){function r(){void 0!==a&&f&&(e._meta={name:w,instanceId:u,blobSupport:a},J.set(w,{idb:E,global:e._meta}),n(null,e))}function o(){if(void 0!==s&&void 0!==i){var e=w+\"_id\";e in i?u=i[e]:i[e]=u=I.uuid(),i.docCount=s,c.objectStore(F).put(i)}}E=t.target.result,E.onversionchange=function(){E.close(),J.delete(w)},E.onabort=function(e){I.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),E.close(),J.delete(w)};var i,s,a,u,c=E.transaction([F,U,L],\"readwrite\"),f=!1;c.objectStore(F).get(F).onsuccess=function(e){i=e.target.result||{id:F},o()},m(c,function(e){s=e,o()}),A||(A=g(c)),A.then(function(e){a=e,r()}),c.oncomplete=function(){f=!0,r()}},j.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";I.guardedConsole(\"error\",e),n(x.createError(x.IDB_ERROR,e))}}function O(e,t){try{return indexedDB.open(e,{version:B,storage:t})}catch(t){return indexedDB.open(e,B)}}var A,j=e(24),I=e(40),D=e(36),x=e(30),C=e(18),R=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),q=e(32),T=e(20),B=5,L=\"document-store\",N=\"by-sequence\",M=\"attach-store\",$=\"attach-seq-store\",F=\"meta-store\",P=\"local-store\",U=\"detect-blob-support\",G=new I.changesHandler,z=!1,K=[],J=new j.Map,V=new j.Map;E.valid=function(){return!(\"undefined\"!=typeof openDatabase&&/(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)&&!/BlackBerry/.test(navigator.platform))&&\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange};var Q=function(e){e.adapter(\"idb\",E,!0)};t.exports=Q},{18:18,20:20,24:24,30:30,32:32,36:36,37:37,40:40}],18:[function(e,t,n){\"use strict\";function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function o(e){if(!/^\\d+\\-./.test(e))return y.createError(y.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function i(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,s=r.length;i<s;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function s(e,t){var n,r,s,a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=v.uuid()),r=v.uuid(32,16).toLowerCase(),e._rev){if(s=o(e._rev),s.error)return s;e._rev_tree=[{pos:s.prefix,ids:[s.id,{status:\"missing\"},[[r,a,[]]]]}],n=s.prefix+1}else e._rev_tree=[{pos:1,ids:[r,a,[]]}],n=1;else if(e._revisions&&(e._rev_tree=i(e._revisions,a),n=e._revisions.start,r=e._revisions.ids[0]),!e._rev_tree){if(s=o(e._rev),s.error)return s;n=s.prefix,r=s.id,e._rev_tree=[{pos:n,ids:[r,a,[]]}]}v.invalidIdError(e._id),e._rev=n+\"-\"+r;var u={metadata:{},data:{}};for(var c in e)if(Object.prototype.hasOwnProperty.call(e,c)){var f=\"_\"===c[0];if(f&&!w[c]){var l=y.createError(y.DOC_VALIDATION,c);throw l.message=y.DOC_VALIDATION.message+\": \"+c,l}f&&!k[c]?u.metadata[c.slice(1)]=e[c]:u.data[c]=e[c]}return u}function a(e){try{return m.atob(e)}catch(e){var t=y.createError(y.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:t}}}function u(e,t,n){var r=a(e.data);if(r.error)return n(r.error);e.length=r.length,e.data=\"blob\"===t?m.binaryStringToBlobOrBuffer(r,e.content_type):\"base64\"===t?m.btoa(r):r,_.binaryMd5(r,function(t){e.digest=\"md5-\"+t,n()})}function c(e,t,n){_.binaryMd5(e.data,function(r){e.digest=\"md5-\"+r,e.length=e.data.size||e.data.length||0,\"binary\"===t?m.blobOrBufferToBinaryString(e.data,function(t){e.data=t,n()}):\"base64\"===t?m.blobOrBufferToBase64(e.data,function(t){e.data=t,n()}):n()})}function f(e,t,n){if(e.stub)return n();\"string\"==typeof e.data?u(e,t,n):c(e,t,n)}function l(e,t,n){function r(){i++,e.length===i&&(o?n(o):n())}if(!e.length)return n();var o,i=0;e.forEach(function(e){function n(e){o=e,++s===i.length&&r()}var i=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],s=0;if(!i.length)return r();for(var a in e.data._attachments)e.data._attachments.hasOwnProperty(a)&&f(e.data._attachments[a],t,n)})}function d(e,t,n,r,o,i,a,u){if(g.revExists(t.rev_tree,n.metadata.rev))return r[o]=n,i();var c=t.winningRev||g.winningRev(t),f=\"deleted\"in t?t.deleted:g.isDeleted(t,c),l=\"deleted\"in n.metadata?n.metadata.deleted:g.isDeleted(n.metadata),d=/^1-/.test(n.metadata.rev);if(f&&!l&&u&&d){var h=n.data;h._rev=c,h._id=n.metadata.id,n=s(h,u)}var p=g.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(u&&(f&&l&&\"new_leaf\"!==p.conflicts||!f&&\"new_leaf\"!==p.conflicts||f&&!l&&\"new_branch\"===p.conflicts)){var v=y.createError(y.REV_CONFLICT);return r[o]=v,i()}var m=n.metadata.rev;n.metadata.rev_tree=p.tree,n.stemmedRevs=p.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var _,b=g.winningRev(n.metadata),w=g.isDeleted(n.metadata,b),k=f===w?0:f<w?-1:1;_=m===b?w:g.isDeleted(n.metadata,m),a(n,b,w,_,!0,k,o,i)}function h(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function p(e,t,n,r,o,i,s,a,u){function c(e,t,n){var r=g.winningRev(e.metadata),o=g.isDeleted(e.metadata,r);if(\"was_delete\"in a&&o)return i[t]=y.createError(y.MISSING_DOC,\"deleted\"),n();if(l&&h(e)){var u=y.createError(y.REV_CONFLICT);return i[t]=u,n()}s(e,r,o,o,!1,o?0:1,t,n)}function f(){++v===m&&u&&u()}e=e||1e3;var l=a.new_edits,p=new b.Map,v=0,m=t.length;t.forEach(function(e,t){if(e._id&&g.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,f()})}var s=e.metadata.id;p.has(s)?(m--,p.get(s).push([e,t])):p.set(s,[[e,t]])}),p.forEach(function(t,n){function o(){++u<t.length?a():f()}function a(){var a=t[u],f=a[0],h=a[1];if(r.has(n))d(e,r.get(n),f,i,h,o,s,l);else{var p=g.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=p.tree,f.stemmedRevs=p.stemmedRevs||[],c(f,h,o)}}var u=0;a()})}Object.defineProperty(n,\"__esModule\",{value:!0});var v=e(40),y=e(30),g=e(36),m=e(20),_=e(35),b=e(24),w=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),k=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"])\n;n.invalidIdError=v.invalidIdError,n.isDeleted=g.isDeleted,n.isLocalId=g.isLocalId,n.normalizeDdocFunctionName=v.normalizeDdocFunctionName,n.parseDdocFunctionName=v.parseDdocFunctionName,n.parseDoc=s,n.preprocessAttachments=l,n.processDocs=p,n.updateDoc=d},{20:20,24:24,30:30,35:35,36:36,40:40}],19:[function(e,t,n){\"use strict\";function r(){for(var e={},t=new l(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,l.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){e.resolve(t)}).catch(function(t){e.reject(t)}),e}function o(e,t){var n,o,i,s=new Headers,a={method:e.method,credentials:\"include\",headers:s};return e.json&&(s.set(\"Accept\",\"application/json\"),s.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.processData&&\"string\"!=typeof e.body?a.body=JSON.stringify(e.body):a.body=\"body\"in e?e.body:null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&s.set(t,e.headers[t])}),n=r(e.url,a),e.timeout>0&&(o=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(o),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):(e.status=i.statusCode,t(e))}).catch(function(e){e||(e=new Error(\"canceled\")),t(e)}),{abort:n.reject}}function i(e,t){var n,r,o=!1,i=function(){n.abort(),u()},s=function(){o=!0,n.abort(),u()},a={abort:i},u=function(){clearTimeout(r),a.abort=function(){},n&&(n.onprogress=void 0,n.upload&&(n.upload.onprogress=void 0),n.onreadystatechange=void 0,n=void 0)};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(e){return t(new Error(e.name||\"Url is invalid\"))}n.withCredentials=!(\"withCredentials\"in e)||e.withCredentials,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var c in e.headers)e.headers.hasOwnProperty(c)&&n.setRequestHeader(c,e.headers[c]);return e.timeout>0&&(r=setTimeout(s,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(s,e.timeout))},void 0!==n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?d.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var s={};if(o)s=new Error(\"ETIMEDOUT\"),s.code=\"ETIMEDOUT\";else if(\"string\"==typeof n.response)try{s=JSON.parse(n.response)}catch(e){}s.status=n.status,t(s)}u()}},e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),a}function s(e,t){return p||e.xhr?i(e,t):o(e,t)}function a(){return\"\"}function u(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(e){return r(e)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?h.generateErrorFromResponse(e):e})),e.binary&&v(t,n),r(null,t,n)}e=f.clone(e);var r={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=f.assign(r,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),s(e,function(r,o,i){if(r)return t(h.generateErrorFromResponse(r));var s,u=o.headers&&o.headers[\"content-type\"],c=i||a();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof c&&(/json/.test(u)||/^[\\s]*\\{/.test(c)&&/\\}[\\s]*$/.test(c)))try{c=JSON.parse(c.toString())}catch(e){}o.statusCode>=200&&o.statusCode<300?n(c,o,t):(s=h.generateErrorFromResponse(c),s.status=o.statusCode,t(s))})}function c(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=-1!==n.indexOf(\"safari\")&&-1===n.indexOf(\"chrome\"),o=-1!==n.indexOf(\"msie\"),i=-1!==n.indexOf(\"edge\"),s=r||(o||i)&&\"GET\"===e.method,a=!(\"cache\"in e)||e.cache;if(!/^blob:/.test(e.url)&&(s||!a)){var c=-1!==e.url.indexOf(\"?\");e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return u(e,t)}var f=e(40),l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),d=e(20),h=e(30),p=function(){try{return new XMLHttpRequest,!0}catch(e){return!1}}(),v=function(){};t.exports=c},{20:20,30:30,37:37,40:40}],20:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function s(e,t){return i(h(e),t)}function a(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){if(\"undefined\"==typeof FileReader)return t(a((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(a(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=s,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],21:[function(e,t,n){\"use strict\";function r(e){return l.scopeEval('\"use strict\";\\nreturn '+e+\";\",{})}function o(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return l.scopeEval(t,{})}function i(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){var n=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+n+'\"'))}t()}function s(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=l.normalizeDdocFunctionName(e.view):e.filter=l.normalizeDdocFunctionName(e.filter))}function a(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!l.isRemote(e.db)}function u(e,t){var n=t.complete;if(\"_view\"===t.filter){if(!t.view||\"string\"!=typeof t.view){var i=f.createError(f.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(i)}var s=l.parseDdocFunctionName(t.view);e.db.get(\"_design/\"+s[0],function(r,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(f.generateErrorFromResponse(r));var a=i&&i.views&&i.views[s[1]]&&i.views[s[1]].map;if(!a)return n(f.createError(f.MISSING_DOC,i.views?\"missing json key: \"+s[1]:\"missing json key: views\"));t.filter=o(a),e.doChanges(t)})}else if(t.selector)t.filter=function(e){return d.matchesSelector(e,t.selector)},e.doChanges(t);else{var a=l.parseDdocFunctionName(t.filter);e.db.get(\"_design/\"+a[0],function(o,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(o)return n(f.generateErrorFromResponse(o));var s=i&&i.filters&&i.filters[a[1]];if(!s)return n(f.createError(f.MISSING_DOC,i&&i.filters?\"missing json key: \"+a[1]:\"missing json key: filters\"));t.filter=r(s),e.doChanges(t)})}}function c(e){e._changesFilterPlugin={validate:i,normalize:s,shouldFilter:a,filter:u}}var f=e(30),l=e(40),d=e(39);t.exports=c},{30:30,39:39,40:40}],22:[function(e,t,n){\"use strict\";function r(e,t,n,o,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"!==e.adapter&&\"https\"!==e.adapter||f.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:o,_id:t,history:[],replicator:h,version:d};throw n}).then(function(s){if(!i.cancelled&&s.last_seq!==n)return s.history=(s.history||[]).filter(function(e){return e.session_id!==o}),s.history.unshift({last_seq:n,session_id:o}),s.history=s.history.slice(0,p),s.version=d,s.replicator=h,s.session_id=o,s.last_seq=n,e.put(s).catch(function(s){if(409===s.status)return r(e,t,n,o,i);throw s})})}function o(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function i(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:s(e.history,t.history)}function s(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);return n&&0!==t.length?a(n.session_id,t)?{last_seq:n.last_seq,history:e}:a(o.session_id,r)?{last_seq:o.last_seq,history:i}:s(r,i):{last_seq:v,history:[]}}function a(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||a(e,r))}function u(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var c=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),f=e(40),l=e(23),d=1,h=\"pouchdb\",p=5,v=0;o.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},o.prototype.updateTarget=function(e,t){return r(this.target,this.id,e,t,this.returnValue)},o.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?c.resolve(!0):r(this.src,this.id,e,t,this.returnValue).catch(function(e){if(u(e))return n.readOnlySource=!0,!0;throw e})};var y={undefined:function(e,t){return 0===l.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return i(t,e).last_seq}};o.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?c.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return v;var n;return n=t.version?t.version.toString():\"undefined\",n in y?y[n](t,e):v},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:v}).then(function(){return v},function(n){return u(n)?(e.readOnlySource=!0,t.last_seq):v});throw n})}).catch(function(e){if(404!==e.status)throw e;return v})},t.exports=o},{23:23,37:37,40:40}],23:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){return r(e,t,n)+e}function i(e,t){if(e===t)return 0;e=s(e),t=s(t);var n=v(e),r=v(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return h(e,t)}return Array.isArray(e)?d(e,t):p(e,t)}function s(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=s(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];void 0!==i&&(e[o]=s(i))}}}}return e}function a(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return y(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=u(n[r]);else for(;++r<o;){var s=n[r];i+=u(s)+u(e[s])}return i}return\"\"}function u(e){return e=s(e),v(e)+_+a(e)+\"\\0\"}function c(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",s=e.substring(t,t+m),a=parseInt(s,10)+g;for(o&&(a=-a),t+=m;;){var u=e[t];if(\"\\0\"===u)break;i+=u,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==a&&(n=parseFloat(n+\"e\"+a))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var s=e.pop();o[s]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=c(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var s=\"\";;){var a=e[r];if(\"\\0\"===a)break;s+=a,r++}s=s.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(s);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function h(e,t){return e===t?0:e>t?1:-1}function p(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),s=0;s<o;s++){var a=i(n[s],r[s]);if(0!==a)return a;if(0!==(a=i(e[n[s]],t[r[s]])))return a}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function y(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",s=(r?-n:n)-g,a=o(s.toString(),\"0\",m);i+=_+a;var u=Math.abs(parseFloat(t[0]));r&&(u=10-u);var c=u.toFixed(20);return c=c.replace(/\\.?0+$/,\"\"),i+=_+c}Object.defineProperty(n,\"__esModule\",{value:!0});var g=-324,m=3,_=\"\";n.collate=i,n.normalizeKey=s,n.toIndexableString=u,n.parseIndexableString=l},{}],24:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this._store={}}function s(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n],s=this._store[i];i=o(i),e(s,i)}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),s.prototype.add=function(e){return this._store.set(e,!0)},s.prototype.has=function(e){return this._store.has(e)},s.prototype.forEach=function(e){this._store.forEach(function(t,n){e(n)})},Object.defineProperty(s.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=s,n.Map=i):(n.Set=Set,n.Map=Map)},{}],25:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){try{e.emit(\"change\",t)}catch(e){b.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}function i(e,t,n){function r(){i.cancel()}S.EventEmitter.call(this);var i=this;this.db=e,t=t?b.clone(t):{};var s=t.complete=b.once(function(t,n){t?b.listenerCount(i,\"error\")>0&&i.emit(\"error\",t):i.emit(\"complete\",n),i.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(i.on(\"complete\",function(e){n(null,e)}),i.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){i.isCancelled||o(i,e)};var a=new E(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});i.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=a.then.bind(a),this.catch=a.catch.bind(a),this.then(function(e){s(null,e)},s),e.taskqueue.isReady?i.validateChanges(t):e.taskqueue.addTask(function(e){e?t.complete(e):i.isCancelled?i.emit(\"cancel\"):i.validateChanges(t)})}function s(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=A.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return A.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=A.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function a(e,t){return e<t?-1:e>t?1:0}function u(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function c(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=b.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function f(e,t){var n=a(e._id,t._id);return 0!==n?n:a(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function l(e){var t={},n=[];return A.traverseRevTree(e,function(e,r,o,i){var s=r+\"-\"+o;return e&&(t[s]=0),void 0!==i&&n.push({from:i,to:s}),s}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function d(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return E.all(r.map(function(n){var r=b.assign({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new E(function(t,i){e._allDocs(r,function(e,r){if(e)return i(e);o.total_rows=r.total_rows,t(r.rows[0]||{key:n,error:\"not_found\"})})})})).then(function(e){return o.rows=e,o})}function h(e){var t=e._compactionQueue[0],n=t.opts,r=t.callback;e.get(\"_local/compaction\").catch(function(){return!1}).then(function(t){t&&t.last_seq&&(n.last_seq=t.last_seq),e._compact(n,function(t,n){t?r(t):r(null,n),b.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&h(e)})})})}function p(e){return\"_\"===e.charAt(0)&&e+\" is not a valid attachment name, attachment names cannot start with '_'\"}function v(){S.EventEmitter.call(this)}function y(){this.isReady=!1,this.failed=!1,this.queue=[]}function g(e,t){var n=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=_.adapters,o=_.preferredAdapters,i=_.prefix,s=t.adapter;if(!s)for(var a=0;a<o.length;++a){s=o[a];{if(!(\"idb\"===s&&\"websql\"in r&&b.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]))break;b.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.')}}var u=r[s];return{name:u&&\"use_prefix\"in u&&!u.use_prefix?e:i+e,adapter:s}}function m(e){function t(){e.removeListener(\"closed\",r),e.constructor.emit(\"destroyed\",e.name)}function n(){e.removeListener(\"destroyed\",t),e.removeListener(\"closed\",r),e.emit(\"destroyed\")}function r(){e.removeListener(\"destroyed\",t),o.delete(e.name)}var o=e.constructor._destructionListeners;e.once(\"destroyed\",t),e.once(\"closed\",r),o.has(e.name)||o.set(e.name,[]),o.get(e.name).push(n)}function _(e,t){if(!(this instanceof _))return new _(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(t=e,e=t.name,delete t.name),this.__opts=t=b.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=_.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=(t.prefix||\"\")+e,o=g(r,t);if(t.name=o.name,t.adapter=t.adapter||o.adapter,n.name=e,n._adapter=t.adapter,_.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!_.adapters[t.adapter]||!_.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);v.call(n),n.taskqueue=new y,n.adapter=t.adapter,_.adapters[t.adapter].call(n,t,function(e){if(e)return n.taskqueue.fail(e);m(n),n.emit(\"created\",n),_.emit(\"created\",n.name),n.taskqueue.ready(n)})}var b=e(40),w=e(24),k=r(e(12)),E=r(e(37)),S=e(10),O=r(e(7)),A=e(36),j=e(30),I=r(e(26)),D=r(e(21));k(i,S.EventEmitter),i.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},i.prototype.validateChanges=function(e){var t=e.complete,n=this;_._changesFilterPlugin?_._changesFilterPlugin.validate(e,function(r){if(r)return t(r);n.doChanges(e)}):n.doChanges(e)},i.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=b.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=s,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){if(t.isCancelled)return void n(null,{status:\"cancelled\"});e.since=r.update_seq,t.doChanges(e)},n);if(_._changesFilterPlugin){if(_._changesFilterPlugin.normalize(e),_._changesFilterPlugin.shouldFilter(this,e))return _._changesFilterPlugin.filter(this,e)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(t){t in e&&b.guardedConsole(\"warn\",'The \"'+t+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=O(function(e){r.cancel(),o.apply(this,e)})}},k(v,S.EventEmitter),v.prototype.post=b.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(j.createError(j.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,u(n))}),v.prototype.put=b.adapterFun(\"put\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(j.createError(j.NOT_AN_OBJECT)):(b.invalidIdError(e._id),A.isLocalId(e._id)&&\"function\"==typeof this._putLocal?e._deleted?this._removeLocal(e,n):this._putLocal(e,n):void(\"function\"==typeof this._put&&!1!==t.new_edits?this._put(e,t,n):this.bulkDocs({docs:[e]},t,u(n))))}),v.prototype.putAttachment=b.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},s.put(e)}var s=this;return\"function\"==typeof o&&(o=r,r=n,n=null),void 0===o&&(o=r,r=n,n=null),o||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e,\"is missing content_type\"),s.get(e).then(function(e){if(e._rev!==n)throw j.createError(j.REV_CONFLICT);return i(e)},function(t){if(t.reason===j.MISSING_DOC.message)return i({_id:e});throw t})}),v.prototype.removeAttachment=b.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(j.createError(j.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),v.prototype.remove=b.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};if(i._deleted=!0,A.isLocalId(i._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[i]},n,u(r))}),v.prototype.revsDiff=b.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){a.has(e)||a.set(e,{missing:[]}),a.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);A.traverseRevTree(n,function(e,n,i,s,a){var u=n+\"-\"+i,c=o.indexOf(u);-1!==c&&(o.splice(c,1),\"available\"!==a.status&&r(t,u))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var s=0,a=new w.Map;i.map(function(t){this._getRevisionTree(t,function(r,u){if(r&&404===r.status&&\"missing\"===r.message)a.set(t,{missing:e[t]});else{if(r)return n(r);o(t,u)}if(++s===i.length){var c={};return a.forEach(function(e,t){c[t]=e}),n(null,c)}})},this)}),v.prototype.bulkGet=b.adapterFun(\"bulkGet\",function(e,t){b.bulkGetShim(this,e,t)}),v.prototype.compactDocument=b.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var s=l(i),a=[],u=[];Object.keys(s).forEach(function(e){s[e]>t&&a.push(e)}),A.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(i)&&u.push(i)}),r._doCompaction(e,u,n)})}),v.prototype.compact=b.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&h(n)}),v.prototype._compact=function(e,t){function n(e){s.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;E.all(s).then(function(){return b.upsert(o,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<n)&&(e.last_seq=n,e)})}).then(function(){t(null,{ok:!0})}).catch(t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},s=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},v.prototype.get=b.adapterFun(\"get\",function(e,t,n){function r(){var r=[],s=o.length;if(!s)return n(null,r);o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,latest:t.latest,attachments:t.attachments},function(e,t){if(e)r.push({missing:o});else{for(var i,a=0,u=r.length;a<u;a++)if(r[a].ok&&r[a].ok._rev===t._rev){i=!0;break}i||r.push({ok:t})}--s||n(null,r)})})}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(j.createError(j.INVALID_ID));if(A.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,s=r.metadata,a=r.ctx;if(t.conflicts){var u=A.collectConflicts(s);u.length&&(o._conflicts=u)}if(A.isDeleted(s,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){for(var c=o._rev.split(\"-\"),f=parseInt(c[0],10),l=c[1],d=A.rootToLeaf(s.rev_tree),h=null,p=0;p<d.length;p++){var v=d[p],y=v.ids.map(function(e){return e.id}).indexOf(l);(y===f-1||!h&&-1!==y)&&(h=v)}var g=h.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,m=h.ids.length-g;if(h.ids.splice(g,m),h.ids.reverse(),t.revs&&(o._revisions={start:h.pos+h.ids.length-1,ids:h.ids.map(function(e){return e.id})}),t.revs_info){var _=h.pos+h.ids.length;o._revs_info=h.ids.map(function(e){return _--,{rev:_+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var b=o._attachments,w=Object.keys(b).length;if(0===w)return n(null,o);Object.keys(b).forEach(function(e){this._getAttachment(o._id,e,b[e],{rev:o._rev,binary:t.binary,ctx:a},function(t,r){var i=o._attachments[e];i.data=r,delete i.stub,delete i.length,--w||n(null,o)})},i)}else{if(o._attachments)for(var k in o._attachments)o._attachments.hasOwnProperty(k)&&(o._attachments[k].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){if(e)return n(e);o=A.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(t.open_revs))return n(j.createError(j.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var s=0;s<o.length;s++){var a=o[s];if(\"string\"!=typeof a||!/^\\d+-/.test(a))return n(j.createError(j.INVALID_REV))}r()}}),v.prototype.getAttachment=b.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,s){return i?r(i):s.doc._attachments&&s.doc._attachments[t]?(n.ctx=s.ctx,n.binary=!0,o._getAttachment(e,t,s.doc._attachments[t],n,r),void 0):r(j.createError(j.MISSING_DOC))})}),v.prototype.allDocs=b.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=void 0!==e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(j.createError(j.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!b.isRemote(this))return d(this,e,t)}return this._allDocs(e,t)}),v.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new i(this,e,t)},v.prototype.close=b.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),v.prototype.info=b.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){if(n)return e(n);r.db_name=r.db_name||t.name,r.auto_compaction=!(!t.auto_compaction||b.isRemote(t)),r.adapter=t.adapter,e(null,r)})}),v.prototype.id=b.adapterFun(\"id\",function(e){return this._id(e)}),v.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},v.prototype.bulkDocs=b.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(j.createError(j.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(j.createError(j.NOT_AN_OBJECT));var o;if(e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(t){o=o||p(t),e._attachments[t].content_type||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e._id,\"is missing content_type\")})}),o)return n(j.createError(j.BAD_REQUEST,o));\"new_edits\"in t||(t.new_edits=!(\"new_edits\"in e)||e.new_edits);var i=this;t.new_edits||b.isRemote(i)||e.docs.sort(f),c(e.docs);var s=e.docs.map(function(e){return e._id});return this._bulkDocs(e,t,function(e,r){if(e)return n(e);if(t.new_edits||(r=r.filter(function(e){return e.error})),!b.isRemote(i))for(var o=0,a=r.length;o<a;o++)r[o].id=r[o].id||s[o];n(null,r)})}),v.prototype.registerDependentDatabase=b.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},!t.dependentDbs[e]&&(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);b.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})}).catch(t)}),v.prototype.destroy=b.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){if(e)return t(e);r._destroyed=!0,r.emit(\"destroyed\"),t(null,n||{ok:!0})})}\"function\"==typeof e&&(t=e,e={});var r=this,o=!(\"use_prefix\"in r)||r.use_prefix;if(b.isRemote(r))return n();r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var s=i.dependentDbs,a=r.constructor,u=Object.keys(s).map(function(e){var t=o?e.replace(new RegExp(\"^\"+a.prefix),\"\"):e;return new a(t,r.__opts).destroy()});E.all(u).then(n,t)})}),y.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},y.prototype.fail=function(e){this.failed=e,this.execute()},y.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},y.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},k(_,v),_.adapters={},_.preferredAdapters=[],_.prefix=\"_pouch_\";var x=new S.EventEmitter;!function(e){Object.keys(S.EventEmitter.prototype).forEach(function(t){\"function\"==typeof S.EventEmitter.prototype[t]&&(e[t]=x[t].bind(x))});var t=e._destructionListeners=new w.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t.delete(e)})}(_),_.adapter=function(e,t,n){t.valid()&&(_.adapters[e]=t,n&&_.preferredAdapters.push(e))},_.plugin=function(e){if(\"function\"==typeof e)e(_);else{if(\"object\"!=typeof e||0===Object.keys(e).length)throw new Error('Invalid plugin: got \"'+e+'\", expected an object or a function');Object.keys(e).forEach(function(t){_.prototype[t]=e[t]})}return this.__defaults&&(_.__defaults=b.assign({},this.__defaults)),_},_.defaults=function(e){function t(e,n){if(!(this instanceof t))return new t(e,n);n=n||{},e&&\"object\"==typeof e&&(n=e,e=n.name,delete n.name),n=b.assign({},t.__defaults,n),_.call(this,e,n)}return k(t,_),t.preferredAdapters=_.preferredAdapters.slice(),Object.keys(_).forEach(function(e){e in t||(t[e]=_[e])}),\nt.__defaults=b.assign({},this.__defaults,e),t};_.plugin(I),_.plugin(D),_.version=\"6.2.0\",t.exports=_},{10:10,12:12,21:21,24:24,26:26,30:30,36:36,37:37,40:40,7:7}],26:[function(e,t,n){\"use strict\";function r(e){e.debug=o;var t={};e.on(\"debug\",function(e){var n=e[0],r=e.slice(1);t[n]||(t[n]=o(\"pouchdb:\"+n)),t[n].apply(null,r)})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(27));t.exports=r},{27:27}],27:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window||void 0===window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document&&\"WebkitAppearance\"in document.documentElement.style||\"undefined\"!=typeof window&&window&&window.console&&(console.firebug||console.exception&&console.table)||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){try{return n.storage.debug}catch(e){}if(void 0!==r&&\"env\"in r)return r.env.DEBUG}n=t.exports=e(28),n.log=s,n.formatArgs=i,n.save=a,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(41))},{28:28,41:41}],28:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r);e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),s=0;s<i.length;s++)i[s]=arguments[s];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var a=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(29),n.names=[],n.skips=[],n.formatters={};var c},{29:29}],29:[function(e,t,n){function r(e){if(e=String(e),!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,c,\"hour\")||s(e,u,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,u=60*a,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],30:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}function o(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=r.prototype,new n(t)}function i(e){if(\"object\"!=typeof e){var t=e;e=p,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0}),function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(12))(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var s=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),a=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),u=new r(404,\"not_found\",\"missing\"),c=new r(409,\"conflict\",\"Document update conflict\"),f=new r(400,\"bad_request\",\"_id field must contain a string\"),l=new r(412,\"missing_id\",\"_id is required for puts\"),d=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),h=new r(412,\"precondition_failed\",\"Database not open\"),p=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),v=new r(500,\"badarg\",\"Some query argument is invalid\"),y=new r(400,\"invalid_request\",\"Request was invalid\"),g=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),m=new r(500,\"doc_validation\",\"Bad special document member\"),_=new r(400,\"bad_request\",\"Something wrong with the request\"),b=new r(400,\"bad_request\",\"Document must be a JSON object\"),w=new r(404,\"not_found\",\"Database not found\"),k=new r(500,\"indexed_db_went_bad\",\"unknown\"),E=new r(500,\"web_sql_went_bad\",\"unknown\"),S=new r(500,\"levelDB_went_went_bad\",\"unknown\"),O=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),A=new r(400,\"bad_request\",\"Invalid rev format\"),j=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),I=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),D=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=s,n.MISSING_BULK_DOCS=a,n.MISSING_DOC=u,n.REV_CONFLICT=c,n.INVALID_ID=f,n.MISSING_ID=l,n.RESERVED_ID=d,n.NOT_OPEN=h,n.UNKNOWN_ERROR=p,n.BAD_ARG=v,n.INVALID_REQUEST=y,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=m,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=b,n.DB_MISSING=w,n.WSQ_ERROR=E,n.LDB_ERROR=S,n.FORBIDDEN=O,n.INVALID_REV=A,n.FILE_EXISTS=j,n.MISSING_STUB=I,n.IDB_ERROR=k,n.INVALID_URL=D,n.createError=o,n.generateErrorFromResponse=i},{12:12}],31:[function(e,t,n){\"use strict\";function r(e){return Object.keys(e).sort(a.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function o(e,t,n){var o=n.doc_ids?n.doc_ids.sort(a.collate):\"\",u=n.filter?n.filter.toString():\"\",c=\"\",f=\"\",l=\"\";return n.selector&&(l=JSON.stringify(n.selector)),n.filter&&n.query_params&&(c=JSON.stringify(r(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),i.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+u+f+c+o+l;return new i(function(e){s.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),s=e(35),a=e(23);t.exports=o},{23:23,35:35,37:37}],32:[function(e,t,n){\"use strict\";function r(e){try{return JSON.parse(e)}catch(t){return i.parse(e)}}function o(e){try{return JSON.stringify(e)}catch(t){return i.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(43));n.safeJsonParse=r,n.safeJsonStringify=o},{43:43}],33:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,o)}catch(e){}}function i(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,i)}catch(e){}}function s(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,s)}catch(e){}}function a(e,t){return t&&e.then(function(e){v.nextTick(function(){t(null,e)})},function(e){v.nextTick(function(){t(e)})}),e}function u(e){return p(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&a(r,n),r})}function c(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})}function f(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}}function l(e){var t=new h.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n}function d(e){var t=new Array(e.size),n=-1;return e.forEach(function(e,r){t[++n]=r}),t}Object.defineProperty(n,\"__esModule\",{value:!0});var h=e(24),p=r(e(7)),v=e(40),y=r(e(12));y(o,Error),y(i,Error),y(s,Error),n.uniq=l,n.sequentialize=f,n.fin=c,n.callbackify=u,n.promisedCallback=a,n.mapToKeysArray=d,n.QueryParseError=o,n.NotFoundError=i,n.BuiltInError=s},{12:12,24:24,40:40,7:7}],34:[function(e,t,n){\"use strict\";function r(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new d.BuiltInError(t)}function o(e){for(var t=0,n=0,o=e.length;n<o;n++){var i=e[n];if(\"number\"!=typeof i){if(!Array.isArray(i))throw r(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var s=0,a=i.length;s<a;s++){var u=i[s];if(\"number\"!=typeof u)throw r(\"_sum\");void 0===t[s]?t.push(u):t[s]+=u}}else\"number\"==typeof t?t+=i:t[0]+=i}return t}function i(e,t){return l.scopeEval(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:o,log:p,isArray:v,toJSON:y})}function s(e,t){if(\"function\"==typeof e&&2===e.length){var n=e;return function(e){return n(e,t)}}return i(e.toString(),t)}function a(e){return g[e]?g[e]:i(e.toString())}function u(e,t){var n=e.views&&e.views[t];if(\"string\"!=typeof n.map)throw new d.NotFoundError(\"ddoc \"+e._id+\" has no string view named \"+t+\", instead found object of type: \"+typeof n.map)}function c(e,t,n){return m.query.call(this,e,t,n)}function f(e){return m.viewCleanup.call(this,e)}var l=e(40),d=e(33),h=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(15)),p=l.guardedConsole.bind(null,\"log\"),v=Array.isArray,y=JSON.parse,g={_sum:function(e,t){return o(t)},_count:function(e,t){return t.length},_stats:function(e,t){return{sum:o(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:function(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];t+=o*o}return t}(t)}}},m=h(\"mrviews\",s,a,u),_={query:c,viewCleanup:f};t.exports=_},{15:15,33:33,40:40}],35:[function(e,t,n){(function(t){\"use strict\";function r(e){return c.btoa(e)}function o(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function i(e,t,n,r,i){(n>0||r<t.size)&&(t=o(t,n,r)),c.readAsArrayBuffer(t,function(t){e.append(t),i()})}function s(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function a(e,t){function n(){l(a)}function o(){var e=y.end(!0),n=r(e);t(n),y.destroy()}function a(){var t=v*h,r=t+h;v++,v<p?g(y,e,t,r,n):g(y,e,t,r,o)}var u=\"string\"==typeof e,c=u?e.length:e.size,h=Math.min(d,c),p=Math.ceil(c/h),v=0,y=u?new f:new f.ArrayBuffer,g=u?s:i;a()}function u(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var c=e(20),f=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(42)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=a,n.stringMd5=u}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{20:20,42:42}],36:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var s=o.ids,a=s[2],u=o.pos;if(a.length)for(var c=0,f=a.length;c<f;c++)i.push({pos:u+1,ids:a[c]});else{var l=!!s[1].deleted,d=s[0];t&&!(r!==l?r:n!==u?n<u:t<d)||(t=d,n=u,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,s=i[2],a=t(0===s.length,o,i[0],n.ctx,i[1]),u=0,c=s.length;u<c;u++)r.push({pos:o+1,ids:s[u],ctx:a})}function i(e,t){return e.pos-t.pos}function s(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;n<r;n++)delete t[n].pos;return t}function a(e){for(var t=r(e),n=s(e.rev_tree),o=[],i=0,a=n.length;i<a;i++){var u=n[i];u.rev===t||u.opts.deleted||o.push(u.rev)}return o}function u(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function c(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,s=i[0],a=i[1],u=i[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:s,opts:a}),c&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=u.length;l<d;l++)r.push({pos:o+1,ids:u[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;o<i;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function h(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var s=e[o],a=[s.id,s.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function p(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,s=o.tree2;(i[1].status||s[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===s[1].status?\"available\":\"missing\");for(var a=0;a<s[2].length;a++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===s[2][a][0]&&(n.push({tree1:i[2][c],tree2:s[2][a]}),u=!0);u||(r=\"new_branch\",d(i[2],s[2][a],p))}else r=\"new_leaf\",i[2][0]=s[2][a]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,s=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var a=0,u=e.length;a<u;a++){var c=e[a];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=v(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,s=!0;else if(!0!==n){var l=c.pos<t.pos?c:t,d=c.pos<t.pos?t:c,h=d.pos-l.pos,p=[],y=[];for(y.push({ids:l.ids,diff:h,parent:null,parentIdx:null});y.length>0;){var g=y.pop();if(0!==g.diff)for(var m=g.ids[2],_=0,b=m.length;_<b;_++)y.push({ids:m[_],diff:g.diff-1,parent:g.ids,parentIdx:_});else g.ids[0]===d.ids[0]&&p.push(g)}var w=p[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,s=!0):o.push(c)}else o.push(c)}return s||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function g(e,t){for(var n,r,i=c(e),s=0,a=i.length;s<a;s++){var u,f=i[s],l=f.ids;if(l.length>t){n||(n={});var d=l.length-t;u={pos:f.pos+d,ids:h(l,d)};for(var p=0;p<d;p++){var v=f.pos+p+\"-\"+l[p].id;n[v]=!0}}else u={pos:f.pos,ids:h(l,0)};r=r?y(r,u,!0).tree:[u]}return n&&o(r,function(e,t,r){delete n[t+\"-\"+r]}),{tree:r,revs:n?Object.keys(n):[]}}function m(e,t,n){var r=y(e,t),o=g(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function _(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),s=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===s)return!0;for(var a=n.ids[2],u=0,c=a.length;u<c;u++)r.push({pos:n.pos+1,ids:a[u]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}function E(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,s=i[0],a=i[1],u=i[2],c=0===u.length,f=n.history?n.history.slice():[];if(f.push({id:s,pos:o,opts:a}),c)for(var l=0,d=f.length;l<d;l++){var h=f[l],p=h.pos+\"-\"+h.id;if(p===e)return o+\"-\"+s}for(var v=0,y=u.length;v<y;v++)r.push({pos:o+1,ids:u[v],history:f})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=a,n.collectLeaves=s,n.compactTree=u,n.isDeleted=w,n.isLocalId=k,n.merge=m,n.revExists=_,n.rootToLeaf=c,n.traverseRevTree=o,n.winningRev=r,n.latest=E},{}],37:[function(e,t,n){\"use strict\";var r=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(13)),o=\"function\"==typeof Promise?Promise:r;t.exports=o},{13:13}],38:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function s(e,t){var n=Object.keys(t._attachments);return m.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function a(e,t,n){var r=_.isRemote(t)&&!_.isRemote(e),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return m.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))}).catch(function(e){if(404!==e.status)throw e;return s(t,n)}):s(t,n)}function u(e){var t=[];return Object.keys(e).forEach(function(n){e[n].missing.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0,latest:!0}}function c(e,t,n,r){function i(){var o=u(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return m.all(n.results.map(function(n){return m.all(n.docs.map(function(n){var r=n.ok;return n.error&&(p=!1),r&&r._attachments?a(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){h=h.concat(_.flatten(e).filter(Boolean))})})}function s(e){return e._attachments&&Object.keys(e._attachments).length>0}function c(e){return e._conflicts&&e._conflicts.length>0}function f(t){return e.allDocs({keys:t,include_docs:!0,conflicts:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!o(e.value.rev)||s(e.doc)||c(e.doc)||(e.doc._conflicts&&delete e.doc._conflicts,h.push(e.doc),delete n[e.id])})})}function l(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});if(e.length>0)return f(e)}function d(){return{ok:p,docs:h}}n=_.clone(n);var h=[],p=!0;return m.resolve().then(l).then(i).then(d)}function f(e,t,n,r){if(!1===e.retry)return t.emit(\"error\",n),void t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=_.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var o=function(){e.current_back_off=O},i=function(){t.removeListener(\"active\",o)};t.once(\"paused\",i),t.once(\"active\",o)}e.current_back_off=e.current_back_off||O,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}function l(e,t,n,r,o){function i(){return x?m.resolve():w(e,t,n).then(function(n){D=n,x=new b(e,t,D,r)})}function s(){if(G=[],0!==I.docs.length){var e=I.docs,i={timeout:n.timeout};return t.bulkDocs({docs:e,new_edits:!1},i).then(function(t){if(r.cancelled)throw y(),new Error(\"cancelled\");var n=Object.create(null);t.forEach(function(e){e.error&&(n[e.id]=e)});var i=Object.keys(n).length;o.doc_write_failures+=i,o.docs_written+=e.length-i,e.forEach(function(e){var t=n[e._id];if(t){if(o.errors.push(t),\"unauthorized\"!==t.name&&\"forbidden\"!==t.name)throw t;r.emit(\"denied\",_.clone(t))}else G.push(e)})},function(t){throw o.doc_write_failures+=e.length,t})}}function a(){if(I.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=L=I.seq;var e=_.clone(o);return G.length&&(e.docs=G,r.emit(\"change\",e)),q=!0,x.writeCheckpoint(I.seq,z).then(function(){if(q=!1,r.cancelled)throw y(),new Error(\"cancelled\");I=void 0,O()}).catch(function(e){throw j(e),e})}function u(){var e={};return I.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw y(),new Error(\"cancelled\");I.diffs=e})}function d(){return c(e,t,I.diffs,r).then(function(e){I.error=!e.ok,e.docs.forEach(function(e){delete I.diffs[e._id],o.docs_read++,I.docs.push(e)})})}function h(){if(!r.cancelled&&!I){if(0===C.length)return void p(!0);I=C.shift(),u().then(d).then(s).then(a).then(h).catch(function(e){v(\"batch processing terminated with error\",e)})}}function p(e){if(0===R.changes.length)return void(0!==C.length||I||((N&&K.live||T)&&(r.state=\"pending\",r.emit(\"paused\")),T&&y()));(e||T||R.changes.length>=M)&&(C.push(R),R={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),h())}function v(e,t){B||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",C=[],R={seq:0,changes:[],docs:[]},y(t))}function y(i){B||r.cancelled&&(o.status=\"cancelled\",q)||(o.status=o.status||\"complete\",o.end_time=new Date,o.last_seq=L,B=!0,i?(i=k.createError(i),i.result=o,\"unauthorized\"===i.name||\"forbidden\"===i.name?(r.emit(\"error\",i),r.removeAllListeners()):f(n,r,i,function(){l(e,t,n,r)})):(r.emit(\"complete\",o),r.removeAllListeners()))}function g(e){if(r.cancelled)return y();_.filterChange(n)(e)&&(R.seq=e.seq,R.changes.push(e),p(0===C.length&&K.live))}function E(e){if(F=!1,r.cancelled)return y();if(e.results.length>0)K.since=e.last_seq,O(),p(!0);else{var t=function(){N?(K.live=!0,O()):T=!0,p(!0)};I||0!==e.results.length?t():(q=!0,x.writeCheckpoint(e.last_seq,z).then(function(){q=!1,o.last_seq=L=e.last_seq,t()}).catch(j))}}function S(e){if(F=!1,r.cancelled)return y();v(\"changes rejected\",e)}function O(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!F&&!T&&C.length<$){F=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(K).on(\"change\",g);i.then(o,o),i.then(E).catch(S),n.retry&&(r._changes=i,r._abortChanges=t)}}function A(){i().then(function(){return r.cancelled?void y():x.getCheckpoint().then(function(e){L=e,K={since:L,limit:M,batch_size:M,style:\"all_docs\",doc_ids:P,selector:U,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?K.include_docs=!0:K.filter=n.filter),\"heartbeat\"in n&&(K.heartbeat=n.heartbeat),\"timeout\"in n&&(K.timeout=n.timeout),n.query_params&&(K.query_params=n.query_params),n.view&&(K.view=n.view),O()})}).catch(function(e){v(\"getCheckpoint rejected with \",e)})}function j(e){q=!1,v(\"writeCheckpoint completed with error\",e)}var I,D,x,C=[],R={seq:0,changes:[],docs:[]},q=!1,T=!1,B=!1,L=0,N=n.continuous||n.live||!1,M=n.batch_size||100,$=n.batches_limit||10,F=!1,P=n.doc_ids,U=n.selector,G=[],z=_.uuid();o=o||{ok:!0,start_time:new Date,docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var K={};if(r.ready(e,t),r.cancelled)return void y();r._addedListeners||(r.once(\"cancel\",y),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void 0===n.since?A():i().then(function(){return q=!0,x.writeCheckpoint(n.since,z)}).then(function(){if(q=!1,r.cancelled)return void y();L=n.since,A()}).catch(j)}function d(){E.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new m(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e.catch=function(e){return t.catch(e)},e.catch(function(){})}function h(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function p(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw k.createError(k.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=_.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n);return l(h(e,n),h(t,n),n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n=_.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=h(e,n),t=h(t,n),new y(e,t,n,r)}function y(e,t,n,r){function o(e){v.emit(\"change\",{direction:\"pull\",change:e})}function i(e){v.emit(\"change\",{direction:\"push\",change:e})}function s(e){v.emit(\"denied\",{direction:\"push\",doc:e})}function a(e){v.emit(\"denied\",{direction:\"pull\",doc:e})}function u(){v.pushPaused=!0,v.pullPaused&&v.emit(\"paused\")}function c(){v.pullPaused=!0,v.pushPaused&&v.emit(\"paused\")}function f(){v.pushPaused=!1,v.pullPaused&&v.emit(\"active\",{direction:\"push\"})}function l(){v.pullPaused=!1,v.pushPaused&&v.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===a||n===s),h=\"paused\"===t&&(n===c||n===u),p=\"active\"===t&&(n===l||n===f);(r||d||h||p)&&(t in b||(b[t]={}),b[t][e]=!0,2===Object.keys(b[t]).length&&v.removeAllListeners(t))}}function h(e,t,n){-1==e.listeners(t).indexOf(n)&&e.on(t,n)}var v=this;this.canceled=!1;var y=n.push?_.assign({},n,n.push):n,g=n.pull?_.assign({},n,n.pull):n;this.push=p(e,t,y),this.pull=p(t,e,g),this.pushPaused=!0,this.pullPaused=!0;var b={};n.live&&(this.push.on(\"complete\",v.pull.cancel.bind(v.pull)),this.pull.on(\"complete\",v.push.cancel.bind(v.push))),this.on(\"newListener\",function(e){\"change\"===e?(h(v.pull,\"change\",o),h(v.push,\"change\",i)):\"denied\"===e?(h(v.pull,\"denied\",a),h(v.push,\"denied\",s)):\"active\"===e?(h(v.pull,\"active\",l),h(v.push,\"active\",f)):\"paused\"===e&&(h(v.pull,\"paused\",c),h(v.push,\"paused\",u))}),this.on(\"removeListener\",function(e){\"change\"===e?(v.pull.removeListener(\"change\",o),v.push.removeListener(\"change\",i)):\"denied\"===e?(v.pull.removeListener(\"denied\",a),v.push.removeListener(\"denied\",s)):\"active\"===e?(v.pull.removeListener(\"active\",l),v.push.removeListener(\"active\",f)):\"paused\"===e&&(v.pull.removeListener(\"paused\",c),v.push.removeListener(\"paused\",u))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var w=m.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return v.emit(\"complete\",t),r&&r(null,t),v.removeAllListeners(),t},function(e){if(v.cancel(),r?r(e):v.emit(\"error\",e),v.removeAllListeners(),r)throw e});this.then=function(e,t){return w.then(e,t)},this.catch=function(e){return w.catch(e)}}function g(e){e.replicate=p,e.sync=v,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var e=this;return{from:function(t,n,r){return e.constructor.replicate(t,e,n,r)},to:function(t,n,r){return e.constructor.replicate(e,t,n,r)}}}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}var m=r(e(37)),_=e(40),b=r(e(22)),w=r(e(31)),k=e(30),E=e(10),S=r(e(12)),O=0;S(d,E.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},S(y,E.EventEmitter),y.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=g},{10:10,12:12,22:22,30:30,31:31,37:37,40:40}],39:[function(e,t,n){\"use strict\";function r(e,t){for(var n=e,r=0,o=t.length;r<o;r++){if(!(n=n[t[r]]))break}return n}function o(e,t,n){for(var r=0,o=t.length;r<o-1;r++){e=e[t[r]]={}}e[t[o-1]]=n}function i(e,t){return e<t?-1:e>t?1:0}function s(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?r>0&&\"\\\\\"===e[r-1]?n=n.substring(0,n.length-1)+\".\":(t.push(n),n=\"\"):n+=i}return t.push(n),t}function a(e){return T.indexOf(e)>-1}function u(e){return Object.keys(e)[0]}function c(e){return e[u(e)]}function f(e){var t={};return e.forEach(function(e){Object.keys(e).forEach(function(n){var r=e[n];if(\"object\"!=typeof r&&(r={$eq:r}),a(n))r instanceof Array?t[n]=r.map(function(e){return f([e])}):t[n]=f([r]);else{var o=t[n]=t[n]||{};Object.keys(r).forEach(function(e){var t=r[e];return\"$gt\"===e||\"$gte\"===e?l(e,t,o):\"$lt\"===e||\"$lte\"===e?d(e,t,o):\"$ne\"===e?h(t,o):\"$eq\"===e?p(t,o):void(o[e]=t)})}})}),t}function l(e,t,n){void 0===n.$eq&&(void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t)}function d(e,t,n){void 0===n.$eq&&(void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t)}function h(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}function p(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}function v(e){var t=R.clone(e),n=!1;\"$and\"in t&&(t=f(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=f([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],s=t[i];\"object\"!=typeof s||null===s?s={$eq:s}:\"$ne\"in s&&!n&&(s.$ne=[s.$ne]),t[i]=s}return t}function y(e){function t(t){return e.map(function(e){var n=u(e),o=s(n);return r(t,o)})}return function(e,n){var r=t(e.doc),o=t(n.doc),s=q.collate(r,o);return 0!==s?s:i(e.doc._id,n.doc._id)}}function g(e,t,n){if(e=e.filter(function(e){return m(e.doc,t.selector,n)}),t.sort){var r=y(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===c(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var o=t.skip||0,i=(\"limit\"in t?t.limit:e.length)+o;e=e.slice(o,i)}return e}function m(e,t,n){return n.every(function(n){if(_(e))return!1;var o=t[n],i=s(n),u=r(e,i);return a(n)?w(n,o,e):b(o,e,i,u)})}function _(e){return/^_design\\//.test(e._id)}function b(e,t,n,r){return!e||Object.keys(e).every(function(o){var i=e[o];return k(o,t,i,n,r)})}function w(e,t,n){return\"$or\"===e?t.some(function(e){return m(n,e,Object.keys(e))}):\"$not\"===e?!m(n,t,Object.keys(t)):!t.find(function(e){return m(n,e,Object.keys(e))})}function k(e,t,n,r,o){if(!B[e])throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type or $all');return B[e](t,n,r,o)}function E(e){return void 0!==e&&null!==e}function S(e){return void 0!==e}function O(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}function A(e,t){return t.some(function(t){return e instanceof Array?e.indexOf(t)>-1:e===t})}function j(e,t){return t.every(function(t){return e.indexOf(t)>-1})}function I(e,t){return e.length===t}function D(e,t){return new RegExp(t).test(e)}function x(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}function C(e,t){if(\"object\"!=typeof t)throw\"Selector error: expected a JSON object\";t=v(t);var n={doc:e},r=g([n],{selector:t},Object.keys(t));return r&&1===r.length}Object.defineProperty(n,\"__esModule\",{value:!0});var R=e(40),q=e(23),T=[\"$or\",\"$nor\",\"$not\"],B={$elemMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.some(function(e){return m(e,t,Object.keys(t))}):r.some(function(r){return b(t,e,n,r)})))},\n$eq:function(e,t,n,r){return S(r)&&0===q.collate(r,t)},$gte:function(e,t,n,r){return S(r)&&q.collate(r,t)>=0},$gt:function(e,t,n,r){return S(r)&&q.collate(r,t)>0},$lte:function(e,t,n,r){return S(r)&&q.collate(r,t)<=0},$lt:function(e,t,n,r){return S(r)&&q.collate(r,t)<0},$exists:function(e,t,n,r){return t?S(r):!S(r)},$mod:function(e,t,n,r){return E(r)&&O(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==q.collate(r,e)})},$in:function(e,t,n,r){return E(r)&&A(r,t)},$nin:function(e,t,n,r){return E(r)&&!A(r,t)},$size:function(e,t,n,r){return E(r)&&I(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&j(r,t)},$regex:function(e,t,n,r){return E(r)&&D(r,t)},$type:function(e,t,n,r){return x(r,t)}};n.massageSelector=v,n.matchesSelector=C,n.filterInMemoryFields=g,n.createFieldSorter=y,n.rowFilter=m,n.isCombinationalField=a,n.getKey=u,n.getValue=c,n.getFieldFromDoc=r,n.setFieldInDoc=o,n.compare=i,n.parseField=s},{23:23,40:40}],40:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function s(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function a(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&W.call(n)==H}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return s(e);if(!a(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);void 0!==i&&(t[n]=i)}return t}function c(e){var t=!1;return G(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return G(function(t){t=u(t);var n=this,r=\"function\"==typeof t[t.length-1]&&t.pop(),o=new U(function(r,o){var i;try{var s=c(function(e,t){e?o(e):r(t)});t.push(s),i=e.apply(n,t),i&&\"function\"==typeof i.then&&r(i)}catch(e){o(e)}});return r&&o.then(function(e){r(null,e)},r),o})}function l(e,t,n){if(e.constructor.listeners(\"debug\").length){for(var r=[\"api\",e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);e.constructor.emit(\"debug\",r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[\"api\",e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),e.constructor.emit(\"debug\",o),i(n,r)}}}function d(e,t){return f(G(function(n){if(this._closed)return U.reject(new Error(\"database is closed\"));if(this._destroyed)return U.reject(new Error(\"database is destroyed\"));var r=this;return l(r,e,n),this.taskqueue.isReady?t.apply(this,n):new U(function(t,o){r.taskqueue.addTask(function(i){i?o(i):t(r[e].apply(r,n))})})}))}function h(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function v(e){return[{ok:e}]}function y(e,t,n){function r(){var e=[];d.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){d[e]={id:t,docs:n},o()}function s(){if(!(g>=y.length)){var e=Math.min(g+Z,y.length),t=y.slice(g,e);a(t,g),g+=t.length}}function a(n,r){n.forEach(function(n,o){var a=r+o,u=c.get(n),f=h(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=v),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(a,n,r),s()})})}var u=t.docs,c=new z.Map;u.forEach(function(e){c.has(e.id)?c.get(e.id).push(e):c.set(e.id,[e])});var f=c.size,l=0,d=new Array(f),y=[];c.forEach(function(e,t){y.push(t)});var g=0;s()}function g(){return\"undefined\"!=typeof chrome&&void 0!==chrome.storage&&void 0!==chrome.storage.local}function m(){return P}function _(e){g()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):m()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function b(){K.EventEmitter.call(this),this._listeners={},_(this)}function w(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function k(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function E(e){var t=0;return e||(t=2e3),k(e,t)}function S(e,t){w(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function O(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return Q.createError(Q.BAD_REQUEST,r)}}function A(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&O(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function j(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function I(){}function D(e){var t;if(e?\"string\"!=typeof e?t=Q.createError(Q.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=Q.createError(Q.RESERVED_ID)):t=Q.createError(Q.MISSING_ID),t)throw t}function x(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function C(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(w(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())}function R(e,t){return\"listenerCount\"in e?e.listenerCount(t):K.EventEmitter.listenerCount(e,t)}function q(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function T(e){var t=q(e);return t?t.join(\"/\"):null}function B(e){for(var t=se.exec(e),n={},r=14;r--;){var o=re[r],i=t[r]||\"\",s=-1!==[\"user\",\"password\"].indexOf(o);n[o]=s?decodeURIComponent(i):i}return n[oe]={},n[re[12]].replace(ie,function(e,t,r){t&&(n[oe][t]=r)}),n}function L(e,t){var n=[],r=[];for(var o in t)t.hasOwnProperty(o)&&(n.push(o),r.push(t[o]));return n.push(e),Function.apply(null,n).apply(null,r)}function N(e,t,n){return new U(function(r,o){e.get(t,function(i,s){if(i){if(404!==i.status)return o(i);s={}}var a=s._rev,u=n(s);if(!u)return r({updated:!1,rev:a});u._id=t,u._rev=a,r(M(e,u,n))})})}function M(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return N(e,t._id,n)})}function $(e){return 0|Math.random()*e}function F(e,t){t=t||ae.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=ae[$(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=ae[3&$(16)|8];break;default:n+=ae[$(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var P,U=r(e(37)),G=r(e(7)),z=e(24),K=e(10),J=r(e(12)),V=r(e(11)),Q=e(30),W=Function.prototype.toString,H=W.call(Object),Z=6;if(g())P=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),P=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){P=!1}J(b,K.EventEmitter),b.prototype.addListener=function(e,t,n,r){function o(){function e(){s=!1}if(i._listeners[t]){if(s)return void(s=\"waiting\");s=!0;var a=h(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(a).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===s&&V(o),s=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,s=!1;this._listeners[t]=o,this.on(e,o)}},b.prototype.removeListener=function(e,t){t in this._listeners&&(K.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},b.prototype.notifyLocalWindows=function(e){g()?chrome.storage.local.set({dbName:e}):m()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},b.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var Y;Y=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};var X,ee=Y,te=I.name;X=te?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ne=X,re=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],oe=\"queryKey\",ie=/(?:^|&)([^&=]*)=?([^&]*)/g,se=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ae=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=d,n.bulkGetShim=y,n.changesHandler=b,n.clone=u,n.defaultBackOff=E,n.explainError=S,n.assign=ee,n.filterChange=A,n.flatten=j,n.functionName=ne,n.guardedConsole=w,n.hasLocalStorage=m,n.invalidIdError=D,n.isChromeApp=g,n.isCordova=x,n.isRemote=C,n.listenerCount=R,n.nextTick=V,n.normalizeDdocFunctionName=T,n.once=c,n.parseDdocFunctionName=q,n.parseUri=B,n.pick=h,n.scopeEval=L,n.toPromise=f,n.upsert=N,n.uuid=F},{10:10,11:11,12:12,24:24,30:30,37:37,7:7}],41:[function(e,t,n){function r(){throw new Error(\"setTimeout has not been defined\")}function o(){throw new Error(\"clearTimeout has not been defined\")}function i(e){if(l===setTimeout)return setTimeout(e,0);if((l===r||!l)&&setTimeout)return l=setTimeout,setTimeout(e,0);try{return l(e,0)}catch(t){try{return l.call(null,e,0)}catch(t){return l.call(this,e,0)}}}function s(e){if(d===clearTimeout)return clearTimeout(e);if((d===o||!d)&&clearTimeout)return d=clearTimeout,clearTimeout(e);try{return d(e)}catch(t){try{return d.call(null,e)}catch(t){return d.call(this,e)}}}function a(){y&&p&&(y=!1,p.length?v=p.concat(v):g=-1,v.length&&u())}function u(){if(!y){var e=i(a);y=!0;for(var t=v.length;t;){for(p=v,v=[];++g<t;)p&&p[g].run();g=-1,t=v.length}p=null,y=!1,s(e)}}function c(e,t){this.fun=e,this.array=t}function f(){}var l,d,h=t.exports={};!function(){try{l=\"function\"==typeof setTimeout?setTimeout:r}catch(e){l=r}try{d=\"function\"==typeof clearTimeout?clearTimeout:o}catch(e){d=o}}();var p,v=[],y=!1,g=-1;h.nextTick=function(e){var t=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];v.push(new c(e,t)),1!==v.length||y||i(u)},c.prototype.run=function(){this.fun.apply(null,this.array)},h.title=\"browser\",h.browser=!0,h.env={},h.argv=[],h.version=\"\",h.versions={},h.on=f,h.addListener=f,h.once=f,h.off=f,h.removeListener=f,h.removeAllListeners=f,h.emit=f,h.binding=function(e){throw new Error(\"process.binding is not supported\")},h.cwd=function(){return\"/\"},h.chdir=function(e){throw new Error(\"process.chdir is not supported\")},h.umask=function(){return 0}},{}],42:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t){var n=e[0],r=e[1],o=e[2],i=e[3];n+=(r&o|~r&i)+t[0]-680876936|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[1]-389564586|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[2]+606105819|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[3]-1044525330|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[4]-176418897|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[5]+1200080426|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[6]-1473231341|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[7]-45705983|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[8]+1770035416|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[9]-1958414417|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[10]-42063|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[11]-1990404162|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[12]+1804603682|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[13]-40341101|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[14]-1502002290|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[15]+1236535329|0,r=(r<<22|r>>>10)+o|0,n+=(r&i|o&~i)+t[1]-165796510|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[6]-1069501632|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[11]+643717713|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[0]-373897302|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[5]-701558691|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[10]+38016083|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[15]-660478335|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[4]-405537848|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[9]+568446438|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[14]-1019803690|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[3]-187363961|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[8]+1163531501|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[13]-1444681467|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[2]-51403784|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[7]+1735328473|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[12]-1926607734|0,r=(r<<20|r>>>12)+o|0,n+=(r^o^i)+t[5]-378558|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[8]-2022574463|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[11]+1839030562|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[14]-35309556|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[1]-1530992060|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[4]+1272893353|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[7]-155497632|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[10]-1094730640|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[13]+681279174|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[0]-358537222|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[3]-722521979|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[6]+76029189|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[9]-640364487|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[12]-421815835|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[15]+530742520|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[2]-995338651|0,r=(r<<23|r>>>9)+o|0,n+=(o^(r|~i))+t[0]-198630844|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[7]+1126891415|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[14]-1416354905|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[5]-57434055|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[12]+1700485571|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[3]-1894986606|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[10]-1051523|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[1]-2054922799|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[8]+1873313359|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[15]-30611744|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[6]-1560198380|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[13]+1309151649|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[4]-145523070|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[11]-1120210379|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[2]+718787259|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[9]-343485551|0,r=(r<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function n(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function r(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function o(e){var r,o,i,s,a,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(r=64;r<=c;r+=64)t(f,n(e.substring(r-64,r)));for(e=e.substring(r-64),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],r=0;r<o;r+=1)i[r>>2]|=e.charCodeAt(r)<<(r%4<<3);if(i[r>>2]|=128<<(r%4<<3),r>55)for(t(f,i),r=0;r<16;r+=1)i[r]=0;return s=8*c,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),u=parseInt(s[1],16)||0,i[14]=a,i[15]=u,t(f,i),f}function i(e){var n,o,i,s,a,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(n=64;n<=c;n+=64)t(f,r(e.subarray(n-64,n)));for(e=n-64<c?e.subarray(n-64):new Uint8Array(0),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],n=0;n<o;n+=1)i[n>>2]|=e[n]<<(n%4<<3);if(i[n>>2]|=128<<(n%4<<3),n>55)for(t(f,i),n=0;n<16;n+=1)i[n]=0;return s=8*c,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),u=parseInt(s[1],16)||0,i[14]=a,i[15]=u,t(f,i),f}function s(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=p[e>>8*t+4&15]+p[e>>8*t&15];return n}function a(e){var t;for(t=0;t<e.length;t+=1)e[t]=s(e[t]);return e.join(\"\")}function u(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function c(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function f(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function l(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function d(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function h(){this.reset()}var p=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==a(o(\"hello\"))&&function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n},\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,s,a,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),s=new Uint8Array(i),a=new Uint8Array(this,c,o),s.set(a),i)}}(),h.prototype.append=function(e){return this.appendBinary(u(e)),this},h.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var r,o=this._buff.length;for(r=64;r<=o;r+=64)t(this._hash,n(this._buff.substring(r-64,r)));return this._buff=this._buff.substring(r-64),this},h.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},h.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},h.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},h.prototype._finish=function(e,n){var r,o,i,s=n;if(e[s>>2]|=128<<(s%4<<3),s>55)for(t(this._hash,e),s=0;s<16;s+=1)e[s]=0;r=8*this._length,r=r.toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(r[2],16),i=parseInt(r[1],16)||0,e[14]=o,e[15]=i,t(this._hash,e)},h.hash=function(e,t){return h.hashBinary(u(e),t)},h.hashBinary=function(e,t){var n=o(e),r=a(n);return t?d(r):r},h.ArrayBuffer=function(){this.reset()},h.ArrayBuffer.prototype.append=function(e){var n,o=l(this._buff.buffer,e,!0),i=o.length;for(this._length+=e.byteLength,n=64;n<=i;n+=64)t(this._hash,r(o.subarray(n-64,n)));return this._buff=n-64<i?new Uint8Array(o.buffer.slice(n-64)):new Uint8Array(0),this},h.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.ArrayBuffer.prototype.getState=function(){var e=h.prototype.getState.call(this);return e.buff=f(e.buff),e},h.ArrayBuffer.prototype.setState=function(e){return e.buff=c(e.buff,!0),h.prototype.setState.call(this,e)},h.ArrayBuffer.prototype.destroy=h.prototype.destroy,h.ArrayBuffer.prototype._finish=h.prototype._finish,h.ArrayBuffer.hash=function(e,t){var n=i(new Uint8Array(e)),r=a(n);return t?d(r):r},h})},{}],43:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var s=t.pop();o[s]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,s,a,u,c,f,l,d,h=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",h+=o,i)h+=i;else if(\"object\"!=typeof r)h+=void 0===r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),s=r.length-1;s>=0;s--)a=0===s?\"\":\",\",t.push({obj:r[s],prefix:a});t.push({val:\"[\"})}else{u=[];for(c in r)r.hasOwnProperty(c)&&u.push(c);for(t.push({val:\"}\"}),s=u.length-1;s>=0;s--)f=u[s],l=r[f],d=s>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,o,i,s,a,u,c,f,l=[],d=[],h=0;;)if(\"}\"!==(t=e[h++])&&\"]\"!==t&&void 0!==t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,r(null,l,d);break;case\"t\":h+=3,r(!0,l,d);break;case\"f\":h+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(o=e[h++],!/[\\d\\.\\-e\\+]/.test(o)){h--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",s=void 0,a=0;;){if('\"'===(u=e[h++])&&(\"\\\\\"!==s||a%2!=1))break;i+=u,s=u,\"\\\\\"===s?a++:a=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":c={element:[],index:l.length},l.push(c.element),d.push(c);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[3]);";
},{}],11:[function(require,module,exports){
'use strict';

module.exports = argsArray;

function argsArray(fun) {
  return function () {
    var len = arguments.length;
    if (len) {
      var args = [];
      var i = -1;
      while (++i < len) {
        args[i] = arguments[i];
      }
      return fun.call(this, args);
    } else {
      return fun.call(this, []);
    }
  };
}
},{}],12:[function(require,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window && typeof window.process !== 'undefined' && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document && 'WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window && window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,require('_process'))
},{"./debug":13,"_process":26}],13:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":19}],14:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],15:[function(require,module,exports){
(function (global){
'use strict';
var Mutation = global.MutationObserver || global.WebKitMutationObserver;

var scheduleDrain;

{
  if (Mutation) {
    var called = 0;
    var observer = new Mutation(nextTick);
    var element = global.document.createTextNode('');
    observer.observe(element, {
      characterData: true
    });
    scheduleDrain = function () {
      element.data = (called = ++called % 2);
    };
  } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
    var channel = new global.MessageChannel();
    channel.port1.onmessage = nextTick;
    scheduleDrain = function () {
      channel.port2.postMessage(0);
    };
  } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
    scheduleDrain = function () {

      // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
      // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
      var scriptEl = global.document.createElement('script');
      scriptEl.onreadystatechange = function () {
        nextTick();

        scriptEl.onreadystatechange = null;
        scriptEl.parentNode.removeChild(scriptEl);
        scriptEl = null;
      };
      global.document.documentElement.appendChild(scriptEl);
    };
  } else {
    scheduleDrain = function () {
      setTimeout(nextTick, 0);
    };
  }
}

var draining;
var queue = [];
//named nextTick for less confusing stack traces
function nextTick() {
  draining = true;
  var i, oldQueue;
  var len = queue.length;
  while (len) {
    oldQueue = queue;
    queue = [];
    i = -1;
    while (++i < len) {
      oldQueue[i]();
    }
    len = queue.length;
  }
  draining = false;
}

module.exports = immediate;
function immediate(task) {
  if (queue.push(task) === 1 && !draining) {
    scheduleDrain();
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],16:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],17:[function(require,module,exports){
(function(factory) {
  if(typeof exports === 'object') {
    factory(exports);
  } else {
    factory(this);
  }
}).call(this, function(root) { 

  var slice   = Array.prototype.slice,
      each    = Array.prototype.forEach;

  var extend = function(obj) {
    if(typeof obj !== 'object') throw obj + ' is not an object' ;

    var sources = slice.call(arguments, 1); 

    each.call(sources, function(source) {
      if(source) {
        for(var prop in source) {
          if(typeof source[prop] === 'object' && obj[prop]) {
            extend.call(obj, obj[prop], source[prop]);
          } else {
            obj[prop] = source[prop];
          }
        } 
      }
    });

    return obj;
  }

  root.extend = extend;
});

},{}],18:[function(require,module,exports){
'use strict';
var immediate = require('immediate');

/* istanbul ignore next */
function INTERNAL() {}

var handlers = {};

var REJECTED = ['REJECTED'];
var FULFILLED = ['FULFILLED'];
var PENDING = ['PENDING'];

module.exports = Promise;

function Promise(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('resolver must be a function');
  }
  this.state = PENDING;
  this.queue = [];
  this.outcome = void 0;
  if (resolver !== INTERNAL) {
    safelyResolveThenable(this, resolver);
  }
}

Promise.prototype["catch"] = function (onRejected) {
  return this.then(null, onRejected);
};
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||
    typeof onRejected !== 'function' && this.state === REJECTED) {
    return this;
  }
  var promise = new this.constructor(INTERNAL);
  if (this.state !== PENDING) {
    var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
    unwrap(promise, resolver, this.outcome);
  } else {
    this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
  }

  return promise;
};
function QueueItem(promise, onFulfilled, onRejected) {
  this.promise = promise;
  if (typeof onFulfilled === 'function') {
    this.onFulfilled = onFulfilled;
    this.callFulfilled = this.otherCallFulfilled;
  }
  if (typeof onRejected === 'function') {
    this.onRejected = onRejected;
    this.callRejected = this.otherCallRejected;
  }
}
QueueItem.prototype.callFulfilled = function (value) {
  handlers.resolve(this.promise, value);
};
QueueItem.prototype.otherCallFulfilled = function (value) {
  unwrap(this.promise, this.onFulfilled, value);
};
QueueItem.prototype.callRejected = function (value) {
  handlers.reject(this.promise, value);
};
QueueItem.prototype.otherCallRejected = function (value) {
  unwrap(this.promise, this.onRejected, value);
};

function unwrap(promise, func, value) {
  immediate(function () {
    var returnValue;
    try {
      returnValue = func(value);
    } catch (e) {
      return handlers.reject(promise, e);
    }
    if (returnValue === promise) {
      handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
    } else {
      handlers.resolve(promise, returnValue);
    }
  });
}

handlers.resolve = function (self, value) {
  var result = tryCatch(getThen, value);
  if (result.status === 'error') {
    return handlers.reject(self, result.value);
  }
  var thenable = result.value;

  if (thenable) {
    safelyResolveThenable(self, thenable);
  } else {
    self.state = FULFILLED;
    self.outcome = value;
    var i = -1;
    var len = self.queue.length;
    while (++i < len) {
      self.queue[i].callFulfilled(value);
    }
  }
  return self;
};
handlers.reject = function (self, error) {
  self.state = REJECTED;
  self.outcome = error;
  var i = -1;
  var len = self.queue.length;
  while (++i < len) {
    self.queue[i].callRejected(error);
  }
  return self;
};

function getThen(obj) {
  // Make sure we only access the accessor once as required by the spec
  var then = obj && obj.then;
  if (obj && (typeof obj === 'object' || typeof obj === 'function') && typeof then === 'function') {
    return function appyThen() {
      then.apply(obj, arguments);
    };
  }
}

function safelyResolveThenable(self, thenable) {
  // Either fulfill, reject or reject with error
  var called = false;
  function onError(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.reject(self, value);
  }

  function onSuccess(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.resolve(self, value);
  }

  function tryToUnwrap() {
    thenable(onSuccess, onError);
  }

  var result = tryCatch(tryToUnwrap);
  if (result.status === 'error') {
    onError(result.value);
  }
}

function tryCatch(func, value) {
  var out = {};
  try {
    out.value = func(value);
    out.status = 'success';
  } catch (e) {
    out.status = 'error';
    out.value = e;
  }
  return out;
}

Promise.resolve = resolve;
function resolve(value) {
  if (value instanceof this) {
    return value;
  }
  return handlers.resolve(new this(INTERNAL), value);
}

Promise.reject = reject;
function reject(reason) {
  var promise = new this(INTERNAL);
  return handlers.reject(promise, reason);
}

Promise.all = all;
function all(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var values = new Array(len);
  var resolved = 0;
  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    allResolver(iterable[i], i);
  }
  return promise;
  function allResolver(value, i) {
    self.resolve(value).then(resolveFromAll, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
    function resolveFromAll(outValue) {
      values[i] = outValue;
      if (++resolved === len && !called) {
        called = true;
        handlers.resolve(promise, values);
      }
    }
  }
}

Promise.race = race;
function race(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    resolver(iterable[i]);
  }
  return promise;
  function resolver(value) {
    self.resolve(value).then(function (response) {
      if (!called) {
        called = true;
        handlers.resolve(promise, response);
      }
    }, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
  }
}

},{"immediate":15}],19:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000
var m = s * 60
var h = m * 60
var d = h * 24
var y = d * 365.25

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function (val, options) {
  options = options || {}
  var type = typeof val
  if (type === 'string' && val.length > 0) {
    return parse(val)
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ?
			fmtLong(val) :
			fmtShort(val)
  }
  throw new Error('val is not a non-empty string or a valid number. val=' + JSON.stringify(val))
}

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str)
  if (str.length > 10000) {
    return
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str)
  if (!match) {
    return
  }
  var n = parseFloat(match[1])
  var type = (match[2] || 'ms').toLowerCase()
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y
    case 'days':
    case 'day':
    case 'd':
      return n * d
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n
    default:
      return undefined
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd'
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h'
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm'
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's'
  }
  return ms + 'ms'
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms'
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name
  }
  return Math.ceil(ms / n) + ' ' + name + 's'
}

},{}],20:[function(require,module,exports){
(function (global){
"use strict";

//Abstracts constructing a Blob object, so it also works in older
//browsers that don't support the native Blob constructor. (i.e.
//old QtWebKit versions, at least).
function createBlob(parts, properties) {
  parts = parts || [];
  properties = properties || {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== "TypeError") {
      throw e;
    }
    var BlobBuilder = global.BlobBuilder ||
                      global.MSBlobBuilder ||
                      global.MozBlobBuilder ||
                      global.WebKitBlobBuilder;
    var builder = new BlobBuilder();
    for (var i = 0; i < parts.length; i += 1) {
      builder.append(parts[i]);
    }
    return builder.getBlob(properties.type);
  }
}

//Can't find original post, but this is close
//http://stackoverflow.com/questions/6965107/ (continues on next line)
//converting-between-strings-and-arraybuffers
function arrayBufferToBinaryString(buffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var length = bytes.byteLength;
  for (var i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// This used to be called "fixBinary", which wasn't a very evocative name
// From http://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
function binaryStringToArrayBuffer(bin) {
  var length = bin.length;
  var buf = new ArrayBuffer(length);
  var arr = new Uint8Array(buf);
  for (var i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

// shim for browsers that don't support it
function readAsBinaryString(blob, callback) {
  var reader = new FileReader();
  var hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    var result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

// simplified API. universal browser support is assumed
function readAsArrayBuffer(blob, callback) {
  var reader = new FileReader();
  reader.onloadend = function (e) {
    var result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

module.exports = {
  createBlob: createBlob,
  readAsArrayBuffer: readAsArrayBuffer,
  readAsBinaryString: readAsBinaryString,
  binaryStringToArrayBuffer: binaryStringToArrayBuffer,
  arrayBufferToBinaryString: arrayBufferToBinaryString
};


}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],21:[function(require,module,exports){
(function (global){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(require('lie'));
var getArguments = _interopDefault(require('argsarray'));
var events = require('events');
var inherits = _interopDefault(require('inherits'));
var nextTick = _interopDefault(require('immediate'));
var debug = _interopDefault(require('debug'));
var Md5 = _interopDefault(require('spark-md5'));
var vuvuzela = _interopDefault(require('vuvuzela'));

/* istanbul ignore next */
var PouchPromise$1 = typeof Promise === 'function' ? Promise : lie;

function isBinaryObject(object) {
  return (typeof ArrayBuffer !== 'undefined' && object instanceof ArrayBuffer) ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  var target = new ArrayBuffer(buff.byteLength);
  var targetArray = new Uint8Array(target);
  var sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  var size = object.size;
  var type = object.type;
  // Blob
  if (typeof object.slice === 'function') {
    return object.slice(0, size, type);
  }
  // PhantomJS slice() replacement
  return object.webkitSlice(0, size, type);
}

// most of this is borrowed from lodash.isPlainObject:
// https://github.com/fis-components/lodash.isplainobject/
// blob/29c358140a74f252aeb08c9eb28bef86f2217d4a/index.js

var funcToString = Function.prototype.toString;
var objectCtorString = funcToString.call(Object);

function isPlainObject(value) {
  var proto = Object.getPrototypeOf(value);
  /* istanbul ignore if */
  if (proto === null) { // not sure when this happens, but I guess it can
    return true;
  }
  var Ctor = proto.constructor;
  return (typeof Ctor == 'function' &&
    Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString);
}

function clone(object) {
  var newObject;
  var i;
  var len;

  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  if (!isPlainObject(object)) {
    return object; // don't clone objects like Workers
  }

  newObject = {};
  for (i in object) {
    /* istanbul ignore else */
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
}

function once(fun) {
  var called = false;
  return getArguments(function (args) {
    /* istanbul ignore if */
    if (called) {
      // this is a smoke test and should never actually happen
      throw new Error('once called more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
}

function toPromise(func) {
  //create the function we will be returning
  return getArguments(function (args) {
    // Clone arguments
    args = clone(args);
    var self = this;
    // if the last argument is a function, assume its a callback
    var usedCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    var promise = new PouchPromise$1(function (fulfill, reject) {
      var resp;
      try {
        var callback = once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        resp = func.apply(self, args);
        if (resp && typeof resp.then === 'function') {
          fulfill(resp);
        }
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    return promise;
  });
}

function logApiCall(self, name, args) {
  /* istanbul ignore if */
  if (self.constructor.listeners('debug').length) {
    var logArgs = ['api', self.name, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    self.constructor.emit('debug', logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = ['api', self.name, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      self.constructor.emit('debug', responseArgs);
      origCallback(err, res);
    };
  }
}

function adapterFun(name, callback) {
  return toPromise(getArguments(function (args) {
    if (this._closed) {
      return PouchPromise$1.reject(new Error('database is closed'));
    }
    if (this._destroyed) {
      return PouchPromise$1.reject(new Error('database is destroyed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new PouchPromise$1(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
}

function mangle(key) {
  return '$' + key;
}
function unmangle(key) {
  return key.substring(1);
}
function Map$1() {
  this._store = {};
}
Map$1.prototype.get = function (key) {
  var mangled = mangle(key);
  return this._store[mangled];
};
Map$1.prototype.set = function (key, value) {
  var mangled = mangle(key);
  this._store[mangled] = value;
  return true;
};
Map$1.prototype.has = function (key) {
  var mangled = mangle(key);
  return mangled in this._store;
};
Map$1.prototype.delete = function (key) {
  var mangled = mangle(key);
  var res = mangled in this._store;
  delete this._store[mangled];
  return res;
};
Map$1.prototype.forEach = function (cb) {
  var keys = Object.keys(this._store);
  for (var i = 0, len = keys.length; i < len; i++) {
    var key = keys[i];
    var value = this._store[key];
    key = unmangle(key);
    cb(value, key);
  }
};
Object.defineProperty(Map$1.prototype, 'size', {
  get: function () {
    return Object.keys(this._store).length;
  }
});

function Set$1(array) {
  this._store = new Map$1();

  // init with an array
  if (array && Array.isArray(array)) {
    for (var i = 0, len = array.length; i < len; i++) {
      this.add(array[i]);
    }
  }
}
Set$1.prototype.add = function (key) {
  return this._store.set(key, true);
};
Set$1.prototype.has = function (key) {
  return this._store.has(key);
};
Set$1.prototype.forEach = function (cb) {
  this._store.forEach(function (value, key) {
    cb(key);
  });
};
Object.defineProperty(Set$1.prototype, 'size', {
  get: function () {
    return this._store.size;
  }
});

/* global Map,Set,Symbol */
// Based on https://kangax.github.io/compat-table/es6/ we can sniff out
// incomplete Map/Set implementations which would otherwise cause our tests to fail.
// Notably they fail in IE11 and iOS 8.4, which this prevents.
function supportsMapAndSet() {
  if (typeof Symbol === 'undefined' || typeof Map === 'undefined' || typeof Set === 'undefined') {
    return false;
  }
  var prop = Object.getOwnPropertyDescriptor(Map, Symbol.species);
  return prop && 'get' in prop && Map[Symbol.species] === Map;
}

// based on https://github.com/montagejs/collections
/* global Map,Set */

var ExportedSet;
var ExportedMap;

{
  if (supportsMapAndSet()) { // prefer built-in Map/Set
    ExportedSet = Set;
    ExportedMap = Map;
  } else { // fall back to our polyfill
    ExportedSet = Set$1;
    ExportedMap = Map$1;
  }
}

// like underscore/lodash _.pick()
function pick(obj, arr) {
  var res = {};
  for (var i = 0, len = arr.length; i < len; i++) {
    var prop = arr[i];
    if (prop in obj) {
      res[prop] = obj[prop];
    }
  }
  return res;
}

// Most browsers throttle concurrent requests at 6, so it's silly
// to shim _bulk_get by trying to launch potentially hundreds of requests
// and then letting the majority time out. We can handle this ourselves.
var MAX_NUM_CONCURRENT_REQUESTS = 6;

function identityFunction(x) {
  return x;
}

function formatResultForOpenRevsGet(result) {
  return [{
    ok: result
  }];
}

// shim for P/CouchDB adapters that don't directly implement _bulk_get
function bulkGet(db, opts, callback) {
  var requests = opts.docs;

  // consolidate into one request per doc if possible
  var requestsById = new ExportedMap();
  requests.forEach(function (request) {
    if (requestsById.has(request.id)) {
      requestsById.get(request.id).push(request);
    } else {
      requestsById.set(request.id, [request]);
    }
  });

  var numDocs = requestsById.size;
  var numDone = 0;
  var perDocResults = new Array(numDocs);

  function collapseResultsAndFinish() {
    var results = [];
    perDocResults.forEach(function (res) {
      res.docs.forEach(function (info) {
        results.push({
          id: res.id,
          docs: [info]
        });
      });
    });
    callback(null, {results: results});
  }

  function checkDone() {
    if (++numDone === numDocs) {
      collapseResultsAndFinish();
    }
  }

  function gotResult(docIndex, id, docs) {
    perDocResults[docIndex] = {id: id, docs: docs};
    checkDone();
  }

  var allRequests = [];
  requestsById.forEach(function (value, key) {
    allRequests.push(key);
  });

  var i = 0;

  function nextBatch() {

    if (i >= allRequests.length) {
      return;
    }

    var upTo = Math.min(i + MAX_NUM_CONCURRENT_REQUESTS, allRequests.length);
    var batch = allRequests.slice(i, upTo);
    processBatch(batch, i);
    i += batch.length;
  }

  function processBatch(batch, offset) {
    batch.forEach(function (docId, j) {
      var docIdx = offset + j;
      var docRequests = requestsById.get(docId);

      // just use the first request as the "template"
      // TODO: The _bulk_get API allows for more subtle use cases than this,
      // but for now it is unlikely that there will be a mix of different
      // "atts_since" or "attachments" in the same request, since it's just
      // replicate.js that is using this for the moment.
      // Also, atts_since is aspirational, since we don't support it yet.
      var docOpts = pick(docRequests[0], ['atts_since', 'attachments']);
      docOpts.open_revs = docRequests.map(function (request) {
        // rev is optional, open_revs disallowed
        return request.rev;
      });

      // remove falsey / undefined revisions
      docOpts.open_revs = docOpts.open_revs.filter(identityFunction);

      var formatResult = identityFunction;

      if (docOpts.open_revs.length === 0) {
        delete docOpts.open_revs;

        // when fetching only the "winning" leaf,
        // transform the result so it looks like an open_revs
        // request
        formatResult = formatResultForOpenRevsGet;
      }

      // globally-supplied options
      ['revs', 'attachments', 'binary', 'ajax', 'latest'].forEach(function (param) {
        if (param in opts) {
          docOpts[param] = opts[param];
        }
      });
      db.get(docId, docOpts, function (err, res) {
        var result;
        /* istanbul ignore if */
        if (err) {
          result = [{error: err}];
        } else {
          result = formatResult(res);
        }
        gotResult(docIdx, docId, result);
        nextBatch();
      });
    });
  }

  nextBatch();

}

function isChromeApp() {
  return (typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined");
}

var hasLocal;

if (isChromeApp()) {
  hasLocal = false;
} else {
  try {
    localStorage.setItem('_pouch_check_localstorage', 1);
    hasLocal = !!localStorage.getItem('_pouch_check_localstorage');
  } catch (e) {
    hasLocal = false;
  }
}

function hasLocalStorage() {
  return hasLocal;
}

// Custom nextTick() shim for browsers. In node, this will just be process.nextTick(). We
// avoid using process.nextTick() directly because the polyfill is very large and we don't
// need all of it (see: https://github.com/defunctzombie/node-process).
// "immediate" 3.0.8 is used by lie, and it's a smaller version of the latest "immediate"
// package, so it's the one we use.
// When we use nextTick() in our codebase, we only care about not releasing Zalgo
// (see: http://blog.izs.me/post/59142742143/designing-apis-for-asynchrony).
// Microtask vs macrotask doesn't matter to us. So we're free to use the fastest
// (least latency) option, which is "immediate" due to use of microtasks.
// All of our nextTicks are isolated to this one function so we can easily swap out one
// implementation for another.

inherits(Changes, events.EventEmitter);

/* istanbul ignore next */
function attachBrowserEvents(self) {
  if (isChromeApp()) {
    chrome.storage.onChanged.addListener(function (e) {
      // make sure it's event addressed to us
      if (e.db_name != null) {
        //object only has oldValue, newValue members
        self.emit(e.dbName.newValue);
      }
    });
  } else if (hasLocalStorage()) {
    if (typeof addEventListener !== 'undefined') {
      addEventListener("storage", function (e) {
        self.emit(e.key);
      });
    } else { // old IE
      window.attachEvent("storage", function (e) {
        self.emit(e.key);
      });
    }
  }
}

function Changes() {
  events.EventEmitter.call(this);
  this._listeners = {};

  attachBrowserEvents(this);
}
Changes.prototype.addListener = function (dbName, id, db, opts) {
  /* istanbul ignore if */
  if (this._listeners[id]) {
    return;
  }
  var self = this;
  var inprogress = false;
  function eventFunction() {
    /* istanbul ignore if */
    if (!self._listeners[id]) {
      return;
    }
    if (inprogress) {
      inprogress = 'waiting';
      return;
    }
    inprogress = true;
    var changesOpts = pick(opts, [
      'style', 'include_docs', 'attachments', 'conflicts', 'filter',
      'doc_ids', 'view', 'since', 'query_params', 'binary'
    ]);

    /* istanbul ignore next */
    function onError() {
      inprogress = false;
    }

    db.changes(changesOpts).on('change', function (c) {
      if (c.seq > opts.since && !opts.cancelled) {
        opts.since = c.seq;
        opts.onChange(c);
      }
    }).on('complete', function () {
      if (inprogress === 'waiting') {
        nextTick(eventFunction);
      }
      inprogress = false;
    }).on('error', onError);
  }
  this._listeners[id] = eventFunction;
  this.on(dbName, eventFunction);
};

Changes.prototype.removeListener = function (dbName, id) {
  /* istanbul ignore if */
  if (!(id in this._listeners)) {
    return;
  }
  events.EventEmitter.prototype.removeListener.call(this, dbName,
    this._listeners[id]);
  delete this._listeners[id];
};


/* istanbul ignore next */
Changes.prototype.notifyLocalWindows = function (dbName) {
  //do a useless change on a storage thing
  //in order to get other windows's listeners to activate
  if (isChromeApp()) {
    chrome.storage.local.set({dbName: dbName});
  } else if (hasLocalStorage()) {
    localStorage[dbName] = (localStorage[dbName] === "a") ? "b" : "a";
  }
};

Changes.prototype.notify = function (dbName) {
  this.emit(dbName);
  this.notifyLocalWindows(dbName);
};

function guardedConsole(method) {
  /* istanbul ignore else */
  if (console !== 'undefined' && method in console) {
    var args = Array.prototype.slice.call(arguments, 1);
    console[method].apply(console, args);
  }
}

function randomNumber(min, max) {
  var maxTimeout = 600000; // Hard-coded default of 10 minutes
  min = parseInt(min, 10) || 0;
  max = parseInt(max, 10);
  if (max !== max || max <= min) {
    max = (min || 1) << 1; //doubling
  } else {
    max = max + 1;
  }
  // In order to not exceed maxTimeout, pick a random value between half of maxTimeout and maxTimeout
  if (max > maxTimeout) {
    min = maxTimeout >> 1; // divide by two
    max = maxTimeout;
  }
  var ratio = Math.random();
  var range = max - min;

  return ~~(range * ratio + min); // ~~ coerces to an int, but fast.
}

function defaultBackOff(min) {
  var max = 0;
  if (!min) {
    max = 2000;
  }
  return randomNumber(min, max);
}

// designed to give info to browser users, who are disturbed
// when they see http errors in the console
function explainError(status, str) {
  guardedConsole('info', 'The above ' + status + ' is totally normal. ' + str);
}

var assign;
{
  if (typeof Object.assign === 'function') {
    assign = Object.assign;
  } else {
    // lite Object.assign polyfill based on
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
    assign = function (target) {
      var to = Object(target);

      for (var index = 1; index < arguments.length; index++) {
        var nextSource = arguments[index];

        if (nextSource != null) { // Skip over if undefined or null
          for (var nextKey in nextSource) {
            // Avoid bugs when hasOwnProperty is shadowed
            if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
              to[nextKey] = nextSource[nextKey];
            }
          }
        }
      }
      return to;
    };
  }
}

var $inject_Object_assign = assign;

inherits(PouchError, Error);

function PouchError(status, error, reason) {
  Error.call(this, reason);
  this.status = status;
  this.name = error;
  this.message = reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message,
    reason: this.reason
  });
};

var UNAUTHORIZED = new PouchError(401, 'unauthorized', "Name or password is incorrect.");
var MISSING_BULK_DOCS = new PouchError(400, 'bad_request', "Missing JSON list of 'docs'");
var MISSING_DOC = new PouchError(404, 'not_found', 'missing');
var REV_CONFLICT = new PouchError(409, 'conflict', 'Document update conflict');
var INVALID_ID = new PouchError(400, 'bad_request', '_id field must contain a string');
var MISSING_ID = new PouchError(412, 'missing_id', '_id is required for puts');
var RESERVED_ID = new PouchError(400, 'bad_request', 'Only reserved document ids may start with underscore.');
var NOT_OPEN = new PouchError(412, 'precondition_failed', 'Database not open');
var UNKNOWN_ERROR = new PouchError(500, 'unknown_error', 'Database encountered an unknown error');
var BAD_ARG = new PouchError(500, 'badarg', 'Some query argument is invalid');
var INVALID_REQUEST = new PouchError(400, 'invalid_request', 'Request was invalid');
var QUERY_PARSE_ERROR = new PouchError(400, 'query_parse_error', 'Some query parameter is invalid');
var DOC_VALIDATION = new PouchError(500, 'doc_validation', 'Bad special document member');
var BAD_REQUEST = new PouchError(400, 'bad_request', 'Something wrong with the request');
var NOT_AN_OBJECT = new PouchError(400, 'bad_request', 'Document must be a JSON object');
var DB_MISSING = new PouchError(404, 'not_found', 'Database not found');
var IDB_ERROR = new PouchError(500, 'indexed_db_went_bad', 'unknown');
var WSQ_ERROR = new PouchError(500, 'web_sql_went_bad', 'unknown');
var LDB_ERROR = new PouchError(500, 'levelDB_went_went_bad', 'unknown');
var FORBIDDEN = new PouchError(403, 'forbidden', 'Forbidden by design doc validate_doc_update function');
var INVALID_REV = new PouchError(400, 'bad_request', 'Invalid rev format');
var FILE_EXISTS = new PouchError(412, 'file_exists', 'The database could not be created, the file already exists.');
var MISSING_STUB = new PouchError(412, 'missing_stub', 'A pre-existing attachment stub wasn\'t found');
var INVALID_URL = new PouchError(413, 'invalid_url', 'Provided URL is invalid');

function createError(error, reason) {
  function CustomPouchError(reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (var p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    /* jshint ignore:end */
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
}

function generateErrorFromResponse(err) {

  if (typeof err !== 'object') {
    var data = err;
    err = UNKNOWN_ERROR;
    err.data = data;
  }

  if ('error' in err && err.error === 'conflict') {
    err.name = 'conflict';
    err.status = 409;
  }

  if (!('name' in err)) {
    err.name = err.error || 'unknown';
  }

  if (!('status' in err)) {
    err.status = 500;
  }

  if (!('message' in err)) {
    err.message = err.message || err.reason;
  }

  return err;
}

function tryFilter(filter, doc, req) {
  try {
    return !filter(doc, req);
  } catch (err) {
    var msg = 'Filter function threw: ' + err.toString();
    return createError(BAD_REQUEST, msg);
  }
}

function filterChange(opts) {
  var req = {};
  var hasFilter = opts.filter && typeof opts.filter === 'function';
  req.query = opts.query_params;

  return function filter(change) {
    if (!change.doc) {
      // CSG sends events on the changes feed that don't have documents,
      // this hack makes a whole lot of existing code robust.
      change.doc = {};
    }

    var filterReturn = hasFilter && tryFilter(opts.filter, change.doc, req);

    if (typeof filterReturn === 'object') {
      return filterReturn;
    }

    if (filterReturn) {
      return false;
    }

    if (!opts.include_docs) {
      delete change.doc;
    } else if (!opts.attachments) {
      for (var att in change.doc._attachments) {
        /* istanbul ignore else */
        if (change.doc._attachments.hasOwnProperty(att)) {
          change.doc._attachments[att].stub = true;
        }
      }
    }
    return true;
  };
}

function flatten(arrs) {
  var res = [];
  for (var i = 0, len = arrs.length; i < len; i++) {
    res = res.concat(arrs[i]);
  }
  return res;
}

// shim for Function.prototype.name,
// for browsers that don't support it like IE

/* istanbul ignore next */
function f() {}

var hasName = f.name;
var res;

// We dont run coverage in IE
/* istanbul ignore else */
if (hasName) {
  res = function (fun) {
    return fun.name;
  };
} else {
  res = function (fun) {
    return fun.toString().match(/^\s*function\s*(\S*)\s*\(/)[1];
  };
}

// Determine id an ID is valid
//   - invalid IDs begin with an underescore that does not begin '_design' or
//     '_local'
//   - any other string value is a valid id
// Returns the specific error object for each case
function invalidIdError(id) {
  var err;
  if (!id) {
    err = createError(MISSING_ID);
  } else if (typeof id !== 'string') {
    err = createError(INVALID_ID);
  } else if (/^_/.test(id) && !(/^_(design|local)/).test(id)) {
    err = createError(RESERVED_ID);
  }
  if (err) {
    throw err;
  }
}

// Checks if a PouchDB object is "remote" or not. This is
// designed to opt-in to certain optimizations, such as
// avoiding checks for "dependentDbs" and other things that
// we know only apply to local databases. In general, "remote"
// should be true for the http adapter, and for third-party
// adapters with similar expensive boundaries to cross for
// every API call, such as socket-pouch and worker-pouch.
// Previously, this was handled via db.type() === 'http'
// which is now deprecated.

function isRemote(db) {
  if (typeof db._remote === 'boolean') {
    return db._remote;
  }
  /* istanbul ignore next */
  if (typeof db.type === 'function') {
    guardedConsole('warn',
      'db.type() is deprecated and will be removed in ' +
      'a future version of PouchDB');
    return db.type() === 'http';
  }
  /* istanbul ignore next */
  return false;
}

function listenerCount(ee, type) {
  return 'listenerCount' in ee ? ee.listenerCount(type) :
                                 events.EventEmitter.listenerCount(ee, type);
}

function parseDesignDocFunctionName(s) {
  if (!s) {
    return null;
  }
  var parts = s.split('/');
  if (parts.length === 2) {
    return parts;
  }
  if (parts.length === 1) {
    return [s, s];
  }
  return null;
}

function normalizeDesignDocFunctionName(s) {
  var normalized = parseDesignDocFunctionName(s);
  return normalized ? normalized.join('/') : null;
}

// originally parseUri 1.2.2, now patched by us
// (c) Steven Levithan <stevenlevithan.com>
// MIT License
var keys = ["source", "protocol", "authority", "userInfo", "user", "password",
    "host", "port", "relative", "path", "directory", "file", "query", "anchor"];
var qName ="queryKey";
var qParser = /(?:^|&)([^&=]*)=?([^&]*)/g;

// use the "loose" parser
/* jshint maxlen: false */
var parser = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

function parseUri(str) {
  var m = parser.exec(str);
  var uri = {};
  var i = 14;

  while (i--) {
    var key = keys[i];
    var value = m[i] || "";
    var encoded = ['user', 'password'].indexOf(key) !== -1;
    uri[key] = encoded ? decodeURIComponent(value) : value;
  }

  uri[qName] = {};
  uri[keys[12]].replace(qParser, function ($0, $1, $2) {
    if ($1) {
      uri[qName][$1] = $2;
    }
  });

  return uri;
}

// Based on https://github.com/alexdavid/scope-eval v0.0.3
// (source: https://unpkg.com/scope-eval@0.0.3/scope_eval.js)
// This is basically just a wrapper around new Function()

function scopeEval(source, scope) {
  var keys = [];
  var values = [];
  for (var key in scope) {
    if (scope.hasOwnProperty(key)) {
      keys.push(key);
      values.push(scope[key]);
    }
  }
  keys.push(source);
  return Function.apply(null, keys).apply(null, values);
}

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
// the diffFun tells us what delta to apply to the doc.  it either returns
// the doc, or false if it doesn't need to do an update after all
function upsert(db, docId, diffFun) {
  return new PouchPromise$1(function (fulfill, reject) {
    db.get(docId, function (err, doc) {
      if (err) {
        /* istanbul ignore next */
        if (err.status !== 404) {
          return reject(err);
        }
        doc = {};
      }

      // the user might change the _rev, so save it for posterity
      var docRev = doc._rev;
      var newDoc = diffFun(doc);

      if (!newDoc) {
        // if the diffFun returns falsy, we short-circuit as
        // an optimization
        return fulfill({updated: false, rev: docRev});
      }

      // users aren't allowed to modify these values,
      // so reset them here
      newDoc._id = docId;
      newDoc._rev = docRev;
      fulfill(tryAndPut(db, newDoc, diffFun));
    });
  });
}

function tryAndPut(db, doc, diffFun) {
  return db.put(doc).then(function (res) {
    return {
      updated: true,
      rev: res.rev
    };
  }, function (err) {
    /* istanbul ignore next */
    if (err.status !== 409) {
      throw err;
    }
    return upsert(db, doc._id, diffFun);
  });
}

// BEGIN Math.uuid.js

/*!
Math.uuid.js (v1.4)
http://www.broofa.com
mailto:robert@broofa.com

Copyright (c) 2010 Robert Kieffer
Dual licensed under the MIT and GPL licenses.
*/

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix. 
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
var chars = (
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz'
).split('');
function getValue(radix) {
  return 0 | Math.random() * radix;
}
function uuid(len, radix) {
  radix = radix || chars.length;
  var out = '';
  var i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
  }
    // rfc4122, version 4 form
    // Fill in random data.  At i==19 set the high bits of clock sequence as
    // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
      case 8:
      case 13:
      case 18:
      case 23:
        out += '-';
        break;
      case 19:
        out += chars[(getValue(16) & 0x3) | 0x8];
        break;
      default:
        out += chars[getValue(16)];
    }
  }

  return out;
}

// We fetch all leafs of the revision tree, and sort them based on tree length
// and whether they were deleted, undeleted documents with the longest revision
// tree (most edits) win
// The final sort algorithm is slightly documented in a sidebar here:
// http://guide.couchdb.org/draft/conflicts.html
function winningRev(metadata) {
  var winningId;
  var winningPos;
  var winningDeleted;
  var toVisit = metadata.rev_tree.slice();
  var node;
  while ((node = toVisit.pop())) {
    var tree = node.ids;
    var branches = tree[2];
    var pos = node.pos;
    if (branches.length) { // non-leaf
      for (var i = 0, len = branches.length; i < len; i++) {
        toVisit.push({pos: pos + 1, ids: branches[i]});
      }
      continue;
    }
    var deleted = !!tree[1].deleted;
    var id = tree[0];
    // sort by deleted, then pos, then id
    if (!winningId || (winningDeleted !== deleted ? winningDeleted :
        winningPos !== pos ? winningPos < pos : winningId < id)) {
      winningId = id;
      winningPos = pos;
      winningDeleted = deleted;
    }
  }

  return winningPos + '-' + winningId;
}

// Pretty much all below can be combined into a higher order function to
// traverse revisions
// The return value from the callback will be passed as context to all
// children of that node
function traverseRevTree(revs, callback) {
  var toVisit = revs.slice();

  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var branches = tree[2];
    var newCtx =
      callback(branches.length === 0, pos, tree[0], node.ctx, tree[1]);
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: pos + 1, ids: branches[i], ctx: newCtx});
    }
  }
}

function sortByPos(a, b) {
  return a.pos - b.pos;
}

function collectLeaves(revs) {
  var leaves = [];
  traverseRevTree(revs, function (isLeaf, pos, id, acc, opts) {
    if (isLeaf) {
      leaves.push({rev: pos + "-" + id, pos: pos, opts: opts});
    }
  });
  leaves.sort(sortByPos).reverse();
  for (var i = 0, len = leaves.length; i < len; i++) {
    delete leaves[i].pos;
  }
  return leaves;
}

// returns revs of all conflicts that is leaves such that
// 1. are not deleted and
// 2. are different than winning revision
function collectConflicts(metadata) {
  var win = winningRev(metadata);
  var leaves = collectLeaves(metadata.rev_tree);
  var conflicts = [];
  for (var i = 0, len = leaves.length; i < len; i++) {
    var leaf = leaves[i];
    if (leaf.rev !== win && !leaf.opts.deleted) {
      conflicts.push(leaf.rev);
    }
  }
  return conflicts;
}

// compact a tree by marking its non-leafs as missing,
// and return a list of revs to delete
function compactTree(metadata) {
  var revs = [];
  traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
                                               revHash, ctx, opts) {
    if (opts.status === 'available' && !isLeaf) {
      revs.push(pos + '-' + revHash);
      opts.status = 'missing';
    }
  });
  return revs;
}

// build up a list of all the paths to the leafs in this revision tree
function rootToLeaf(revs) {
  var paths = [];
  var toVisit = revs.slice();
  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var id = tree[0];
    var opts = tree[1];
    var branches = tree[2];
    var isLeaf = branches.length === 0;

    var history = node.history ? node.history.slice() : [];
    history.push({id: id, opts: opts});
    if (isLeaf) {
      paths.push({pos: (pos + 1 - history.length), ids: history});
    }
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: pos + 1, ids: branches[i], history: history});
    }
  }
  return paths.reverse();
}

// for a better overview of what this is doing, read:
// https://github.com/apache/couchdb-couch/blob/master/src/couch_key_tree.erl
//
// But for a quick intro, CouchDB uses a revision tree to store a documents
// history, A -> B -> C, when a document has conflicts, that is a branch in the
// tree, A -> (B1 | B2 -> C), We store these as a nested array in the format
//
// KeyTree = [Path ... ]
// Path = {pos: position_from_root, ids: Tree}
// Tree = [Key, Opts, [Tree, ...]], in particular single node: [Key, []]

function sortByPos$1(a, b) {
  return a.pos - b.pos;
}

// classic binary search
function binarySearch(arr, item, comparator) {
  var low = 0;
  var high = arr.length;
  var mid;
  while (low < high) {
    mid = (low + high) >>> 1;
    if (comparator(arr[mid], item) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// assuming the arr is sorted, insert the item in the proper place
function insertSorted(arr, item, comparator) {
  var idx = binarySearch(arr, item, comparator);
  arr.splice(idx, 0, item);
}

// Turn a path as a flat array into a tree with a single branch.
// If any should be stemmed from the beginning of the array, that's passed
// in as the second argument
function pathToTree(path, numStemmed) {
  var root;
  var leaf;
  for (var i = numStemmed, len = path.length; i < len; i++) {
    var node = path[i];
    var currentLeaf = [node.id, node.opts, []];
    if (leaf) {
      leaf[2].push(currentLeaf);
      leaf = currentLeaf;
    } else {
      root = leaf = currentLeaf;
    }
  }
  return root;
}

// compare the IDs of two trees
function compareTree(a, b) {
  return a[0] < b[0] ? -1 : 1;
}

// Merge two trees together
// The roots of tree1 and tree2 must be the same revision
function mergeTree(in_tree1, in_tree2) {
  var queue = [{tree1: in_tree1, tree2: in_tree2}];
  var conflicts = false;
  while (queue.length > 0) {
    var item = queue.pop();
    var tree1 = item.tree1;
    var tree2 = item.tree2;

    if (tree1[1].status || tree2[1].status) {
      tree1[1].status =
        (tree1[1].status ===  'available' ||
        tree2[1].status === 'available') ? 'available' : 'missing';
    }

    for (var i = 0; i < tree2[2].length; i++) {
      if (!tree1[2][0]) {
        conflicts = 'new_leaf';
        tree1[2][0] = tree2[2][i];
        continue;
      }

      var merged = false;
      for (var j = 0; j < tree1[2].length; j++) {
        if (tree1[2][j][0] === tree2[2][i][0]) {
          queue.push({tree1: tree1[2][j], tree2: tree2[2][i]});
          merged = true;
        }
      }
      if (!merged) {
        conflicts = 'new_branch';
        insertSorted(tree1[2], tree2[2][i], compareTree);
      }
    }
  }
  return {conflicts: conflicts, tree: in_tree1};
}

function doMerge(tree, path, dontExpand) {
  var restree = [];
  var conflicts = false;
  var merged = false;
  var res;

  if (!tree.length) {
    return {tree: [path], conflicts: 'new_leaf'};
  }

  for (var i = 0, len = tree.length; i < len; i++) {
    var branch = tree[i];
    if (branch.pos === path.pos && branch.ids[0] === path.ids[0]) {
      // Paths start at the same position and have the same root, so they need
      // merged
      res = mergeTree(branch.ids, path.ids);
      restree.push({pos: branch.pos, ids: res.tree});
      conflicts = conflicts || res.conflicts;
      merged = true;
    } else if (dontExpand !== true) {
      // The paths start at a different position, take the earliest path and
      // traverse up until it as at the same point from root as the path we
      // want to merge.  If the keys match we return the longer path with the
      // other merged After stemming we dont want to expand the trees

      var t1 = branch.pos < path.pos ? branch : path;
      var t2 = branch.pos < path.pos ? path : branch;
      var diff = t2.pos - t1.pos;

      var candidateParents = [];

      var trees = [];
      trees.push({ids: t1.ids, diff: diff, parent: null, parentIdx: null});
      while (trees.length > 0) {
        var item = trees.pop();
        if (item.diff === 0) {
          if (item.ids[0] === t2.ids[0]) {
            candidateParents.push(item);
          }
          continue;
        }
        var elements = item.ids[2];
        for (var j = 0, elementsLen = elements.length; j < elementsLen; j++) {
          trees.push({
            ids: elements[j],
            diff: item.diff - 1,
            parent: item.ids,
            parentIdx: j
          });
        }
      }

      var el = candidateParents[0];

      if (!el) {
        restree.push(branch);
      } else {
        res = mergeTree(el.ids, t2.ids);
        el.parent[2][el.parentIdx] = res.tree;
        restree.push({pos: t1.pos, ids: t1.ids});
        conflicts = conflicts || res.conflicts;
        merged = true;
      }
    } else {
      restree.push(branch);
    }
  }

  // We didnt find
  if (!merged) {
    restree.push(path);
  }

  restree.sort(sortByPos$1);

  return {
    tree: restree,
    conflicts: conflicts || 'internal_node'
  };
}

// To ensure we dont grow the revision tree infinitely, we stem old revisions
function stem(tree, depth) {
  // First we break out the tree into a complete list of root to leaf paths
  var paths = rootToLeaf(tree);
  var stemmedRevs;

  var result;
  for (var i = 0, len = paths.length; i < len; i++) {
    // Then for each path, we cut off the start of the path based on the
    // `depth` to stem to, and generate a new set of flat trees
    var path = paths[i];
    var stemmed = path.ids;
    var node;
    if (stemmed.length > depth) {
      // only do the stemming work if we actually need to stem
      if (!stemmedRevs) {
        stemmedRevs = {}; // avoid allocating this object unnecessarily
      }
      var numStemmed = stemmed.length - depth;
      node = {
        pos: path.pos + numStemmed,
        ids: pathToTree(stemmed, numStemmed)
      };

      for (var s = 0; s < numStemmed; s++) {
        var rev = (path.pos + s) + '-' + stemmed[s].id;
        stemmedRevs[rev] = true;
      }
    } else { // no need to actually stem
      node = {
        pos: path.pos,
        ids: pathToTree(stemmed, 0)
      };
    }

    // Then we remerge all those flat trees together, ensuring that we dont
    // connect trees that would go beyond the depth limit
    if (result) {
      result = doMerge(result, node, true).tree;
    } else {
      result = [node];
    }
  }

  // this is memory-heavy per Chrome profiler, avoid unless we actually stemmed
  if (stemmedRevs) {
    traverseRevTree(result, function (isLeaf, pos, revHash) {
      // some revisions may have been removed in a branch but not in another
      delete stemmedRevs[pos + '-' + revHash];
    });
  }

  return {
    tree: result,
    revs: stemmedRevs ? Object.keys(stemmedRevs) : []
  };
}

function merge(tree, path, depth) {
  var newTree = doMerge(tree, path);
  var stemmed = stem(newTree.tree, depth);
  return {
    tree: stemmed.tree,
    stemmedRevs: stemmed.revs,
    conflicts: newTree.conflicts
  };
}

// return true if a rev exists in the rev tree, false otherwise
function revExists(revs, rev) {
  var toVisit = revs.slice();
  var splitRev = rev.split('-');
  var targetPos = parseInt(splitRev[0], 10);
  var targetId = splitRev[1];

  var node;
  while ((node = toVisit.pop())) {
    if (node.pos === targetPos && node.ids[0] === targetId) {
      return true;
    }
    var branches = node.ids[2];
    for (var i = 0, len = branches.length; i < len; i++) {
      toVisit.push({pos: node.pos + 1, ids: branches[i]});
    }
  }
  return false;
}

function getTrees(node) {
  return node.ids;
}

// check if a specific revision of a doc has been deleted
//  - metadata: the metadata object from the doc store
//  - rev: (optional) the revision to check. defaults to winning revision
function isDeleted(metadata, rev) {
  if (!rev) {
    rev = winningRev(metadata);
  }
  var id = rev.substring(rev.indexOf('-') + 1);
  var toVisit = metadata.rev_tree.map(getTrees);

  var tree;
  while ((tree = toVisit.pop())) {
    if (tree[0] === id) {
      return !!tree[1].deleted;
    }
    toVisit = toVisit.concat(tree[2]);
  }
}

function isLocalId(id) {
  return (/^_local/).test(id);
}

// returns the current leaf node for a given revision
function latest(rev, metadata) {
  var toVisit = metadata.rev_tree.slice();
  var node;
  while ((node = toVisit.pop())) {
    var pos = node.pos;
    var tree = node.ids;
    var id = tree[0];
    var opts = tree[1];
    var branches = tree[2];
    var isLeaf = branches.length === 0;

    var history = node.history ? node.history.slice() : [];
    history.push({id: id, pos: pos, opts: opts});

    if (isLeaf) {
      for (var i = 0, len = history.length; i < len; i++) {
        var historyNode = history[i];
        var historyRev = historyNode.pos + '-' + historyNode.id;

        if (historyRev === rev) {
          // return the rev of this leaf
          return pos + '-' + id;
        }
      }
    }

    for (var j = 0, l = branches.length; j < l; j++) {
      toVisit.push({pos: pos + 1, ids: branches[j], history: history});
    }
  }

  /* istanbul ignore next */
  throw new Error('Unable to resolve latest revision for id ' + metadata.id + ', rev ' + rev);
}

inherits(Changes$2, events.EventEmitter);

function tryCatchInChangeListener(self, change) {
  // isolate try/catches to avoid V8 deoptimizations
  try {
    self.emit('change', change);
  } catch (e) {
    guardedConsole('error', 'Error in .on("change", function):', e);
  }
}

function Changes$2(db, opts, callback) {
  events.EventEmitter.call(this);
  var self = this;
  this.db = db;
  opts = opts ? clone(opts) : {};
  var complete = opts.complete = once(function (err, resp) {
    if (err) {
      if (listenerCount(self, 'error') > 0) {
        self.emit('error', err);
      }
    } else {
      self.emit('complete', resp);
    }
    self.removeAllListeners();
    db.removeListener('destroyed', onDestroy);
  });
  if (callback) {
    self.on('complete', function (resp) {
      callback(null, resp);
    });
    self.on('error', callback);
  }
  function onDestroy() {
    self.cancel();
  }
  db.once('destroyed', onDestroy);

  opts.onChange = function (change) {
    /* istanbul ignore if */
    if (self.isCancelled) {
      return;
    }
    tryCatchInChangeListener(self, change);
  };

  var promise = new PouchPromise$1(function (fulfill, reject) {
    opts.complete = function (err, res) {
      if (err) {
        reject(err);
      } else {
        fulfill(res);
      }
    };
  });
  self.once('cancel', function () {
    db.removeListener('destroyed', onDestroy);
    opts.complete(null, {status: 'cancelled'});
  });
  this.then = promise.then.bind(promise);
  this['catch'] = promise['catch'].bind(promise);
  this.then(function (result) {
    complete(null, result);
  }, complete);



  if (!db.taskqueue.isReady) {
    db.taskqueue.addTask(function (failed) {
      if (failed) {
        opts.complete(failed);
      } else if (self.isCancelled) {
        self.emit('cancel');
      } else {
        self.validateChanges(opts);
      }
    });
  } else {
    self.validateChanges(opts);
  }
}
Changes$2.prototype.cancel = function () {
  this.isCancelled = true;
  if (this.db.taskqueue.isReady) {
    this.emit('cancel');
  }
};
function processChange(doc, metadata, opts) {
  var changeList = [{rev: doc._rev}];
  if (opts.style === 'all_docs') {
    changeList = collectLeaves(metadata.rev_tree)
    .map(function (x) { return {rev: x.rev}; });
  }
  var change = {
    id: metadata.id,
    changes: changeList,
    doc: doc
  };

  if (isDeleted(metadata, doc._rev)) {
    change.deleted = true;
  }
  if (opts.conflicts) {
    change.doc._conflicts = collectConflicts(metadata);
    if (!change.doc._conflicts.length) {
      delete change.doc._conflicts;
    }
  }
  return change;
}

Changes$2.prototype.validateChanges = function (opts) {
  var callback = opts.complete;
  var self = this;

  /* istanbul ignore else */
  if (PouchDB$3._changesFilterPlugin) {
    PouchDB$3._changesFilterPlugin.validate(opts, function (err) {
      if (err) {
        return callback(err);
      }
      self.doChanges(opts);
    });
  } else {
    self.doChanges(opts);
  }
};

Changes$2.prototype.doChanges = function (opts) {
  var self = this;
  var callback = opts.complete;

  opts = clone(opts);
  if ('live' in opts && !('continuous' in opts)) {
    opts.continuous = opts.live;
  }
  opts.processChange = processChange;

  if (opts.since === 'latest') {
    opts.since = 'now';
  }
  if (!opts.since) {
    opts.since = 0;
  }
  if (opts.since === 'now') {
    this.db.info().then(function (info) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        callback(null, {status: 'cancelled'});
        return;
      }
      opts.since = info.update_seq;
      self.doChanges(opts);
    }, callback);
    return;
  }

  /* istanbul ignore else */
  if (PouchDB$3._changesFilterPlugin) {
    PouchDB$3._changesFilterPlugin.normalize(opts);
    if (PouchDB$3._changesFilterPlugin.shouldFilter(this, opts)) {
      return PouchDB$3._changesFilterPlugin.filter(this, opts);
    }
  } else {
    ['doc_ids', 'filter', 'selector', 'view'].forEach(function (key) {
      if (key in opts) {
        guardedConsole('warn',
          'The "' + key + '" option was passed in to changes/replicate, ' +
          'but pouchdb-changes-filter plugin is not installed, so it ' +
          'was ignored. Please install the plugin to enable filtering.'
        );
      }
    });
  }

  if (!('descending' in opts)) {
    opts.descending = false;
  }

  // 0 and 1 should return 1 document
  opts.limit = opts.limit === 0 ? 1 : opts.limit;
  opts.complete = callback;
  var newPromise = this.db._changes(opts);
  /* istanbul ignore else */
  if (newPromise && typeof newPromise.cancel === 'function') {
    var cancel = self.cancel;
    self.cancel = getArguments(function (args) {
      newPromise.cancel();
      cancel.apply(this, args);
    });
  }
};

/*
 * A generic pouch adapter
 */

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Wrapper for functions that call the bulkdocs api with a single doc,
// if the first result is an error, return an error
function yankError(callback) {
  return function (err, results) {
    if (err || (results[0] && results[0].error)) {
      callback(err || results[0]);
    } else {
      callback(null, results.length ? results[0]  : results);
    }
  };
}

// clean docs given to us by the user
function cleanDocs(docs) {
  for (var i = 0; i < docs.length; i++) {
    var doc = docs[i];
    if (doc._deleted) {
      delete doc._attachments; // ignore atts for deleted docs
    } else if (doc._attachments) {
      // filter out extraneous keys from _attachments
      var atts = Object.keys(doc._attachments);
      for (var j = 0; j < atts.length; j++) {
        var att = atts[j];
        doc._attachments[att] = pick(doc._attachments[att],
          ['data', 'digest', 'content_type', 'length', 'revpos', 'stub']);
      }
    }
  }
}

// compare two docs, first by _id then by _rev
function compareByIdThenRev(a, b) {
  var idCompare = compare(a._id, b._id);
  if (idCompare !== 0) {
    return idCompare;
  }
  var aStart = a._revisions ? a._revisions.start : 0;
  var bStart = b._revisions ? b._revisions.start : 0;
  return compare(aStart, bStart);
}

// for every node in a revision tree computes its distance from the closest
// leaf
function computeHeight(revs) {
  var height = {};
  var edges = [];
  traverseRevTree(revs, function (isLeaf, pos, id, prnt) {
    var rev = pos + "-" + id;
    if (isLeaf) {
      height[rev] = 0;
    }
    if (prnt !== undefined) {
      edges.push({from: prnt, to: rev});
    }
    return rev;
  });

  edges.reverse();
  edges.forEach(function (edge) {
    if (height[edge.from] === undefined) {
      height[edge.from] = 1 + height[edge.to];
    } else {
      height[edge.from] = Math.min(height[edge.from], 1 + height[edge.to]);
    }
  });
  return height;
}

function allDocsKeysQuery(api, opts, callback) {
  var keys =  ('limit' in opts) ?
      opts.keys.slice(opts.skip, opts.limit + opts.skip) :
      (opts.skip > 0) ? opts.keys.slice(opts.skip) : opts.keys;
  if (opts.descending) {
    keys.reverse();
  }
  if (!keys.length) {
    return api._allDocs({limit: 0}, callback);
  }
  var finalResults = {
    offset: opts.skip
  };
  return PouchPromise$1.all(keys.map(function (key) {
    var subOpts = $inject_Object_assign({key: key, deleted: 'ok'}, opts);
    ['limit', 'skip', 'keys'].forEach(function (optKey) {
      delete subOpts[optKey];
    });
    return new PouchPromise$1(function (resolve, reject) {
      api._allDocs(subOpts, function (err, res) {
        /* istanbul ignore if */
        if (err) {
          return reject(err);
        }
        finalResults.total_rows = res.total_rows;
        resolve(res.rows[0] || {key: key, error: 'not_found'});
      });
    });
  })).then(function (results) {
    finalResults.rows = results;
    return finalResults;
  });
}

// all compaction is done in a queue, to avoid attaching
// too many listeners at once
function doNextCompaction(self) {
  var task = self._compactionQueue[0];
  var opts = task.opts;
  var callback = task.callback;
  self.get('_local/compaction').catch(function () {
    return false;
  }).then(function (doc) {
    if (doc && doc.last_seq) {
      opts.last_seq = doc.last_seq;
    }
    self._compact(opts, function (err, res) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        callback(null, res);
      }
      nextTick(function () {
        self._compactionQueue.shift();
        if (self._compactionQueue.length) {
          doNextCompaction(self);
        }
      });
    });
  });
}

function attachmentNameError(name) {
  if (name.charAt(0) === '_') {
    return name + ' is not a valid attachment name, attachment ' +
      'names cannot start with \'_\'';
  }
  return false;
}

inherits(AbstractPouchDB, events.EventEmitter);

function AbstractPouchDB() {
  events.EventEmitter.call(this);
}

AbstractPouchDB.prototype.post =
  adapterFun('post', function (doc, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return callback(createError(NOT_AN_OBJECT));
  }
  this.bulkDocs({docs: [doc]}, opts, yankError(callback));
});

AbstractPouchDB.prototype.put = adapterFun('put', function (doc, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return cb(createError(NOT_AN_OBJECT));
  }
  invalidIdError(doc._id);
  if (isLocalId(doc._id) && typeof this._putLocal === 'function') {
    if (doc._deleted) {
      return this._removeLocal(doc, cb);
    } else {
      return this._putLocal(doc, cb);
    }
  }
  if (typeof this._put === 'function' && opts.new_edits !== false) {
    this._put(doc, opts, cb);
  } else {
    this.bulkDocs({docs: [doc]}, opts, yankError(cb));
  }
});

AbstractPouchDB.prototype.putAttachment =
  adapterFun('putAttachment', function (docId, attachmentId, rev,
                                              blob, type) {
  var api = this;
  if (typeof type === 'function') {
    type = blob;
    blob = rev;
    rev = null;
  }
  // Lets fix in https://github.com/pouchdb/pouchdb/issues/3267
  /* istanbul ignore if */
  if (typeof type === 'undefined') {
    type = blob;
    blob = rev;
    rev = null;
  }
  if (!type) {
    guardedConsole('warn', 'Attachment', attachmentId, 'on document', docId, 'is missing content_type');
  }

  function createAttachment(doc) {
    var prevrevpos = '_rev' in doc ? parseInt(doc._rev, 10) : 0;
    doc._attachments = doc._attachments || {};
    doc._attachments[attachmentId] = {
      content_type: type,
      data: blob,
      revpos: ++prevrevpos
    };
    return api.put(doc);
  }

  return api.get(docId).then(function (doc) {
    if (doc._rev !== rev) {
      throw createError(REV_CONFLICT);
    }

    return createAttachment(doc);
  }, function (err) {
     // create new doc
    /* istanbul ignore else */
    if (err.reason === MISSING_DOC.message) {
      return createAttachment({_id: docId});
    } else {
      throw err;
    }
  });
});

AbstractPouchDB.prototype.removeAttachment =
  adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                 callback) {
  var self = this;
  self.get(docId, function (err, obj) {
    /* istanbul ignore if */
    if (err) {
      callback(err);
      return;
    }
    if (obj._rev !== rev) {
      callback(createError(REV_CONFLICT));
      return;
    }
    /* istanbul ignore if */
    if (!obj._attachments) {
      return callback();
    }
    delete obj._attachments[attachmentId];
    if (Object.keys(obj._attachments).length === 0) {
      delete obj._attachments;
    }
    self.put(obj, callback);
  });
});

AbstractPouchDB.prototype.remove =
  adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
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
  opts = opts || {};
  opts.was_delete = true;
  var newDoc = {_id: doc._id, _rev: (doc._rev || opts.rev)};
  newDoc._deleted = true;
  if (isLocalId(newDoc._id) && typeof this._removeLocal === 'function') {
    return this._removeLocal(doc, callback);
  }
  this.bulkDocs({docs: [newDoc]}, opts, yankError(callback));
});

AbstractPouchDB.prototype.revsDiff =
  adapterFun('revsDiff', function (req, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  var ids = Object.keys(req);

  if (!ids.length) {
    return callback(null, {});
  }

  var count = 0;
  var missing = new ExportedMap();

  function addToMissing(id, revId) {
    if (!missing.has(id)) {
      missing.set(id, {missing: []});
    }
    missing.get(id).missing.push(revId);
  }

  function processDoc(id, rev_tree) {
    // Is this fast enough? Maybe we should switch to a set simulated by a map
    var missingForId = req[id].slice(0);
    traverseRevTree(rev_tree, function (isLeaf, pos, revHash, ctx,
      opts) {
        var rev = pos + '-' + revHash;
        var idx = missingForId.indexOf(rev);
        if (idx === -1) {
          return;
        }

        missingForId.splice(idx, 1);
        /* istanbul ignore if */
        if (opts.status !== 'available') {
          addToMissing(id, rev);
        }
      });

    // Traversing the tree is synchronous, so now `missingForId` contains
    // revisions that were not found in the tree
    missingForId.forEach(function (rev) {
      addToMissing(id, rev);
    });
  }

  ids.map(function (id) {
    this._getRevisionTree(id, function (err, rev_tree) {
      if (err && err.status === 404 && err.message === 'missing') {
        missing.set(id, {missing: req[id]});
      } else if (err) {
        /* istanbul ignore next */
        return callback(err);
      } else {
        processDoc(id, rev_tree);
      }

      if (++count === ids.length) {
        // convert LazyMap to object
        var missingObj = {};
        missing.forEach(function (value, key) {
          missingObj[key] = value;
        });
        return callback(null, missingObj);
      }
    });
  }, this);
});

// _bulk_get API for faster replication, as described in
// https://github.com/apache/couchdb-chttpd/pull/33
// At the "abstract" level, it will just run multiple get()s in
// parallel, because this isn't much of a performance cost
// for local databases (except the cost of multiple transactions, which is
// small). The http adapter overrides this in order
// to do a more efficient single HTTP request.
AbstractPouchDB.prototype.bulkGet =
  adapterFun('bulkGet', function (opts, callback) {
  bulkGet(this, opts, callback);
});

// compact one document and fire callback
// by compacting we mean removing all revisions which
// are further from the leaf in revision tree than max_height
AbstractPouchDB.prototype.compactDocument =
  adapterFun('compactDocument', function (docId, maxHeight, callback) {
  var self = this;
  this._getRevisionTree(docId, function (err, revTree) {
    /* istanbul ignore if */
    if (err) {
      return callback(err);
    }
    var height = computeHeight(revTree);
    var candidates = [];
    var revs = [];
    Object.keys(height).forEach(function (rev) {
      if (height[rev] > maxHeight) {
        candidates.push(rev);
      }
    });

    traverseRevTree(revTree, function (isLeaf, pos, revHash, ctx, opts) {
      var rev = pos + '-' + revHash;
      if (opts.status === 'available' && candidates.indexOf(rev) !== -1) {
        revs.push(rev);
      }
    });
    self._doCompaction(docId, revs, callback);
  });
});

// compact the whole database using single document
// compaction
AbstractPouchDB.prototype.compact =
  adapterFun('compact', function (opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }

  var self = this;
  opts = opts || {};

  self._compactionQueue = self._compactionQueue || [];
  self._compactionQueue.push({opts: opts, callback: callback});
  if (self._compactionQueue.length === 1) {
    doNextCompaction(self);
  }
});
AbstractPouchDB.prototype._compact = function (opts, callback) {
  var self = this;
  var changesOpts = {
    return_docs: false,
    last_seq: opts.last_seq || 0
  };
  var promises = [];

  function onChange(row) {
    promises.push(self.compactDocument(row.id, 0));
  }
  function onComplete(resp) {
    var lastSeq = resp.last_seq;
    PouchPromise$1.all(promises).then(function () {
      return upsert(self, '_local/compaction', function deltaFunc(doc) {
        if (!doc.last_seq || doc.last_seq < lastSeq) {
          doc.last_seq = lastSeq;
          return doc;
        }
        return false; // somebody else got here first, don't update
      });
    }).then(function () {
      callback(null, {ok: true});
    }).catch(callback);
  }
  self.changes(changesOpts)
    .on('change', onChange)
    .on('complete', onComplete)
    .on('error', callback);
};

/* Begin api wrappers. Specific functionality to storage belongs in the
   _[method] */
AbstractPouchDB.prototype.get = adapterFun('get', function (id, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (typeof id !== 'string') {
    return cb(createError(INVALID_ID));
  }
  if (isLocalId(id) && typeof this._getLocal === 'function') {
    return this._getLocal(id, cb);
  }
  var leaves = [], self = this;

  function finishOpenRevs() {
    var result = [];
    var count = leaves.length;
    /* istanbul ignore if */
    if (!count) {
      return cb(null, result);
    }

    // order with open_revs is unspecified
    leaves.forEach(function (leaf) {
      self.get(id, {
        rev: leaf,
        revs: opts.revs,
        latest: opts.latest,
        attachments: opts.attachments
      }, function (err, doc) {
        if (!err) {
          // using latest=true can produce duplicates
          var existing;
          for (var i = 0, l = result.length; i < l; i++) {
            if (result[i].ok && result[i].ok._rev === doc._rev) {
              existing = true;
              break;
            }
          }
          if (!existing) {
            result.push({ok: doc});
          }
        } else {
          result.push({missing: leaf});
        }
        count--;
        if (!count) {
          cb(null, result);
        }
      });
    });
  }

  if (opts.open_revs) {
    if (opts.open_revs === "all") {
      this._getRevisionTree(id, function (err, rev_tree) {
        if (err) {
          return cb(err);
        }
        leaves = collectLeaves(rev_tree).map(function (leaf) {
          return leaf.rev;
        });
        finishOpenRevs();
      });
    } else {
      if (Array.isArray(opts.open_revs)) {
        leaves = opts.open_revs;
        for (var i = 0; i < leaves.length; i++) {
          var l = leaves[i];
          // looks like it's the only thing couchdb checks
          if (!(typeof (l) === "string" && /^\d+-/.test(l))) {
            return cb(createError(INVALID_REV));
          }
        }
        finishOpenRevs();
      } else {
        return cb(createError(UNKNOWN_ERROR, 'function_clause'));
      }
    }
    return; // open_revs does not like other options
  }

  return this._get(id, opts, function (err, result) {
    if (err) {
      return cb(err);
    }

    var doc = result.doc;
    var metadata = result.metadata;
    var ctx = result.ctx;

    if (opts.conflicts) {
      var conflicts = collectConflicts(metadata);
      if (conflicts.length) {
        doc._conflicts = conflicts;
      }
    }

    if (isDeleted(metadata, doc._rev)) {
      doc._deleted = true;
    }

    if (opts.revs || opts.revs_info) {
      var splittedRev = doc._rev.split('-');
      var revNo       = parseInt(splittedRev[0], 10);
      var revHash     = splittedRev[1];

      var paths = rootToLeaf(metadata.rev_tree);
      var path = null;

      for (var i = 0; i < paths.length; i++) {
        var currentPath = paths[i];
        var hashIndex = currentPath.ids.map(function (x) { return x.id; })
          .indexOf(revHash);
        var hashFoundAtRevPos = hashIndex === (revNo - 1);

        if (hashFoundAtRevPos || (!path && hashIndex !== -1)) {
          path = currentPath;
        }
      }

      var indexOfRev = path.ids.map(function (x) { return x.id; })
        .indexOf(doc._rev.split('-')[1]) + 1;
      var howMany = path.ids.length - indexOfRev;
      path.ids.splice(indexOfRev, howMany);
      path.ids.reverse();

      if (opts.revs) {
        doc._revisions = {
          start: (path.pos + path.ids.length) - 1,
          ids: path.ids.map(function (rev) {
            return rev.id;
          })
        };
      }
      if (opts.revs_info) {
        var pos =  path.pos + path.ids.length;
        doc._revs_info = path.ids.map(function (rev) {
          pos--;
          return {
            rev: pos + '-' + rev.id,
            status: rev.opts.status
          };
        });
      }
    }

    if (opts.attachments && doc._attachments) {
      var attachments = doc._attachments;
      var count = Object.keys(attachments).length;
      if (count === 0) {
        return cb(null, doc);
      }
      Object.keys(attachments).forEach(function (key) {
        this._getAttachment(doc._id, key, attachments[key], {
          // Previously the revision handling was done in adapter.js
          // getAttachment, however since idb-next doesnt we need to
          // pass the rev through
          rev: doc._rev,
          binary: opts.binary,
          ctx: ctx
        }, function (err, data) {
          var att = doc._attachments[key];
          att.data = data;
          delete att.stub;
          delete att.length;
          if (!--count) {
            cb(null, doc);
          }
        });
      }, self);
    } else {
      if (doc._attachments) {
        for (var key in doc._attachments) {
          /* istanbul ignore else */
          if (doc._attachments.hasOwnProperty(key)) {
            doc._attachments[key].stub = true;
          }
        }
      }
      cb(null, doc);
    }
  });
});

// TODO: I dont like this, it forces an extra read for every
// attachment read and enforces a confusing api between
// adapter.js and the adapter implementation
AbstractPouchDB.prototype.getAttachment =
  adapterFun('getAttachment', function (docId, attachmentId, opts, callback) {
  var self = this;
  if (opts instanceof Function) {
    callback = opts;
    opts = {};
  }
  this._get(docId, opts, function (err, res) {
    if (err) {
      return callback(err);
    }
    if (res.doc._attachments && res.doc._attachments[attachmentId]) {
      opts.ctx = res.ctx;
      opts.binary = true;
      self._getAttachment(docId, attachmentId,
                          res.doc._attachments[attachmentId], opts, callback);
    } else {
      return callback(createError(MISSING_DOC));
    }
  });
});

AbstractPouchDB.prototype.allDocs =
  adapterFun('allDocs', function (opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts.skip = typeof opts.skip !== 'undefined' ? opts.skip : 0;
  if (opts.start_key) {
    opts.startkey = opts.start_key;
  }
  if (opts.end_key) {
    opts.endkey = opts.end_key;
  }
  if ('keys' in opts) {
    if (!Array.isArray(opts.keys)) {
      return callback(new TypeError('options.keys must be an array'));
    }
    var incompatibleOpt =
      ['startkey', 'endkey', 'key'].filter(function (incompatibleOpt) {
      return incompatibleOpt in opts;
    })[0];
    if (incompatibleOpt) {
      callback(createError(QUERY_PARSE_ERROR,
        'Query parameter `' + incompatibleOpt +
        '` is not compatible with multi-get'
      ));
      return;
    }
    if (!isRemote(this)) {
      return allDocsKeysQuery(this, opts, callback);
    }
  }

  return this._allDocs(opts, callback);
});

AbstractPouchDB.prototype.changes = function (opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  return new Changes$2(this, opts, callback);
};

AbstractPouchDB.prototype.close = adapterFun('close', function (callback) {
  this._closed = true;
  this.emit('closed');
  return this._close(callback);
});

AbstractPouchDB.prototype.info = adapterFun('info', function (callback) {
  var self = this;
  this._info(function (err, info) {
    if (err) {
      return callback(err);
    }
    // assume we know better than the adapter, unless it informs us
    info.db_name = info.db_name || self.name;
    info.auto_compaction = !!(self.auto_compaction && !isRemote(self));
    info.adapter = self.adapter;
    callback(null, info);
  });
});

AbstractPouchDB.prototype.id = adapterFun('id', function (callback) {
  return this._id(callback);
});

/* istanbul ignore next */
AbstractPouchDB.prototype.type = function () {
  return (typeof this._type === 'function') ? this._type() : this.adapter;
};

AbstractPouchDB.prototype.bulkDocs =
  adapterFun('bulkDocs', function (req, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }

  opts = opts || {};

  if (Array.isArray(req)) {
    req = {
      docs: req
    };
  }

  if (!req || !req.docs || !Array.isArray(req.docs)) {
    return callback(createError(MISSING_BULK_DOCS));
  }

  for (var i = 0; i < req.docs.length; ++i) {
    if (typeof req.docs[i] !== 'object' || Array.isArray(req.docs[i])) {
      return callback(createError(NOT_AN_OBJECT));
    }
  }

  var attachmentError;
  req.docs.forEach(function (doc) {
    if (doc._attachments) {
      Object.keys(doc._attachments).forEach(function (name) {
        attachmentError = attachmentError || attachmentNameError(name);
        if (!doc._attachments[name].content_type) {
          guardedConsole('warn', 'Attachment', name, 'on document', doc._id, 'is missing content_type');
        }
      });
    }
  });

  if (attachmentError) {
    return callback(createError(BAD_REQUEST, attachmentError));
  }

  if (!('new_edits' in opts)) {
    if ('new_edits' in req) {
      opts.new_edits = req.new_edits;
    } else {
      opts.new_edits = true;
    }
  }

  var adapter = this;
  if (!opts.new_edits && !isRemote(adapter)) {
    // ensure revisions of the same doc are sorted, so that
    // the local adapter processes them correctly (#2935)
    req.docs.sort(compareByIdThenRev);
  }

  cleanDocs(req.docs);

  // in the case of conflicts, we want to return the _ids to the user
  // however, the underlying adapter may destroy the docs array, so
  // create a copy here
  var ids = req.docs.map(function (doc) {
    return doc._id;
  });

  return this._bulkDocs(req, opts, function (err, res) {
    if (err) {
      return callback(err);
    }
    if (!opts.new_edits) {
      // this is what couch does when new_edits is false
      res = res.filter(function (x) {
        return x.error;
      });
    }
    // add ids for error/conflict responses (not required for CouchDB)
    if (!isRemote(adapter)) {
      for (var i = 0, l = res.length; i < l; i++) {
        res[i].id = res[i].id || ids[i];
      }
    }

    callback(null, res);
  });
});

AbstractPouchDB.prototype.registerDependentDatabase =
  adapterFun('registerDependentDatabase', function (dependentDb,
                                                          callback) {
  var depDB = new this.constructor(dependentDb, this.__opts);

  function diffFun(doc) {
    doc.dependentDbs = doc.dependentDbs || {};
    if (doc.dependentDbs[dependentDb]) {
      return false; // no update required
    }
    doc.dependentDbs[dependentDb] = true;
    return doc;
  }
  upsert(this, '_local/_pouch_dependentDbs', diffFun)
    .then(function () {
      callback(null, {db: depDB});
    }).catch(callback);
});

AbstractPouchDB.prototype.destroy =
  adapterFun('destroy', function (opts, callback) {

  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }

  var self = this;
  var usePrefix = 'use_prefix' in self ? self.use_prefix : true;

  function destroyDb() {
    // call destroy method of the particular adaptor
    self._destroy(opts, function (err, resp) {
      if (err) {
        return callback(err);
      }
      self._destroyed = true;
      self.emit('destroyed');
      callback(null, resp || { 'ok': true });
    });
  }

  if (isRemote(self)) {
    // no need to check for dependent DBs if it's a remote DB
    return destroyDb();
  }

  self.get('_local/_pouch_dependentDbs', function (err, localDoc) {
    if (err) {
      /* istanbul ignore if */
      if (err.status !== 404) {
        return callback(err);
      } else { // no dependencies
        return destroyDb();
      }
    }
    var dependentDbs = localDoc.dependentDbs;
    var PouchDB = self.constructor;
    var deletedMap = Object.keys(dependentDbs).map(function (name) {
      // use_prefix is only false in the browser
      /* istanbul ignore next */
      var trueName = usePrefix ?
        name.replace(new RegExp('^' + PouchDB.prefix), '') : name;
      return new PouchDB(trueName, self.__opts).destroy();
    });
    PouchPromise$1.all(deletedMap).then(destroyDb, callback);
  });
});

function TaskQueue$1() {
  this.isReady = false;
  this.failed = false;
  this.queue = [];
}

TaskQueue$1.prototype.execute = function () {
  var fun;
  if (this.failed) {
    while ((fun = this.queue.shift())) {
      fun(this.failed);
    }
  } else {
    while ((fun = this.queue.shift())) {
      fun();
    }
  }
};

TaskQueue$1.prototype.fail = function (err) {
  this.failed = err;
  this.execute();
};

TaskQueue$1.prototype.ready = function (db) {
  this.isReady = true;
  this.db = db;
  this.execute();
};

TaskQueue$1.prototype.addTask = function (fun) {
  this.queue.push(fun);
  if (this.failed) {
    this.execute();
  }
};

function parseAdapter(name, opts) {
  var match = name.match(/([a-z\-]*):\/\/(.*)/);
  if (match) {
    // the http adapter expects the fully qualified name
    return {
      name: /https?/.test(match[1]) ? match[1] + '://' + match[2] : match[2],
      adapter: match[1]
    };
  }

  var adapters = PouchDB$3.adapters;
  var preferredAdapters = PouchDB$3.preferredAdapters;
  var prefix = PouchDB$3.prefix;
  var adapterName = opts.adapter;

  if (!adapterName) { // automatically determine adapter
    for (var i = 0; i < preferredAdapters.length; ++i) {
      adapterName = preferredAdapters[i];
      // check for browsers that have been upgraded from websql-only to websql+idb
      /* istanbul ignore if */
      if (adapterName === 'idb' && 'websql' in adapters &&
          hasLocalStorage() && localStorage['_pouch__websqldb_' + prefix + name]) {
        // log it, because this can be confusing during development
        guardedConsole('log', 'PouchDB is downgrading "' + name + '" to WebSQL to' +
          ' avoid data loss, because it was already opened with WebSQL.');
        continue; // keep using websql to avoid user data loss
      }
      break;
    }
  }

  var adapter = adapters[adapterName];

  // if adapter is invalid, then an error will be thrown later
  var usePrefix = (adapter && 'use_prefix' in adapter) ?
    adapter.use_prefix : true;

  return {
    name: usePrefix ? (prefix + name) : name,
    adapter: adapterName
  };
}

// OK, so here's the deal. Consider this code:
//     var db1 = new PouchDB('foo');
//     var db2 = new PouchDB('foo');
//     db1.destroy();
// ^ these two both need to emit 'destroyed' events,
// as well as the PouchDB constructor itself.
// So we have one db object (whichever one got destroy() called on it)
// responsible for emitting the initial event, which then gets emitted
// by the constructor, which then broadcasts it to any other dbs
// that may have been created with the same name.
function prepareForDestruction(self) {

  var destructionListeners = self.constructor._destructionListeners;

  function onDestroyed() {
    self.removeListener('closed', onClosed);
    self.constructor.emit('destroyed', self.name);
  }

  function onConstructorDestroyed() {
    self.removeListener('destroyed', onDestroyed);
    self.removeListener('closed', onClosed);
    self.emit('destroyed');
  }

  function onClosed() {
    self.removeListener('destroyed', onDestroyed);
    destructionListeners.delete(self.name);
  }

  self.once('destroyed', onDestroyed);
  self.once('closed', onClosed);

  // in setup.js, the constructor is primed to listen for destroy events
  if (!destructionListeners.has(self.name)) {
    destructionListeners.set(self.name, []);
  }
  destructionListeners.get(self.name).push(onConstructorDestroyed);
}

inherits(PouchDB$3, AbstractPouchDB);
function PouchDB$3(name, opts) {
  // In Node our test suite only tests this for PouchAlt unfortunately
  /* istanbul ignore if */
  if (!(this instanceof PouchDB$3)) {
    return new PouchDB$3(name, opts);
  }

  var self = this;
  opts = opts || {};

  if (name && typeof name === 'object') {
    opts = name;
    name = opts.name;
    delete opts.name;
  }

  this.__opts = opts = clone(opts);

  self.auto_compaction = opts.auto_compaction;
  self.prefix = PouchDB$3.prefix;

  if (typeof name !== 'string') {
    throw new Error('Missing/invalid DB name');
  }

  var prefixedName = (opts.prefix || '') + name;
  var backend = parseAdapter(prefixedName, opts);

  opts.name = backend.name;
  opts.adapter = opts.adapter || backend.adapter;

  self.name = name;
  self._adapter = opts.adapter;
  PouchDB$3.emit('debug', ['adapter', 'Picked adapter: ', opts.adapter]);

  if (!PouchDB$3.adapters[opts.adapter] ||
      !PouchDB$3.adapters[opts.adapter].valid()) {
    throw new Error('Invalid Adapter: ' + opts.adapter);
  }

  AbstractPouchDB.call(self);
  self.taskqueue = new TaskQueue$1();

  self.adapter = opts.adapter;

  PouchDB$3.adapters[opts.adapter].call(self, opts, function (err) {
    if (err) {
      return self.taskqueue.fail(err);
    }
    prepareForDestruction(self);

    self.emit('created', self);
    PouchDB$3.emit('created', self.name);
    self.taskqueue.ready(self);
  });

}

PouchDB$3.adapters = {};
PouchDB$3.preferredAdapters = [];

PouchDB$3.prefix = '_pouch_';

var eventEmitter = new events.EventEmitter();

function setUpEventEmitter(Pouch) {
  Object.keys(events.EventEmitter.prototype).forEach(function (key) {
    if (typeof events.EventEmitter.prototype[key] === 'function') {
      Pouch[key] = eventEmitter[key].bind(eventEmitter);
    }
  });

  // these are created in constructor.js, and allow us to notify each DB with
  // the same name that it was destroyed, via the constructor object
  var destructListeners = Pouch._destructionListeners = new ExportedMap();
  Pouch.on('destroyed', function onConstructorDestroyed(name) {
    destructListeners.get(name).forEach(function (callback) {
      callback();
    });
    destructListeners.delete(name);
  });
}

setUpEventEmitter(PouchDB$3);

PouchDB$3.adapter = function (id, obj, addToPreferredAdapters) {
  /* istanbul ignore else */
  if (obj.valid()) {
    PouchDB$3.adapters[id] = obj;
    if (addToPreferredAdapters) {
      PouchDB$3.preferredAdapters.push(id);
    }
  }
};

PouchDB$3.plugin = function (obj) {
  if (typeof obj === 'function') { // function style for plugins
    obj(PouchDB$3);
  } else if (typeof obj !== 'object' || Object.keys(obj).length === 0) {
    throw new Error('Invalid plugin: got \"' + obj + '\", expected an object or a function');
  } else {
    Object.keys(obj).forEach(function (id) { // object style for plugins
      PouchDB$3.prototype[id] = obj[id];
    });
  }
  if (this.__defaults) {
    PouchDB$3.__defaults = $inject_Object_assign({}, this.__defaults);
  }
  return PouchDB$3;
};

PouchDB$3.defaults = function (defaultOpts) {
  function PouchAlt(name, opts) {
    if (!(this instanceof PouchAlt)) {
      return new PouchAlt(name, opts);
    }

    opts = opts || {};

    if (name && typeof name === 'object') {
      opts = name;
      name = opts.name;
      delete opts.name;
    }

    opts = $inject_Object_assign({}, PouchAlt.__defaults, opts);
    PouchDB$3.call(this, name, opts);
  }

  inherits(PouchAlt, PouchDB$3);

  PouchAlt.preferredAdapters = PouchDB$3.preferredAdapters.slice();
  Object.keys(PouchDB$3).forEach(function (key) {
    if (!(key in PouchAlt)) {
      PouchAlt[key] = PouchDB$3[key];
    }
  });

  // make default options transitive
  // https://github.com/pouchdb/pouchdb/issues/5922
  PouchAlt.__defaults = $inject_Object_assign({}, this.__defaults, defaultOpts);

  return PouchAlt;
};

// managed automatically by set-version.js
var version = "6.2.0";

function debugPouch(PouchDB) {
  PouchDB.debug = debug;
  var logs = {};
  /* istanbul ignore next */
  PouchDB.on('debug', function (args) {
    // first argument is log identifier
    var logId = args[0];
    // rest should be passed verbatim to debug module
    var logArgs = args.slice(1);
    if (!logs[logId]) {
      logs[logId] = debug('pouchdb:' + logId);
    }
    logs[logId].apply(null, logArgs);
  });
}

// this would just be "return doc[field]", but fields
// can be "deep" due to dot notation
function getFieldFromDoc(doc, parsedField) {
  var value = doc;
  for (var i = 0, len = parsedField.length; i < len; i++) {
    var key = parsedField[i];
    value = value[key];
    if (!value) {
      break;
    }
  }
  return value;
}

function compare$1(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Converts a string in dot notation to an array of its components, with backslash escaping
function parseField(fieldName) {
  // fields may be deep (e.g. "foo.bar.baz"), so parse
  var fields = [];
  var current = '';
  for (var i = 0, len = fieldName.length; i < len; i++) {
    var ch = fieldName[i];
    if (ch === '.') {
      if (i > 0 && fieldName[i - 1] === '\\') { // escaped delimiter
        current = current.substring(0, current.length - 1) + '.';
      } else { // not escaped, so delimiter
        fields.push(current);
        current = '';
      }
    } else { // normal character
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

var combinationFields = ['$or', '$nor', '$not'];
function isCombinationalField(field) {
  return combinationFields.indexOf(field) > -1;
}

function getKey(obj) {
  return Object.keys(obj)[0];
}

function getValue$1(obj) {
  return obj[getKey(obj)];
}


// flatten an array of selectors joined by an $and operator
function mergeAndedSelectors(selectors) {

  // sort to ensure that e.g. if the user specified
  // $and: [{$gt: 'a'}, {$gt: 'b'}], then it's collapsed into
  // just {$gt: 'b'}
  var res = {};

  selectors.forEach(function (selector) {
    Object.keys(selector).forEach(function (field) {
      var matcher = selector[field];
      if (typeof matcher !== 'object') {
        matcher = {$eq: matcher};
      }

      if (isCombinationalField(field)) {
        if (matcher instanceof Array) {
          res[field] = matcher.map(function (m) {
            return mergeAndedSelectors([m]);
          });
        } else {
          res[field] = mergeAndedSelectors([matcher]);
        }
      } else {
        var fieldMatchers = res[field] = res[field] || {};
        Object.keys(matcher).forEach(function (operator) {
          var value = matcher[operator];

          if (operator === '$gt' || operator === '$gte') {
            return mergeGtGte(operator, value, fieldMatchers);
          } else if (operator === '$lt' || operator === '$lte') {
            return mergeLtLte(operator, value, fieldMatchers);
          } else if (operator === '$ne') {
            return mergeNe(value, fieldMatchers);
          } else if (operator === '$eq') {
            return mergeEq(value, fieldMatchers);
          }
          fieldMatchers[operator] = value;
        });
      }
    });
  });

  return res;
}



// collapse logically equivalent gt/gte values
function mergeGtGte(operator, value, fieldMatchers) {
  if (typeof fieldMatchers.$eq !== 'undefined') {
    return; // do nothing
  }
  if (typeof fieldMatchers.$gte !== 'undefined') {
    if (operator === '$gte') {
      if (value > fieldMatchers.$gte) { // more specificity
        fieldMatchers.$gte = value;
      }
    } else { // operator === '$gt'
      if (value >= fieldMatchers.$gte) { // more specificity
        delete fieldMatchers.$gte;
        fieldMatchers.$gt = value;
      }
    }
  } else if (typeof fieldMatchers.$gt !== 'undefined') {
    if (operator === '$gte') {
      if (value > fieldMatchers.$gt) { // more specificity
        delete fieldMatchers.$gt;
        fieldMatchers.$gte = value;
      }
    } else { // operator === '$gt'
      if (value > fieldMatchers.$gt) { // more specificity
        fieldMatchers.$gt = value;
      }
    }
  } else {
    fieldMatchers[operator] = value;
  }
}

// collapse logically equivalent lt/lte values
function mergeLtLte(operator, value, fieldMatchers) {
  if (typeof fieldMatchers.$eq !== 'undefined') {
    return; // do nothing
  }
  if (typeof fieldMatchers.$lte !== 'undefined') {
    if (operator === '$lte') {
      if (value < fieldMatchers.$lte) { // more specificity
        fieldMatchers.$lte = value;
      }
    } else { // operator === '$gt'
      if (value <= fieldMatchers.$lte) { // more specificity
        delete fieldMatchers.$lte;
        fieldMatchers.$lt = value;
      }
    }
  } else if (typeof fieldMatchers.$lt !== 'undefined') {
    if (operator === '$lte') {
      if (value < fieldMatchers.$lt) { // more specificity
        delete fieldMatchers.$lt;
        fieldMatchers.$lte = value;
      }
    } else { // operator === '$gt'
      if (value < fieldMatchers.$lt) { // more specificity
        fieldMatchers.$lt = value;
      }
    }
  } else {
    fieldMatchers[operator] = value;
  }
}

// combine $ne values into one array
function mergeNe(value, fieldMatchers) {
  if ('$ne' in fieldMatchers) {
    // there are many things this could "not" be
    fieldMatchers.$ne.push(value);
  } else { // doesn't exist yet
    fieldMatchers.$ne = [value];
  }
}

// add $eq into the mix
function mergeEq(value, fieldMatchers) {
  // these all have less specificity than the $eq
  // TODO: check for user errors here
  delete fieldMatchers.$gt;
  delete fieldMatchers.$gte;
  delete fieldMatchers.$lt;
  delete fieldMatchers.$lte;
  delete fieldMatchers.$ne;
  fieldMatchers.$eq = value;
}


//
// normalize the selector
//
function massageSelector(input) {
  var result = clone(input);
  var wasAnded = false;
  if ('$and' in result) {
    result = mergeAndedSelectors(result['$and']);
    wasAnded = true;
  }

  ['$or', '$nor'].forEach(function (orOrNor) {
    if (orOrNor in result) {
      // message each individual selector
      // e.g. {foo: 'bar'} becomes {foo: {$eq: 'bar'}}
      result[orOrNor].forEach(function (subSelector) {
        var fields = Object.keys(subSelector);
        for (var i = 0; i < fields.length; i++) {
          var field = fields[i];
          var matcher = subSelector[field];
          if (typeof matcher !== 'object' || matcher === null) {
            subSelector[field] = {$eq: matcher};
          }
        }
      });
    }
  });

  if ('$not' in result) {
    //This feels a little like forcing, but it will work for now,
    //I would like to come back to this and make the merging of selectors a little more generic
    result['$not'] = mergeAndedSelectors([result['$not']]);
  }

  var fields = Object.keys(result);

  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var matcher = result[field];

    if (typeof matcher !== 'object' || matcher === null) {
      matcher = {$eq: matcher};
    } else if ('$ne' in matcher && !wasAnded) {
      // I put these in an array, since there may be more than one
      // but in the "mergeAnded" operation, I already take care of that
      matcher.$ne = [matcher.$ne];
    }
    result[field] = matcher;
  }

  return result;
}

function pad(str, padWith, upToLength) {
  var padding = '';
  var targetLength = upToLength - str.length;
  /* istanbul ignore next */
  while (padding.length < targetLength) {
    padding += padWith;
  }
  return padding;
}

function padLeft(str, padWith, upToLength) {
  var padding = pad(str, padWith, upToLength);
  return padding + str;
}

var MIN_MAGNITUDE = -324; // verified by -Number.MIN_VALUE
var MAGNITUDE_DIGITS = 3; // ditto
var SEP = ''; // set to '_' for easier debugging 

function collate(a, b) {

  if (a === b) {
    return 0;
  }

  a = normalizeKey(a);
  b = normalizeKey(b);

  var ai = collationIndex(a);
  var bi = collationIndex(b);
  if ((ai - bi) !== 0) {
    return ai - bi;
  }
  switch (typeof a) {
    case 'number':
      return a - b;
    case 'boolean':
      return a < b ? -1 : 1;
    case 'string':
      return stringCollate(a, b);
  }
  return Array.isArray(a) ? arrayCollate(a, b) : objectCollate(a, b);
}

// couch considers null/NaN/Infinity/-Infinity === undefined,
// for the purposes of mapreduce indexes. also, dates get stringified.
function normalizeKey(key) {
  switch (typeof key) {
    case 'undefined':
      return null;
    case 'number':
      if (key === Infinity || key === -Infinity || isNaN(key)) {
        return null;
      }
      return key;
    case 'object':
      var origKey = key;
      if (Array.isArray(key)) {
        var len = key.length;
        key = new Array(len);
        for (var i = 0; i < len; i++) {
          key[i] = normalizeKey(origKey[i]);
        }
      /* istanbul ignore next */
      } else if (key instanceof Date) {
        return key.toJSON();
      } else if (key !== null) { // generic object
        key = {};
        for (var k in origKey) {
          if (origKey.hasOwnProperty(k)) {
            var val = origKey[k];
            if (typeof val !== 'undefined') {
              key[k] = normalizeKey(val);
            }
          }
        }
      }
  }
  return key;
}

function indexify(key) {
  if (key !== null) {
    switch (typeof key) {
      case 'boolean':
        return key ? 1 : 0;
      case 'number':
        return numToIndexableString(key);
      case 'string':
        // We've to be sure that key does not contain \u0000
        // Do order-preserving replacements:
        // 0 -> 1, 1
        // 1 -> 1, 2
        // 2 -> 2, 2
        return key
          .replace(/\u0002/g, '\u0002\u0002')
          .replace(/\u0001/g, '\u0001\u0002')
          .replace(/\u0000/g, '\u0001\u0001');
      case 'object':
        var isArray = Array.isArray(key);
        var arr = isArray ? key : Object.keys(key);
        var i = -1;
        var len = arr.length;
        var result = '';
        if (isArray) {
          while (++i < len) {
            result += toIndexableString(arr[i]);
          }
        } else {
          while (++i < len) {
            var objKey = arr[i];
            result += toIndexableString(objKey) +
                toIndexableString(key[objKey]);
          }
        }
        return result;
    }
  }
  return '';
}

// convert the given key to a string that would be appropriate
// for lexical sorting, e.g. within a database, where the
// sorting is the same given by the collate() function.
function toIndexableString(key) {
  var zero = '\u0000';
  key = normalizeKey(key);
  return collationIndex(key) + SEP + indexify(key) + zero;
}

function parseNumber(str, i) {
  var originalIdx = i;
  var num;
  var zero = str[i] === '1';
  if (zero) {
    num = 0;
    i++;
  } else {
    var neg = str[i] === '0';
    i++;
    var numAsString = '';
    var magAsString = str.substring(i, i + MAGNITUDE_DIGITS);
    var magnitude = parseInt(magAsString, 10) + MIN_MAGNITUDE;
    /* istanbul ignore next */
    if (neg) {
      magnitude = -magnitude;
    }
    i += MAGNITUDE_DIGITS;
    while (true) {
      var ch = str[i];
      if (ch === '\u0000') {
        break;
      } else {
        numAsString += ch;
      }
      i++;
    }
    numAsString = numAsString.split('.');
    if (numAsString.length === 1) {
      num = parseInt(numAsString, 10);
    } else {
      /* istanbul ignore next */
      num = parseFloat(numAsString[0] + '.' + numAsString[1]);
    }
    /* istanbul ignore next */
    if (neg) {
      num = num - 10;
    }
    /* istanbul ignore next */
    if (magnitude !== 0) {
      // parseFloat is more reliable than pow due to rounding errors
      // e.g. Number.MAX_VALUE would return Infinity if we did
      // num * Math.pow(10, magnitude);
      num = parseFloat(num + 'e' + magnitude);
    }
  }
  return {num: num, length : i - originalIdx};
}

// move up the stack while parsing
// this function moved outside of parseIndexableString for performance
function pop(stack, metaStack) {
  var obj = stack.pop();

  if (metaStack.length) {
    var lastMetaElement = metaStack[metaStack.length - 1];
    if (obj === lastMetaElement.element) {
      // popping a meta-element, e.g. an object whose value is another object
      metaStack.pop();
      lastMetaElement = metaStack[metaStack.length - 1];
    }
    var element = lastMetaElement.element;
    var lastElementIndex = lastMetaElement.index;
    if (Array.isArray(element)) {
      element.push(obj);
    } else if (lastElementIndex === stack.length - 2) { // obj with key+value
      var key = stack.pop();
      element[key] = obj;
    } else {
      stack.push(obj); // obj with key only
    }
  }
}

function parseIndexableString(str) {
  var stack = [];
  var metaStack = []; // stack for arrays and objects
  var i = 0;

  /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
  while (true) {
    var collationIndex = str[i++];
    if (collationIndex === '\u0000') {
      if (stack.length === 1) {
        return stack.pop();
      } else {
        pop(stack, metaStack);
        continue;
      }
    }
    switch (collationIndex) {
      case '1':
        stack.push(null);
        break;
      case '2':
        stack.push(str[i] === '1');
        i++;
        break;
      case '3':
        var parsedNum = parseNumber(str, i);
        stack.push(parsedNum.num);
        i += parsedNum.length;
        break;
      case '4':
        var parsedStr = '';
        /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
        while (true) {
          var ch = str[i];
          if (ch === '\u0000') {
            break;
          }
          parsedStr += ch;
          i++;
        }
        // perform the reverse of the order-preserving replacement
        // algorithm (see above)
        parsedStr = parsedStr.replace(/\u0001\u0001/g, '\u0000')
          .replace(/\u0001\u0002/g, '\u0001')
          .replace(/\u0002\u0002/g, '\u0002');
        stack.push(parsedStr);
        break;
      case '5':
        var arrayElement = { element: [], index: stack.length };
        stack.push(arrayElement.element);
        metaStack.push(arrayElement);
        break;
      case '6':
        var objElement = { element: {}, index: stack.length };
        stack.push(objElement.element);
        metaStack.push(objElement);
        break;
      /* istanbul ignore next */
      default:
        throw new Error(
          'bad collationIndex or unexpectedly reached end of input: ' +
            collationIndex);
    }
  }
}

function arrayCollate(a, b) {
  var len = Math.min(a.length, b.length);
  for (var i = 0; i < len; i++) {
    var sort = collate(a[i], b[i]);
    if (sort !== 0) {
      return sort;
    }
  }
  return (a.length === b.length) ? 0 :
    (a.length > b.length) ? 1 : -1;
}
function stringCollate(a, b) {
  // See: https://github.com/daleharvey/pouchdb/issues/40
  // This is incompatible with the CouchDB implementation, but its the
  // best we can do for now
  return (a === b) ? 0 : ((a > b) ? 1 : -1);
}
function objectCollate(a, b) {
  var ak = Object.keys(a), bk = Object.keys(b);
  var len = Math.min(ak.length, bk.length);
  for (var i = 0; i < len; i++) {
    // First sort the keys
    var sort = collate(ak[i], bk[i]);
    if (sort !== 0) {
      return sort;
    }
    // if the keys are equal sort the values
    sort = collate(a[ak[i]], b[bk[i]]);
    if (sort !== 0) {
      return sort;
    }

  }
  return (ak.length === bk.length) ? 0 :
    (ak.length > bk.length) ? 1 : -1;
}
// The collation is defined by erlangs ordered terms
// the atoms null, true, false come first, then numbers, strings,
// arrays, then objects
// null/undefined/NaN/Infinity/-Infinity are all considered null
function collationIndex(x) {
  var id = ['boolean', 'number', 'string', 'object'];
  var idx = id.indexOf(typeof x);
  //false if -1 otherwise true, but fast!!!!1
  if (~idx) {
    if (x === null) {
      return 1;
    }
    if (Array.isArray(x)) {
      return 5;
    }
    return idx < 3 ? (idx + 2) : (idx + 3);
  }
  /* istanbul ignore next */
  if (Array.isArray(x)) {
    return 5;
  }
}

// conversion:
// x yyy zz...zz
// x = 0 for negative, 1 for 0, 2 for positive
// y = exponent (for negative numbers negated) moved so that it's >= 0
// z = mantisse
function numToIndexableString(num) {

  if (num === 0) {
    return '1';
  }

  // convert number to exponential format for easier and
  // more succinct string sorting
  var expFormat = num.toExponential().split(/e\+?/);
  var magnitude = parseInt(expFormat[1], 10);

  var neg = num < 0;

  var result = neg ? '0' : '2';

  // first sort by magnitude
  // it's easier if all magnitudes are positive
  var magForComparison = ((neg ? -magnitude : magnitude) - MIN_MAGNITUDE);
  var magString = padLeft((magForComparison).toString(), '0', MAGNITUDE_DIGITS);

  result += SEP + magString;

  // then sort by the factor
  var factor = Math.abs(parseFloat(expFormat[0])); // [1..10)
  /* istanbul ignore next */
  if (neg) { // for negative reverse ordering
    factor = 10 - factor;
  }

  var factorStr = factor.toFixed(20);

  // strip zeros from the end
  factorStr = factorStr.replace(/\.?0+$/, '');

  result += SEP + factorStr;

  return result;
}

// create a comparator based on the sort object
function createFieldSorter(sort) {

  function getFieldValuesAsArray(doc) {
    return sort.map(function (sorting) {
      var fieldName = getKey(sorting);
      var parsedField = parseField(fieldName);
      var docFieldValue = getFieldFromDoc(doc, parsedField);
      return docFieldValue;
    });
  }

  return function (aRow, bRow) {
    var aFieldValues = getFieldValuesAsArray(aRow.doc);
    var bFieldValues = getFieldValuesAsArray(bRow.doc);
    var collation = collate(aFieldValues, bFieldValues);
    if (collation !== 0) {
      return collation;
    }
    // this is what mango seems to do
    return compare$1(aRow.doc._id, bRow.doc._id);
  };
}

function filterInMemoryFields(rows, requestDef, inMemoryFields) {
  rows = rows.filter(function (row) {
    return rowFilter(row.doc, requestDef.selector, inMemoryFields);
  });

  if (requestDef.sort) {
    // in-memory sort
    var fieldSorter = createFieldSorter(requestDef.sort);
    rows = rows.sort(fieldSorter);
    if (typeof requestDef.sort[0] !== 'string' &&
        getValue$1(requestDef.sort[0]) === 'desc') {
      rows = rows.reverse();
    }
  }

  if ('limit' in requestDef || 'skip' in requestDef) {
    // have to do the limit in-memory
    var skip = requestDef.skip || 0;
    var limit = ('limit' in requestDef ? requestDef.limit : rows.length) + skip;
    rows = rows.slice(skip, limit);
  }
  return rows;
}

function rowFilter(doc, selector, inMemoryFields) {
  return inMemoryFields.every(function (field) {
    if (isDesignDoc(doc)) {
      return false;
    }

    var matcher = selector[field];
    var parsedField = parseField(field);
    var docFieldValue = getFieldFromDoc(doc, parsedField);
    if (isCombinationalField(field)) {
      return matchCominationalSelector(field, matcher, doc);
    }

    return matchSelector(matcher, doc, parsedField, docFieldValue);
  });
}

function isDesignDoc(doc) {
  return /^_design\//.test(doc._id);
}

function matchSelector(matcher, doc, parsedField, docFieldValue) {
  if (!matcher) {
    // no filtering necessary; this field is just needed for sorting
    return true;
  }

  return Object.keys(matcher).every(function (userOperator) {
    var userValue = matcher[userOperator];
    return match(userOperator, doc, userValue, parsedField, docFieldValue);
  });
}

function matchCominationalSelector(field, matcher, doc) {

  if (field === '$or') {
    return matcher.some(function (orMatchers) {
      return rowFilter(doc, orMatchers, Object.keys(orMatchers));
    });
  }

  if (field === '$not') {
    return !rowFilter(doc, matcher, Object.keys(matcher));
  }

  //`$nor`
  return !matcher.find(function (orMatchers) {
    return rowFilter(doc, orMatchers, Object.keys(orMatchers));
  });

}

function match(userOperator, doc, userValue, parsedField, docFieldValue) {
  if (!matchers[userOperator]) {
    throw new Error('unknown operator "' + userOperator +
      '" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, ' +
      '$nin, $size, $mod, $regex, $elemMatch, $type or $all');
  }
  return matchers[userOperator](doc, userValue, parsedField, docFieldValue);
}

function fieldExists(docFieldValue) {
  return typeof docFieldValue !== 'undefined' && docFieldValue !== null;
}

function fieldIsNotUndefined(docFieldValue) {
  return typeof docFieldValue !== 'undefined';
}

function modField(docFieldValue, userValue) {
  var divisor = userValue[0];
  var mod = userValue[1];
  if (divisor === 0) {
    throw new Error('Bad divisor, cannot divide by zero');
  }

  if (parseInt(divisor, 10) !== divisor ) {
    throw new Error('Divisor is not an integer');
  }

  if (parseInt(mod, 10) !== mod ) {
    throw new Error('Modulus is not an integer');
  }

  if (parseInt(docFieldValue, 10) !== docFieldValue) {
    return false;
  }

  return docFieldValue % divisor === mod;
}

function arrayContainsValue(docFieldValue, userValue) {
  return userValue.some(function (val) {
    if (docFieldValue instanceof Array) {
      return docFieldValue.indexOf(val) > -1;
    }

    return docFieldValue === val;
  });
}

function arrayContainsAllValues(docFieldValue, userValue) {
  return userValue.every(function (val) {
    return docFieldValue.indexOf(val) > -1;
  });
}

function arraySize(docFieldValue, userValue) {
  return docFieldValue.length === userValue;
}

function regexMatch(docFieldValue, userValue) {
  var re = new RegExp(userValue);

  return re.test(docFieldValue);
}

function typeMatch(docFieldValue, userValue) {

  switch (userValue) {
    case 'null':
      return docFieldValue === null;
    case 'boolean':
      return typeof (docFieldValue) === 'boolean';
    case 'number':
      return typeof (docFieldValue) === 'number';
    case 'string':
      return typeof (docFieldValue) === 'string';
    case 'array':
      return docFieldValue instanceof Array;
    case 'object':
      return ({}).toString.call(docFieldValue) === '[object Object]';
  }

  throw new Error(userValue + ' not supported as a type.' +
                  'Please use one of object, string, array, number, boolean or null.');

}

var matchers = {

  '$elemMatch': function (doc, userValue, parsedField, docFieldValue) {
    if (!Array.isArray(docFieldValue)) {
      return false;
    }

    if (docFieldValue.length === 0) {
      return false;
    }

    if (typeof docFieldValue[0] === 'object') {
      return docFieldValue.some(function (val) {
        return rowFilter(val, userValue, Object.keys(userValue));
      });
    }

    return docFieldValue.some(function (val) {
      return matchSelector(userValue, doc, parsedField, val);
    });
  },

  '$eq': function (doc, userValue, parsedField, docFieldValue) {
    return fieldIsNotUndefined(docFieldValue) && collate(docFieldValue, userValue) === 0;
  },

  '$gte': function (doc, userValue, parsedField, docFieldValue) {
    return fieldIsNotUndefined(docFieldValue) && collate(docFieldValue, userValue) >= 0;
  },

  '$gt': function (doc, userValue, parsedField, docFieldValue) {
    return fieldIsNotUndefined(docFieldValue) && collate(docFieldValue, userValue) > 0;
  },

  '$lte': function (doc, userValue, parsedField, docFieldValue) {
    return fieldIsNotUndefined(docFieldValue) && collate(docFieldValue, userValue) <= 0;
  },

  '$lt': function (doc, userValue, parsedField, docFieldValue) {
    return fieldIsNotUndefined(docFieldValue) && collate(docFieldValue, userValue) < 0;
  },

  '$exists': function (doc, userValue, parsedField, docFieldValue) {
    //a field that is null is still considered to exist
    if (userValue) {
      return fieldIsNotUndefined(docFieldValue);
    }

    return !fieldIsNotUndefined(docFieldValue);
  },

  '$mod': function (doc, userValue, parsedField, docFieldValue) {
    return fieldExists(docFieldValue) && modField(docFieldValue, userValue);
  },

  '$ne': function (doc, userValue, parsedField, docFieldValue) {
    return userValue.every(function (neValue) {
      return collate(docFieldValue, neValue) !== 0;
    });
  },
  '$in': function (doc, userValue, parsedField, docFieldValue) {
    return fieldExists(docFieldValue) && arrayContainsValue(docFieldValue, userValue);
  },

  '$nin': function (doc, userValue, parsedField, docFieldValue) {
    return fieldExists(docFieldValue) && !arrayContainsValue(docFieldValue, userValue);
  },

  '$size': function (doc, userValue, parsedField, docFieldValue) {
    return fieldExists(docFieldValue) && arraySize(docFieldValue, userValue);
  },

  '$all': function (doc, userValue, parsedField, docFieldValue) {
    return Array.isArray(docFieldValue) && arrayContainsAllValues(docFieldValue, userValue);
  },

  '$regex': function (doc, userValue, parsedField, docFieldValue) {
    return fieldExists(docFieldValue) && regexMatch(docFieldValue, userValue);
  },

  '$type': function (doc, userValue, parsedField, docFieldValue) {
    return typeMatch(docFieldValue, userValue);
  }
};

// return true if the given doc matches the supplied selector
function matchesSelector(doc, selector) {
  /* istanbul ignore if */
  if (typeof selector !== 'object') {
    // match the CouchDB error message
    throw 'Selector error: expected a JSON object';
  }

  selector = massageSelector(selector);
  var row = {
    'doc': doc
  };

  var rowsMatched = filterInMemoryFields([row], { 'selector': selector }, Object.keys(selector));
  return rowsMatched && rowsMatched.length === 1;
}

function evalFilter(input) {
  return scopeEval('"use strict";\nreturn ' + input + ';', {});
}

function evalView(input) {
  var code = [
    'return function(doc) {',
    '  "use strict";',
    '  var emitted = false;',
    '  var emit = function (a, b) {',
    '    emitted = true;',
    '  };',
    '  var view = ' + input + ';',
    '  view(doc);',
    '  if (emitted) {',
    '    return true;',
    '  }',
    '};'
  ].join('\n');

  return scopeEval(code, {});
}

function validate(opts, callback) {
  if (opts.selector) {
    if (opts.filter && opts.filter !== '_selector') {
      var filterName = typeof opts.filter === 'string' ?
        opts.filter : 'function';
      return callback(new Error('selector invalid for filter "' + filterName + '"'));
    }
  }
  callback();
}

function normalize(opts) {
  if (opts.view && !opts.filter) {
    opts.filter = '_view';
  }

  if (opts.selector && !opts.filter) {
    opts.filter = '_selector';
  }

  if (opts.filter && typeof opts.filter === 'string') {
    if (opts.filter === '_view') {
      opts.view = normalizeDesignDocFunctionName(opts.view);
    } else {
      opts.filter = normalizeDesignDocFunctionName(opts.filter);
    }
  }
}

function shouldFilter(changesHandler$$1, opts) {
  return opts.filter && typeof opts.filter === 'string' &&
    !opts.doc_ids && !isRemote(changesHandler$$1.db);
}

function filter(changesHandler$$1, opts) {
  var callback = opts.complete;
  if (opts.filter === '_view') {
    if (!opts.view || typeof opts.view !== 'string') {
      var err = createError(BAD_REQUEST,
        '`view` filter parameter not found or invalid.');
      return callback(err);
    }
    // fetch a view from a design doc, make it behave like a filter
    var viewName = parseDesignDocFunctionName(opts.view);
    changesHandler$$1.db.get('_design/' + viewName[0], function (err, ddoc) {
      /* istanbul ignore if */
      if (changesHandler$$1.isCancelled) {
        return callback(null, {status: 'cancelled'});
      }
      /* istanbul ignore next */
      if (err) {
        return callback(generateErrorFromResponse(err));
      }
      var mapFun = ddoc && ddoc.views && ddoc.views[viewName[1]] &&
        ddoc.views[viewName[1]].map;
      if (!mapFun) {
        return callback(createError(MISSING_DOC,
          (ddoc.views ? 'missing json key: ' + viewName[1] :
            'missing json key: views')));
      }
      opts.filter = evalView(mapFun);
      changesHandler$$1.doChanges(opts);
    });
  } else if (opts.selector) {
    opts.filter = function (doc) {
      return matchesSelector(doc, opts.selector);
    };
    changesHandler$$1.doChanges(opts);
  } else {
    // fetch a filter from a design doc
    var filterName = parseDesignDocFunctionName(opts.filter);
    changesHandler$$1.db.get('_design/' + filterName[0], function (err, ddoc) {
      /* istanbul ignore if */
      if (changesHandler$$1.isCancelled) {
        return callback(null, {status: 'cancelled'});
      }
      /* istanbul ignore next */
      if (err) {
        return callback(generateErrorFromResponse(err));
      }
      var filterFun = ddoc && ddoc.filters && ddoc.filters[filterName[1]];
      if (!filterFun) {
        return callback(createError(MISSING_DOC,
          ((ddoc && ddoc.filters) ? 'missing json key: ' + filterName[1]
            : 'missing json key: filters')));
      }
      opts.filter = evalFilter(filterFun);
      changesHandler$$1.doChanges(opts);
    });
  }
}

function applyChangesFilterPlugin(PouchDB) {
  PouchDB._changesFilterPlugin = {
    validate: validate,
    normalize: normalize,
    shouldFilter: shouldFilter,
    filter: filter
  };
}

// TODO: remove from pouchdb-core (breaking)
PouchDB$3.plugin(debugPouch);

// TODO: remove from pouchdb-core (breaking)
PouchDB$3.plugin(applyChangesFilterPlugin);

PouchDB$3.version = version;

function toObject(array) {
  return array.reduce(function (obj, item) {
    obj[item] = true;
    return obj;
  }, {});
}
// List of top level reserved words for doc
var reservedWords = toObject([
  '_id',
  '_rev',
  '_attachments',
  '_deleted',
  '_revisions',
  '_revs_info',
  '_conflicts',
  '_deleted_conflicts',
  '_local_seq',
  '_rev_tree',
  //replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats',
  // Specific to Couchbase Sync Gateway
  '_removed'
]);

// List of reserved words that should end up the document
var dataWords = toObject([
  '_attachments',
  //replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats'
]);

function parseRevisionInfo(rev) {
  if (!/^\d+\-./.test(rev)) {
    return createError(INVALID_REV);
  }
  var idx = rev.indexOf('-');
  var left = rev.substring(0, idx);
  var right = rev.substring(idx + 1);
  return {
    prefix: parseInt(left, 10),
    id: right
  };
}

function makeRevTreeFromRevisions(revisions, opts) {
  var pos = revisions.start - revisions.ids.length + 1;

  var revisionIds = revisions.ids;
  var ids = [revisionIds[0], opts, []];

  for (var i = 1, len = revisionIds.length; i < len; i++) {
    ids = [revisionIds[i], {status: 'missing'}, [ids]];
  }

  return [{
    pos: pos,
    ids: ids
  }];
}

// Preprocess documents, parse their revisions, assign an id and a
// revision for new writes that are missing them, etc
function parseDoc(doc, newEdits) {

  var nRevNum;
  var newRevId;
  var revInfo;
  var opts = {status: 'available'};
  if (doc._deleted) {
    opts.deleted = true;
  }

  if (newEdits) {
    if (!doc._id) {
      doc._id = uuid();
    }
    newRevId = uuid(32, 16).toLowerCase();
    if (doc._rev) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      doc._rev_tree = [{
        pos: revInfo.prefix,
        ids: [revInfo.id, {status: 'missing'}, [[newRevId, opts, []]]]
      }];
      nRevNum = revInfo.prefix + 1;
    } else {
      doc._rev_tree = [{
        pos: 1,
        ids : [newRevId, opts, []]
      }];
      nRevNum = 1;
    }
  } else {
    if (doc._revisions) {
      doc._rev_tree = makeRevTreeFromRevisions(doc._revisions, opts);
      nRevNum = doc._revisions.start;
      newRevId = doc._revisions.ids[0];
    }
    if (!doc._rev_tree) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      nRevNum = revInfo.prefix;
      newRevId = revInfo.id;
      doc._rev_tree = [{
        pos: nRevNum,
        ids: [newRevId, opts, []]
      }];
    }
  }

  invalidIdError(doc._id);

  doc._rev = nRevNum + '-' + newRevId;

  var result = {metadata : {}, data : {}};
  for (var key in doc) {
    /* istanbul ignore else */
    if (Object.prototype.hasOwnProperty.call(doc, key)) {
      var specialKey = key[0] === '_';
      if (specialKey && !reservedWords[key]) {
        var error = createError(DOC_VALIDATION, key);
        error.message = DOC_VALIDATION.message + ': ' + key;
        throw error;
      } else if (specialKey && !dataWords[key]) {
        result.metadata[key.slice(1)] = doc[key];
      } else {
        result.data[key] = doc[key];
      }
    }
  }
  return result;
}

var thisAtob = function (str) {
  return atob(str);
};

var thisBtoa = function (str) {
  return btoa(str);
};

// Abstracts constructing a Blob object, so it also works in older
// browsers that don't support the native Blob constructor (e.g.
// old QtWebKit versions, Android < 4.4).
function createBlob(parts, properties) {
  /* global BlobBuilder,MSBlobBuilder,MozBlobBuilder,WebKitBlobBuilder */
  parts = parts || [];
  properties = properties || {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== "TypeError") {
      throw e;
    }
    var Builder = typeof BlobBuilder !== 'undefined' ? BlobBuilder :
                  typeof MSBlobBuilder !== 'undefined' ? MSBlobBuilder :
                  typeof MozBlobBuilder !== 'undefined' ? MozBlobBuilder :
                  WebKitBlobBuilder;
    var builder = new Builder();
    for (var i = 0; i < parts.length; i += 1) {
      builder.append(parts[i]);
    }
    return builder.getBlob(properties.type);
  }
}

// From http://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
function binaryStringToArrayBuffer(bin) {
  var length = bin.length;
  var buf = new ArrayBuffer(length);
  var arr = new Uint8Array(buf);
  for (var i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

function binStringToBluffer(binString, type) {
  return createBlob([binaryStringToArrayBuffer(binString)], {type: type});
}

function b64ToBluffer(b64, type) {
  return binStringToBluffer(thisAtob(b64), type);
}

//Can't find original post, but this is close
//http://stackoverflow.com/questions/6965107/ (continues on next line)
//converting-between-strings-and-arraybuffers
function arrayBufferToBinaryString(buffer) {
  var binary = '';
  var bytes = new Uint8Array(buffer);
  var length = bytes.byteLength;
  for (var i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// shim for browsers that don't support it
function readAsBinaryString(blob, callback) {
  if (typeof FileReader === 'undefined') {
    // fix for Firefox in a web worker
    // https://bugzilla.mozilla.org/show_bug.cgi?id=901097
    return callback(arrayBufferToBinaryString(
      new FileReaderSync().readAsArrayBuffer(blob)));
  }

  var reader = new FileReader();
  var hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    var result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

function blobToBinaryString(blobOrBuffer, callback) {
  readAsBinaryString(blobOrBuffer, function (bin) {
    callback(bin);
  });
}

function blobToBase64(blobOrBuffer, callback) {
  blobToBinaryString(blobOrBuffer, function (base64) {
    callback(thisBtoa(base64));
  });
}

// simplified API. universal browser support is assumed
function readAsArrayBuffer(blob, callback) {
  if (typeof FileReader === 'undefined') {
    // fix for Firefox in a web worker:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=901097
    return callback(new FileReaderSync().readAsArrayBuffer(blob));
  }

  var reader = new FileReader();
  reader.onloadend = function (e) {
    var result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

// this is not used in the browser

var setImmediateShim = global.setImmediate || global.setTimeout;
var MD5_CHUNK_SIZE = 32768;

function rawToBase64(raw) {
  return thisBtoa(raw);
}

function sliceBlob(blob$$1, start, end) {
  if (blob$$1.webkitSlice) {
    return blob$$1.webkitSlice(start, end);
  }
  return blob$$1.slice(start, end);
}

function appendBlob(buffer, blob$$1, start, end, callback) {
  if (start > 0 || end < blob$$1.size) {
    // only slice blob if we really need to
    blob$$1 = sliceBlob(blob$$1, start, end);
  }
  readAsArrayBuffer(blob$$1, function (arrayBuffer) {
    buffer.append(arrayBuffer);
    callback();
  });
}

function appendString(buffer, string, start, end, callback) {
  if (start > 0 || end < string.length) {
    // only create a substring if we really need to
    string = string.substring(start, end);
  }
  buffer.appendBinary(string);
  callback();
}

function binaryMd5(data, callback) {
  var inputIsString = typeof data === 'string';
  var len = inputIsString ? data.length : data.size;
  var chunkSize = Math.min(MD5_CHUNK_SIZE, len);
  var chunks = Math.ceil(len / chunkSize);
  var currentChunk = 0;
  var buffer = inputIsString ? new Md5() : new Md5.ArrayBuffer();

  var append = inputIsString ? appendString : appendBlob;

  function next() {
    setImmediateShim(loadNextChunk);
  }

  function done() {
    var raw = buffer.end(true);
    var base64 = rawToBase64(raw);
    callback(base64);
    buffer.destroy();
  }

  function loadNextChunk() {
    var start = currentChunk * chunkSize;
    var end = start + chunkSize;
    currentChunk++;
    if (currentChunk < chunks) {
      append(buffer, data, start, end, next);
    } else {
      append(buffer, data, start, end, done);
    }
  }
  loadNextChunk();
}

function stringMd5(string) {
  return Md5.hash(string);
}

function parseBase64(data) {
  try {
    return thisAtob(data);
  } catch (e) {
    var err = createError(BAD_ARG,
      'Attachment is not a valid base64 string');
    return {error: err};
  }
}

function preprocessString(att, blobType, callback) {
  var asBinary = parseBase64(att.data);
  if (asBinary.error) {
    return callback(asBinary.error);
  }

  att.length = asBinary.length;
  if (blobType === 'blob') {
    att.data = binStringToBluffer(asBinary, att.content_type);
  } else if (blobType === 'base64') {
    att.data = thisBtoa(asBinary);
  } else { // binary
    att.data = asBinary;
  }
  binaryMd5(asBinary, function (result) {
    att.digest = 'md5-' + result;
    callback();
  });
}

function preprocessBlob(att, blobType, callback) {
  binaryMd5(att.data, function (md5) {
    att.digest = 'md5-' + md5;
    // size is for blobs (browser), length is for buffers (node)
    att.length = att.data.size || att.data.length || 0;
    if (blobType === 'binary') {
      blobToBinaryString(att.data, function (binString) {
        att.data = binString;
        callback();
      });
    } else if (blobType === 'base64') {
      blobToBase64(att.data, function (b64) {
        att.data = b64;
        callback();
      });
    } else {
      callback();
    }
  });
}

function preprocessAttachment(att, blobType, callback) {
  if (att.stub) {
    return callback();
  }
  if (typeof att.data === 'string') { // input is a base64 string
    preprocessString(att, blobType, callback);
  } else { // input is a blob
    preprocessBlob(att, blobType, callback);
  }
}

function preprocessAttachments(docInfos, blobType, callback) {

  if (!docInfos.length) {
    return callback();
  }

  var docv = 0;
  var overallErr;

  docInfos.forEach(function (docInfo) {
    var attachments = docInfo.data && docInfo.data._attachments ?
      Object.keys(docInfo.data._attachments) : [];
    var recv = 0;

    if (!attachments.length) {
      return done();
    }

    function processedAttachment(err) {
      overallErr = err;
      recv++;
      if (recv === attachments.length) {
        done();
      }
    }

    for (var key in docInfo.data._attachments) {
      if (docInfo.data._attachments.hasOwnProperty(key)) {
        preprocessAttachment(docInfo.data._attachments[key],
          blobType, processedAttachment);
      }
    }
  });

  function done() {
    docv++;
    if (docInfos.length === docv) {
      if (overallErr) {
        callback(overallErr);
      } else {
        callback();
      }
    }
  }
}

function updateDoc(revLimit, prev, docInfo, results,
                   i, cb, writeDoc, newEdits) {

  if (revExists(prev.rev_tree, docInfo.metadata.rev)) {
    results[i] = docInfo;
    return cb();
  }

  // sometimes this is pre-calculated. historically not always
  var previousWinningRev = prev.winningRev || winningRev(prev);
  var previouslyDeleted = 'deleted' in prev ? prev.deleted :
    isDeleted(prev, previousWinningRev);
  var deleted = 'deleted' in docInfo.metadata ? docInfo.metadata.deleted :
    isDeleted(docInfo.metadata);
  var isRoot = /^1-/.test(docInfo.metadata.rev);

  if (previouslyDeleted && !deleted && newEdits && isRoot) {
    var newDoc = docInfo.data;
    newDoc._rev = previousWinningRev;
    newDoc._id = docInfo.metadata.id;
    docInfo = parseDoc(newDoc, newEdits);
  }

  var merged = merge(prev.rev_tree, docInfo.metadata.rev_tree[0], revLimit);

  var inConflict = newEdits && ((
    (previouslyDeleted && deleted && merged.conflicts !== 'new_leaf') ||
    (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
    (previouslyDeleted && !deleted && merged.conflicts === 'new_branch')));

  if (inConflict) {
    var err = createError(REV_CONFLICT);
    results[i] = err;
    return cb();
  }

  var newRev = docInfo.metadata.rev;
  docInfo.metadata.rev_tree = merged.tree;
  docInfo.stemmedRevs = merged.stemmedRevs || [];
  /* istanbul ignore else */
  if (prev.rev_map) {
    docInfo.metadata.rev_map = prev.rev_map; // used only by leveldb
  }

  // recalculate
  var winningRev$$1 = winningRev(docInfo.metadata);
  var winningRevIsDeleted = isDeleted(docInfo.metadata, winningRev$$1);

  // calculate the total number of documents that were added/removed,
  // from the perspective of total_rows/doc_count
  var delta = (previouslyDeleted === winningRevIsDeleted) ? 0 :
    previouslyDeleted < winningRevIsDeleted ? -1 : 1;

  var newRevIsDeleted;
  if (newRev === winningRev$$1) {
    // if the new rev is the same as the winning rev, we can reuse that value
    newRevIsDeleted = winningRevIsDeleted;
  } else {
    // if they're not the same, then we need to recalculate
    newRevIsDeleted = isDeleted(docInfo.metadata, newRev);
  }

  writeDoc(docInfo, winningRev$$1, winningRevIsDeleted, newRevIsDeleted,
    true, delta, i, cb);
}

function rootIsMissing(docInfo) {
  return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
}

function processDocs(revLimit, docInfos, api, fetchedDocs, tx, results,
                     writeDoc, opts, overallCallback) {

  // Default to 1000 locally
  revLimit = revLimit || 1000;

  function insertDoc(docInfo, resultsIdx, callback) {
    // Cant insert new deleted documents
    var winningRev$$1 = winningRev(docInfo.metadata);
    var deleted = isDeleted(docInfo.metadata, winningRev$$1);
    if ('was_delete' in opts && deleted) {
      results[resultsIdx] = createError(MISSING_DOC, 'deleted');
      return callback();
    }

    // 4712 - detect whether a new document was inserted with a _rev
    var inConflict = newEdits && rootIsMissing(docInfo);

    if (inConflict) {
      var err = createError(REV_CONFLICT);
      results[resultsIdx] = err;
      return callback();
    }

    var delta = deleted ? 0 : 1;

    writeDoc(docInfo, winningRev$$1, deleted, deleted, false,
      delta, resultsIdx, callback);
  }

  var newEdits = opts.new_edits;
  var idsToDocs = new ExportedMap();

  var docsDone = 0;
  var docsToDo = docInfos.length;

  function checkAllDocsDone() {
    if (++docsDone === docsToDo && overallCallback) {
      overallCallback();
    }
  }

  docInfos.forEach(function (currentDoc, resultsIdx) {

    if (currentDoc._id && isLocalId(currentDoc._id)) {
      var fun = currentDoc._deleted ? '_removeLocal' : '_putLocal';
      api[fun](currentDoc, {ctx: tx}, function (err, res) {
        results[resultsIdx] = err || res;
        checkAllDocsDone();
      });
      return;
    }

    var id = currentDoc.metadata.id;
    if (idsToDocs.has(id)) {
      docsToDo--; // duplicate
      idsToDocs.get(id).push([currentDoc, resultsIdx]);
    } else {
      idsToDocs.set(id, [[currentDoc, resultsIdx]]);
    }
  });

  // in the case of new_edits, the user can provide multiple docs
  // with the same id. these need to be processed sequentially
  idsToDocs.forEach(function (docs, id) {
    var numDone = 0;

    function docWritten() {
      if (++numDone < docs.length) {
        nextDoc();
      } else {
        checkAllDocsDone();
      }
    }
    function nextDoc() {
      var value = docs[numDone];
      var currentDoc = value[0];
      var resultsIdx = value[1];

      if (fetchedDocs.has(id)) {
        updateDoc(revLimit, fetchedDocs.get(id), currentDoc, results,
          resultsIdx, docWritten, writeDoc, newEdits);
      } else {
        // Ensure stemming applies to new writes as well
        var merged = merge([], currentDoc.metadata.rev_tree[0], revLimit);
        currentDoc.metadata.rev_tree = merged.tree;
        currentDoc.stemmedRevs = merged.stemmedRevs || [];
        insertDoc(currentDoc, resultsIdx, docWritten);
      }
    }
    nextDoc();
  });
}

// IndexedDB requires a versioned database structure, so we use the
// version here to manage migrations.
var ADAPTER_VERSION = 5;

// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
// Keyed by document id
var DOC_STORE = 'document-store';
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
var BY_SEQ_STORE = 'by-sequence';
// Where we store attachments
var ATTACH_STORE = 'attach-store';
// Where we store many-to-many relations
// between attachment digests and seqs
var ATTACH_AND_SEQ_STORE = 'attach-seq-store';

// Where we store database-wide meta data in a single record
// keyed by id: META_STORE
var META_STORE = 'meta-store';
// Where we store local documents
var LOCAL_STORE = 'local-store';
// Where we detect blob support
var DETECT_BLOB_SUPPORT_STORE = 'detect-blob-support';

function safeJsonParse(str) {
  // This try/catch guards against stack overflow errors.
  // JSON.parse() is faster than vuvuzela.parse() but vuvuzela
  // cannot overflow.
  try {
    return JSON.parse(str);
  } catch (e) {
    /* istanbul ignore next */
    return vuvuzela.parse(str);
  }
}

function safeJsonStringify(json) {
  try {
    return JSON.stringify(json);
  } catch (e) {
    /* istanbul ignore next */
    return vuvuzela.stringify(json);
  }
}

function idbError(callback) {
  return function (evt) {
    var message = 'unknown_error';
    if (evt.target && evt.target.error) {
      message = evt.target.error.name || evt.target.error.message;
    }
    callback(createError(IDB_ERROR, message, evt.type));
  };
}

// Unfortunately, the metadata has to be stringified
// when it is put into the database, because otherwise
// IndexedDB can throw errors for deeply-nested objects.
// Originally we just used JSON.parse/JSON.stringify; now
// we use this custom vuvuzela library that avoids recursion.
// If we could do it all over again, we'd probably use a
// format for the revision trees other than JSON.
function encodeMetadata(metadata, winningRev, deleted) {
  return {
    data: safeJsonStringify(metadata),
    winningRev: winningRev,
    deletedOrLocal: deleted ? '1' : '0',
    seq: metadata.seq, // highest seq for this doc
    id: metadata.id
  };
}

function decodeMetadata(storedObject) {
  if (!storedObject) {
    return null;
  }
  var metadata = safeJsonParse(storedObject.data);
  metadata.winningRev = storedObject.winningRev;
  metadata.deleted = storedObject.deletedOrLocal === '1';
  metadata.seq = storedObject.seq;
  return metadata;
}

// read the doc back out from the database. we don't store the
// _id or _rev because we already have _doc_id_rev.
function decodeDoc(doc) {
  if (!doc) {
    return doc;
  }
  var idx = doc._doc_id_rev.lastIndexOf(':');
  doc._id = doc._doc_id_rev.substring(0, idx - 1);
  doc._rev = doc._doc_id_rev.substring(idx + 1);
  delete doc._doc_id_rev;
  return doc;
}

// Read a blob from the database, encoding as necessary
// and translating from base64 if the IDB doesn't support
// native Blobs
function readBlobData(body, type, asBlob, callback) {
  if (asBlob) {
    if (!body) {
      callback(createBlob([''], {type: type}));
    } else if (typeof body !== 'string') { // we have blob support
      callback(body);
    } else { // no blob support
      callback(b64ToBluffer(body, type));
    }
  } else { // as base64 string
    if (!body) {
      callback('');
    } else if (typeof body !== 'string') { // we have blob support
      readAsBinaryString(body, function (binary) {
        callback(thisBtoa(binary));
      });
    } else { // no blob support
      callback(body);
    }
  }
}

function fetchAttachmentsIfNecessary(doc, opts, txn, cb) {
  var attachments = Object.keys(doc._attachments || {});
  if (!attachments.length) {
    return cb && cb();
  }
  var numDone = 0;

  function checkDone() {
    if (++numDone === attachments.length && cb) {
      cb();
    }
  }

  function fetchAttachment(doc, att) {
    var attObj = doc._attachments[att];
    var digest = attObj.digest;
    var req = txn.objectStore(ATTACH_STORE).get(digest);
    req.onsuccess = function (e) {
      attObj.body = e.target.result.body;
      checkDone();
    };
  }

  attachments.forEach(function (att) {
    if (opts.attachments && opts.include_docs) {
      fetchAttachment(doc, att);
    } else {
      doc._attachments[att].stub = true;
      checkDone();
    }
  });
}

// IDB-specific postprocessing necessary because
// we don't know whether we stored a true Blob or
// a base64-encoded string, and if it's a Blob it
// needs to be read outside of the transaction context
function postProcessAttachments(results, asBlob) {
  return PouchPromise$1.all(results.map(function (row) {
    if (row.doc && row.doc._attachments) {
      var attNames = Object.keys(row.doc._attachments);
      return PouchPromise$1.all(attNames.map(function (att) {
        var attObj = row.doc._attachments[att];
        if (!('body' in attObj)) { // already processed
          return;
        }
        var body = attObj.body;
        var type = attObj.content_type;
        return new PouchPromise$1(function (resolve) {
          readBlobData(body, type, asBlob, function (data) {
            row.doc._attachments[att] = $inject_Object_assign(
              pick(attObj, ['digest', 'content_type']),
              {data: data}
            );
            resolve();
          });
        });
      }));
    }
  }));
}

function compactRevs(revs, docId, txn) {

  var possiblyOrphanedDigests = [];
  var seqStore = txn.objectStore(BY_SEQ_STORE);
  var attStore = txn.objectStore(ATTACH_STORE);
  var attAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);
  var count = revs.length;

  function checkDone() {
    count--;
    if (!count) { // done processing all revs
      deleteOrphanedAttachments();
    }
  }

  function deleteOrphanedAttachments() {
    if (!possiblyOrphanedDigests.length) {
      return;
    }
    possiblyOrphanedDigests.forEach(function (digest) {
      var countReq = attAndSeqStore.index('digestSeq').count(
        IDBKeyRange.bound(
          digest + '::', digest + '::\uffff', false, false));
      countReq.onsuccess = function (e) {
        var count = e.target.result;
        if (!count) {
          // orphaned
          attStore.delete(digest);
        }
      };
    });
  }

  revs.forEach(function (rev) {
    var index = seqStore.index('_doc_id_rev');
    var key = docId + "::" + rev;
    index.getKey(key).onsuccess = function (e) {
      var seq = e.target.result;
      if (typeof seq !== 'number') {
        return checkDone();
      }
      seqStore.delete(seq);

      var cursor = attAndSeqStore.index('seq')
        .openCursor(IDBKeyRange.only(seq));

      cursor.onsuccess = function (event) {
        var cursor = event.target.result;
        if (cursor) {
          var digest = cursor.value.digestSeq.split('::')[0];
          possiblyOrphanedDigests.push(digest);
          attAndSeqStore.delete(cursor.primaryKey);
          cursor.continue();
        } else { // done
          checkDone();
        }
      };
    };
  });
}

function openTransactionSafely(idb, stores, mode) {
  try {
    return {
      txn: idb.transaction(stores, mode)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

var changesHandler$$1 = new Changes();

function idbBulkDocs(dbOpts, req, opts, api, idb, callback) {
  var docInfos = req.docs;
  var txn;
  var docStore;
  var bySeqStore;
  var attachStore;
  var attachAndSeqStore;
  var metaStore;
  var docInfoError;
  var metaDoc;

  for (var i = 0, len = docInfos.length; i < len; i++) {
    var doc = docInfos[i];
    if (doc._id && isLocalId(doc._id)) {
      continue;
    }
    doc = docInfos[i] = parseDoc(doc, opts.new_edits);
    if (doc.error && !docInfoError) {
      docInfoError = doc;
    }
  }

  if (docInfoError) {
    return callback(docInfoError);
  }

  var allDocsProcessed = false;
  var docCountDelta = 0;
  var results = new Array(docInfos.length);
  var fetchedDocs = new ExportedMap();
  var preconditionErrored = false;
  var blobType = api._meta.blobSupport ? 'blob' : 'base64';

  preprocessAttachments(docInfos, blobType, function (err) {
    if (err) {
      return callback(err);
    }
    startTransaction();
  });

  function startTransaction() {

    var stores = [
      DOC_STORE, BY_SEQ_STORE,
      ATTACH_STORE,
      LOCAL_STORE, ATTACH_AND_SEQ_STORE,
      META_STORE
    ];
    var txnResult = openTransactionSafely(idb, stores, 'readwrite');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    txn = txnResult.txn;
    txn.onabort = idbError(callback);
    txn.ontimeout = idbError(callback);
    txn.oncomplete = complete;
    docStore = txn.objectStore(DOC_STORE);
    bySeqStore = txn.objectStore(BY_SEQ_STORE);
    attachStore = txn.objectStore(ATTACH_STORE);
    attachAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);
    metaStore = txn.objectStore(META_STORE);

    metaStore.get(META_STORE).onsuccess = function (e) {
      metaDoc = e.target.result;
      updateDocCountIfReady();
    };

    verifyAttachments(function (err) {
      if (err) {
        preconditionErrored = true;
        return callback(err);
      }
      fetchExistingDocs();
    });
  }

  function onAllDocsProcessed() {
    allDocsProcessed = true;
    updateDocCountIfReady();
  }

  function idbProcessDocs() {
    processDocs(dbOpts.revs_limit, docInfos, api, fetchedDocs,
                txn, results, writeDoc, opts, onAllDocsProcessed);
  }

  function updateDocCountIfReady() {
    if (!metaDoc || !allDocsProcessed) {
      return;
    }
    // caching the docCount saves a lot of time in allDocs() and
    // info(), which is why we go to all the trouble of doing this
    metaDoc.docCount += docCountDelta;
    metaStore.put(metaDoc);
  }

  function fetchExistingDocs() {

    if (!docInfos.length) {
      return;
    }

    var numFetched = 0;

    function checkDone() {
      if (++numFetched === docInfos.length) {
        idbProcessDocs();
      }
    }

    function readMetadata(event) {
      var metadata = decodeMetadata(event.target.result);

      if (metadata) {
        fetchedDocs.set(metadata.id, metadata);
      }
      checkDone();
    }

    for (var i = 0, len = docInfos.length; i < len; i++) {
      var docInfo = docInfos[i];
      if (docInfo._id && isLocalId(docInfo._id)) {
        checkDone(); // skip local docs
        continue;
      }
      var req = docStore.get(docInfo.metadata.id);
      req.onsuccess = readMetadata;
    }
  }

  function complete() {
    if (preconditionErrored) {
      return;
    }

    changesHandler$$1.notify(api._meta.name);
    callback(null, results);
  }

  function verifyAttachment(digest, callback) {

    var req = attachStore.get(digest);
    req.onsuccess = function (e) {
      if (!e.target.result) {
        var err = createError(MISSING_STUB,
          'unknown stub attachment with digest ' +
          digest);
        err.status = 412;
        callback(err);
      } else {
        callback();
      }
    };
  }

  function verifyAttachments(finish) {


    var digests = [];
    docInfos.forEach(function (docInfo) {
      if (docInfo.data && docInfo.data._attachments) {
        Object.keys(docInfo.data._attachments).forEach(function (filename) {
          var att = docInfo.data._attachments[filename];
          if (att.stub) {
            digests.push(att.digest);
          }
        });
      }
    });
    if (!digests.length) {
      return finish();
    }
    var numDone = 0;
    var err;

    function checkDone() {
      if (++numDone === digests.length) {
        finish(err);
      }
    }
    digests.forEach(function (digest) {
      verifyAttachment(digest, function (attErr) {
        if (attErr && !err) {
          err = attErr;
        }
        checkDone();
      });
    });
  }

  function writeDoc(docInfo, winningRev$$1, winningRevIsDeleted, newRevIsDeleted,
                    isUpdate, delta, resultsIdx, callback) {

    docInfo.metadata.winningRev = winningRev$$1;
    docInfo.metadata.deleted = winningRevIsDeleted;

    var doc = docInfo.data;
    doc._id = docInfo.metadata.id;
    doc._rev = docInfo.metadata.rev;

    if (newRevIsDeleted) {
      doc._deleted = true;
    }

    var hasAttachments = doc._attachments &&
      Object.keys(doc._attachments).length;
    if (hasAttachments) {
      return writeAttachments(docInfo, winningRev$$1, winningRevIsDeleted,
        isUpdate, resultsIdx, callback);
    }

    docCountDelta += delta;
    updateDocCountIfReady();

    finishDoc(docInfo, winningRev$$1, winningRevIsDeleted,
      isUpdate, resultsIdx, callback);
  }

  function finishDoc(docInfo, winningRev$$1, winningRevIsDeleted,
                     isUpdate, resultsIdx, callback) {

    var doc = docInfo.data;
    var metadata = docInfo.metadata;

    doc._doc_id_rev = metadata.id + '::' + metadata.rev;
    delete doc._id;
    delete doc._rev;

    function afterPutDoc(e) {
      var revsToDelete = docInfo.stemmedRevs || [];

      if (isUpdate && api.auto_compaction) {
        revsToDelete = revsToDelete.concat(compactTree(docInfo.metadata));
      }

      if (revsToDelete && revsToDelete.length) {
        compactRevs(revsToDelete, docInfo.metadata.id, txn);
      }

      metadata.seq = e.target.result;
      // Current _rev is calculated from _rev_tree on read
      // delete metadata.rev;
      var metadataToStore = encodeMetadata(metadata, winningRev$$1,
        winningRevIsDeleted);
      var metaDataReq = docStore.put(metadataToStore);
      metaDataReq.onsuccess = afterPutMetadata;
    }

    function afterPutDocError(e) {
      // ConstraintError, need to update, not put (see #1638 for details)
      e.preventDefault(); // avoid transaction abort
      e.stopPropagation(); // avoid transaction onerror
      var index = bySeqStore.index('_doc_id_rev');
      var getKeyReq = index.getKey(doc._doc_id_rev);
      getKeyReq.onsuccess = function (e) {
        var putReq = bySeqStore.put(doc, e.target.result);
        putReq.onsuccess = afterPutDoc;
      };
    }

    function afterPutMetadata() {
      results[resultsIdx] = {
        ok: true,
        id: metadata.id,
        rev: metadata.rev
      };
      fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
      insertAttachmentMappings(docInfo, metadata.seq, callback);
    }

    var putReq = bySeqStore.put(doc);

    putReq.onsuccess = afterPutDoc;
    putReq.onerror = afterPutDocError;
  }

  function writeAttachments(docInfo, winningRev$$1, winningRevIsDeleted,
                            isUpdate, resultsIdx, callback) {


    var doc = docInfo.data;

    var numDone = 0;
    var attachments = Object.keys(doc._attachments);

    function collectResults() {
      if (numDone === attachments.length) {
        finishDoc(docInfo, winningRev$$1, winningRevIsDeleted,
          isUpdate, resultsIdx, callback);
      }
    }

    function attachmentSaved() {
      numDone++;
      collectResults();
    }

    attachments.forEach(function (key) {
      var att = docInfo.data._attachments[key];
      if (!att.stub) {
        var data = att.data;
        delete att.data;
        att.revpos = parseInt(winningRev$$1, 10);
        var digest = att.digest;
        saveAttachment(digest, data, attachmentSaved);
      } else {
        numDone++;
        collectResults();
      }
    });
  }

  // map seqs to attachment digests, which
  // we will need later during compaction
  function insertAttachmentMappings(docInfo, seq, callback) {

    var attsAdded = 0;
    var attsToAdd = Object.keys(docInfo.data._attachments || {});

    if (!attsToAdd.length) {
      return callback();
    }

    function checkDone() {
      if (++attsAdded === attsToAdd.length) {
        callback();
      }
    }

    function add(att) {
      var digest = docInfo.data._attachments[att].digest;
      var req = attachAndSeqStore.put({
        seq: seq,
        digestSeq: digest + '::' + seq
      });

      req.onsuccess = checkDone;
      req.onerror = function (e) {
        // this callback is for a constaint error, which we ignore
        // because this docid/rev has already been associated with
        // the digest (e.g. when new_edits == false)
        e.preventDefault(); // avoid transaction abort
        e.stopPropagation(); // avoid transaction onerror
        checkDone();
      };
    }
    for (var i = 0; i < attsToAdd.length; i++) {
      add(attsToAdd[i]); // do in parallel
    }
  }

  function saveAttachment(digest, data, callback) {


    var getKeyReq = attachStore.count(digest);
    getKeyReq.onsuccess = function (e) {
      var count = e.target.result;
      if (count) {
        return callback(); // already exists
      }
      var newAtt = {
        digest: digest,
        body: data
      };
      var putReq = attachStore.put(newAtt);
      putReq.onsuccess = callback;
    };
  }
}

// Abstraction over IDBCursor and getAll()/getAllKeys() that allows us to batch our operations
// while falling back to a normal IDBCursor operation on browsers that don't support getAll() or
// getAllKeys(). This allows for a much faster implementation than just straight-up cursors, because
// we're not processing each document one-at-a-time.
function runBatchedCursor(objectStore, keyRange, descending, batchSize, onBatch) {

  // Bail out of getAll()/getAllKeys() in the following cases:
  // 1) either method is unsupported - we need both
  // 2) batchSize is 1 (might as well use IDBCursor), or batchSize is -1 (i.e. batchSize unlimited,
  //    not really clear the user wants a batched approach where the entire DB is read into memory,
  //    perhaps they are filtering on a per-doc basis)
  // 3) descending – no real way to do this via getAll()/getAllKeys()

  var useGetAll = typeof objectStore.getAll === 'function' &&
    typeof objectStore.getAllKeys === 'function' &&
    batchSize > 1 && !descending;

  var keysBatch;
  var valuesBatch;
  var pseudoCursor;

  function onGetAll(e) {
    valuesBatch = e.target.result;
    if (keysBatch) {
      onBatch(keysBatch, valuesBatch, pseudoCursor);
    }
  }

  function onGetAllKeys(e) {
    keysBatch = e.target.result;
    if (valuesBatch) {
      onBatch(keysBatch, valuesBatch, pseudoCursor);
    }
  }

  function continuePseudoCursor() {
    if (!keysBatch.length) { // no more results
      return onBatch();
    }
    // fetch next batch, exclusive start
    var lastKey = keysBatch[keysBatch.length - 1];
    var newKeyRange;
    if (keyRange && keyRange.upper) {
      try {
        newKeyRange = IDBKeyRange.bound(lastKey, keyRange.upper,
          true, keyRange.upperOpen);
      } catch (e) {
        if (e.name === "DataError" && e.code === 0) {
          return onBatch(); // we're done, startkey and endkey are equal
        }
      }
    } else {
      newKeyRange = IDBKeyRange.lowerBound(lastKey, true);
    }
    keyRange = newKeyRange;
    keysBatch = null;
    valuesBatch = null;
    objectStore.getAll(keyRange, batchSize).onsuccess = onGetAll;
    objectStore.getAllKeys(keyRange, batchSize).onsuccess = onGetAllKeys;
  }

  function onCursor(e) {
    var cursor = e.target.result;
    if (!cursor) { // done
      return onBatch();
    }
    // regular IDBCursor acts like a batch where batch size is always 1
    onBatch([cursor.key], [cursor.value], cursor);
  }

  if (useGetAll) {
    pseudoCursor = {"continue": continuePseudoCursor};
    objectStore.getAll(keyRange, batchSize).onsuccess = onGetAll;
    objectStore.getAllKeys(keyRange, batchSize).onsuccess = onGetAllKeys;
  } else if (descending) {
    objectStore.openCursor(keyRange, 'prev').onsuccess = onCursor;
  } else {
    objectStore.openCursor(keyRange).onsuccess = onCursor;
  }
}

// simple shim for objectStore.getAll(), falling back to IDBCursor
function getAll(objectStore, keyRange, onSuccess) {
  if (typeof objectStore.getAll === 'function') {
    // use native getAll
    objectStore.getAll(keyRange).onsuccess = onSuccess;
    return;
  }
  // fall back to cursors
  var values = [];

  function onCursor(e) {
    var cursor = e.target.result;
    if (cursor) {
      values.push(cursor.value);
      cursor.continue();
    } else {
      onSuccess({
        target: {
          result: values
        }
      });
    }
  }

  objectStore.openCursor(keyRange).onsuccess = onCursor;
}

function createKeyRange(start, end, inclusiveEnd, key, descending) {
  try {
    if (start && end) {
      if (descending) {
        return IDBKeyRange.bound(end, start, !inclusiveEnd, false);
      } else {
        return IDBKeyRange.bound(start, end, false, !inclusiveEnd);
      }
    } else if (start) {
      if (descending) {
        return IDBKeyRange.upperBound(start);
      } else {
        return IDBKeyRange.lowerBound(start);
      }
    } else if (end) {
      if (descending) {
        return IDBKeyRange.lowerBound(end, !inclusiveEnd);
      } else {
        return IDBKeyRange.upperBound(end, !inclusiveEnd);
      }
    } else if (key) {
      return IDBKeyRange.only(key);
    }
  } catch (e) {
    return {error: e};
  }
  return null;
}

function idbAllDocs(opts, idb, callback) {
  var start = 'startkey' in opts ? opts.startkey : false;
  var end = 'endkey' in opts ? opts.endkey : false;
  var key = 'key' in opts ? opts.key : false;
  var skip = opts.skip || 0;
  var limit = typeof opts.limit === 'number' ? opts.limit : -1;
  var inclusiveEnd = opts.inclusive_end !== false;

  var keyRange = createKeyRange(start, end, inclusiveEnd, key, opts.descending);
  var keyRangeError = keyRange && keyRange.error;
  if (keyRangeError && !(keyRangeError.name === "DataError" &&
      keyRangeError.code === 0)) {
    // DataError with error code 0 indicates start is less than end, so
    // can just do an empty query. Else need to throw
    return callback(createError(IDB_ERROR,
      keyRangeError.name, keyRangeError.message));
  }

  var stores = [DOC_STORE, BY_SEQ_STORE, META_STORE];

  if (opts.attachments) {
    stores.push(ATTACH_STORE);
  }
  var txnResult = openTransactionSafely(idb, stores, 'readonly');
  if (txnResult.error) {
    return callback(txnResult.error);
  }
  var txn = txnResult.txn;
  txn.oncomplete = onTxnComplete;
  txn.onabort = idbError(callback);
  var docStore = txn.objectStore(DOC_STORE);
  var seqStore = txn.objectStore(BY_SEQ_STORE);
  var metaStore = txn.objectStore(META_STORE);
  var docIdRevIndex = seqStore.index('_doc_id_rev');
  var results = [];
  var docCount;

  metaStore.get(META_STORE).onsuccess = function (e) {
    docCount = e.target.result.docCount;
  };

  // if the user specifies include_docs=true, then we don't
  // want to block the main cursor while we're fetching the doc
  function fetchDocAsynchronously(metadata, row, winningRev$$1) {
    var key = metadata.id + "::" + winningRev$$1;
    docIdRevIndex.get(key).onsuccess =  function onGetDoc(e) {
      row.doc = decodeDoc(e.target.result);
      if (opts.conflicts) {
        var conflicts = collectConflicts(metadata);
        if (conflicts.length) {
          row.doc._conflicts = conflicts;
        }
      }
      fetchAttachmentsIfNecessary(row.doc, opts, txn);
    };
  }

  function allDocsInner(winningRev$$1, metadata) {
    var row = {
      id: metadata.id,
      key: metadata.id,
      value: {
        rev: winningRev$$1
      }
    };
    var deleted = metadata.deleted;
    if (opts.deleted === 'ok') {
      results.push(row);
      // deleted docs are okay with "keys" requests
      if (deleted) {
        row.value.deleted = true;
        row.doc = null;
      } else if (opts.include_docs) {
        fetchDocAsynchronously(metadata, row, winningRev$$1);
      }
    } else if (!deleted && skip-- <= 0) {
      results.push(row);
      if (opts.include_docs) {
        fetchDocAsynchronously(metadata, row, winningRev$$1);
      }
    }
  }

  function processBatch(batchValues) {
    for (var i = 0, len = batchValues.length; i < len; i++) {
      if (results.length === limit) {
        break;
      }
      var batchValue = batchValues[i];
      var metadata = decodeMetadata(batchValue);
      var winningRev$$1 = metadata.winningRev;
      allDocsInner(winningRev$$1, metadata);
    }
  }

  function onBatch(batchKeys, batchValues, cursor) {
    if (!cursor) {
      return;
    }
    processBatch(batchValues);
    if (results.length < limit) {
      cursor.continue();
    }
  }

  function onGetAll(e) {
    var values = e.target.result;
    if (opts.descending) {
      values = values.reverse();
    }
    processBatch(values);
  }

  function onResultsReady() {
    callback(null, {
      total_rows: docCount,
      offset: opts.skip,
      rows: results
    });
  }

  function onTxnComplete() {
    if (opts.attachments) {
      postProcessAttachments(results, opts.binary).then(onResultsReady);
    } else {
      onResultsReady();
    }
  }

  // don't bother doing any requests if start > end or limit === 0
  if (keyRangeError || limit === 0) {
    return;
  }
  if (limit === -1) { // just fetch everything
    return getAll(docStore, keyRange, onGetAll);
  }
  // else do a cursor
  // choose a batch size based on the skip, since we'll need to skip that many
  runBatchedCursor(docStore, keyRange, opts.descending, limit + skip, onBatch);
}

//
// Blobs are not supported in all versions of IndexedDB, notably
// Chrome <37 and Android <5. In those versions, storing a blob will throw.
//
// Various other blob bugs exist in Chrome v37-42 (inclusive).
// Detecting them is expensive and confusing to users, and Chrome 37-42
// is at very low usage worldwide, so we do a hacky userAgent check instead.
//
// content-type bug: https://code.google.com/p/chromium/issues/detail?id=408120
// 404 bug: https://code.google.com/p/chromium/issues/detail?id=447916
// FileReader bug: https://code.google.com/p/chromium/issues/detail?id=447836
//
function checkBlobSupport(txn) {
  return new PouchPromise$1(function (resolve) {
    var blob$$1 = createBlob(['']);
    var req = txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob$$1, 'key');

    req.onsuccess = function () {
      var matchedChrome = navigator.userAgent.match(/Chrome\/(\d+)/);
      var matchedEdge = navigator.userAgent.match(/Edge\//);
      // MS Edge pretends to be Chrome 42:
      // https://msdn.microsoft.com/en-us/library/hh869301%28v=vs.85%29.aspx
      resolve(matchedEdge || !matchedChrome ||
        parseInt(matchedChrome[1], 10) >= 43);
    };

    txn.onabort = function (e) {
      // If the transaction aborts now its due to not being able to
      // write to the database, likely due to the disk being full
      e.preventDefault();
      e.stopPropagation();
      resolve(false);
    };
  }).catch(function () {
    return false; // error, so assume unsupported
  });
}

function countDocs(txn, cb) {
  var index = txn.objectStore(DOC_STORE).index('deletedOrLocal');
  index.count(IDBKeyRange.only('0')).onsuccess = function (e) {
    cb(e.target.result);
  };
}

// This task queue ensures that IDB open calls are done in their own tick
// and sequentially - i.e. we wait for the async IDB open to *fully* complete
// before calling the next one. This works around IE/Edge race conditions in IDB.

var running = false;
var queue = [];

function tryCode(fun, err, res, PouchDB) {
  try {
    fun(err, res);
  } catch (err) {
    // Shouldn't happen, but in some odd cases
    // IndexedDB implementations might throw a sync
    // error, in which case this will at least log it.
    PouchDB.emit('error', err);
  }
}

function applyNext() {
  if (running || !queue.length) {
    return;
  }
  running = true;
  queue.shift()();
}

function enqueueTask(action, callback, PouchDB) {
  queue.push(function runAction() {
    action(function runCallback(err, res) {
      tryCode(callback, err, res, PouchDB);
      running = false;
      nextTick(function runNext() {
        applyNext(PouchDB);
      });
    });
  });
  applyNext();
}

function changes(opts, api, dbName, idb) {
  opts = clone(opts);

  if (opts.continuous) {
    var id = dbName + ':' + uuid();
    changesHandler$$1.addListener(dbName, id, api, opts);
    changesHandler$$1.notify(dbName);
    return {
      cancel: function () {
        changesHandler$$1.removeListener(dbName, id);
      }
    };
  }

  var docIds = opts.doc_ids && new ExportedSet(opts.doc_ids);

  opts.since = opts.since || 0;
  var lastSeq = opts.since;

  var limit = 'limit' in opts ? opts.limit : -1;
  if (limit === 0) {
    limit = 1; // per CouchDB _changes spec
  }
  var returnDocs;
  if ('return_docs' in opts) {
    returnDocs = opts.return_docs;
  } else if ('returnDocs' in opts) {
    // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
    returnDocs = opts.returnDocs;
  } else {
    returnDocs = true;
  }

  var results = [];
  var numResults = 0;
  var filter = filterChange(opts);
  var docIdsToMetadata = new ExportedMap();

  var txn;
  var bySeqStore;
  var docStore;
  var docIdRevIndex;

  function onBatch(batchKeys, batchValues, cursor) {
    if (!cursor || !batchKeys.length) { // done
      return;
    }

    var winningDocs = new Array(batchKeys.length);
    var metadatas = new Array(batchKeys.length);

    function processMetadataAndWinningDoc(metadata, winningDoc) {
      var change = opts.processChange(winningDoc, metadata, opts);
      lastSeq = change.seq = metadata.seq;

      var filtered = filter(change);
      if (typeof filtered === 'object') { // anything but true/false indicates error
        return opts.complete(filtered);
      }

      if (filtered) {
        numResults++;
        if (returnDocs) {
          results.push(change);
        }
        // process the attachment immediately
        // for the benefit of live listeners
        if (opts.attachments && opts.include_docs) {
          fetchAttachmentsIfNecessary(winningDoc, opts, txn, function () {
            postProcessAttachments([change], opts.binary).then(function () {
              opts.onChange(change);
            });
          });
        } else {
          opts.onChange(change);
        }
      }
    }

    function onBatchDone() {
      for (var i = 0, len = winningDocs.length; i < len; i++) {
        if (numResults === limit) {
          break;
        }
        var winningDoc = winningDocs[i];
        if (!winningDoc) {
          continue;
        }
        var metadata = metadatas[i];
        processMetadataAndWinningDoc(metadata, winningDoc);
      }

      if (numResults !== limit) {
        cursor.continue();
      }
    }

    // Fetch all metadatas/winningdocs from this batch in parallel, then process
    // them all only once all data has been collected. This is done in parallel
    // because it's faster than doing it one-at-a-time.
    var numDone = 0;
    batchValues.forEach(function (value, i) {
      var doc = decodeDoc(value);
      var seq = batchKeys[i];
      fetchWinningDocAndMetadata(doc, seq, function (metadata, winningDoc) {
        metadatas[i] = metadata;
        winningDocs[i] = winningDoc;
        if (++numDone === batchKeys.length) {
          onBatchDone();
        }
      });
    });
  }

  function onGetMetadata(doc, seq, metadata, cb) {
    if (metadata.seq !== seq) {
      // some other seq is later
      return cb();
    }

    if (metadata.winningRev === doc._rev) {
      // this is the winning doc
      return cb(metadata, doc);
    }

    // fetch winning doc in separate request
    var docIdRev = doc._id + '::' + metadata.winningRev;
    var req = docIdRevIndex.get(docIdRev);
    req.onsuccess = function (e) {
      cb(metadata, decodeDoc(e.target.result));
    };
  }

  function fetchWinningDocAndMetadata(doc, seq, cb) {
    if (docIds && !docIds.has(doc._id)) {
      return cb();
    }

    var metadata = docIdsToMetadata.get(doc._id);
    if (metadata) { // cached
      return onGetMetadata(doc, seq, metadata, cb);
    }
    // metadata not cached, have to go fetch it
    docStore.get(doc._id).onsuccess = function (e) {
      metadata = decodeMetadata(e.target.result);
      docIdsToMetadata.set(doc._id, metadata);
      onGetMetadata(doc, seq, metadata, cb);
    };
  }

  function finish() {
    opts.complete(null, {
      results: results,
      last_seq: lastSeq
    });
  }

  function onTxnComplete() {
    if (!opts.continuous && opts.attachments) {
      // cannot guarantee that postProcessing was already done,
      // so do it again
      postProcessAttachments(results).then(finish);
    } else {
      finish();
    }
  }

  var objectStores = [DOC_STORE, BY_SEQ_STORE];
  if (opts.attachments) {
    objectStores.push(ATTACH_STORE);
  }
  var txnResult = openTransactionSafely(idb, objectStores, 'readonly');
  if (txnResult.error) {
    return opts.complete(txnResult.error);
  }
  txn = txnResult.txn;
  txn.onabort = idbError(opts.complete);
  txn.oncomplete = onTxnComplete;

  bySeqStore = txn.objectStore(BY_SEQ_STORE);
  docStore = txn.objectStore(DOC_STORE);
  docIdRevIndex = bySeqStore.index('_doc_id_rev');

  var keyRange = (opts.since && !opts.descending) ?
    IDBKeyRange.lowerBound(opts.since, true) : null;

  runBatchedCursor(bySeqStore, keyRange, opts.descending, limit, onBatch);
}

var cachedDBs = new ExportedMap();
var blobSupportPromise;
var openReqList = new ExportedMap();

function IdbPouch(opts, callback) {
  var api = this;

  enqueueTask(function (thisCallback) {
    init(api, opts, thisCallback);
  }, callback, api.constructor);
}

function init(api, opts, callback) {

  var dbName = opts.name;

  var idb = null;
  api._meta = null;

  // called when creating a fresh new database
  function createSchema(db) {
    var docStore = db.createObjectStore(DOC_STORE, {keyPath : 'id'});
    db.createObjectStore(BY_SEQ_STORE, {autoIncrement: true})
      .createIndex('_doc_id_rev', '_doc_id_rev', {unique: true});
    db.createObjectStore(ATTACH_STORE, {keyPath: 'digest'});
    db.createObjectStore(META_STORE, {keyPath: 'id', autoIncrement: false});
    db.createObjectStore(DETECT_BLOB_SUPPORT_STORE);

    // added in v2
    docStore.createIndex('deletedOrLocal', 'deletedOrLocal', {unique : false});

    // added in v3
    db.createObjectStore(LOCAL_STORE, {keyPath: '_id'});

    // added in v4
    var attAndSeqStore = db.createObjectStore(ATTACH_AND_SEQ_STORE,
      {autoIncrement: true});
    attAndSeqStore.createIndex('seq', 'seq');
    attAndSeqStore.createIndex('digestSeq', 'digestSeq', {unique: true});
  }

  // migration to version 2
  // unfortunately "deletedOrLocal" is a misnomer now that we no longer
  // store local docs in the main doc-store, but whaddyagonnado
  function addDeletedOrLocalIndex(txn, callback) {
    var docStore = txn.objectStore(DOC_STORE);
    docStore.createIndex('deletedOrLocal', 'deletedOrLocal', {unique : false});

    docStore.openCursor().onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        var metadata = cursor.value;
        var deleted = isDeleted(metadata);
        metadata.deletedOrLocal = deleted ? "1" : "0";
        docStore.put(metadata);
        cursor.continue();
      } else {
        callback();
      }
    };
  }

  // migration to version 3 (part 1)
  function createLocalStoreSchema(db) {
    db.createObjectStore(LOCAL_STORE, {keyPath: '_id'})
      .createIndex('_doc_id_rev', '_doc_id_rev', {unique: true});
  }

  // migration to version 3 (part 2)
  function migrateLocalStore(txn, cb) {
    var localStore = txn.objectStore(LOCAL_STORE);
    var docStore = txn.objectStore(DOC_STORE);
    var seqStore = txn.objectStore(BY_SEQ_STORE);

    var cursor = docStore.openCursor();
    cursor.onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        var metadata = cursor.value;
        var docId = metadata.id;
        var local = isLocalId(docId);
        var rev = winningRev(metadata);
        if (local) {
          var docIdRev = docId + "::" + rev;
          // remove all seq entries
          // associated with this docId
          var start = docId + "::";
          var end = docId + "::~";
          var index = seqStore.index('_doc_id_rev');
          var range = IDBKeyRange.bound(start, end, false, false);
          var seqCursor = index.openCursor(range);
          seqCursor.onsuccess = function (e) {
            seqCursor = e.target.result;
            if (!seqCursor) {
              // done
              docStore.delete(cursor.primaryKey);
              cursor.continue();
            } else {
              var data = seqCursor.value;
              if (data._doc_id_rev === docIdRev) {
                localStore.put(data);
              }
              seqStore.delete(seqCursor.primaryKey);
              seqCursor.continue();
            }
          };
        } else {
          cursor.continue();
        }
      } else if (cb) {
        cb();
      }
    };
  }

  // migration to version 4 (part 1)
  function addAttachAndSeqStore(db) {
    var attAndSeqStore = db.createObjectStore(ATTACH_AND_SEQ_STORE,
      {autoIncrement: true});
    attAndSeqStore.createIndex('seq', 'seq');
    attAndSeqStore.createIndex('digestSeq', 'digestSeq', {unique: true});
  }

  // migration to version 4 (part 2)
  function migrateAttsAndSeqs(txn, callback) {
    var seqStore = txn.objectStore(BY_SEQ_STORE);
    var attStore = txn.objectStore(ATTACH_STORE);
    var attAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);

    // need to actually populate the table. this is the expensive part,
    // so as an optimization, check first that this database even
    // contains attachments
    var req = attStore.count();
    req.onsuccess = function (e) {
      var count = e.target.result;
      if (!count) {
        return callback(); // done
      }

      seqStore.openCursor().onsuccess = function (e) {
        var cursor = e.target.result;
        if (!cursor) {
          return callback(); // done
        }
        var doc = cursor.value;
        var seq = cursor.primaryKey;
        var atts = Object.keys(doc._attachments || {});
        var digestMap = {};
        for (var j = 0; j < atts.length; j++) {
          var att = doc._attachments[atts[j]];
          digestMap[att.digest] = true; // uniq digests, just in case
        }
        var digests = Object.keys(digestMap);
        for (j = 0; j < digests.length; j++) {
          var digest = digests[j];
          attAndSeqStore.put({
            seq: seq,
            digestSeq: digest + '::' + seq
          });
        }
        cursor.continue();
      };
    };
  }

  // migration to version 5
  // Instead of relying on on-the-fly migration of metadata,
  // this brings the doc-store to its modern form:
  // - metadata.winningrev
  // - metadata.seq
  // - stringify the metadata when storing it
  function migrateMetadata(txn) {

    function decodeMetadataCompat(storedObject) {
      if (!storedObject.data) {
        // old format, when we didn't store it stringified
        storedObject.deleted = storedObject.deletedOrLocal === '1';
        return storedObject;
      }
      return decodeMetadata(storedObject);
    }

    // ensure that every metadata has a winningRev and seq,
    // which was previously created on-the-fly but better to migrate
    var bySeqStore = txn.objectStore(BY_SEQ_STORE);
    var docStore = txn.objectStore(DOC_STORE);
    var cursor = docStore.openCursor();
    cursor.onsuccess = function (e) {
      var cursor = e.target.result;
      if (!cursor) {
        return; // done
      }
      var metadata = decodeMetadataCompat(cursor.value);

      metadata.winningRev = metadata.winningRev ||
        winningRev(metadata);

      function fetchMetadataSeq() {
        // metadata.seq was added post-3.2.0, so if it's missing,
        // we need to fetch it manually
        var start = metadata.id + '::';
        var end = metadata.id + '::\uffff';
        var req = bySeqStore.index('_doc_id_rev').openCursor(
          IDBKeyRange.bound(start, end));

        var metadataSeq = 0;
        req.onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) {
            metadata.seq = metadataSeq;
            return onGetMetadataSeq();
          }
          var seq = cursor.primaryKey;
          if (seq > metadataSeq) {
            metadataSeq = seq;
          }
          cursor.continue();
        };
      }

      function onGetMetadataSeq() {
        var metadataToStore = encodeMetadata(metadata,
          metadata.winningRev, metadata.deleted);

        var req = docStore.put(metadataToStore);
        req.onsuccess = function () {
          cursor.continue();
        };
      }

      if (metadata.seq) {
        return onGetMetadataSeq();
      }

      fetchMetadataSeq();
    };

  }

  api._remote = false;
  api.type = function () {
    return 'idb';
  };

  api._id = toPromise(function (callback) {
    callback(null, api._meta.instanceId);
  });

  api._bulkDocs = function idb_bulkDocs(req, reqOpts, callback) {
    idbBulkDocs(opts, req, reqOpts, api, idb, callback);
  };

  // First we look up the metadata in the ids database, then we fetch the
  // current revision(s) from the by sequence store
  api._get = function idb_get(id, opts, callback) {
    var doc;
    var metadata;
    var err;
    var txn = opts.ctx;
    if (!txn) {
      var txnResult = openTransactionSafely(idb,
        [DOC_STORE, BY_SEQ_STORE, ATTACH_STORE], 'readonly');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      txn = txnResult.txn;
    }

    function finish() {
      callback(err, {doc: doc, metadata: metadata, ctx: txn});
    }

    txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {
      metadata = decodeMetadata(e.target.result);
      // we can determine the result here if:
      // 1. there is no such document
      // 2. the document is deleted and we don't ask about specific rev
      // When we ask with opts.rev we expect the answer to be either
      // doc (possibly with _deleted=true) or missing error
      if (!metadata) {
        err = createError(MISSING_DOC, 'missing');
        return finish();
      }

      var rev;
      if (!opts.rev) {
        rev = metadata.winningRev;
        var deleted = isDeleted(metadata);
        if (deleted) {
          err = createError(MISSING_DOC, "deleted");
          return finish();
        }
      } else {
        rev = opts.latest ? latest(opts.rev, metadata) : opts.rev;
      }

      var objectStore = txn.objectStore(BY_SEQ_STORE);
      var key = metadata.id + '::' + rev;

      objectStore.index('_doc_id_rev').get(key).onsuccess = function (e) {
        doc = e.target.result;
        if (doc) {
          doc = decodeDoc(doc);
        }
        if (!doc) {
          err = createError(MISSING_DOC, 'missing');
          return finish();
        }
        finish();
      };
    };
  };

  api._getAttachment = function (docId, attachId, attachment, opts, callback) {
    var txn;
    if (opts.ctx) {
      txn = opts.ctx;
    } else {
      var txnResult = openTransactionSafely(idb,
        [DOC_STORE, BY_SEQ_STORE, ATTACH_STORE], 'readonly');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      txn = txnResult.txn;
    }
    var digest = attachment.digest;
    var type = attachment.content_type;

    txn.objectStore(ATTACH_STORE).get(digest).onsuccess = function (e) {
      var body = e.target.result.body;
      readBlobData(body, type, opts.binary, function (blobData) {
        callback(null, blobData);
      });
    };
  };

  api._info = function idb_info(callback) {
    var updateSeq;
    var docCount;

    var txnResult = openTransactionSafely(idb, [META_STORE, BY_SEQ_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    var txn = txnResult.txn;
    txn.objectStore(META_STORE).get(META_STORE).onsuccess = function (e) {
      docCount = e.target.result.docCount;
    };
    txn.objectStore(BY_SEQ_STORE).openCursor(null, 'prev').onsuccess = function (e) {
      var cursor = e.target.result;
      updateSeq = cursor ? cursor.key : 0;
    };

    txn.oncomplete = function () {
      callback(null, {
        doc_count: docCount,
        update_seq: updateSeq,
        // for debugging
        idb_attachment_format: (api._meta.blobSupport ? 'binary' : 'base64')
      });
    };
  };

  api._allDocs = function idb_allDocs(opts, callback) {
    idbAllDocs(opts, idb, callback);
  };

  api._changes = function idbChanges(opts) {
    changes(opts, api, dbName, idb);
  };

  api._close = function (callback) {
    // https://developer.mozilla.org/en-US/docs/IndexedDB/IDBDatabase#close
    // "Returns immediately and closes the connection in a separate thread..."
    idb.close();
    cachedDBs.delete(dbName);
    callback();
  };

  api._getRevisionTree = function (docId, callback) {
    var txnResult = openTransactionSafely(idb, [DOC_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    var txn = txnResult.txn;
    var req = txn.objectStore(DOC_STORE).get(docId);
    req.onsuccess = function (event) {
      var doc = decodeMetadata(event.target.result);
      if (!doc) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, doc.rev_tree);
      }
    };
  };

  // This function removes revisions of document docId
  // which are listed in revs and sets this document
  // revision to to rev_tree
  api._doCompaction = function (docId, revs, callback) {
    var stores = [
      DOC_STORE,
      BY_SEQ_STORE,
      ATTACH_STORE,
      ATTACH_AND_SEQ_STORE
    ];
    var txnResult = openTransactionSafely(idb, stores, 'readwrite');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    var txn = txnResult.txn;

    var docStore = txn.objectStore(DOC_STORE);

    docStore.get(docId).onsuccess = function (event) {
      var metadata = decodeMetadata(event.target.result);
      traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
                                                         revHash, ctx, opts) {
        var rev = pos + '-' + revHash;
        if (revs.indexOf(rev) !== -1) {
          opts.status = 'missing';
        }
      });
      compactRevs(revs, docId, txn);
      var winningRev$$1 = metadata.winningRev;
      var deleted = metadata.deleted;
      txn.objectStore(DOC_STORE).put(
        encodeMetadata(metadata, winningRev$$1, deleted));
    };
    txn.onabort = idbError(callback);
    txn.oncomplete = function () {
      callback();
    };
  };


  api._getLocal = function (id, callback) {
    var txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    var tx = txnResult.txn;
    var req = tx.objectStore(LOCAL_STORE).get(id);

    req.onerror = idbError(callback);
    req.onsuccess = function (e) {
      var doc = e.target.result;
      if (!doc) {
        callback(createError(MISSING_DOC));
      } else {
        delete doc['_doc_id_rev']; // for backwards compat
        callback(null, doc);
      }
    };
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    delete doc._revisions; // ignore this, trust the rev
    var oldRev = doc._rev;
    var id = doc._id;
    if (!oldRev) {
      doc._rev = '0-1';
    } else {
      doc._rev = '0-' + (parseInt(oldRev.split('-')[1], 10) + 1);
    }

    var tx = opts.ctx;
    var ret;
    if (!tx) {
      var txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readwrite');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      tx = txnResult.txn;
      tx.onerror = idbError(callback);
      tx.oncomplete = function () {
        if (ret) {
          callback(null, ret);
        }
      };
    }

    var oStore = tx.objectStore(LOCAL_STORE);
    var req;
    if (oldRev) {
      req = oStore.get(id);
      req.onsuccess = function (e) {
        var oldDoc = e.target.result;
        if (!oldDoc || oldDoc._rev !== oldRev) {
          callback(createError(REV_CONFLICT));
        } else { // update
          var req = oStore.put(doc);
          req.onsuccess = function () {
            ret = {ok: true, id: doc._id, rev: doc._rev};
            if (opts.ctx) { // return immediately
              callback(null, ret);
            }
          };
        }
      };
    } else { // new doc
      req = oStore.add(doc);
      req.onerror = function (e) {
        // constraint error, already exists
        callback(createError(REV_CONFLICT));
        e.preventDefault(); // avoid transaction abort
        e.stopPropagation(); // avoid transaction onerror
      };
      req.onsuccess = function () {
        ret = {ok: true, id: doc._id, rev: doc._rev};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      };
    }
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var tx = opts.ctx;
    if (!tx) {
      var txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readwrite');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      tx = txnResult.txn;
      tx.oncomplete = function () {
        if (ret) {
          callback(null, ret);
        }
      };
    }
    var ret;
    var id = doc._id;
    var oStore = tx.objectStore(LOCAL_STORE);
    var req = oStore.get(id);

    req.onerror = idbError(callback);
    req.onsuccess = function (e) {
      var oldDoc = e.target.result;
      if (!oldDoc || oldDoc._rev !== doc._rev) {
        callback(createError(MISSING_DOC));
      } else {
        oStore.delete(id);
        ret = {ok: true, id: id, rev: '0-0'};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      }
    };
  };

  api._destroy = function (opts, callback) {
    changesHandler$$1.removeAllListeners(dbName);

    //Close open request for "dbName" database to fix ie delay.
    var openReq = openReqList.get(dbName);
    if (openReq && openReq.result) {
      openReq.result.close();
      cachedDBs.delete(dbName);
    }
    var req = indexedDB.deleteDatabase(dbName);

    req.onsuccess = function () {
      //Remove open request from the list.
      openReqList.delete(dbName);
      if (hasLocalStorage() && (dbName in localStorage)) {
        delete localStorage[dbName];
      }
      callback(null, { 'ok': true });
    };

    req.onerror = idbError(callback);
  };

  var cached = cachedDBs.get(dbName);

  if (cached) {
    idb = cached.idb;
    api._meta = cached.global;
    return nextTick(function () {
      callback(null, api);
    });
  }

  var req;
  if (opts.storage) {
    req = tryStorageOption(dbName, opts.storage);
  } else {
    req = indexedDB.open(dbName, ADAPTER_VERSION);
  }

  openReqList.set(dbName, req);

  req.onupgradeneeded = function (e) {
    var db = e.target.result;
    if (e.oldVersion < 1) {
      return createSchema(db); // new db, initial schema
    }
    // do migrations

    var txn = e.currentTarget.transaction;
    // these migrations have to be done in this function, before
    // control is returned to the event loop, because IndexedDB

    if (e.oldVersion < 3) {
      createLocalStoreSchema(db); // v2 -> v3
    }
    if (e.oldVersion < 4) {
      addAttachAndSeqStore(db); // v3 -> v4
    }

    var migrations = [
      addDeletedOrLocalIndex, // v1 -> v2
      migrateLocalStore,      // v2 -> v3
      migrateAttsAndSeqs,     // v3 -> v4
      migrateMetadata         // v4 -> v5
    ];

    var i = e.oldVersion;

    function next() {
      var migration = migrations[i - 1];
      i++;
      if (migration) {
        migration(txn, next);
      }
    }

    next();
  };

  req.onsuccess = function (e) {

    idb = e.target.result;

    idb.onversionchange = function () {
      idb.close();
      cachedDBs.delete(dbName);
    };

    idb.onabort = function (e) {
      guardedConsole('error', 'Database has a global failure', e.target.error);
      idb.close();
      cachedDBs.delete(dbName);
    };

    // Do a few setup operations (in parallel as much as possible):
    // 1. Fetch meta doc
    // 2. Check blob support
    // 3. Calculate docCount
    // 4. Generate an instanceId if necessary
    // 5. Store docCount and instanceId on meta doc

    var txn = idb.transaction([
      META_STORE,
      DETECT_BLOB_SUPPORT_STORE,
      DOC_STORE
    ], 'readwrite');

    var storedMetaDoc = false;
    var metaDoc;
    var docCount;
    var blobSupport;
    var instanceId;

    function completeSetup() {
      if (typeof blobSupport === 'undefined' || !storedMetaDoc) {
        return;
      }
      api._meta = {
        name: dbName,
        instanceId: instanceId,
        blobSupport: blobSupport
      };

      cachedDBs.set(dbName, {
        idb: idb,
        global: api._meta
      });
      callback(null, api);
    }

    function storeMetaDocIfReady() {
      if (typeof docCount === 'undefined' || typeof metaDoc === 'undefined') {
        return;
      }
      var instanceKey = dbName + '_id';
      if (instanceKey in metaDoc) {
        instanceId = metaDoc[instanceKey];
      } else {
        metaDoc[instanceKey] = instanceId = uuid();
      }
      metaDoc.docCount = docCount;
      txn.objectStore(META_STORE).put(metaDoc);
    }

    //
    // fetch or generate the instanceId
    //
    txn.objectStore(META_STORE).get(META_STORE).onsuccess = function (e) {
      metaDoc = e.target.result || { id: META_STORE };
      storeMetaDocIfReady();
    };

    //
    // countDocs
    //
    countDocs(txn, function (count) {
      docCount = count;
      storeMetaDocIfReady();
    });

    //
    // check blob support
    //
    if (!blobSupportPromise) {
      // make sure blob support is only checked once
      blobSupportPromise = checkBlobSupport(txn);
    }

    blobSupportPromise.then(function (val) {
      blobSupport = val;
      completeSetup();
    });

    // only when the metadata put transaction has completed,
    // consider the setup done
    txn.oncomplete = function () {
      storedMetaDoc = true;
      completeSetup();
    };
  };

  req.onerror = function () {
    var msg = 'Failed to open indexedDB, are you in private browsing mode?';
    guardedConsole('error', msg);
    callback(createError(IDB_ERROR, msg));
  };
}

IdbPouch.valid = function () {
  // Issue #2533, we finally gave up on doing bug
  // detection instead of browser sniffing. Safari brought us
  // to our knees.
  var isSafari = typeof openDatabase !== 'undefined' &&
    /(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent) &&
    !/Chrome/.test(navigator.userAgent) &&
    !/BlackBerry/.test(navigator.platform);

  // some outdated implementations of IDB that appear on Samsung
  // and HTC Android devices <4.4 are missing IDBKeyRange
  return !isSafari && typeof indexedDB !== 'undefined' &&
    typeof IDBKeyRange !== 'undefined';
};

function tryStorageOption(dbName, storage) {
  try { // option only available in Firefox 26+
    return indexedDB.open(dbName, {
      version: ADAPTER_VERSION,
      storage: storage
    });
  } catch (err) {
      return indexedDB.open(dbName, ADAPTER_VERSION);
  }
}

var IDBPouch = function (PouchDB) {
  PouchDB.adapter('idb', IdbPouch, true);
};

//
// Parsing hex strings. Yeah.
//
// So basically we need this because of a bug in WebSQL:
// https://code.google.com/p/chromium/issues/detail?id=422690
// https://bugs.webkit.org/show_bug.cgi?id=137637
//
// UTF-8 and UTF-16 are provided as separate functions
// for meager performance improvements
//

function decodeUtf8(str) {
  return decodeURIComponent(escape(str));
}

function hexToInt(charCode) {
  // '0'-'9' is 48-57
  // 'A'-'F' is 65-70
  // SQLite will only give us uppercase hex
  return charCode < 65 ? (charCode - 48) : (charCode - 55);
}


// Example:
// pragma encoding=utf8;
// select hex('A');
// returns '41'
function parseHexUtf8(str, start, end) {
  var result = '';
  while (start < end) {
    result += String.fromCharCode(
      (hexToInt(str.charCodeAt(start++)) << 4) |
        hexToInt(str.charCodeAt(start++)));
  }
  return result;
}

// Example:
// pragma encoding=utf16;
// select hex('A');
// returns '4100'
// notice that the 00 comes after the 41 (i.e. it's swizzled)
function parseHexUtf16(str, start, end) {
  var result = '';
  while (start < end) {
    // UTF-16, so swizzle the bytes
    result += String.fromCharCode(
      (hexToInt(str.charCodeAt(start + 2)) << 12) |
        (hexToInt(str.charCodeAt(start + 3)) << 8) |
        (hexToInt(str.charCodeAt(start)) << 4) |
        hexToInt(str.charCodeAt(start + 1)));
    start += 4;
  }
  return result;
}

function parseHexString(str, encoding) {
  if (encoding === 'UTF-8') {
    return decodeUtf8(parseHexUtf8(str, 0, str.length));
  } else {
    return parseHexUtf16(str, 0, str.length);
  }
}

function quote(str) {
  return "'" + str + "'";
}

var ADAPTER_VERSION$1 = 7; // used to manage migrations

// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
var DOC_STORE$1 = quote('document-store');
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
var BY_SEQ_STORE$1 = quote('by-sequence');
// Where we store attachments
var ATTACH_STORE$1 = quote('attach-store');
var LOCAL_STORE$1 = quote('local-store');
var META_STORE$1 = quote('metadata-store');
// where we store many-to-many relations between attachment
// digests and seqs
var ATTACH_AND_SEQ_STORE$1 = quote('attach-seq-store');

// escapeBlob and unescapeBlob are workarounds for a websql bug:
// https://code.google.com/p/chromium/issues/detail?id=422690
// https://bugs.webkit.org/show_bug.cgi?id=137637
// The goal is to never actually insert the \u0000 character
// in the database.
function escapeBlob(str) {
  return str
    .replace(/\u0002/g, '\u0002\u0002')
    .replace(/\u0001/g, '\u0001\u0002')
    .replace(/\u0000/g, '\u0001\u0001');
}

function unescapeBlob(str) {
  return str
    .replace(/\u0001\u0001/g, '\u0000')
    .replace(/\u0001\u0002/g, '\u0001')
    .replace(/\u0002\u0002/g, '\u0002');
}

function stringifyDoc(doc) {
  // don't bother storing the id/rev. it uses lots of space,
  // in persistent map/reduce especially
  delete doc._id;
  delete doc._rev;
  return JSON.stringify(doc);
}

function unstringifyDoc(doc, id, rev) {
  doc = JSON.parse(doc);
  doc._id = id;
  doc._rev = rev;
  return doc;
}

// question mark groups IN queries, e.g. 3 -> '(?,?,?)'
function qMarks(num) {
  var s = '(';
  while (num--) {
    s += '?';
    if (num) {
      s += ',';
    }
  }
  return s + ')';
}

function select(selector, table, joiner, where, orderBy) {
  return 'SELECT ' + selector + ' FROM ' +
    (typeof table === 'string' ? table : table.join(' JOIN ')) +
    (joiner ? (' ON ' + joiner) : '') +
    (where ? (' WHERE ' +
    (typeof where === 'string' ? where : where.join(' AND '))) : '') +
    (orderBy ? (' ORDER BY ' + orderBy) : '');
}

function compactRevs$1(revs, docId, tx) {

  if (!revs.length) {
    return;
  }

  var numDone = 0;
  var seqs = [];

  function checkDone() {
    if (++numDone === revs.length) { // done
      deleteOrphans();
    }
  }

  function deleteOrphans() {
    // find orphaned attachment digests

    if (!seqs.length) {
      return;
    }

    var sql = 'SELECT DISTINCT digest AS digest FROM ' +
      ATTACH_AND_SEQ_STORE$1 + ' WHERE seq IN ' + qMarks(seqs.length);

    tx.executeSql(sql, seqs, function (tx, res) {

      var digestsToCheck = [];
      for (var i = 0; i < res.rows.length; i++) {
        digestsToCheck.push(res.rows.item(i).digest);
      }
      if (!digestsToCheck.length) {
        return;
      }

      var sql = 'DELETE FROM ' + ATTACH_AND_SEQ_STORE$1 +
        ' WHERE seq IN (' +
        seqs.map(function () { return '?'; }).join(',') +
        ')';
      tx.executeSql(sql, seqs, function (tx) {

        var sql = 'SELECT digest FROM ' + ATTACH_AND_SEQ_STORE$1 +
          ' WHERE digest IN (' +
          digestsToCheck.map(function () { return '?'; }).join(',') +
          ')';
        tx.executeSql(sql, digestsToCheck, function (tx, res) {
          var nonOrphanedDigests = new ExportedSet();
          for (var i = 0; i < res.rows.length; i++) {
            nonOrphanedDigests.add(res.rows.item(i).digest);
          }
          digestsToCheck.forEach(function (digest) {
            if (nonOrphanedDigests.has(digest)) {
              return;
            }
            tx.executeSql(
              'DELETE FROM ' + ATTACH_AND_SEQ_STORE$1 + ' WHERE digest=?',
              [digest]);
            tx.executeSql(
              'DELETE FROM ' + ATTACH_STORE$1 + ' WHERE digest=?', [digest]);
          });
        });
      });
    });
  }

  // update by-seq and attach stores in parallel
  revs.forEach(function (rev) {
    var sql = 'SELECT seq FROM ' + BY_SEQ_STORE$1 +
      ' WHERE doc_id=? AND rev=?';

    tx.executeSql(sql, [docId, rev], function (tx, res) {
      if (!res.rows.length) { // already deleted
        return checkDone();
      }
      var seq = res.rows.item(0).seq;
      seqs.push(seq);

      tx.executeSql(
        'DELETE FROM ' + BY_SEQ_STORE$1 + ' WHERE seq=?', [seq], checkDone);
    });
  });
}

function websqlError(callback) {
  return function (event) {
    guardedConsole('error', 'WebSQL threw an error', event);
    // event may actually be a SQLError object, so report is as such
    var errorNameMatch = event && event.constructor.toString()
        .match(/function ([^\(]+)/);
    var errorName = (errorNameMatch && errorNameMatch[1]) || event.type;
    var errorReason = event.target || event.message;
    callback(createError(WSQ_ERROR, errorReason, errorName));
  };
}

function getSize(opts) {
  if ('size' in opts) {
    // triggers immediate popup in iOS, fixes #2347
    // e.g. 5000001 asks for 5 MB, 10000001 asks for 10 MB,
    return opts.size * 1000000;
  }
  // In iOS, doesn't matter as long as it's <= 5000000.
  // Except that if you request too much, our tests fail
  // because of the native "do you accept?" popup.
  // In Android <=4.3, this value is actually used as an
  // honest-to-god ceiling for data, so we need to
  // set it to a decently high number.
  var isAndroid = typeof navigator !== 'undefined' &&
    /Android/.test(navigator.userAgent);
  return isAndroid ? 5000000 : 1; // in PhantomJS, if you use 0 it will crash
}

function websqlBulkDocs(dbOpts, req, opts, api, db, websqlChanges, callback) {
  var newEdits = opts.new_edits;
  var userDocs = req.docs;

  // Parse the docs, give them a sequence number for the result
  var docInfos = userDocs.map(function (doc) {
    if (doc._id && isLocalId(doc._id)) {
      return doc;
    }
    var newDoc = parseDoc(doc, newEdits);
    return newDoc;
  });

  var docInfoErrors = docInfos.filter(function (docInfo) {
    return docInfo.error;
  });
  if (docInfoErrors.length) {
    return callback(docInfoErrors[0]);
  }

  var tx;
  var results = new Array(docInfos.length);
  var fetchedDocs = new ExportedMap();

  var preconditionErrored;
  function complete() {
    if (preconditionErrored) {
      return callback(preconditionErrored);
    }
    websqlChanges.notify(api._name);
    callback(null, results);
  }

  function verifyAttachment(digest, callback) {
    var sql = 'SELECT count(*) as cnt FROM ' + ATTACH_STORE$1 +
      ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      if (result.rows.item(0).cnt === 0) {
        var err = createError(MISSING_STUB,
          'unknown stub attachment with digest ' +
          digest);
        callback(err);
      } else {
        callback();
      }
    });
  }

  function verifyAttachments(finish) {
    var digests = [];
    docInfos.forEach(function (docInfo) {
      if (docInfo.data && docInfo.data._attachments) {
        Object.keys(docInfo.data._attachments).forEach(function (filename) {
          var att = docInfo.data._attachments[filename];
          if (att.stub) {
            digests.push(att.digest);
          }
        });
      }
    });
    if (!digests.length) {
      return finish();
    }
    var numDone = 0;
    var err;

    function checkDone() {
      if (++numDone === digests.length) {
        finish(err);
      }
    }
    digests.forEach(function (digest) {
      verifyAttachment(digest, function (attErr) {
        if (attErr && !err) {
          err = attErr;
        }
        checkDone();
      });
    });
  }

  function writeDoc(docInfo, winningRev$$1, winningRevIsDeleted, newRevIsDeleted,
                    isUpdate, delta, resultsIdx, callback) {

    function finish() {
      var data = docInfo.data;
      var deletedInt = newRevIsDeleted ? 1 : 0;

      var id = data._id;
      var rev = data._rev;
      var json = stringifyDoc(data);
      var sql = 'INSERT INTO ' + BY_SEQ_STORE$1 +
        ' (doc_id, rev, json, deleted) VALUES (?, ?, ?, ?);';
      var sqlArgs = [id, rev, json, deletedInt];

      // map seqs to attachment digests, which
      // we will need later during compaction
      function insertAttachmentMappings(seq, callback) {
        var attsAdded = 0;
        var attsToAdd = Object.keys(data._attachments || {});

        if (!attsToAdd.length) {
          return callback();
        }
        function checkDone() {
          if (++attsAdded === attsToAdd.length) {
            callback();
          }
          return false; // ack handling a constraint error
        }
        function add(att) {
          var sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE$1 +
            ' (digest, seq) VALUES (?,?)';
          var sqlArgs = [data._attachments[att].digest, seq];
          tx.executeSql(sql, sqlArgs, checkDone, checkDone);
          // second callback is for a constaint error, which we ignore
          // because this docid/rev has already been associated with
          // the digest (e.g. when new_edits == false)
        }
        for (var i = 0; i < attsToAdd.length; i++) {
          add(attsToAdd[i]); // do in parallel
        }
      }

      tx.executeSql(sql, sqlArgs, function (tx, result) {
        var seq = result.insertId;
        insertAttachmentMappings(seq, function () {
          dataWritten(tx, seq);
        });
      }, function () {
        // constraint error, recover by updating instead (see #1638)
        var fetchSql = select('seq', BY_SEQ_STORE$1, null,
          'doc_id=? AND rev=?');
        tx.executeSql(fetchSql, [id, rev], function (tx, res) {
          var seq = res.rows.item(0).seq;
          var sql = 'UPDATE ' + BY_SEQ_STORE$1 +
            ' SET json=?, deleted=? WHERE doc_id=? AND rev=?;';
          var sqlArgs = [json, deletedInt, id, rev];
          tx.executeSql(sql, sqlArgs, function (tx) {
            insertAttachmentMappings(seq, function () {
              dataWritten(tx, seq);
            });
          });
        });
        return false; // ack that we've handled the error
      });
    }

    function collectResults(attachmentErr) {
      if (!err) {
        if (attachmentErr) {
          err = attachmentErr;
          callback(err);
        } else if (recv === attachments.length) {
          finish();
        }
      }
    }

    var err = null;
    var recv = 0;

    docInfo.data._id = docInfo.metadata.id;
    docInfo.data._rev = docInfo.metadata.rev;
    var attachments = Object.keys(docInfo.data._attachments || {});


    if (newRevIsDeleted) {
      docInfo.data._deleted = true;
    }

    function attachmentSaved(err) {
      recv++;
      collectResults(err);
    }

    attachments.forEach(function (key) {
      var att = docInfo.data._attachments[key];
      if (!att.stub) {
        var data = att.data;
        delete att.data;
        att.revpos = parseInt(winningRev$$1, 10);
        var digest = att.digest;
        saveAttachment(digest, data, attachmentSaved);
      } else {
        recv++;
        collectResults();
      }
    });

    if (!attachments.length) {
      finish();
    }

    function dataWritten(tx, seq) {
      var id = docInfo.metadata.id;

      var revsToCompact = docInfo.stemmedRevs || [];
      if (isUpdate && api.auto_compaction) {
        revsToCompact = compactTree(docInfo.metadata).concat(revsToCompact);
      }
      if (revsToCompact.length) {
        compactRevs$1(revsToCompact, id, tx);
      }

      docInfo.metadata.seq = seq;
      var rev = docInfo.metadata.rev;
      delete docInfo.metadata.rev;

      var sql = isUpdate ?
      'UPDATE ' + DOC_STORE$1 +
      ' SET json=?, max_seq=?, winningseq=' +
      '(SELECT seq FROM ' + BY_SEQ_STORE$1 +
      ' WHERE doc_id=' + DOC_STORE$1 + '.id AND rev=?) WHERE id=?'
        : 'INSERT INTO ' + DOC_STORE$1 +
      ' (id, winningseq, max_seq, json) VALUES (?,?,?,?);';
      var metadataStr = safeJsonStringify(docInfo.metadata);
      var params = isUpdate ?
        [metadataStr, seq, winningRev$$1, id] :
        [id, seq, seq, metadataStr];
      tx.executeSql(sql, params, function () {
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: rev
        };
        fetchedDocs.set(id, docInfo.metadata);
        callback();
      });
    }
  }

  function websqlProcessDocs() {
    processDocs(dbOpts.revs_limit, docInfos, api, fetchedDocs, tx,
                results, writeDoc, opts);
  }

  function fetchExistingDocs(callback) {
    if (!docInfos.length) {
      return callback();
    }

    var numFetched = 0;

    function checkDone() {
      if (++numFetched === docInfos.length) {
        callback();
      }
    }

    docInfos.forEach(function (docInfo) {
      if (docInfo._id && isLocalId(docInfo._id)) {
        return checkDone(); // skip local docs
      }
      var id = docInfo.metadata.id;
      tx.executeSql('SELECT json FROM ' + DOC_STORE$1 +
      ' WHERE id = ?', [id], function (tx, result) {
        if (result.rows.length) {
          var metadata = safeJsonParse(result.rows.item(0).json);
          fetchedDocs.set(id, metadata);
        }
        checkDone();
      });
    });
  }

  function saveAttachment(digest, data, callback) {
    var sql = 'SELECT digest FROM ' + ATTACH_STORE$1 + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      if (result.rows.length) { // attachment already exists
        return callback();
      }
      // we could just insert before selecting and catch the error,
      // but my hunch is that it's cheaper not to serialize the blob
      // from JS to C if we don't have to (TODO: confirm this)
      sql = 'INSERT INTO ' + ATTACH_STORE$1 +
      ' (digest, body, escaped) VALUES (?,?,1)';
      tx.executeSql(sql, [digest, escapeBlob(data)], function () {
        callback();
      }, function () {
        // ignore constaint errors, means it already exists
        callback();
        return false; // ack we handled the error
      });
    });
  }

  preprocessAttachments(docInfos, 'binary', function (err) {
    if (err) {
      return callback(err);
    }
    db.transaction(function (txn) {
      tx = txn;
      verifyAttachments(function (err) {
        if (err) {
          preconditionErrored = err;
        } else {
          fetchExistingDocs(websqlProcessDocs);
        }
      });
    }, websqlError(callback), complete);
  });
}

var cachedDatabases = new ExportedMap();

// openDatabase passed in through opts (e.g. for node-websql)
function openDatabaseWithOpts(opts) {
  return opts.websql(opts.name, opts.version, opts.description, opts.size);
}

function openDBSafely(opts) {
  try {
    return {
      db: openDatabaseWithOpts(opts)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

function openDB$1(opts) {
  var cachedResult = cachedDatabases.get(opts.name);
  if (!cachedResult) {
    cachedResult = openDBSafely(opts);
    cachedDatabases.set(opts.name, cachedResult);
  }
  return cachedResult;
}

var websqlChanges = new Changes();

function fetchAttachmentsIfNecessary$1(doc, opts, api, txn, cb) {
  var attachments = Object.keys(doc._attachments || {});
  if (!attachments.length) {
    return cb && cb();
  }
  var numDone = 0;

  function checkDone() {
    if (++numDone === attachments.length && cb) {
      cb();
    }
  }

  function fetchAttachment(doc, att) {
    var attObj = doc._attachments[att];
    var attOpts = {binary: opts.binary, ctx: txn};
    api._getAttachment(doc._id, att, attObj, attOpts, function (_, data) {
      doc._attachments[att] = $inject_Object_assign(
        pick(attObj, ['digest', 'content_type']),
        { data: data }
      );
      checkDone();
    });
  }

  attachments.forEach(function (att) {
    if (opts.attachments && opts.include_docs) {
      fetchAttachment(doc, att);
    } else {
      doc._attachments[att].stub = true;
      checkDone();
    }
  });
}

var POUCH_VERSION = 1;

// these indexes cover the ground for most allDocs queries
var BY_SEQ_STORE_DELETED_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'by-seq-deleted-idx\' ON ' +
  BY_SEQ_STORE$1 + ' (seq, deleted)';
var BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'by-seq-doc-id-rev\' ON ' +
    BY_SEQ_STORE$1 + ' (doc_id, rev)';
var DOC_STORE_WINNINGSEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'doc-winningseq-idx\' ON ' +
  DOC_STORE$1 + ' (winningseq)';
var ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'attach-seq-seq-idx\' ON ' +
    ATTACH_AND_SEQ_STORE$1 + ' (seq)';
var ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'attach-seq-digest-idx\' ON ' +
    ATTACH_AND_SEQ_STORE$1 + ' (digest, seq)';

var DOC_STORE_AND_BY_SEQ_JOINER = BY_SEQ_STORE$1 +
  '.seq = ' + DOC_STORE$1 + '.winningseq';

var SELECT_DOCS = BY_SEQ_STORE$1 + '.seq AS seq, ' +
  BY_SEQ_STORE$1 + '.deleted AS deleted, ' +
  BY_SEQ_STORE$1 + '.json AS data, ' +
  BY_SEQ_STORE$1 + '.rev AS rev, ' +
  DOC_STORE$1 + '.json AS metadata';

function WebSqlPouch$1(opts, callback) {
  var api = this;
  var instanceId = null;
  var size = getSize(opts);
  var idRequests = [];
  var encoding;

  api._name = opts.name;

  // extend the options here, because sqlite plugin has a ton of options
  // and they are constantly changing, so it's more prudent to allow anything
  var websqlOpts = $inject_Object_assign({}, opts, {
    version: POUCH_VERSION,
    description: opts.name,
    size: size
  });
  var openDBResult = openDB$1(websqlOpts);
  if (openDBResult.error) {
    return websqlError(callback)(openDBResult.error);
  }
  var db = openDBResult.db;
  if (typeof db.readTransaction !== 'function') {
    // doesn't exist in sqlite plugin
    db.readTransaction = db.transaction;
  }

  function dbCreated() {
    // note the db name in case the browser upgrades to idb
    if (hasLocalStorage()) {
      window.localStorage['_pouch__websqldb_' + api._name] = true;
    }
    callback(null, api);
  }

  // In this migration, we added the 'deleted' and 'local' columns to the
  // by-seq and doc store tables.
  // To preserve existing user data, we re-process all the existing JSON
  // and add these values.
  // Called migration2 because it corresponds to adapter version (db_version) #2
  function runMigration2(tx, callback) {
    // index used for the join in the allDocs query
    tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);

    tx.executeSql('ALTER TABLE ' + BY_SEQ_STORE$1 +
      ' ADD COLUMN deleted TINYINT(1) DEFAULT 0', [], function () {
      tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
      tx.executeSql('ALTER TABLE ' + DOC_STORE$1 +
        ' ADD COLUMN local TINYINT(1) DEFAULT 0', [], function () {
        tx.executeSql('CREATE INDEX IF NOT EXISTS \'doc-store-local-idx\' ON ' +
          DOC_STORE$1 + ' (local, id)');

        var sql = 'SELECT ' + DOC_STORE$1 + '.winningseq AS seq, ' + DOC_STORE$1 +
          '.json AS metadata FROM ' + BY_SEQ_STORE$1 + ' JOIN ' + DOC_STORE$1 +
          ' ON ' + BY_SEQ_STORE$1 + '.seq = ' + DOC_STORE$1 + '.winningseq';

        tx.executeSql(sql, [], function (tx, result) {

          var deleted = [];
          var local = [];

          for (var i = 0; i < result.rows.length; i++) {
            var item = result.rows.item(i);
            var seq = item.seq;
            var metadata = JSON.parse(item.metadata);
            if (isDeleted(metadata)) {
              deleted.push(seq);
            }
            if (isLocalId(metadata.id)) {
              local.push(metadata.id);
            }
          }
          tx.executeSql('UPDATE ' + DOC_STORE$1 + 'SET local = 1 WHERE id IN ' +
            qMarks(local.length), local, function () {
            tx.executeSql('UPDATE ' + BY_SEQ_STORE$1 +
              ' SET deleted = 1 WHERE seq IN ' +
              qMarks(deleted.length), deleted, callback);
          });
        });
      });
    });
  }

  // in this migration, we make all the local docs unversioned
  function runMigration3(tx, callback) {
    var local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE$1 +
      ' (id UNIQUE, rev, json)';
    tx.executeSql(local, [], function () {
      var sql = 'SELECT ' + DOC_STORE$1 + '.id AS id, ' +
        BY_SEQ_STORE$1 + '.json AS data ' +
        'FROM ' + BY_SEQ_STORE$1 + ' JOIN ' +
        DOC_STORE$1 + ' ON ' + BY_SEQ_STORE$1 + '.seq = ' +
        DOC_STORE$1 + '.winningseq WHERE local = 1';
      tx.executeSql(sql, [], function (tx, res) {
        var rows = [];
        for (var i = 0; i < res.rows.length; i++) {
          rows.push(res.rows.item(i));
        }
        function doNext() {
          if (!rows.length) {
            return callback(tx);
          }
          var row = rows.shift();
          var rev = JSON.parse(row.data)._rev;
          tx.executeSql('INSERT INTO ' + LOCAL_STORE$1 +
              ' (id, rev, json) VALUES (?,?,?)',
              [row.id, rev, row.data], function (tx) {
            tx.executeSql('DELETE FROM ' + DOC_STORE$1 + ' WHERE id=?',
                [row.id], function (tx) {
              tx.executeSql('DELETE FROM ' + BY_SEQ_STORE$1 + ' WHERE seq=?',
                  [row.seq], function () {
                doNext();
              });
            });
          });
        }
        doNext();
      });
    });
  }

  // in this migration, we remove doc_id_rev and just use rev
  function runMigration4(tx, callback) {

    function updateRows(rows) {
      function doNext() {
        if (!rows.length) {
          return callback(tx);
        }
        var row = rows.shift();
        var doc_id_rev = parseHexString(row.hex, encoding);
        var idx = doc_id_rev.lastIndexOf('::');
        var doc_id = doc_id_rev.substring(0, idx);
        var rev = doc_id_rev.substring(idx + 2);
        var sql = 'UPDATE ' + BY_SEQ_STORE$1 +
          ' SET doc_id=?, rev=? WHERE doc_id_rev=?';
        tx.executeSql(sql, [doc_id, rev, doc_id_rev], function () {
          doNext();
        });
      }
      doNext();
    }

    var sql = 'ALTER TABLE ' + BY_SEQ_STORE$1 + ' ADD COLUMN doc_id';
    tx.executeSql(sql, [], function (tx) {
      var sql = 'ALTER TABLE ' + BY_SEQ_STORE$1 + ' ADD COLUMN rev';
      tx.executeSql(sql, [], function (tx) {
        tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL, [], function (tx) {
          var sql = 'SELECT hex(doc_id_rev) as hex FROM ' + BY_SEQ_STORE$1;
          tx.executeSql(sql, [], function (tx, res) {
            var rows = [];
            for (var i = 0; i < res.rows.length; i++) {
              rows.push(res.rows.item(i));
            }
            updateRows(rows);
          });
        });
      });
    });
  }

  // in this migration, we add the attach_and_seq table
  // for issue #2818
  function runMigration5(tx, callback) {

    function migrateAttsAndSeqs(tx) {
      // need to actually populate the table. this is the expensive part,
      // so as an optimization, check first that this database even
      // contains attachments
      var sql = 'SELECT COUNT(*) AS cnt FROM ' + ATTACH_STORE$1;
      tx.executeSql(sql, [], function (tx, res) {
        var count = res.rows.item(0).cnt;
        if (!count) {
          return callback(tx);
        }

        var offset = 0;
        var pageSize = 10;
        function nextPage() {
          var sql = select(
            SELECT_DOCS + ', ' + DOC_STORE$1 + '.id AS id',
            [DOC_STORE$1, BY_SEQ_STORE$1],
            DOC_STORE_AND_BY_SEQ_JOINER,
            null,
            DOC_STORE$1 + '.id '
          );
          sql += ' LIMIT ' + pageSize + ' OFFSET ' + offset;
          offset += pageSize;
          tx.executeSql(sql, [], function (tx, res) {
            if (!res.rows.length) {
              return callback(tx);
            }
            var digestSeqs = {};
            function addDigestSeq(digest, seq) {
              // uniq digest/seq pairs, just in case there are dups
              var seqs = digestSeqs[digest] = (digestSeqs[digest] || []);
              if (seqs.indexOf(seq) === -1) {
                seqs.push(seq);
              }
            }
            for (var i = 0; i < res.rows.length; i++) {
              var row = res.rows.item(i);
              var doc = unstringifyDoc(row.data, row.id, row.rev);
              var atts = Object.keys(doc._attachments || {});
              for (var j = 0; j < atts.length; j++) {
                var att = doc._attachments[atts[j]];
                addDigestSeq(att.digest, row.seq);
              }
            }
            var digestSeqPairs = [];
            Object.keys(digestSeqs).forEach(function (digest) {
              var seqs = digestSeqs[digest];
              seqs.forEach(function (seq) {
                digestSeqPairs.push([digest, seq]);
              });
            });
            if (!digestSeqPairs.length) {
              return nextPage();
            }
            var numDone = 0;
            digestSeqPairs.forEach(function (pair) {
              var sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE$1 +
                ' (digest, seq) VALUES (?,?)';
              tx.executeSql(sql, pair, function () {
                if (++numDone === digestSeqPairs.length) {
                  nextPage();
                }
              });
            });
          });
        }
        nextPage();
      });
    }

    var attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
      ATTACH_AND_SEQ_STORE$1 + ' (digest, seq INTEGER)';
    tx.executeSql(attachAndRev, [], function (tx) {
      tx.executeSql(
        ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL, [], function (tx) {
          tx.executeSql(
            ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL, [],
            migrateAttsAndSeqs);
        });
    });
  }

  // in this migration, we use escapeBlob() and unescapeBlob()
  // instead of reading out the binary as HEX, which is slow
  function runMigration6(tx, callback) {
    var sql = 'ALTER TABLE ' + ATTACH_STORE$1 +
      ' ADD COLUMN escaped TINYINT(1) DEFAULT 0';
    tx.executeSql(sql, [], callback);
  }

  // issue #3136, in this migration we need a "latest seq" as well
  // as the "winning seq" in the doc store
  function runMigration7(tx, callback) {
    var sql = 'ALTER TABLE ' + DOC_STORE$1 +
      ' ADD COLUMN max_seq INTEGER';
    tx.executeSql(sql, [], function (tx) {
      var sql = 'UPDATE ' + DOC_STORE$1 + ' SET max_seq=(SELECT MAX(seq) FROM ' +
        BY_SEQ_STORE$1 + ' WHERE doc_id=id)';
      tx.executeSql(sql, [], function (tx) {
        // add unique index after filling, else we'll get a constraint
        // error when we do the ALTER TABLE
        var sql =
          'CREATE UNIQUE INDEX IF NOT EXISTS \'doc-max-seq-idx\' ON ' +
          DOC_STORE$1 + ' (max_seq)';
        tx.executeSql(sql, [], callback);
      });
    });
  }

  function checkEncoding(tx, cb) {
    // UTF-8 on chrome/android, UTF-16 on safari < 7.1
    tx.executeSql('SELECT HEX("a") AS hex', [], function (tx, res) {
        var hex = res.rows.item(0).hex;
        encoding = hex.length === 2 ? 'UTF-8' : 'UTF-16';
        cb();
      }
    );
  }

  function onGetInstanceId() {
    while (idRequests.length > 0) {
      var idCallback = idRequests.pop();
      idCallback(null, instanceId);
    }
  }

  function onGetVersion(tx, dbVersion) {
    if (dbVersion === 0) {
      // initial schema

      var meta = 'CREATE TABLE IF NOT EXISTS ' + META_STORE$1 +
        ' (dbid, db_version INTEGER)';
      var attach = 'CREATE TABLE IF NOT EXISTS ' + ATTACH_STORE$1 +
        ' (digest UNIQUE, escaped TINYINT(1), body BLOB)';
      var attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
        ATTACH_AND_SEQ_STORE$1 + ' (digest, seq INTEGER)';
      // TODO: migrate winningseq to INTEGER
      var doc = 'CREATE TABLE IF NOT EXISTS ' + DOC_STORE$1 +
        ' (id unique, json, winningseq, max_seq INTEGER UNIQUE)';
      var seq = 'CREATE TABLE IF NOT EXISTS ' + BY_SEQ_STORE$1 +
        ' (seq INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
        'json, deleted TINYINT(1), doc_id, rev)';
      var local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE$1 +
        ' (id UNIQUE, rev, json)';

      // creates
      tx.executeSql(attach);
      tx.executeSql(local);
      tx.executeSql(attachAndRev, [], function () {
        tx.executeSql(ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL);
        tx.executeSql(ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL);
      });
      tx.executeSql(doc, [], function () {
        tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);
        tx.executeSql(seq, [], function () {
          tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
          tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL);
          tx.executeSql(meta, [], function () {
            // mark the db version, and new dbid
            var initSeq = 'INSERT INTO ' + META_STORE$1 +
              ' (db_version, dbid) VALUES (?,?)';
            instanceId = uuid();
            var initSeqArgs = [ADAPTER_VERSION$1, instanceId];
            tx.executeSql(initSeq, initSeqArgs, function () {
              onGetInstanceId();
            });
          });
        });
      });
    } else { // version > 0

      var setupDone = function () {
        var migrated = dbVersion < ADAPTER_VERSION$1;
        if (migrated) {
          // update the db version within this transaction
          tx.executeSql('UPDATE ' + META_STORE$1 + ' SET db_version = ' +
            ADAPTER_VERSION$1);
        }
        // notify db.id() callers
        var sql = 'SELECT dbid FROM ' + META_STORE$1;
        tx.executeSql(sql, [], function (tx, result) {
          instanceId = result.rows.item(0).dbid;
          onGetInstanceId();
        });
      };

      // would love to use promises here, but then websql
      // ends the transaction early
      var tasks = [
        runMigration2,
        runMigration3,
        runMigration4,
        runMigration5,
        runMigration6,
        runMigration7,
        setupDone
      ];

      // run each migration sequentially
      var i = dbVersion;
      var nextMigration = function (tx) {
        tasks[i - 1](tx, nextMigration);
        i++;
      };
      nextMigration(tx);
    }
  }

  function setup() {
    db.transaction(function (tx) {
      // first check the encoding
      checkEncoding(tx, function () {
        // then get the version
        fetchVersion(tx);
      });
    }, websqlError(callback), dbCreated);
  }

  function fetchVersion(tx) {
    var sql = 'SELECT sql FROM sqlite_master WHERE tbl_name = ' + META_STORE$1;
    tx.executeSql(sql, [], function (tx, result) {
      if (!result.rows.length) {
        // database hasn't even been created yet (version 0)
        onGetVersion(tx, 0);
      } else if (!/db_version/.test(result.rows.item(0).sql)) {
        // table was created, but without the new db_version column,
        // so add it.
        tx.executeSql('ALTER TABLE ' + META_STORE$1 +
          ' ADD COLUMN db_version INTEGER', [], function () {
          // before version 2, this column didn't even exist
          onGetVersion(tx, 1);
        });
      } else { // column exists, we can safely get it
        tx.executeSql('SELECT db_version FROM ' + META_STORE$1,
          [], function (tx, result) {
          var dbVersion = result.rows.item(0).db_version;
          onGetVersion(tx, dbVersion);
        });
      }
    });
  }

  setup();

  function getMaxSeq(tx, callback) {
    var sql = 'SELECT MAX(seq) AS seq FROM ' + BY_SEQ_STORE$1;
    tx.executeSql(sql, [], function (tx, res) {
      var updateSeq = res.rows.item(0).seq || 0;
      callback(updateSeq);
    });
  }

  function countDocs(tx, callback) {
    // count the total rows
    var sql = select(
      'COUNT(' + DOC_STORE$1 + '.id) AS \'num\'',
      [DOC_STORE$1, BY_SEQ_STORE$1],
      DOC_STORE_AND_BY_SEQ_JOINER,
      BY_SEQ_STORE$1 + '.deleted=0');

    tx.executeSql(sql, [], function (tx, result) {
      callback(result.rows.item(0).num);
    });
  }

  api._remote = false;
  api.type = function () {
    return 'websql';
  };

  api._id = toPromise(function (callback) {
    callback(null, instanceId);
  });

  api._info = function (callback) {
    var seq;
    var docCount;
    db.readTransaction(function (tx) {
      getMaxSeq(tx, function (theSeq) {
        seq = theSeq;
      });
      countDocs(tx, function (theDocCount) {
        docCount = theDocCount;
      });
    }, websqlError(callback), function () {
      callback(null, {
        doc_count: docCount,
        update_seq: seq,
        websql_encoding: encoding
      });
    });
  };

  api._bulkDocs = function (req, reqOpts, callback) {
    websqlBulkDocs(opts, req, reqOpts, api, db, websqlChanges, callback);
  };

  function latest$$1(tx, id, rev, callback, finish) {
    var sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE_AND_BY_SEQ_JOINER,
        DOC_STORE$1 + '.id=?');
    var sqlArgs = [id];

    tx.executeSql(sql, sqlArgs, function (a, results) {
      if (!results.rows.length) {
        var err = createError(MISSING_DOC, 'missing');
        return finish(err);
      }
      var item = results.rows.item(0);
      var metadata = safeJsonParse(item.metadata);
      callback(latest(rev, metadata));
    });
  }

  api._get = function (id, opts, callback) {
    var doc;
    var metadata;
    var tx = opts.ctx;
    if (!tx) {
      return db.readTransaction(function (txn) {
        api._get(id, $inject_Object_assign({ctx: txn}, opts), callback);
      });
    }

    function finish(err) {
      callback(err, {doc: doc, metadata: metadata, ctx: tx});
    }

    var sql;
    var sqlArgs;

    if (!opts.rev) {
      sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE_AND_BY_SEQ_JOINER,
        DOC_STORE$1 + '.id=?');
      sqlArgs = [id];
    } else if (opts.latest) {
      latest$$1(tx, id, opts.rev, function (latestRev) {
        opts.latest = false;
        opts.rev = latestRev;
        api._get(id, opts, callback);
      }, finish);
      return;
    } else {
      sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE$1 + '.id=' + BY_SEQ_STORE$1 + '.doc_id',
        [BY_SEQ_STORE$1 + '.doc_id=?', BY_SEQ_STORE$1 + '.rev=?']);
      sqlArgs = [id, opts.rev];
    }

    tx.executeSql(sql, sqlArgs, function (a, results) {
      if (!results.rows.length) {
        var missingErr = createError(MISSING_DOC, 'missing');
        return finish(missingErr);
      }
      var item = results.rows.item(0);
      metadata = safeJsonParse(item.metadata);
      if (item.deleted && !opts.rev) {
        var deletedErr = createError(MISSING_DOC, 'deleted');
        return finish(deletedErr);
      }
      doc = unstringifyDoc(item.data, metadata.id, item.rev);
      finish();
    });
  };

  api._allDocs = function (opts, callback) {
    var results = [];
    var totalRows;

    var start = 'startkey' in opts ? opts.startkey : false;
    var end = 'endkey' in opts ? opts.endkey : false;
    var key = 'key' in opts ? opts.key : false;
    var descending = 'descending' in opts ? opts.descending : false;
    var limit = 'limit' in opts ? opts.limit : -1;
    var offset = 'skip' in opts ? opts.skip : 0;
    var inclusiveEnd = opts.inclusive_end !== false;

    var sqlArgs = [];
    var criteria = [];

    if (key !== false) {
      criteria.push(DOC_STORE$1 + '.id = ?');
      sqlArgs.push(key);
    } else if (start !== false || end !== false) {
      if (start !== false) {
        criteria.push(DOC_STORE$1 + '.id ' + (descending ? '<=' : '>=') + ' ?');
        sqlArgs.push(start);
      }
      if (end !== false) {
        var comparator = descending ? '>' : '<';
        if (inclusiveEnd) {
          comparator += '=';
        }
        criteria.push(DOC_STORE$1 + '.id ' + comparator + ' ?');
        sqlArgs.push(end);
      }
      if (key !== false) {
        criteria.push(DOC_STORE$1 + '.id = ?');
        sqlArgs.push(key);
      }
    }

    if (opts.deleted !== 'ok') {
      // report deleted if keys are specified
      criteria.push(BY_SEQ_STORE$1 + '.deleted = 0');
    }

    db.readTransaction(function (tx) {
      // count the docs in parallel to other operations
      countDocs(tx, function (docCount) {
        totalRows = docCount;
      });

      if (limit === 0) {
        return;
      }

      // do a single query to fetch the documents
      var sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE_AND_BY_SEQ_JOINER,
        criteria,
        DOC_STORE$1 + '.id ' + (descending ? 'DESC' : 'ASC')
        );
      sql += ' LIMIT ' + limit + ' OFFSET ' + offset;

      tx.executeSql(sql, sqlArgs, function (tx, result) {
        for (var i = 0, l = result.rows.length; i < l; i++) {
          var item = result.rows.item(i);
          var metadata = safeJsonParse(item.metadata);
          var id = metadata.id;
          var data = unstringifyDoc(item.data, id, item.rev);
          var winningRev$$1 = data._rev;
          var doc = {
            id: id,
            key: id,
            value: {rev: winningRev$$1}
          };
          if (opts.include_docs) {
            doc.doc = data;
            doc.doc._rev = winningRev$$1;
            if (opts.conflicts) {
              var conflicts = collectConflicts(metadata);
              if (conflicts.length) {
                doc.doc._conflicts = conflicts;
              }
            }
            fetchAttachmentsIfNecessary$1(doc.doc, opts, api, tx);
          }
          if (item.deleted) {
            if (opts.deleted === 'ok') {
              doc.value.deleted = true;
              doc.doc = null;
            } else {
              continue;
            }
          }
          results.push(doc);
        }
      });
    }, websqlError(callback), function () {
      callback(null, {
        total_rows: totalRows,
        offset: opts.skip,
        rows: results
      });
    });
  };

  api._changes = function (opts) {
    opts = clone(opts);

    if (opts.continuous) {
      var id = api._name + ':' + uuid();
      websqlChanges.addListener(api._name, id, api, opts);
      websqlChanges.notify(api._name);
      return {
        cancel: function () {
          websqlChanges.removeListener(api._name, id);
        }
      };
    }

    var descending = opts.descending;

    // Ignore the `since` parameter when `descending` is true
    opts.since = opts.since && !descending ? opts.since : 0;

    var limit = 'limit' in opts ? opts.limit : -1;
    if (limit === 0) {
      limit = 1; // per CouchDB _changes spec
    }

    var returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }
    var results = [];
    var numResults = 0;

    function fetchChanges() {

      var selectStmt =
        DOC_STORE$1 + '.json AS metadata, ' +
        DOC_STORE$1 + '.max_seq AS maxSeq, ' +
        BY_SEQ_STORE$1 + '.json AS winningDoc, ' +
        BY_SEQ_STORE$1 + '.rev AS winningRev ';

      var from = DOC_STORE$1 + ' JOIN ' + BY_SEQ_STORE$1;

      var joiner = DOC_STORE$1 + '.id=' + BY_SEQ_STORE$1 + '.doc_id' +
        ' AND ' + DOC_STORE$1 + '.winningseq=' + BY_SEQ_STORE$1 + '.seq';

      var criteria = ['maxSeq > ?'];
      var sqlArgs = [opts.since];

      if (opts.doc_ids) {
        criteria.push(DOC_STORE$1 + '.id IN ' + qMarks(opts.doc_ids.length));
        sqlArgs = sqlArgs.concat(opts.doc_ids);
      }

      var orderBy = 'maxSeq ' + (descending ? 'DESC' : 'ASC');

      var sql = select(selectStmt, from, joiner, criteria, orderBy);

      var filter = filterChange(opts);
      if (!opts.view && !opts.filter) {
        // we can just limit in the query
        sql += ' LIMIT ' + limit;
      }

      var lastSeq = opts.since || 0;
      db.readTransaction(function (tx) {
        tx.executeSql(sql, sqlArgs, function (tx, result) {
          function reportChange(change) {
            return function () {
              opts.onChange(change);
            };
          }
          for (var i = 0, l = result.rows.length; i < l; i++) {
            var item = result.rows.item(i);
            var metadata = safeJsonParse(item.metadata);
            lastSeq = item.maxSeq;

            var doc = unstringifyDoc(item.winningDoc, metadata.id,
              item.winningRev);
            var change = opts.processChange(doc, metadata, opts);
            change.seq = item.maxSeq;

            var filtered = filter(change);
            if (typeof filtered === 'object') {
              return opts.complete(filtered);
            }

            if (filtered) {
              numResults++;
              if (returnDocs) {
                results.push(change);
              }
              // process the attachment immediately
              // for the benefit of live listeners
              if (opts.attachments && opts.include_docs) {
                fetchAttachmentsIfNecessary$1(doc, opts, api, tx,
                  reportChange(change));
              } else {
                reportChange(change)();
              }
            }
            if (numResults === limit) {
              break;
            }
          }
        });
      }, websqlError(opts.complete), function () {
        if (!opts.continuous) {
          opts.complete(null, {
            results: results,
            last_seq: lastSeq
          });
        }
      });
    }

    fetchChanges();
  };

  api._close = function (callback) {
    //WebSQL databases do not need to be closed
    callback();
  };

  api._getAttachment = function (docId, attachId, attachment, opts, callback) {
    var res;
    var tx = opts.ctx;
    var digest = attachment.digest;
    var type = attachment.content_type;
    var sql = 'SELECT escaped, ' +
      'CASE WHEN escaped = 1 THEN body ELSE HEX(body) END AS body FROM ' +
      ATTACH_STORE$1 + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      // websql has a bug where \u0000 causes early truncation in strings
      // and blobs. to work around this, we used to use the hex() function,
      // but that's not performant. after migration 6, we remove \u0000
      // and add it back in afterwards
      var item = result.rows.item(0);
      var data = item.escaped ? unescapeBlob(item.body) :
        parseHexString(item.body, encoding);
      if (opts.binary) {
        res = binStringToBluffer(data, type);
      } else {
        res = thisBtoa(data);
      }
      callback(null, res);
    });
  };

  api._getRevisionTree = function (docId, callback) {
    db.readTransaction(function (tx) {
      var sql = 'SELECT json AS metadata FROM ' + DOC_STORE$1 + ' WHERE id = ?';
      tx.executeSql(sql, [docId], function (tx, result) {
        if (!result.rows.length) {
          callback(createError(MISSING_DOC));
        } else {
          var data = safeJsonParse(result.rows.item(0).metadata);
          callback(null, data.rev_tree);
        }
      });
    });
  };

  api._doCompaction = function (docId, revs, callback) {
    if (!revs.length) {
      return callback();
    }
    db.transaction(function (tx) {

      // update doc store
      var sql = 'SELECT json AS metadata FROM ' + DOC_STORE$1 + ' WHERE id = ?';
      tx.executeSql(sql, [docId], function (tx, result) {
        var metadata = safeJsonParse(result.rows.item(0).metadata);
        traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
                                                           revHash, ctx, opts) {
          var rev = pos + '-' + revHash;
          if (revs.indexOf(rev) !== -1) {
            opts.status = 'missing';
          }
        });

        var sql = 'UPDATE ' + DOC_STORE$1 + ' SET json = ? WHERE id = ?';
        tx.executeSql(sql, [safeJsonStringify(metadata), docId]);
      });

      compactRevs$1(revs, docId, tx);
    }, websqlError(callback), function () {
      callback();
    });
  };

  api._getLocal = function (id, callback) {
    db.readTransaction(function (tx) {
      var sql = 'SELECT json, rev FROM ' + LOCAL_STORE$1 + ' WHERE id=?';
      tx.executeSql(sql, [id], function (tx, res) {
        if (res.rows.length) {
          var item = res.rows.item(0);
          var doc = unstringifyDoc(item.json, id, item.rev);
          callback(null, doc);
        } else {
          callback(createError(MISSING_DOC));
        }
      });
    });
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    delete doc._revisions; // ignore this, trust the rev
    var oldRev = doc._rev;
    var id = doc._id;
    var newRev;
    if (!oldRev) {
      newRev = doc._rev = '0-1';
    } else {
      newRev = doc._rev = '0-' + (parseInt(oldRev.split('-')[1], 10) + 1);
    }
    var json = stringifyDoc(doc);

    var ret;
    function putLocal(tx) {
      var sql;
      var values;
      if (oldRev) {
        sql = 'UPDATE ' + LOCAL_STORE$1 + ' SET rev=?, json=? ' +
          'WHERE id=? AND rev=?';
        values = [newRev, json, id, oldRev];
      } else {
        sql = 'INSERT INTO ' + LOCAL_STORE$1 + ' (id, rev, json) VALUES (?,?,?)';
        values = [id, newRev, json];
      }
      tx.executeSql(sql, values, function (tx, res) {
        if (res.rowsAffected) {
          ret = {ok: true, id: id, rev: newRev};
          if (opts.ctx) { // return immediately
            callback(null, ret);
          }
        } else {
          callback(createError(REV_CONFLICT));
        }
      }, function () {
        callback(createError(REV_CONFLICT));
        return false; // ack that we handled the error
      });
    }

    if (opts.ctx) {
      putLocal(opts.ctx);
    } else {
      db.transaction(putLocal, websqlError(callback), function () {
        if (ret) {
          callback(null, ret);
        }
      });
    }
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var ret;

    function removeLocal(tx) {
      var sql = 'DELETE FROM ' + LOCAL_STORE$1 + ' WHERE id=? AND rev=?';
      var params = [doc._id, doc._rev];
      tx.executeSql(sql, params, function (tx, res) {
        if (!res.rowsAffected) {
          return callback(createError(MISSING_DOC));
        }
        ret = {ok: true, id: doc._id, rev: '0-0'};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      });
    }

    if (opts.ctx) {
      removeLocal(opts.ctx);
    } else {
      db.transaction(removeLocal, websqlError(callback), function () {
        if (ret) {
          callback(null, ret);
        }
      });
    }
  };

  api._destroy = function (opts, callback) {
    websqlChanges.removeAllListeners(api._name);
    db.transaction(function (tx) {
      var stores = [DOC_STORE$1, BY_SEQ_STORE$1, ATTACH_STORE$1, META_STORE$1,
        LOCAL_STORE$1, ATTACH_AND_SEQ_STORE$1];
      stores.forEach(function (store) {
        tx.executeSql('DROP TABLE IF EXISTS ' + store, []);
      });
    }, websqlError(callback), function () {
      if (hasLocalStorage()) {
        delete window.localStorage['_pouch__websqldb_' + api._name];
        delete window.localStorage[api._name];
      }
      callback(null, {'ok': true});
    });
  };
}

function canOpenTestDB() {
  try {
    openDatabase('_pouch_validate_websql', 1, '', 1);
    return true;
  } catch (err) {
    return false;
  }
}

// WKWebView had a bug where WebSQL would throw a DOM Exception 18
// (see https://bugs.webkit.org/show_bug.cgi?id=137760 and
// https://github.com/pouchdb/pouchdb/issues/5079)
// This has been fixed in latest WebKit, so we try to detect it here.
function isValidWebSQL() {
  // WKWebView UA:
  //   Mozilla/5.0 (iPhone; CPU iPhone OS 9_2 like Mac OS X)
  //   AppleWebKit/601.1.46 (KHTML, like Gecko) Mobile/13C75
  // Chrome for iOS UA:
  //   Mozilla/5.0 (iPhone; U; CPU iPhone OS 5_1_1 like Mac OS X; en)
  //   AppleWebKit/534.46.0 (KHTML, like Gecko) CriOS/19.0.1084.60
  //   Mobile/9B206 Safari/7534.48.3
  // Firefox for iOS UA:
  //   Mozilla/5.0 (iPhone; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4
  //   (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4

  // indexedDB is null on some UIWebViews and undefined in others
  // see: https://bugs.webkit.org/show_bug.cgi?id=137034
  if (typeof indexedDB === 'undefined' || indexedDB === null ||
      !/iP(hone|od|ad)/.test(navigator.userAgent)) {
    // definitely not WKWebView, avoid creating an unnecessary database
    return true;
  }
  // Cache the result in LocalStorage. Reason we do this is because if we
  // call openDatabase() too many times, Safari craps out in SauceLabs and
  // starts throwing DOM Exception 14s.
  var hasLS = hasLocalStorage();
  // Include user agent in the hash, so that if Safari is upgraded, we don't
  // continually think it's broken.
  var localStorageKey = '_pouch__websqldb_valid_' + navigator.userAgent;
  if (hasLS && localStorage[localStorageKey]) {
    return localStorage[localStorageKey] === '1';
  }
  var openedTestDB = canOpenTestDB();
  if (hasLS) {
    localStorage[localStorageKey] = openedTestDB ? '1' : '0';
  }
  return openedTestDB;
}

function valid() {
  if (typeof openDatabase !== 'function') {
    return false;
  }
  return isValidWebSQL();
}

function openDB(name, version, description, size) {
  // Traditional WebSQL API
  return openDatabase(name, version, description, size);
}

function WebSQLPouch(opts, callback) {
  var _opts = $inject_Object_assign({
    websql: openDB
  }, opts);

  WebSqlPouch$1.call(this, _opts, callback);
}

WebSQLPouch.valid = valid;

WebSQLPouch.use_prefix = true;

var WebSqlPouch = function (PouchDB) {
  PouchDB.adapter('websql', WebSQLPouch, true);
};

/* global fetch */
/* global Headers */
function wrappedFetch() {
  var wrappedPromise = {};

  var promise = new PouchPromise$1(function (resolve, reject) {
    wrappedPromise.resolve = resolve;
    wrappedPromise.reject = reject;
  });

  var args = new Array(arguments.length);

  for (var i = 0; i < args.length; i++) {
    args[i] = arguments[i];
  }

  wrappedPromise.promise = promise;

  PouchPromise$1.resolve().then(function () {
    return fetch.apply(null, args);
  }).then(function (response) {
    wrappedPromise.resolve(response);
  }).catch(function (error) {
    wrappedPromise.reject(error);
  });

  return wrappedPromise;
}

function fetchRequest(options, callback) {
  var wrappedPromise, timer, response;

  var headers = new Headers();

  var fetchOptions = {
    method: options.method,
    credentials: 'include',
    headers: headers
  };

  if (options.json) {
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', options.headers['Content-Type'] ||
      'application/json');
  }

  if (options.body &&
      options.processData &&
      typeof options.body !== 'string') {
    fetchOptions.body = JSON.stringify(options.body);
  } else if ('body' in options) {
    fetchOptions.body = options.body;
  } else {
    fetchOptions.body = null;
  }

  Object.keys(options.headers).forEach(function (key) {
    if (options.headers.hasOwnProperty(key)) {
      headers.set(key, options.headers[key]);
    }
  });

  wrappedPromise = wrappedFetch(options.url, fetchOptions);

  if (options.timeout > 0) {
    timer = setTimeout(function () {
      wrappedPromise.reject(new Error('Load timeout for resource: ' +
        options.url));
    }, options.timeout);
  }

  wrappedPromise.promise.then(function (fetchResponse) {
    response = {
      statusCode: fetchResponse.status
    };

    if (options.timeout > 0) {
      clearTimeout(timer);
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return options.binary ? fetchResponse.blob() : fetchResponse.text();
    }

    return fetchResponse.json();
  }).then(function (result) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      callback(null, response, result);
    } else {
      result.status = response.statusCode;
      callback(result);
    }
  }).catch(function (error) {
    if (!error) {
      // this happens when the listener is canceled
      error = new Error('canceled');
    }
    callback(error);
  });

  return {abort: wrappedPromise.reject};
}

function xhRequest(options, callback) {

  var xhr, timer;
  var timedout = false;

  var abortReq = function () {
    xhr.abort();
    cleanUp();
  };

  var timeoutReq = function () {
    timedout = true;
    xhr.abort();
    cleanUp();
  };

  var ret = {abort: abortReq};

  var cleanUp = function () {
    clearTimeout(timer);
    ret.abort = function () {};
    if (xhr) {
      xhr.onprogress = undefined;
      if (xhr.upload) {
        xhr.upload.onprogress = undefined;
      }
      xhr.onreadystatechange = undefined;
      xhr = undefined;
    }
  };

  if (options.xhr) {
    xhr = new options.xhr();
  } else {
    xhr = new XMLHttpRequest();
  }

  try {
    xhr.open(options.method, options.url);
  } catch (exception) {
    return callback(new Error(exception.name || 'Url is invalid'));
  }

  xhr.withCredentials = ('withCredentials' in options) ?
    options.withCredentials : true;

  if (options.method === 'GET') {
    delete options.headers['Content-Type'];
  } else if (options.json) {
    options.headers.Accept = 'application/json';
    options.headers['Content-Type'] = options.headers['Content-Type'] ||
      'application/json';
    if (options.body &&
        options.processData &&
        typeof options.body !== "string") {
      options.body = JSON.stringify(options.body);
    }
  }

  if (options.binary) {
    xhr.responseType = 'arraybuffer';
  }

  if (!('body' in options)) {
    options.body = null;
  }

  for (var key in options.headers) {
    if (options.headers.hasOwnProperty(key)) {
      xhr.setRequestHeader(key, options.headers[key]);
    }
  }

  if (options.timeout > 0) {
    timer = setTimeout(timeoutReq, options.timeout);
    xhr.onprogress = function () {
      clearTimeout(timer);
      if (xhr.readyState !== 4) {
        timer = setTimeout(timeoutReq, options.timeout);
      }
    };
    if (typeof xhr.upload !== 'undefined') { // does not exist in ie9
      xhr.upload.onprogress = xhr.onprogress;
    }
  }

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) {
      return;
    }

    var response = {
      statusCode: xhr.status
    };

    if (xhr.status >= 200 && xhr.status < 300) {
      var data;
      if (options.binary) {
        data = createBlob([xhr.response || ''], {
          type: xhr.getResponseHeader('Content-Type')
        });
      } else {
        data = xhr.responseText;
      }
      callback(null, response, data);
    } else {
      var err = {};
      if (timedout) {
        err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
      } else if (typeof xhr.response === 'string') {
        try {
          err = JSON.parse(xhr.response);
        } catch (e) {}
      }
      err.status = xhr.status;
      callback(err);
    }
    cleanUp();
  };

  if (options.body && (options.body instanceof Blob)) {
    readAsArrayBuffer(options.body, function (arrayBuffer) {
      xhr.send(arrayBuffer);
    });
  } else {
    xhr.send(options.body);
  }

  return ret;
}

function testXhr() {
  try {
    new XMLHttpRequest();
    return true;
  } catch (err) {
    return false;
  }
}

var hasXhr = testXhr();

function ajax$1(options, callback) {
  if (!false && (hasXhr || options.xhr)) {
    return xhRequest(options, callback);
  } else {
    return fetchRequest(options, callback);
  }
}

// the blob already has a type; do nothing
var res$2 = function () {};

function defaultBody() {
  return '';
}

function ajaxCore$1(options, callback) {

  options = clone(options);

  var defaultOptions = {
    method : "GET",
    headers: {},
    json: true,
    processData: true,
    timeout: 10000,
    cache: false
  };

  options = $inject_Object_assign(defaultOptions, options);

  function onSuccess(obj, resp, cb) {
    if (!options.binary && options.json && typeof obj === 'string') {
      /* istanbul ignore next */
      try {
        obj = JSON.parse(obj);
      } catch (e) {
        // Probably a malformed JSON from server
        return cb(e);
      }
    }
    if (Array.isArray(obj)) {
      obj = obj.map(function (v) {
        if (v.error || v.missing) {
          return generateErrorFromResponse(v);
        } else {
          return v;
        }
      });
    }
    if (options.binary) {
      res$2(obj, resp);
    }
    cb(null, obj, resp);
  }

  if (options.json) {
    if (!options.binary) {
      options.headers.Accept = 'application/json';
    }
    options.headers['Content-Type'] = options.headers['Content-Type'] ||
      'application/json';
  }

  if (options.binary) {
    options.encoding = null;
    options.json = false;
  }

  if (!options.processData) {
    options.json = false;
  }

  return ajax$1(options, function (err, response, body) {

    if (err) {
      return callback(generateErrorFromResponse(err));
    }

    var error;
    var content_type = response.headers && response.headers['content-type'];
    var data = body || defaultBody();

    // CouchDB doesn't always return the right content-type for JSON data, so
    // we check for ^{ and }$ (ignoring leading/trailing whitespace)
    if (!options.binary && (options.json || !options.processData) &&
        typeof data !== 'object' &&
        (/json/.test(content_type) ||
         (/^[\s]*\{/.test(data) && /\}[\s]*$/.test(data)))) {
      try {
        data = JSON.parse(data.toString());
      } catch (e) {}
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      onSuccess(data, response, callback);
    } else {
      error = generateErrorFromResponse(data);
      error.status = response.statusCode;
      callback(error);
    }
  });
}

function ajax(opts, callback) {

  // cache-buster, specifically designed to work around IE's aggressive caching
  // see http://www.dashbay.com/2011/05/internet-explorer-caches-ajax/
  // Also Safari caches POSTs, so we need to cache-bust those too.
  var ua = (navigator && navigator.userAgent) ?
    navigator.userAgent.toLowerCase() : '';

  var isSafari = ua.indexOf('safari') !== -1 && ua.indexOf('chrome') === -1;
  var isIE = ua.indexOf('msie') !== -1;
  var isEdge = ua.indexOf('edge') !== -1;

  // it appears the new version of safari also caches GETs,
  // see https://github.com/pouchdb/pouchdb/issues/5010
  var shouldCacheBust = (isSafari ||
    ((isIE || isEdge) && opts.method === 'GET'));

  var cache = 'cache' in opts ? opts.cache : true;

  var isBlobUrl = /^blob:/.test(opts.url); // don't append nonces for blob URLs

  if (!isBlobUrl && (shouldCacheBust || !cache)) {
    var hasArgs = opts.url.indexOf('?') !== -1;
    opts.url += (hasArgs ? '&' : '?') + '_nonce=' + Date.now();
  }

  return ajaxCore$1(opts, callback);
}

// dead simple promise pool, inspired by https://github.com/timdp/es6-promise-pool
// but much smaller in code size. limits the number of concurrent promises that are executed


function pool(promiseFactories, limit) {
  return new PouchPromise$1(function (resolve, reject) {
    var running = 0;
    var current = 0;
    var done = 0;
    var len = promiseFactories.length;
    var err;

    function runNext() {
      running++;
      promiseFactories[current++]().then(onSuccess, onError);
    }

    function doNext() {
      if (++done === len) {
        /* istanbul ignore if */
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      } else {
        runNextBatch();
      }
    }

    function onSuccess() {
      running--;
      doNext();
    }

    /* istanbul ignore next */
    function onError(thisErr) {
      running--;
      err = err || thisErr;
      doNext();
    }

    function runNextBatch() {
      while (running < limit && current < len) {
        runNext();
      }
    }

    runNextBatch();
  });
}

var CHANGES_BATCH_SIZE = 25;
var MAX_SIMULTANEOUS_REVS = 50;

var supportsBulkGetMap = {};

function readAttachmentsAsBlobOrBuffer(row) {
  var atts = row.doc && row.doc._attachments;
  if (!atts) {
    return;
  }
  Object.keys(atts).forEach(function (filename) {
    var att = atts[filename];
    att.data = b64ToBluffer(att.data, att.content_type);
  });
}

function encodeDocId(id) {
  if (/^_design/.test(id)) {
    return '_design/' + encodeURIComponent(id.slice(8));
  }
  if (/^_local/.test(id)) {
    return '_local/' + encodeURIComponent(id.slice(7));
  }
  return encodeURIComponent(id);
}

function preprocessAttachments$2(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return PouchPromise$1.resolve();
  }

  return PouchPromise$1.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      return new PouchPromise$1(function (resolve) {
        blobToBase64(attachment.data, resolve);
      }).then(function (b64) {
        attachment.data = b64;
      });
    }
  }));
}

function hasUrlPrefix(opts) {
  if (!opts.prefix) {
    return false;
  }

  var protocol = parseUri(opts.prefix).protocol;

  return protocol === 'http' || protocol === 'https';
}

// Get all the information you possibly can about the URI given by name and
// return it as a suitable object.
function getHost(name, opts) {

  // encode db name if opts.prefix is a url (#5574)
  if (hasUrlPrefix(opts)) {
    var dbName = opts.name.substr(opts.prefix.length);
    name = opts.prefix + encodeURIComponent(dbName);
  }

  // Prase the URI into all its little bits
  var uri = parseUri(name);

  // Store the user and password as a separate auth object
  if (uri.user || uri.password) {
    uri.auth = {username: uri.user, password: uri.password};
  }

  // Split the path part of the URI into parts using '/' as the delimiter
  // after removing any leading '/' and any trailing '/'
  var parts = uri.path.replace(/(^\/|\/$)/g, '').split('/');

  // Store the first part as the database name and remove it from the parts
  // array
  uri.db = parts.pop();
  // Prevent double encoding of URI component
  if (uri.db.indexOf('%') === -1) {
    uri.db = encodeURIComponent(uri.db);
  }

  // Restore the path by joining all the remaining parts (all the parts
  // except for the database name) with '/'s
  uri.path = parts.join('/');

  return uri;
}

// Generate a URL with the host data given by opts and the given path
function genDBUrl(opts, path) {
  return genUrl(opts, opts.db + '/' + path);
}

// Generate a URL with the host data given by opts and the given path
function genUrl(opts, path) {
  // If the host already has a path, then we need to have a path delimiter
  // Otherwise, the path delimiter is the empty string
  var pathDel = !opts.path ? '' : '/';

  // If the host already has a path, then we need to have a path delimiter
  // Otherwise, the path delimiter is the empty string
  return opts.protocol + '://' + opts.host +
         (opts.port ? (':' + opts.port) : '') +
         '/' + opts.path + pathDel + path;
}

function paramsToStr(params) {
  return '?' + Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
}

// Implements the PouchDB API for dealing with CouchDB instances over HTTP
function HttpPouch(opts, callback) {

  // The functions that will be publicly available for HttpPouch
  var api = this;

  var host = getHost(opts.name, opts);
  var dbUrl = genDBUrl(host, '');

  opts = clone(opts);
  var ajaxOpts = opts.ajax || {};

  if (opts.auth || host.auth) {
    var nAuth = opts.auth || host.auth;
    var str = nAuth.username + ':' + nAuth.password;
    var token = thisBtoa(unescape(encodeURIComponent(str)));
    ajaxOpts.headers = ajaxOpts.headers || {};
    ajaxOpts.headers.Authorization = 'Basic ' + token;
  }

  // Not strictly necessary, but we do this because numerous tests
  // rely on swapping ajax in and out.
  api._ajax = ajax;

  function ajax$$1(userOpts, options, callback) {
    var reqAjax = userOpts.ajax || {};
    var reqOpts = $inject_Object_assign(clone(ajaxOpts), reqAjax, options);
    var defaultHeaders = clone(ajaxOpts.headers || {});
    reqOpts.headers = $inject_Object_assign(defaultHeaders, reqAjax.headers,
      options.headers || {});
    /* istanbul ignore if */
    if (api.constructor.listeners('debug').length) {
      api.constructor.emit('debug', ['http', reqOpts.method, reqOpts.url]);
    }
    return api._ajax(reqOpts, callback);
  }

  function ajaxPromise(userOpts, opts) {
    return new PouchPromise$1(function (resolve, reject) {
      ajax$$1(userOpts, opts, function (err, res) {
        /* istanbul ignore if */
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
    });
  }

  function adapterFun$$1(name, fun) {
    return adapterFun(name, getArguments(function (args) {
      setup().then(function () {
        return fun.apply(this, args);
      }).catch(function (e) {
        var callback = args.pop();
        callback(e);
      });
    }));
  }

  var setupPromise;

  function setup() {
    // TODO: Remove `skipSetup` in favor of `skip_setup` in a future release
    if (opts.skipSetup || opts.skip_setup) {
      return PouchPromise$1.resolve();
    }

    // If there is a setup in process or previous successful setup
    // done then we will use that
    // If previous setups have been rejected we will try again
    if (setupPromise) {
      return setupPromise;
    }

    var checkExists = {method: 'GET', url: dbUrl};
    setupPromise = ajaxPromise({}, checkExists).catch(function (err) {
      if (err && err.status && err.status === 404) {
        // Doesnt exist, create it
        explainError(404, 'PouchDB is just detecting if the remote exists.');
        return ajaxPromise({}, {method: 'PUT', url: dbUrl});
      } else {
        return PouchPromise$1.reject(err);
      }
    }).catch(function (err) {
      // If we try to create a database that already exists, skipped in
      // istanbul since its catching a race condition.
      /* istanbul ignore if */
      if (err && err.status && err.status === 412) {
        return true;
      }
      return PouchPromise$1.reject(err);
    });

    setupPromise.catch(function () {
      setupPromise = null;
    });

    return setupPromise;
  }

  nextTick(function () {
    callback(null, api);
  });

  api._remote = true;
  /* istanbul ignore next */
  api.type = function () {
    return 'http';
  };

  api.id = adapterFun$$1('id', function (callback) {
    ajax$$1({}, {method: 'GET', url: genUrl(host, '')}, function (err, result) {
      var uuid$$1 = (result && result.uuid) ?
        (result.uuid + host.db) : genDBUrl(host, '');
      callback(null, uuid$$1);
    });
  });

  api.request = adapterFun$$1('request', function (options, callback) {
    options.url = genDBUrl(host, options.url);
    ajax$$1({}, options, callback);
  });

  // Sends a POST request to the host calling the couchdb _compact function
  //    version: The version of CouchDB it is running
  api.compact = adapterFun$$1('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);
    ajax$$1(opts, {
      url: genDBUrl(host, '_compact'),
      method: 'POST'
    }, function () {
      function ping() {
        api.info(function (err, res) {
          // CouchDB may send a "compact_running:true" if it's
          // already compacting. PouchDB Server doesn't.
          /* istanbul ignore else */
          if (res && !res.compact_running) {
            callback(null, {ok: true});
          } else {
            setTimeout(ping, opts.interval || 200);
          }
        });
      }
      // Ping the http if it's finished compaction
      ping();
    });
  });

  api.bulkGet = adapterFun('bulkGet', function (opts, callback) {
    var self = this;

    function doBulkGet(cb) {
      var params = {};
      if (opts.revs) {
        params.revs = true;
      }
      if (opts.attachments) {
        /* istanbul ignore next */
        params.attachments = true;
      }
      if (opts.latest) {
        params.latest = true;
      }
      ajax$$1(opts, {
        url: genDBUrl(host, '_bulk_get' + paramsToStr(params)),
        method: 'POST',
        body: { docs: opts.docs}
      }, cb);
    }

    /* istanbul ignore next */
    function doBulkGetShim() {
      // avoid "url too long error" by splitting up into multiple requests
      var batchSize = MAX_SIMULTANEOUS_REVS;
      var numBatches = Math.ceil(opts.docs.length / batchSize);
      var numDone = 0;
      var results = new Array(numBatches);

      function onResult(batchNum) {
        return function (err, res) {
          // err is impossible because shim returns a list of errs in that case
          results[batchNum] = res.results;
          if (++numDone === numBatches) {
            callback(null, {results: flatten(results)});
          }
        };
      }

      for (var i = 0; i < numBatches; i++) {
        var subOpts = pick(opts, ['revs', 'attachments', 'latest']);
        subOpts.ajax = ajaxOpts;
        subOpts.docs = opts.docs.slice(i * batchSize,
          Math.min(opts.docs.length, (i + 1) * batchSize));
        bulkGet(self, subOpts, onResult(i));
      }
    }

    // mark the whole database as either supporting or not supporting _bulk_get
    var dbUrl = genUrl(host, '');
    var supportsBulkGet = supportsBulkGetMap[dbUrl];

    /* istanbul ignore next */
    if (typeof supportsBulkGet !== 'boolean') {
      // check if this database supports _bulk_get
      doBulkGet(function (err, res) {
        if (err) {
          supportsBulkGetMap[dbUrl] = false;
          explainError(
            err.status,
            'PouchDB is just detecting if the remote ' +
            'supports the _bulk_get API.'
          );
          doBulkGetShim();
        } else {
          supportsBulkGetMap[dbUrl] = true;
          callback(null, res);
        }
      });
    } else if (supportsBulkGet) {
      doBulkGet(callback);
    } else {
      doBulkGetShim();
    }
  });

  // Calls GET on the host, which gets back a JSON string containing
  //    couchdb: A welcome string
  //    version: The version of CouchDB it is running
  api._info = function (callback) {
    setup().then(function () {
      ajax$$1({}, {
        method: 'GET',
        url: genDBUrl(host, '')
      }, function (err, res) {
        /* istanbul ignore next */
        if (err) {
        return callback(err);
        }
        res.host = genDBUrl(host, '');
        callback(null, res);
      });
    }).catch(callback);
  };

  // Get the document with the given id from the database given by host.
  // The id could be solely the _id in the database, or it may be a
  // _design/ID or _local/ID path
  api.get = adapterFun$$1('get', function (id, opts, callback) {
    // If no options were given, set the callback to the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);

    // List of parameters to add to the GET request
    var params = {};

    if (opts.revs) {
      params.revs = true;
    }

    if (opts.revs_info) {
      params.revs_info = true;
    }

    if (opts.latest) {
      params.latest = true;
    }

    if (opts.open_revs) {
      if (opts.open_revs !== "all") {
        opts.open_revs = JSON.stringify(opts.open_revs);
      }
      params.open_revs = opts.open_revs;
    }

    if (opts.rev) {
      params.rev = opts.rev;
    }

    if (opts.conflicts) {
      params.conflicts = opts.conflicts;
    }

    id = encodeDocId(id);

    // Set the options for the ajax call
    var options = {
      method: 'GET',
      url: genDBUrl(host, id + paramsToStr(params))
    };

    function fetchAttachments(doc) {
      var atts = doc._attachments;
      var filenames = atts && Object.keys(atts);
      if (!atts || !filenames.length) {
        return;
      }
      // we fetch these manually in separate XHRs, because
      // Sync Gateway would normally send it back as multipart/mixed,
      // which we cannot parse. Also, this is more efficient than
      // receiving attachments as base64-encoded strings.
      function fetch(filename) {
        var att = atts[filename];
        var path = encodeDocId(doc._id) + '/' + encodeAttachmentId(filename) +
          '?rev=' + doc._rev;
        return ajaxPromise(opts, {
          method: 'GET',
          url: genDBUrl(host, path),
          binary: true
        }).then(function (blob$$1) {
          if (opts.binary) {
            return blob$$1;
          }
          return new PouchPromise$1(function (resolve) {
            blobToBase64(blob$$1, resolve);
          });
        }).then(function (data) {
          delete att.stub;
          delete att.length;
          att.data = data;
        });
      }

      var promiseFactories = filenames.map(function (filename) {
        return function () {
          return fetch(filename);
        };
      });

      // This limits the number of parallel xhr requests to 5 any time
      // to avoid issues with maximum browser request limits
      return pool(promiseFactories, 5);
    }

    function fetchAllAttachments(docOrDocs) {
      if (Array.isArray(docOrDocs)) {
        return PouchPromise$1.all(docOrDocs.map(function (doc) {
          if (doc.ok) {
            return fetchAttachments(doc.ok);
          }
        }));
      }
      return fetchAttachments(docOrDocs);
    }

    ajaxPromise(opts, options).then(function (res) {
      return PouchPromise$1.resolve().then(function () {
        if (opts.attachments) {
          return fetchAllAttachments(res);
        }
      }).then(function () {
        callback(null, res);
      });
    }).catch(callback);
  });

  // Delete the document given by doc from the database given by host.
  api.remove = adapterFun$$1('remove',
      function (docOrId, optsOrRev, opts, callback) {
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

    // Delete the document
    ajax$$1(opts, {
      method: 'DELETE',
      url: genDBUrl(host, encodeDocId(doc._id)) + '?rev=' + rev
    }, callback);
  });

  function encodeAttachmentId(attachmentId) {
    return attachmentId.split("/").map(encodeURIComponent).join("/");
  }

  // Get the attachment
  api.getAttachment =
    adapterFun$$1('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var params = opts.rev ? ('?rev=' + opts.rev) : '';
    var url = genDBUrl(host, encodeDocId(docId)) + '/' +
      encodeAttachmentId(attachmentId) + params;
    ajax$$1(opts, {
      method: 'GET',
      url: url,
      binary: true
    }, callback);
  });

  // Remove the attachment given by the id and rev
  api.removeAttachment =
    adapterFun$$1('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

    var url = genDBUrl(host, encodeDocId(docId) + '/' +
      encodeAttachmentId(attachmentId)) + '?rev=' + rev;

    ajax$$1({}, {
      method: 'DELETE',
      url: url
    }, callback);
  });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun$$1('putAttachment', function (docId, attachmentId, rev, blob$$1,
                                                type, callback) {
    if (typeof type === 'function') {
      callback = type;
      type = blob$$1;
      blob$$1 = rev;
      rev = null;
    }
    var id = encodeDocId(docId) + '/' + encodeAttachmentId(attachmentId);
    var url = genDBUrl(host, id);
    if (rev) {
      url += '?rev=' + rev;
    }

    if (typeof blob$$1 === 'string') {
      // input is assumed to be a base64 string
      var binary;
      try {
        binary = thisAtob(blob$$1);
      } catch (err) {
        return callback(createError(BAD_ARG,
                        'Attachment is not a valid base64 string'));
      }
      blob$$1 = binary ? binStringToBluffer(binary, type) : '';
    }

    var opts = {
      headers: {'Content-Type': type},
      method: 'PUT',
      url: url,
      processData: false,
      body: blob$$1,
      timeout: ajaxOpts.timeout || 60000
    };
    // Add the attachment
    ajax$$1({}, opts, callback);
  });

  // Update/create multiple documents given by req in the database
  // given by host.
  api._bulkDocs = function (req, opts, callback) {
    // If new_edits=false then it prevents the database from creating
    // new revision numbers for the documents. Instead it just uses
    // the old ones. This is used in database replication.
    req.new_edits = opts.new_edits;

    setup().then(function () {
      return PouchPromise$1.all(req.docs.map(preprocessAttachments$2));
    }).then(function () {
      // Update/create the documents
      ajax$$1(opts, {
        method: 'POST',
        url: genDBUrl(host, '_bulk_docs'),
        timeout: opts.timeout,
        body: req
      }, function (err, results) {
        if (err) {
          return callback(err);
        }
        results.forEach(function (result) {
          result.ok = true; // smooths out cloudant not adding this
        });
        callback(null, results);
      });
    }).catch(callback);
  };


  // Update/create document
  api._put = function (doc, opts, callback) {
    setup().then(function () {
      return preprocessAttachments$2(doc);
    }).then(function () {
      // Update/create the document
      ajax$$1(opts, {
        method: 'PUT',
        url: genDBUrl(host, encodeDocId(doc._id)),
        body: doc
      }, function (err, result) {
        if (err) {
          return callback(err);
        }
        callback(null, result);
      });
    }).catch(callback);
  };


  // Get a listing of the documents in the database given
  // by host and ordered by increasing id.
  api.allDocs = adapterFun$$1('allDocs', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);

    // List of parameters to add to the GET request
    var params = {};
    var body;
    var method = 'GET';

    if (opts.conflicts) {
      params.conflicts = true;
    }

    if (opts.descending) {
      params.descending = true;
    }

    if (opts.include_docs) {
      params.include_docs = true;
    }

    // added in CouchDB 1.6.0
    if (opts.attachments) {
      params.attachments = true;
    }

    if (opts.key) {
      params.key = JSON.stringify(opts.key);
    }

    if (opts.start_key) {
      opts.startkey = opts.start_key;
    }

    if (opts.startkey) {
      params.startkey = JSON.stringify(opts.startkey);
    }

    if (opts.end_key) {
      opts.endkey = opts.end_key;
    }

    if (opts.endkey) {
      params.endkey = JSON.stringify(opts.endkey);
    }

    if (typeof opts.inclusive_end !== 'undefined') {
      params.inclusive_end = !!opts.inclusive_end;
    }

    if (typeof opts.limit !== 'undefined') {
      params.limit = opts.limit;
    }

    if (typeof opts.skip !== 'undefined') {
      params.skip = opts.skip;
    }

    var paramStr = paramsToStr(params);

    if (typeof opts.keys !== 'undefined') {
      method = 'POST';
      body = {keys: opts.keys};
    }

    // Get the document listing
    ajaxPromise(opts, {
      method: method,
      url: genDBUrl(host, '_all_docs' + paramStr),
      body: body
    }).then(function (res) {
      if (opts.include_docs && opts.attachments && opts.binary) {
        res.rows.forEach(readAttachmentsAsBlobOrBuffer);
      }
      callback(null, res);
    }).catch(callback);
  });

  // Get a list of changes made to documents in the database given by host.
  // TODO According to the README, there should be two other methods here,
  // api.changes.addListener and api.changes.removeListener.
  api._changes = function (opts) {

    // We internally page the results of a changes request, this means
    // if there is a large set of changes to be returned we can start
    // processing them quicker instead of waiting on the entire
    // set of changes to return and attempting to process them at once
    var batchSize = 'batch_size' in opts ? opts.batch_size : CHANGES_BATCH_SIZE;

    opts = clone(opts);
    opts.timeout = ('timeout' in opts) ? opts.timeout :
      ('timeout' in ajaxOpts) ? ajaxOpts.timeout :
      30 * 1000;

    // We give a 5 second buffer for CouchDB changes to respond with
    // an ok timeout (if a timeout it set)
    var params = opts.timeout ? {timeout: opts.timeout - (5 * 1000)} : {};
    var limit = (typeof opts.limit !== 'undefined') ? opts.limit : false;
    var returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }
    //
    var leftToFetch = limit;

    if (opts.style) {
      params.style = opts.style;
    }

    if (opts.include_docs || opts.filter && typeof opts.filter === 'function') {
      params.include_docs = true;
    }

    if (opts.attachments) {
      params.attachments = true;
    }

    if (opts.continuous) {
      params.feed = 'longpoll';
    }

    if (opts.conflicts) {
      params.conflicts = true;
    }

    if (opts.descending) {
      params.descending = true;
    }

    if ('heartbeat' in opts) {
      // If the heartbeat value is false, it disables the default heartbeat
      if (opts.heartbeat) {
        params.heartbeat = opts.heartbeat;
      }
    } else if (opts.continuous) {
      // Default heartbeat to 10 seconds
      params.heartbeat = 10000;
    }

    if (opts.filter && typeof opts.filter === 'string') {
      params.filter = opts.filter;
    }

    if (opts.view && typeof opts.view === 'string') {
      params.filter = '_view';
      params.view = opts.view;
    }

    // If opts.query_params exists, pass it through to the changes request.
    // These parameters may be used by the filter on the source database.
    if (opts.query_params && typeof opts.query_params === 'object') {
      for (var param_name in opts.query_params) {
        /* istanbul ignore else */
        if (opts.query_params.hasOwnProperty(param_name)) {
          params[param_name] = opts.query_params[param_name];
        }
      }
    }

    var method = 'GET';
    var body;

    if (opts.doc_ids) {
      // set this automagically for the user; it's annoying that couchdb
      // requires both a "filter" and a "doc_ids" param.
      params.filter = '_doc_ids';
      method = 'POST';
      body = {doc_ids: opts.doc_ids };
    }
    /* istanbul ignore next */
    else if (opts.selector) {
      // set this automagically for the user, similar to above
      params.filter = '_selector';
      method = 'POST';
      body = {selector: opts.selector };
    }

    var xhr;
    var lastFetchedSeq;

    // Get all the changes starting wtih the one immediately after the
    // sequence number given by since.
    var fetch = function (since, callback) {
      if (opts.aborted) {
        return;
      }
      params.since = since;
      // "since" can be any kind of json object in Coudant/CouchDB 2.x
      /* istanbul ignore next */
      if (typeof params.since === "object") {
        params.since = JSON.stringify(params.since);
      }

      if (opts.descending) {
        if (limit) {
          params.limit = leftToFetch;
        }
      } else {
        params.limit = (!limit || leftToFetch > batchSize) ?
          batchSize : leftToFetch;
      }

      // Set the options for the ajax call
      var xhrOpts = {
        method: method,
        url: genDBUrl(host, '_changes' + paramsToStr(params)),
        timeout: opts.timeout,
        body: body
      };
      lastFetchedSeq = since;

      /* istanbul ignore if */
      if (opts.aborted) {
        return;
      }

      // Get the changes
      setup().then(function () {
        xhr = ajax$$1(opts, xhrOpts, callback);
      }).catch(callback);
    };

    // If opts.since exists, get all the changes from the sequence
    // number given by opts.since. Otherwise, get all the changes
    // from the sequence number 0.
    var results = {results: []};

    var fetched = function (err, res) {
      if (opts.aborted) {
        return;
      }
      var raw_results_length = 0;
      // If the result of the ajax call (res) contains changes (res.results)
      if (res && res.results) {
        raw_results_length = res.results.length;
        results.last_seq = res.last_seq;
        // For each change
        var req = {};
        req.query = opts.query_params;
        res.results = res.results.filter(function (c) {
          leftToFetch--;
          var ret = filterChange(opts)(c);
          if (ret) {
            if (opts.include_docs && opts.attachments && opts.binary) {
              readAttachmentsAsBlobOrBuffer(c);
            }
            if (returnDocs) {
              results.results.push(c);
            }
            opts.onChange(c);
          }
          return ret;
        });
      } else if (err) {
        // In case of an error, stop listening for changes and call
        // opts.complete
        opts.aborted = true;
        opts.complete(err);
        return;
      }

      // The changes feed may have timed out with no results
      // if so reuse last update sequence
      if (res && res.last_seq) {
        lastFetchedSeq = res.last_seq;
      }

      var finished = (limit && leftToFetch <= 0) ||
        (res && raw_results_length < batchSize) ||
        (opts.descending);

      if ((opts.continuous && !(limit && leftToFetch <= 0)) || !finished) {
        // Queue a call to fetch again with the newest sequence number
        nextTick(function () { fetch(lastFetchedSeq, fetched); });
      } else {
        // We're done, call the callback
        opts.complete(null, results);
      }
    };

    fetch(opts.since || 0, fetched);

    // Return a method to cancel this method from processing any more
    return {
      cancel: function () {
        opts.aborted = true;
        if (xhr) {
          xhr.abort();
        }
      }
    };
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun$$1('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    // Get the missing document/revision IDs
    ajax$$1(opts, {
      method: 'POST',
      url: genDBUrl(host, '_revs_diff'),
      body: req
    }, callback);
  });

  api._close = function (callback) {
    callback();
  };

  api._destroy = function (options, callback) {
    ajax$$1(options, {
      url: genDBUrl(host, ''),
      method: 'DELETE'
    }, function (err, resp) {
      if (err && err.status && err.status !== 404) {
        return callback(err);
      }
      callback(null, resp);
    });
  };
}

// HttpPouch is a valid adapter.
HttpPouch.valid = function () {
  return true;
};

var HttpPouch$1 = function (PouchDB) {
  PouchDB.adapter('http', HttpPouch, false);
  PouchDB.adapter('https', HttpPouch, false);
};

function QueryParseError(message) {
  this.status = 400;
  this.name = 'query_parse_error';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, QueryParseError);
  } catch (e) {}
}

inherits(QueryParseError, Error);

function NotFoundError(message) {
  this.status = 404;
  this.name = 'not_found';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, NotFoundError);
  } catch (e) {}
}

inherits(NotFoundError, Error);

function BuiltInError(message) {
  this.status = 500;
  this.name = 'invalid_value';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, BuiltInError);
  } catch (e) {}
}

inherits(BuiltInError, Error);

function promisedCallback(promise, callback) {
  if (callback) {
    promise.then(function (res) {
      nextTick(function () {
        callback(null, res);
      });
    }, function (reason) {
      nextTick(function () {
        callback(reason);
      });
    });
  }
  return promise;
}

function callbackify(fun) {
  return getArguments(function (args) {
    var cb = args.pop();
    var promise = fun.apply(this, args);
    if (typeof cb === 'function') {
      promisedCallback(promise, cb);
    }
    return promise;
  });
}

// Promise finally util similar to Q.finally
function fin(promise, finalPromiseFactory) {
  return promise.then(function (res) {
    return finalPromiseFactory().then(function () {
      return res;
    });
  }, function (reason) {
    return finalPromiseFactory().then(function () {
      throw reason;
    });
  });
}

function sequentialize(queue, promiseFactory) {
  return function () {
    var args = arguments;
    var that = this;
    return queue.add(function () {
      return promiseFactory.apply(that, args);
    });
  };
}

// uniq an array of strings, order not guaranteed
// similar to underscore/lodash _.uniq
function uniq(arr) {
  var theSet = new ExportedSet(arr);
  var result = new Array(theSet.size);
  var index = -1;
  theSet.forEach(function (value) {
    result[++index] = value;
  });
  return result;
}

function mapToKeysArray(map) {
  var result = new Array(map.size);
  var index = -1;
  map.forEach(function (value, key) {
    result[++index] = key;
  });
  return result;
}

function createBuiltInError(name) {
  var message = 'builtin ' + name +
    ' function requires map values to be numbers' +
    ' or number arrays';
  return new BuiltInError(message);
}

function sum(values) {
  var result = 0;
  for (var i = 0, len = values.length; i < len; i++) {
    var num = values[i];
    if (typeof num !== 'number') {
      if (Array.isArray(num)) {
        // lists of numbers are also allowed, sum them separately
        result = typeof result === 'number' ? [result] : result;
        for (var j = 0, jLen = num.length; j < jLen; j++) {
          var jNum = num[j];
          if (typeof jNum !== 'number') {
            throw createBuiltInError('_sum');
          } else if (typeof result[j] === 'undefined') {
            result.push(jNum);
          } else {
            result[j] += jNum;
          }
        }
      } else { // not array/number
        throw createBuiltInError('_sum');
      }
    } else if (typeof result === 'number') {
      result += num;
    } else { // add number to array
      result[0] += num;
    }
  }
  return result;
}

var log = guardedConsole.bind(null, 'log');
var isArray = Array.isArray;
var toJSON = JSON.parse;

function evalFunctionWithEval(func, emit) {
  return scopeEval(
    "return (" + func.replace(/;\s*$/, "") + ");",
    {
      emit: emit,
      sum: sum,
      log: log,
      isArray: isArray,
      toJSON: toJSON
    }
  );
}

/*
 * Simple task queue to sequentialize actions. Assumes
 * callbacks will eventually fire (once).
 */


function TaskQueue$2() {
  this.promise = new PouchPromise$1(function (fulfill) {fulfill(); });
}
TaskQueue$2.prototype.add = function (promiseFactory) {
  this.promise = this.promise.catch(function () {
    // just recover
  }).then(function () {
    return promiseFactory();
  });
  return this.promise;
};
TaskQueue$2.prototype.finish = function () {
  return this.promise;
};

function stringify(input) {
  if (!input) {
    return 'undefined'; // backwards compat for empty reduce
  }
  // for backwards compat with mapreduce, functions/strings are stringified
  // as-is. everything else is JSON-stringified.
  switch (typeof input) {
    case 'function':
      // e.g. a mapreduce map
      return input.toString();
    case 'string':
      // e.g. a mapreduce built-in _reduce function
      return input.toString();
    default:
      // e.g. a JSON object in the case of mango queries
      return JSON.stringify(input);
  }
}

/* create a string signature for a view so we can cache it and uniq it */
function createViewSignature(mapFun, reduceFun) {
  // the "undefined" part is for backwards compatibility
  return stringify(mapFun) + stringify(reduceFun) + 'undefined';
}

function createView(sourceDB, viewName, mapFun, reduceFun, temporary, localDocName) {
  var viewSignature = createViewSignature(mapFun, reduceFun);

  var cachedViews;
  if (!temporary) {
    // cache this to ensure we don't try to update the same view twice
    cachedViews = sourceDB._cachedViews = sourceDB._cachedViews || {};
    if (cachedViews[viewSignature]) {
      return cachedViews[viewSignature];
    }
  }

  var promiseForView = sourceDB.info().then(function (info) {

    var depDbName = info.db_name + '-mrview-' +
      (temporary ? 'temp' : stringMd5(viewSignature));

    // save the view name in the source db so it can be cleaned up if necessary
    // (e.g. when the _design doc is deleted, remove all associated view data)
    function diffFunction(doc) {
      doc.views = doc.views || {};
      var fullViewName = viewName;
      if (fullViewName.indexOf('/') === -1) {
        fullViewName = viewName + '/' + viewName;
      }
      var depDbs = doc.views[fullViewName] = doc.views[fullViewName] || {};
      /* istanbul ignore if */
      if (depDbs[depDbName]) {
        return; // no update necessary
      }
      depDbs[depDbName] = true;
      return doc;
    }
    return upsert(sourceDB, '_local/' + localDocName, diffFunction).then(function () {
      return sourceDB.registerDependentDatabase(depDbName).then(function (res) {
        var db = res.db;
        db.auto_compaction = true;
        var view = {
          name: depDbName,
          db: db,
          sourceDB: sourceDB,
          adapter: sourceDB.adapter,
          mapFun: mapFun,
          reduceFun: reduceFun
        };
        return view.db.get('_local/lastSeq').catch(function (err) {
          /* istanbul ignore if */
          if (err.status !== 404) {
            throw err;
          }
        }).then(function (lastSeqDoc) {
          view.seq = lastSeqDoc ? lastSeqDoc.seq : 0;
          if (cachedViews) {
            view.db.once('destroyed', function () {
              delete cachedViews[viewSignature];
            });
          }
          return view;
        });
      });
    });
  });

  if (cachedViews) {
    cachedViews[viewSignature] = promiseForView;
  }
  return promiseForView;
}

var persistentQueues = {};
var tempViewQueue = new TaskQueue$2();
var CHANGES_BATCH_SIZE$1 = 50;

function parseViewName(name) {
  // can be either 'ddocname/viewname' or just 'viewname'
  // (where the ddoc name is the same)
  return name.indexOf('/') === -1 ? [name, name] : name.split('/');
}

function isGenOne(changes) {
  // only return true if the current change is 1-
  // and there are no other leafs
  return changes.length === 1 && /^1-/.test(changes[0].rev);
}

function emitError(db, e) {
  try {
    db.emit('error', e);
  } catch (err) {
    guardedConsole('error',
      'The user\'s map/reduce function threw an uncaught error.\n' +
      'You can debug this error by doing:\n' +
      'myDatabase.on(\'error\', function (err) { debugger; });\n' +
      'Please double-check your map/reduce function.');
    guardedConsole('error', e);
  }
}

/**
 * Returns an "abstract" mapreduce object of the form:
 *
 *   {
 *     query: queryFun,
 *     viewCleanup: viewCleanupFun
 *   }
 *
 * Arguments are:
 *
 * localDoc: string
 *   This is for the local doc that gets saved in order to track the
 *   "dependent" DBs and clean them up for viewCleanup. It should be
 *   unique, so that indexer plugins don't collide with each other.
 * mapper: function (mapFunDef, emit)
 *   Returns a map function based on the mapFunDef, which in the case of
 *   normal map/reduce is just the de-stringified function, but may be
 *   something else, such as an object in the case of pouchdb-find.
 * reducer: function (reduceFunDef)
 *   Ditto, but for reducing. Modules don't have to support reducing
 *   (e.g. pouchdb-find).
 * ddocValidator: function (ddoc, viewName)
 *   Throws an error if the ddoc or viewName is not valid.
 *   This could be a way to communicate to the user that the configuration for the
 *   indexer is invalid.
 */
function createAbstractMapReduce(localDocName, mapper, reducer, ddocValidator) {

  function tryMap(db, fun, doc) {
    // emit an event if there was an error thrown by a map function.
    // putting try/catches in a single function also avoids deoptimizations.
    try {
      fun(doc);
    } catch (e) {
      emitError(db, e);
    }
  }

  function tryReduce(db, fun, keys, values, rereduce) {
    // same as above, but returning the result or an error. there are two separate
    // functions to avoid extra memory allocations since the tryCode() case is used
    // for custom map functions (common) vs this function, which is only used for
    // custom reduce functions (rare)
    try {
      return {output : fun(keys, values, rereduce)};
    } catch (e) {
      emitError(db, e);
      return {error: e};
    }
  }

  function sortByKeyThenValue(x, y) {
    var keyCompare = collate(x.key, y.key);
    return keyCompare !== 0 ? keyCompare : collate(x.value, y.value);
  }

  function sliceResults(results, limit, skip) {
    skip = skip || 0;
    if (typeof limit === 'number') {
      return results.slice(skip, limit + skip);
    } else if (skip > 0) {
      return results.slice(skip);
    }
    return results;
  }

  function rowToDocId(row) {
    var val = row.value;
    // Users can explicitly specify a joined doc _id, or it
    // defaults to the doc _id that emitted the key/value.
    var docId = (val && typeof val === 'object' && val._id) || row.id;
    return docId;
  }

  function readAttachmentsAsBlobOrBuffer(res) {
    res.rows.forEach(function (row) {
      var atts = row.doc && row.doc._attachments;
      if (!atts) {
        return;
      }
      Object.keys(atts).forEach(function (filename) {
        var att = atts[filename];
        atts[filename].data = b64ToBluffer(att.data, att.content_type);
      });
    });
  }

  function postprocessAttachments(opts) {
    return function (res) {
      if (opts.include_docs && opts.attachments && opts.binary) {
        readAttachmentsAsBlobOrBuffer(res);
      }
      return res;
    };
  }

  function addHttpParam(paramName, opts, params, asJson) {
    // add an http param from opts to params, optionally json-encoded
    var val = opts[paramName];
    if (typeof val !== 'undefined') {
      if (asJson) {
        val = encodeURIComponent(JSON.stringify(val));
      }
      params.push(paramName + '=' + val);
    }
  }

  function coerceInteger(integerCandidate) {
    if (typeof integerCandidate !== 'undefined') {
      var asNumber = Number(integerCandidate);
      // prevents e.g. '1foo' or '1.1' being coerced to 1
      if (!isNaN(asNumber) && asNumber === parseInt(integerCandidate, 10)) {
        return asNumber;
      } else {
        return integerCandidate;
      }
    }
  }

  function coerceOptions(opts) {
    opts.group_level = coerceInteger(opts.group_level);
    opts.limit = coerceInteger(opts.limit);
    opts.skip = coerceInteger(opts.skip);
    return opts;
  }

  function checkPositiveInteger(number) {
    if (number) {
      if (typeof number !== 'number') {
        return  new QueryParseError('Invalid value for integer: "' +
          number + '"');
      }
      if (number < 0) {
        return new QueryParseError('Invalid value for positive integer: ' +
          '"' + number + '"');
      }
    }
  }

  function checkQueryParseError(options, fun) {
    var startkeyName = options.descending ? 'endkey' : 'startkey';
    var endkeyName = options.descending ? 'startkey' : 'endkey';

    if (typeof options[startkeyName] !== 'undefined' &&
      typeof options[endkeyName] !== 'undefined' &&
      collate(options[startkeyName], options[endkeyName]) > 0) {
      throw new QueryParseError('No rows can match your key range, ' +
        'reverse your start_key and end_key or set {descending : true}');
    } else if (fun.reduce && options.reduce !== false) {
      if (options.include_docs) {
        throw new QueryParseError('{include_docs:true} is invalid for reduce');
      } else if (options.keys && options.keys.length > 1 &&
        !options.group && !options.group_level) {
        throw new QueryParseError('Multi-key fetches for reduce views must use ' +
          '{group: true}');
      }
    }
    ['group_level', 'limit', 'skip'].forEach(function (optionName) {
      var error = checkPositiveInteger(options[optionName]);
      if (error) {
        throw error;
      }
    });
  }

  function httpQuery(db, fun, opts) {
    // List of parameters to add to the PUT request
    var params = [];
    var body;
    var method = 'GET';

    // If opts.reduce exists and is defined, then add it to the list
    // of parameters.
    // If reduce=false then the results are that of only the map function
    // not the final result of map and reduce.
    addHttpParam('reduce', opts, params);
    addHttpParam('include_docs', opts, params);
    addHttpParam('attachments', opts, params);
    addHttpParam('limit', opts, params);
    addHttpParam('descending', opts, params);
    addHttpParam('group', opts, params);
    addHttpParam('group_level', opts, params);
    addHttpParam('skip', opts, params);
    addHttpParam('stale', opts, params);
    addHttpParam('conflicts', opts, params);
    addHttpParam('startkey', opts, params, true);
    addHttpParam('start_key', opts, params, true);
    addHttpParam('endkey', opts, params, true);
    addHttpParam('end_key', opts, params, true);
    addHttpParam('inclusive_end', opts, params);
    addHttpParam('key', opts, params, true);

    // Format the list of parameters into a valid URI query string
    params = params.join('&');
    params = params === '' ? '' : '?' + params;

    // If keys are supplied, issue a POST to circumvent GET query string limits
    // see http://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
    if (typeof opts.keys !== 'undefined') {
      var MAX_URL_LENGTH = 2000;
      // according to http://stackoverflow.com/a/417184/680742,
      // the de facto URL length limit is 2000 characters

      var keysAsString =
        'keys=' + encodeURIComponent(JSON.stringify(opts.keys));
      if (keysAsString.length + params.length + 1 <= MAX_URL_LENGTH) {
        // If the keys are short enough, do a GET. we do this to work around
        // Safari not understanding 304s on POSTs (see pouchdb/pouchdb#1239)
        params += (params[0] === '?' ? '&' : '?') + keysAsString;
      } else {
        method = 'POST';
        if (typeof fun === 'string') {
          body = {keys: opts.keys};
        } else { // fun is {map : mapfun}, so append to this
          fun.keys = opts.keys;
        }
      }
    }

    // We are referencing a query defined in the design doc
    if (typeof fun === 'string') {
      var parts = parseViewName(fun);
      return db.request({
        method: method,
        url: '_design/' + parts[0] + '/_view/' + parts[1] + params,
        body: body
      }).then(postprocessAttachments(opts));
    }

    // We are using a temporary view, terrible for performance, good for testing
    body = body || {};
    Object.keys(fun).forEach(function (key) {
      if (Array.isArray(fun[key])) {
        body[key] = fun[key];
      } else {
        body[key] = fun[key].toString();
      }
    });
    return db.request({
      method: 'POST',
      url: '_temp_view' + params,
      body: body
    }).then(postprocessAttachments(opts));
  }

  // custom adapters can define their own api._query
  // and override the default behavior
  /* istanbul ignore next */
  function customQuery(db, fun, opts) {
    return new PouchPromise$1(function (resolve, reject) {
      db._query(fun, opts, function (err, res) {
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
    });
  }

  // custom adapters can define their own api._viewCleanup
  // and override the default behavior
  /* istanbul ignore next */
  function customViewCleanup(db) {
    return new PouchPromise$1(function (resolve, reject) {
      db._viewCleanup(function (err, res) {
        if (err) {
          return reject(err);
        }
        resolve(res);
      });
    });
  }

  function defaultsTo(value) {
    return function (reason) {
      /* istanbul ignore else */
      if (reason.status === 404) {
        return value;
      } else {
        throw reason;
      }
    };
  }

  // returns a promise for a list of docs to update, based on the input docId.
  // the order doesn't matter, because post-3.2.0, bulkDocs
  // is an atomic operation in all three adapters.
  function getDocsToPersist(docId, view, docIdsToChangesAndEmits) {
    var metaDocId = '_local/doc_' + docId;
    var defaultMetaDoc = {_id: metaDocId, keys: []};
    var docData = docIdsToChangesAndEmits.get(docId);
    var indexableKeysToKeyValues = docData[0];
    var changes = docData[1];

    function getMetaDoc() {
      if (isGenOne(changes)) {
        // generation 1, so we can safely assume initial state
        // for performance reasons (avoids unnecessary GETs)
        return PouchPromise$1.resolve(defaultMetaDoc);
      }
      return view.db.get(metaDocId).catch(defaultsTo(defaultMetaDoc));
    }

    function getKeyValueDocs(metaDoc) {
      if (!metaDoc.keys.length) {
        // no keys, no need for a lookup
        return PouchPromise$1.resolve({rows: []});
      }
      return view.db.allDocs({
        keys: metaDoc.keys,
        include_docs: true
      });
    }

    function processKeyValueDocs(metaDoc, kvDocsRes) {
      var kvDocs = [];
      var oldKeys = new ExportedSet();

      for (var i = 0, len = kvDocsRes.rows.length; i < len; i++) {
        var row = kvDocsRes.rows[i];
        var doc = row.doc;
        if (!doc) { // deleted
          continue;
        }
        kvDocs.push(doc);
        oldKeys.add(doc._id);
        doc._deleted = !indexableKeysToKeyValues.has(doc._id);
        if (!doc._deleted) {
          var keyValue = indexableKeysToKeyValues.get(doc._id);
          if ('value' in keyValue) {
            doc.value = keyValue.value;
          }
        }
      }
      var newKeys = mapToKeysArray(indexableKeysToKeyValues);
      newKeys.forEach(function (key) {
        if (!oldKeys.has(key)) {
          // new doc
          var kvDoc = {
            _id: key
          };
          var keyValue = indexableKeysToKeyValues.get(key);
          if ('value' in keyValue) {
            kvDoc.value = keyValue.value;
          }
          kvDocs.push(kvDoc);
        }
      });
      metaDoc.keys = uniq(newKeys.concat(metaDoc.keys));
      kvDocs.push(metaDoc);

      return kvDocs;
    }

    return getMetaDoc().then(function (metaDoc) {
      return getKeyValueDocs(metaDoc).then(function (kvDocsRes) {
        return processKeyValueDocs(metaDoc, kvDocsRes);
      });
    });
  }

  // updates all emitted key/value docs and metaDocs in the mrview database
  // for the given batch of documents from the source database
  function saveKeyValues(view, docIdsToChangesAndEmits, seq) {
    var seqDocId = '_local/lastSeq';
    return view.db.get(seqDocId)
      .catch(defaultsTo({_id: seqDocId, seq: 0}))
      .then(function (lastSeqDoc) {
        var docIds = mapToKeysArray(docIdsToChangesAndEmits);
        return PouchPromise$1.all(docIds.map(function (docId) {
          return getDocsToPersist(docId, view, docIdsToChangesAndEmits);
        })).then(function (listOfDocsToPersist) {
          var docsToPersist = flatten(listOfDocsToPersist);
          lastSeqDoc.seq = seq;
          docsToPersist.push(lastSeqDoc);
          // write all docs in a single operation, update the seq once
          return view.db.bulkDocs({docs : docsToPersist});
        });
      });
  }

  function getQueue(view) {
    var viewName = typeof view === 'string' ? view : view.name;
    var queue = persistentQueues[viewName];
    if (!queue) {
      queue = persistentQueues[viewName] = new TaskQueue$2();
    }
    return queue;
  }

  function updateView(view) {
    return sequentialize(getQueue(view), function () {
      return updateViewInQueue(view);
    })();
  }

  function updateViewInQueue(view) {
    // bind the emit function once
    var mapResults;
    var doc;

    function emit(key, value) {
      var output = {id: doc._id, key: normalizeKey(key)};
      // Don't explicitly store the value unless it's defined and non-null.
      // This saves on storage space, because often people don't use it.
      if (typeof value !== 'undefined' && value !== null) {
        output.value = normalizeKey(value);
      }
      mapResults.push(output);
    }

    var mapFun = mapper(view.mapFun, emit);

    var currentSeq = view.seq || 0;

    function processChange(docIdsToChangesAndEmits, seq) {
      return function () {
        return saveKeyValues(view, docIdsToChangesAndEmits, seq);
      };
    }

    var queue = new TaskQueue$2();

    function processNextBatch() {
      return view.sourceDB.changes({
        conflicts: true,
        include_docs: true,
        style: 'all_docs',
        since: currentSeq,
        limit: CHANGES_BATCH_SIZE$1
      }).then(processBatch);
    }

    function processBatch(response) {
      var results = response.results;
      if (!results.length) {
        return;
      }
      var docIdsToChangesAndEmits = createDocIdsToChangesAndEmits(results);
      queue.add(processChange(docIdsToChangesAndEmits, currentSeq));
      if (results.length < CHANGES_BATCH_SIZE$1) {
        return;
      }
      return processNextBatch();
    }

    function createDocIdsToChangesAndEmits(results) {
      var docIdsToChangesAndEmits = new ExportedMap();
      for (var i = 0, len = results.length; i < len; i++) {
        var change = results[i];
        if (change.doc._id[0] !== '_') {
          mapResults = [];
          doc = change.doc;

          if (!doc._deleted) {
            tryMap(view.sourceDB, mapFun, doc);
          }
          mapResults.sort(sortByKeyThenValue);

          var indexableKeysToKeyValues = createIndexableKeysToKeyValues(mapResults);
          docIdsToChangesAndEmits.set(change.doc._id, [
            indexableKeysToKeyValues,
            change.changes
          ]);
        }
        currentSeq = change.seq;
      }
      return docIdsToChangesAndEmits;
    }

    function createIndexableKeysToKeyValues(mapResults) {
      var indexableKeysToKeyValues = new ExportedMap();
      var lastKey;
      for (var i = 0, len = mapResults.length; i < len; i++) {
        var emittedKeyValue = mapResults[i];
        var complexKey = [emittedKeyValue.key, emittedKeyValue.id];
        if (i > 0 && collate(emittedKeyValue.key, lastKey) === 0) {
          complexKey.push(i); // dup key+id, so make it unique
        }
        indexableKeysToKeyValues.set(toIndexableString(complexKey), emittedKeyValue);
        lastKey = emittedKeyValue.key;
      }
      return indexableKeysToKeyValues;
    }

    return processNextBatch().then(function () {
      return queue.finish();
    }).then(function () {
      view.seq = currentSeq;
    });
  }

  function reduceView(view, results, options) {
    if (options.group_level === 0) {
      delete options.group_level;
    }

    var shouldGroup = options.group || options.group_level;

    var reduceFun = reducer(view.reduceFun);

    var groups = [];
    var lvl = isNaN(options.group_level) ? Number.POSITIVE_INFINITY :
      options.group_level;
    results.forEach(function (e) {
      var last = groups[groups.length - 1];
      var groupKey = shouldGroup ? e.key : null;

      // only set group_level for array keys
      if (shouldGroup && Array.isArray(groupKey)) {
        groupKey = groupKey.slice(0, lvl);
      }

      if (last && collate(last.groupKey, groupKey) === 0) {
        last.keys.push([e.key, e.id]);
        last.values.push(e.value);
        return;
      }
      groups.push({
        keys: [[e.key, e.id]],
        values: [e.value],
        groupKey: groupKey
      });
    });
    results = [];
    for (var i = 0, len = groups.length; i < len; i++) {
      var e = groups[i];
      var reduceTry = tryReduce(view.sourceDB, reduceFun, e.keys, e.values, false);
      if (reduceTry.error && reduceTry.error instanceof BuiltInError) {
        // CouchDB returns an error if a built-in errors out
        throw reduceTry.error;
      }
      results.push({
        // CouchDB just sets the value to null if a non-built-in errors out
        value: reduceTry.error ? null : reduceTry.output,
        key: e.groupKey
      });
    }
    // no total_rows/offset when reducing
    return {rows: sliceResults(results, options.limit, options.skip)};
  }

  function queryView(view, opts) {
    return sequentialize(getQueue(view), function () {
      return queryViewInQueue(view, opts);
    })();
  }

  function queryViewInQueue(view, opts) {
    var totalRows;
    var shouldReduce = view.reduceFun && opts.reduce !== false;
    var skip = opts.skip || 0;
    if (typeof opts.keys !== 'undefined' && !opts.keys.length) {
      // equivalent query
      opts.limit = 0;
      delete opts.keys;
    }

    function fetchFromView(viewOpts) {
      viewOpts.include_docs = true;
      return view.db.allDocs(viewOpts).then(function (res) {
        totalRows = res.total_rows;
        return res.rows.map(function (result) {

          // implicit migration - in older versions of PouchDB,
          // we explicitly stored the doc as {id: ..., key: ..., value: ...}
          // this is tested in a migration test
          /* istanbul ignore next */
          if ('value' in result.doc && typeof result.doc.value === 'object' &&
            result.doc.value !== null) {
            var keys = Object.keys(result.doc.value).sort();
            // this detection method is not perfect, but it's unlikely the user
            // emitted a value which was an object with these 3 exact keys
            var expectedKeys = ['id', 'key', 'value'];
            if (!(keys < expectedKeys || keys > expectedKeys)) {
              return result.doc.value;
            }
          }

          var parsedKeyAndDocId = parseIndexableString(result.doc._id);
          return {
            key: parsedKeyAndDocId[0],
            id: parsedKeyAndDocId[1],
            value: ('value' in result.doc ? result.doc.value : null)
          };
        });
      });
    }

    function onMapResultsReady(rows) {
      var finalResults;
      if (shouldReduce) {
        finalResults = reduceView(view, rows, opts);
      } else {
        finalResults = {
          total_rows: totalRows,
          offset: skip,
          rows: rows
        };
      }
      if (opts.include_docs) {
        var docIds = uniq(rows.map(rowToDocId));

        return view.sourceDB.allDocs({
          keys: docIds,
          include_docs: true,
          conflicts: opts.conflicts,
          attachments: opts.attachments,
          binary: opts.binary
        }).then(function (allDocsRes) {
          var docIdsToDocs = new ExportedMap();
          allDocsRes.rows.forEach(function (row) {
            docIdsToDocs.set(row.id, row.doc);
          });
          rows.forEach(function (row) {
            var docId = rowToDocId(row);
            var doc = docIdsToDocs.get(docId);
            if (doc) {
              row.doc = doc;
            }
          });
          return finalResults;
        });
      } else {
        return finalResults;
      }
    }

    if (typeof opts.keys !== 'undefined') {
      var keys = opts.keys;
      var fetchPromises = keys.map(function (key) {
        var viewOpts = {
          startkey : toIndexableString([key]),
          endkey   : toIndexableString([key, {}])
        };
        return fetchFromView(viewOpts);
      });
      return PouchPromise$1.all(fetchPromises).then(flatten).then(onMapResultsReady);
    } else { // normal query, no 'keys'
      var viewOpts = {
        descending : opts.descending
      };
      var startkey;
      var endkey;
      if ('start_key' in opts) {
        startkey = opts.start_key;
      }
      if ('startkey' in opts) {
        startkey = opts.startkey;
      }
      if ('end_key' in opts) {
        endkey = opts.end_key;
      }
      if ('endkey' in opts) {
        endkey = opts.endkey;
      }
      if (typeof startkey !== 'undefined') {
        viewOpts.startkey = opts.descending ?
          toIndexableString([startkey, {}]) :
          toIndexableString([startkey]);
      }
      if (typeof endkey !== 'undefined') {
        var inclusiveEnd = opts.inclusive_end !== false;
        if (opts.descending) {
          inclusiveEnd = !inclusiveEnd;
        }

        viewOpts.endkey = toIndexableString(
          inclusiveEnd ? [endkey, {}] : [endkey]);
      }
      if (typeof opts.key !== 'undefined') {
        var keyStart = toIndexableString([opts.key]);
        var keyEnd = toIndexableString([opts.key, {}]);
        if (viewOpts.descending) {
          viewOpts.endkey = keyStart;
          viewOpts.startkey = keyEnd;
        } else {
          viewOpts.startkey = keyStart;
          viewOpts.endkey = keyEnd;
        }
      }
      if (!shouldReduce) {
        if (typeof opts.limit === 'number') {
          viewOpts.limit = opts.limit;
        }
        viewOpts.skip = skip;
      }
      return fetchFromView(viewOpts).then(onMapResultsReady);
    }
  }

  function httpViewCleanup(db) {
    return db.request({
      method: 'POST',
      url: '_view_cleanup'
    });
  }

  function localViewCleanup(db) {
    return db.get('_local/' + localDocName).then(function (metaDoc) {
      var docsToViews = new ExportedMap();
      Object.keys(metaDoc.views).forEach(function (fullViewName) {
        var parts = parseViewName(fullViewName);
        var designDocName = '_design/' + parts[0];
        var viewName = parts[1];
        var views = docsToViews.get(designDocName);
        if (!views) {
          views = new ExportedSet();
          docsToViews.set(designDocName, views);
        }
        views.add(viewName);
      });
      var opts = {
        keys : mapToKeysArray(docsToViews),
        include_docs : true
      };
      return db.allDocs(opts).then(function (res) {
        var viewsToStatus = {};
        res.rows.forEach(function (row) {
          var ddocName = row.key.substring(8); // cuts off '_design/'
          docsToViews.get(row.key).forEach(function (viewName) {
            var fullViewName = ddocName + '/' + viewName;
            /* istanbul ignore if */
            if (!metaDoc.views[fullViewName]) {
              // new format, without slashes, to support PouchDB 2.2.0
              // migration test in pouchdb's browser.migration.js verifies this
              fullViewName = viewName;
            }
            var viewDBNames = Object.keys(metaDoc.views[fullViewName]);
            // design doc deleted, or view function nonexistent
            var statusIsGood = row.doc && row.doc.views &&
              row.doc.views[viewName];
            viewDBNames.forEach(function (viewDBName) {
              viewsToStatus[viewDBName] =
                viewsToStatus[viewDBName] || statusIsGood;
            });
          });
        });
        var dbsToDelete = Object.keys(viewsToStatus).filter(
          function (viewDBName) { return !viewsToStatus[viewDBName]; });
        var destroyPromises = dbsToDelete.map(function (viewDBName) {
          return sequentialize(getQueue(viewDBName), function () {
            return new db.constructor(viewDBName, db.__opts).destroy();
          })();
        });
        return PouchPromise$1.all(destroyPromises).then(function () {
          return {ok: true};
        });
      });
    }, defaultsTo({ok: true}));
  }

  function queryPromised(db, fun, opts) {
    /* istanbul ignore next */
    if (typeof db._query === 'function') {
      return customQuery(db, fun, opts);
    }
    if (isRemote(db)) {
      return httpQuery(db, fun, opts);
    }

    if (typeof fun !== 'string') {
      // temp_view
      checkQueryParseError(opts, fun);

      tempViewQueue.add(function () {
        var createViewPromise = createView(
          /* sourceDB */ db,
          /* viewName */ 'temp_view/temp_view',
          /* mapFun */ fun.map,
          /* reduceFun */ fun.reduce,
          /* temporary */ true,
          /* localDocName */ localDocName);
        return createViewPromise.then(function (view) {
          return fin(updateView(view).then(function () {
            return queryView(view, opts);
          }), function () {
            return view.db.destroy();
          });
        });
      });
      return tempViewQueue.finish();
    } else {
      // persistent view
      var fullViewName = fun;
      var parts = parseViewName(fullViewName);
      var designDocName = parts[0];
      var viewName = parts[1];
      return db.get('_design/' + designDocName).then(function (doc) {
        var fun = doc.views && doc.views[viewName];

        if (!fun) {
          // basic validator; it's assumed that every subclass would want this
          throw new NotFoundError('ddoc ' + doc._id + ' has no view named ' +
            viewName);
        }

        ddocValidator(doc, viewName);
        checkQueryParseError(opts, fun);

        var createViewPromise = createView(
          /* sourceDB */ db,
          /* viewName */ fullViewName,
          /* mapFun */ fun.map,
          /* reduceFun */ fun.reduce,
          /* temporary */ false,
          /* localDocName */ localDocName);
        return createViewPromise.then(function (view) {
          if (opts.stale === 'ok' || opts.stale === 'update_after') {
            if (opts.stale === 'update_after') {
              nextTick(function () {
                updateView(view);
              });
            }
            return queryView(view, opts);
          } else { // stale not ok
            return updateView(view).then(function () {
              return queryView(view, opts);
            });
          }
        });
      });
    }
  }

  function abstractQuery(fun, opts, callback) {
    var db = this;
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = opts ? coerceOptions(opts) : {};

    if (typeof fun === 'function') {
      fun = {map : fun};
    }

    var promise = PouchPromise$1.resolve().then(function () {
      return queryPromised(db, fun, opts);
    });
    promisedCallback(promise, callback);
    return promise;
  }

  var abstractViewCleanup = callbackify(function () {
    var db = this;
    /* istanbul ignore next */
    if (typeof db._viewCleanup === 'function') {
      return customViewCleanup(db);
    }
    if (isRemote(db)) {
      return httpViewCleanup(db);
    }
    return localViewCleanup(db);
  });

  return {
    query: abstractQuery,
    viewCleanup: abstractViewCleanup
  };
}

var builtInReduce = {
  _sum: function (keys, values) {
    return sum(values);
  },

  _count: function (keys, values) {
    return values.length;
  },

  _stats: function (keys, values) {
    // no need to implement rereduce=true, because Pouch
    // will never call it
    function sumsqr(values) {
      var _sumsqr = 0;
      for (var i = 0, len = values.length; i < len; i++) {
        var num = values[i];
        _sumsqr += (num * num);
      }
      return _sumsqr;
    }
    return {
      sum     : sum(values),
      min     : Math.min.apply(null, values),
      max     : Math.max.apply(null, values),
      count   : values.length,
      sumsqr : sumsqr(values)
    };
  }
};

function mapper(mapFun, emit) {
  // for temp_views one can use emit(doc, emit), see #38
  if (typeof mapFun === "function" && mapFun.length === 2) {
    var origMap = mapFun;
    return function (doc) {
      return origMap(doc, emit);
    };
  } else {
    return evalFunctionWithEval(mapFun.toString(), emit);
  }
}

function reducer(reduceFun) {
  if (builtInReduce[reduceFun]) {
    return builtInReduce[reduceFun];
  } else {
    return evalFunctionWithEval(reduceFun.toString());
  }
}

function ddocValidator(ddoc, viewName) {
  var fun = ddoc.views && ddoc.views[viewName];
  if (typeof fun.map !== 'string') {
    throw new NotFoundError('ddoc ' + ddoc._id + ' has no string view named ' +
      viewName + ', instead found object of type: ' + typeof fun.map);
  }
}

var localDocName = 'mrviews';
var abstract = createAbstractMapReduce(localDocName, mapper, reducer, ddocValidator);

function query(fun, opts, callback) {
  return abstract.query.call(this, fun, opts, callback);
}

function viewCleanup(callback) {
  return abstract.viewCleanup.call(this, callback);
}

var mapreduce = {
  query: query,
  viewCleanup: viewCleanup
};

function isGenOne$1(rev) {
  return /^1-/.test(rev);
}

function fileHasChanged(localDoc, remoteDoc, filename) {
  return !localDoc._attachments ||
         !localDoc._attachments[filename] ||
         localDoc._attachments[filename].digest !== remoteDoc._attachments[filename].digest;
}

function getDocAttachments(db, doc) {
  var filenames = Object.keys(doc._attachments);
  return PouchPromise$1.all(filenames.map(function (filename) {
    return db.getAttachment(doc._id, filename, {rev: doc._rev});
  }));
}

function getDocAttachmentsFromTargetOrSource(target, src, doc) {
  var doCheckForLocalAttachments = isRemote(src) && !isRemote(target);
  var filenames = Object.keys(doc._attachments);

  if (!doCheckForLocalAttachments) {
    return getDocAttachments(src, doc);
  }

  return target.get(doc._id).then(function (localDoc) {
    return PouchPromise$1.all(filenames.map(function (filename) {
      if (fileHasChanged(localDoc, doc, filename)) {
        return src.getAttachment(doc._id, filename);
      }

      return target.getAttachment(localDoc._id, filename);
    }));
  }).catch(function (error) {
    /* istanbul ignore if */
    if (error.status !== 404) {
      throw error;
    }

    return getDocAttachments(src, doc);
  });
}

function createBulkGetOpts(diffs) {
  var requests = [];
  Object.keys(diffs).forEach(function (id) {
    var missingRevs = diffs[id].missing;
    missingRevs.forEach(function (missingRev) {
      requests.push({
        id: id,
        rev: missingRev
      });
    });
  });

  return {
    docs: requests,
    revs: true,
    latest: true
  };
}

//
// Fetch all the documents from the src as described in the "diffs",
// which is a mapping of docs IDs to revisions. If the state ever
// changes to "cancelled", then the returned promise will be rejected.
// Else it will be resolved with a list of fetched documents.
//
function getDocs(src, target, diffs, state) {
  diffs = clone(diffs); // we do not need to modify this

  var resultDocs = [],
      ok = true;

  function getAllDocs() {

    var bulkGetOpts = createBulkGetOpts(diffs);

    if (!bulkGetOpts.docs.length) { // optimization: skip empty requests
      return;
    }

    return src.bulkGet(bulkGetOpts).then(function (bulkGetResponse) {
      /* istanbul ignore if */
      if (state.cancelled) {
        throw new Error('cancelled');
      }
      return PouchPromise$1.all(bulkGetResponse.results.map(function (bulkGetInfo) {
        return PouchPromise$1.all(bulkGetInfo.docs.map(function (doc) {
          var remoteDoc = doc.ok;

          if (doc.error) {
            // when AUTO_COMPACTION is set, docs can be returned which look
            // like this: {"missing":"1-7c3ac256b693c462af8442f992b83696"}
            ok = false;
          }

          if (!remoteDoc || !remoteDoc._attachments) {
            return remoteDoc;
          }

          return getDocAttachmentsFromTargetOrSource(target, src, remoteDoc)
                   .then(function (attachments) {
                           var filenames = Object.keys(remoteDoc._attachments);
                           attachments
                             .forEach(function (attachment, i) {
                                        var att = remoteDoc._attachments[filenames[i]];
                                        delete att.stub;
                                        delete att.length;
                                        att.data = attachment;
                                      });

                                      return remoteDoc;
                                    });
        }));
      }))

      .then(function (results) {
        resultDocs = resultDocs.concat(flatten(results).filter(Boolean));
      });
    });
  }

  function hasAttachments(doc) {
    return doc._attachments && Object.keys(doc._attachments).length > 0;
  }

  function hasConflicts(doc) {
    return doc._conflicts && doc._conflicts.length > 0;
  }

  function fetchRevisionOneDocs(ids) {
    // Optimization: fetch gen-1 docs and attachments in
    // a single request using _all_docs
    return src.allDocs({
      keys: ids,
      include_docs: true,
      conflicts: true
    }).then(function (res) {
      if (state.cancelled) {
        throw new Error('cancelled');
      }
      res.rows.forEach(function (row) {
        if (row.deleted || !row.doc || !isGenOne$1(row.value.rev) ||
            hasAttachments(row.doc) || hasConflicts(row.doc)) {
          // if any of these conditions apply, we need to fetch using get()
          return;
        }

        // strip _conflicts array to appease CSG (#5793)
        /* istanbul ignore if */
        if (row.doc._conflicts) {
          delete row.doc._conflicts;
        }

        // the doc we got back from allDocs() is sufficient
        resultDocs.push(row.doc);
        delete diffs[row.id];
      });
    });
  }

  function getRevisionOneDocs() {
    // filter out the generation 1 docs and get them
    // leaving the non-generation one docs to be got otherwise
    var ids = Object.keys(diffs).filter(function (id) {
      var missing = diffs[id].missing;
      return missing.length === 1 && isGenOne$1(missing[0]);
    });
    if (ids.length > 0) {
      return fetchRevisionOneDocs(ids);
    }
  }

  function returnResult() {
    return { ok:ok, docs:resultDocs };
  }

  return PouchPromise$1.resolve()
    .then(getRevisionOneDocs)
    .then(getAllDocs)
    .then(returnResult);
}

var CHECKPOINT_VERSION = 1;
var REPLICATOR = "pouchdb";
// This is an arbitrary number to limit the
// amount of replication history we save in the checkpoint.
// If we save too much, the checkpoing docs will become very big,
// if we save fewer, we'll run a greater risk of having to
// read all the changes from 0 when checkpoint PUTs fail
// CouchDB 2.0 has a more involved history pruning,
// but let's go for the simple version for now.
var CHECKPOINT_HISTORY_SIZE = 5;
var LOWEST_SEQ = 0;

function updateCheckpoint(db, id, checkpoint, session, returnValue) {
  return db.get(id).catch(function (err) {
    if (err.status === 404) {
      if (db.adapter === 'http' || db.adapter === 'https') {
        explainError(
          404, 'PouchDB is just checking if a remote checkpoint exists.'
        );
      }
      return {
        session_id: session,
        _id: id,
        history: [],
        replicator: REPLICATOR,
        version: CHECKPOINT_VERSION
      };
    }
    throw err;
  }).then(function (doc) {
    if (returnValue.cancelled) {
      return;
    }

    // if the checkpoint has not changed, do not update
    if (doc.last_seq === checkpoint) {
      return;
    }

    // Filter out current entry for this replication
    doc.history = (doc.history || []).filter(function (item) {
      return item.session_id !== session;
    });

    // Add the latest checkpoint to history
    doc.history.unshift({
      last_seq: checkpoint,
      session_id: session
    });

    // Just take the last pieces in history, to
    // avoid really big checkpoint docs.
    // see comment on history size above
    doc.history = doc.history.slice(0, CHECKPOINT_HISTORY_SIZE);

    doc.version = CHECKPOINT_VERSION;
    doc.replicator = REPLICATOR;

    doc.session_id = session;
    doc.last_seq = checkpoint;

    return db.put(doc).catch(function (err) {
      if (err.status === 409) {
        // retry; someone is trying to write a checkpoint simultaneously
        return updateCheckpoint(db, id, checkpoint, session, returnValue);
      }
      throw err;
    });
  });
}

function Checkpointer(src, target, id, returnValue) {
  this.src = src;
  this.target = target;
  this.id = id;
  this.returnValue = returnValue;
}

Checkpointer.prototype.writeCheckpoint = function (checkpoint, session) {
  var self = this;
  return this.updateTarget(checkpoint, session).then(function () {
    return self.updateSource(checkpoint, session);
  });
};

Checkpointer.prototype.updateTarget = function (checkpoint, session) {
  return updateCheckpoint(this.target, this.id, checkpoint,
    session, this.returnValue);
};

Checkpointer.prototype.updateSource = function (checkpoint, session) {
  var self = this;
  if (this.readOnlySource) {
    return PouchPromise$1.resolve(true);
  }
  return updateCheckpoint(this.src, this.id, checkpoint,
    session, this.returnValue)
    .catch(function (err) {
      if (isForbiddenError(err)) {
        self.readOnlySource = true;
        return true;
      }
      throw err;
    });
};

var comparisons = {
  "undefined": function (targetDoc, sourceDoc) {
    // This is the previous comparison function
    if (collate(targetDoc.last_seq, sourceDoc.last_seq) === 0) {
      return sourceDoc.last_seq;
    }
    /* istanbul ignore next */
    return 0;
  },
  "1": function (targetDoc, sourceDoc) {
    // This is the comparison function ported from CouchDB
    return compareReplicationLogs(sourceDoc, targetDoc).last_seq;
  }
};

Checkpointer.prototype.getCheckpoint = function () {
  var self = this;
  return self.target.get(self.id).then(function (targetDoc) {
    if (self.readOnlySource) {
      return PouchPromise$1.resolve(targetDoc.last_seq);
    }

    return self.src.get(self.id).then(function (sourceDoc) {
      // Since we can't migrate an old version doc to a new one
      // (no session id), we just go with the lowest seq in this case
      /* istanbul ignore if */
      if (targetDoc.version !== sourceDoc.version) {
        return LOWEST_SEQ;
      }

      var version;
      if (targetDoc.version) {
        version = targetDoc.version.toString();
      } else {
        version = "undefined";
      }

      if (version in comparisons) {
        return comparisons[version](targetDoc, sourceDoc);
      }
      /* istanbul ignore next */
      return LOWEST_SEQ;
    }, function (err) {
      if (err.status === 404 && targetDoc.last_seq) {
        return self.src.put({
          _id: self.id,
          last_seq: LOWEST_SEQ
        }).then(function () {
          return LOWEST_SEQ;
        }, function (err) {
          if (isForbiddenError(err)) {
            self.readOnlySource = true;
            return targetDoc.last_seq;
          }
          /* istanbul ignore next */
          return LOWEST_SEQ;
        });
      }
      throw err;
    });
  }).catch(function (err) {
    if (err.status !== 404) {
      throw err;
    }
    return LOWEST_SEQ;
  });
};
// This checkpoint comparison is ported from CouchDBs source
// they come from here:
// https://github.com/apache/couchdb-couch-replicator/blob/master/src/couch_replicator.erl#L863-L906

function compareReplicationLogs(srcDoc, tgtDoc) {
  if (srcDoc.session_id === tgtDoc.session_id) {
    return {
      last_seq: srcDoc.last_seq,
      history: srcDoc.history
    };
  }

  return compareReplicationHistory(srcDoc.history, tgtDoc.history);
}

function compareReplicationHistory(sourceHistory, targetHistory) {
  // the erlang loop via function arguments is not so easy to repeat in JS
  // therefore, doing this as recursion
  var S = sourceHistory[0];
  var sourceRest = sourceHistory.slice(1);
  var T = targetHistory[0];
  var targetRest = targetHistory.slice(1);

  if (!S || targetHistory.length === 0) {
    return {
      last_seq: LOWEST_SEQ,
      history: []
    };
  }

  var sourceId = S.session_id;
  /* istanbul ignore if */
  if (hasSessionId(sourceId, targetHistory)) {
    return {
      last_seq: S.last_seq,
      history: sourceHistory
    };
  }

  var targetId = T.session_id;
  if (hasSessionId(targetId, sourceRest)) {
    return {
      last_seq: T.last_seq,
      history: targetRest
    };
  }

  return compareReplicationHistory(sourceRest, targetRest);
}

function hasSessionId(sessionId, history) {
  var props = history[0];
  var rest = history.slice(1);

  if (!sessionId || history.length === 0) {
    return false;
  }

  if (sessionId === props.session_id) {
    return true;
  }

  return hasSessionId(sessionId, rest);
}

function isForbiddenError(err) {
  return typeof err.status === 'number' && Math.floor(err.status / 100) === 4;
}

var STARTING_BACK_OFF = 0;

function backOff(opts, returnValue, error, callback) {
  if (opts.retry === false) {
    returnValue.emit('error', error);
    returnValue.removeAllListeners();
    return;
  }
  if (typeof opts.back_off_function !== 'function') {
    opts.back_off_function = defaultBackOff;
  }
  returnValue.emit('requestError', error);
  if (returnValue.state === 'active' || returnValue.state === 'pending') {
    returnValue.emit('paused', error);
    returnValue.state = 'stopped';
    var backOffSet = function backoffTimeSet() {
      opts.current_back_off = STARTING_BACK_OFF;
    };
    var removeBackOffSetter = function removeBackOffTimeSet() {
      returnValue.removeListener('active', backOffSet);
    };
    returnValue.once('paused', removeBackOffSetter);
    returnValue.once('active', backOffSet);
  }

  opts.current_back_off = opts.current_back_off || STARTING_BACK_OFF;
  opts.current_back_off = opts.back_off_function(opts.current_back_off);
  setTimeout(callback, opts.current_back_off);
}

function sortObjectPropertiesByKey(queryParams) {
  return Object.keys(queryParams).sort(collate).reduce(function (result, key) {
    result[key] = queryParams[key];
    return result;
  }, {});
}

// Generate a unique id particular to this replication.
// Not guaranteed to align perfectly with CouchDB's rep ids.
function generateReplicationId(src, target, opts) {
  var docIds = opts.doc_ids ? opts.doc_ids.sort(collate) : '';
  var filterFun = opts.filter ? opts.filter.toString() : '';
  var queryParams = '';
  var filterViewName =  '';
  var selector = '';

  // possibility for checkpoints to be lost here as behaviour of
  // JSON.stringify is not stable (see #6226)
  /* istanbul ignore if */
  if (opts.selector) {
    selector = JSON.stringify(opts.selector);
  }

  if (opts.filter && opts.query_params) {
    queryParams = JSON.stringify(sortObjectPropertiesByKey(opts.query_params));
  }

  if (opts.filter && opts.filter === '_view') {
    filterViewName = opts.view.toString();
  }

  return PouchPromise$1.all([src.id(), target.id()]).then(function (res) {
    var queryData = res[0] + res[1] + filterFun + filterViewName +
      queryParams + docIds + selector;
    return new PouchPromise$1(function (resolve) {
      binaryMd5(queryData, resolve);
    });
  }).then(function (md5sum) {
    // can't use straight-up md5 alphabet, because
    // the char '/' is interpreted as being for attachments,
    // and + is also not url-safe
    md5sum = md5sum.replace(/\//g, '.').replace(/\+/g, '_');
    return '_local/' + md5sum;
  });
}

function replicate(src, target, opts, returnValue, result) {
  var batches = [];               // list of batches to be processed
  var currentBatch;               // the batch currently being processed
  var pendingBatch = {
    seq: 0,
    changes: [],
    docs: []
  }; // next batch, not yet ready to be processed
  var writingCheckpoint = false;  // true while checkpoint is being written
  var changesCompleted = false;   // true when all changes received
  var replicationCompleted = false; // true when replication has completed
  var last_seq = 0;
  var continuous = opts.continuous || opts.live || false;
  var batch_size = opts.batch_size || 100;
  var batches_limit = opts.batches_limit || 10;
  var changesPending = false;     // true while src.changes is running
  var doc_ids = opts.doc_ids;
  var selector = opts.selector;
  var repId;
  var checkpointer;
  var changedDocs = [];
  // Like couchdb, every replication gets a unique session id
  var session = uuid();

  result = result || {
    ok: true,
    start_time: new Date(),
    docs_read: 0,
    docs_written: 0,
    doc_write_failures: 0,
    errors: []
  };

  var changesOpts = {};
  returnValue.ready(src, target);

  function initCheckpointer() {
    if (checkpointer) {
      return PouchPromise$1.resolve();
    }
    return generateReplicationId(src, target, opts).then(function (res) {
      repId = res;
      checkpointer = new Checkpointer(src, target, repId, returnValue);
    });
  }

  function writeDocs() {
    changedDocs = [];

    if (currentBatch.docs.length === 0) {
      return;
    }
    var docs = currentBatch.docs;
    var bulkOpts = {timeout: opts.timeout};
    return target.bulkDocs({docs: docs, new_edits: false}, bulkOpts).then(function (res) {
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }

      // `res` doesn't include full documents (which live in `docs`), so we create a map of 
      // (id -> error), and check for errors while iterating over `docs`
      var errorsById = Object.create(null);
      res.forEach(function (res) {
        if (res.error) {
          errorsById[res.id] = res;
        }
      });

      var errorsNo = Object.keys(errorsById).length;
      result.doc_write_failures += errorsNo;
      result.docs_written += docs.length - errorsNo;

      docs.forEach(function (doc) {
        var error = errorsById[doc._id];
        if (error) {
          result.errors.push(error);
          if (error.name === 'unauthorized' || error.name === 'forbidden') {
            returnValue.emit('denied', clone(error));
          } else {
            throw error;
          }
        } else {
          changedDocs.push(doc);
        }
      });

    }, function (err) {
      result.doc_write_failures += docs.length;
      throw err;
    });
  }

  function finishBatch() {
    if (currentBatch.error) {
      throw new Error('There was a problem getting docs.');
    }
    result.last_seq = last_seq = currentBatch.seq;
    var outResult = clone(result);
    if (changedDocs.length) {
      outResult.docs = changedDocs;
      returnValue.emit('change', outResult);
    }
    writingCheckpoint = true;
    return checkpointer.writeCheckpoint(currentBatch.seq,
        session).then(function () {
      writingCheckpoint = false;
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }
      currentBatch = undefined;
      getChanges();
    }).catch(function (err) {
      onCheckpointError(err);
      throw err;
    });
  }

  function getDiffs() {
    var diff = {};
    currentBatch.changes.forEach(function (change) {
      // Couchbase Sync Gateway emits these, but we can ignore them
      /* istanbul ignore if */
      if (change.id === "_user/") {
        return;
      }
      diff[change.id] = change.changes.map(function (x) {
        return x.rev;
      });
    });
    return target.revsDiff(diff).then(function (diffs) {
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }
      // currentBatch.diffs elements are deleted as the documents are written
      currentBatch.diffs = diffs;
    });
  }

  function getBatchDocs() {
    return getDocs(src, target, currentBatch.diffs, returnValue).then(function (got) {
      currentBatch.error = !got.ok;
      got.docs.forEach(function (doc) {
        delete currentBatch.diffs[doc._id];
        result.docs_read++;
        currentBatch.docs.push(doc);
      });
    });
  }

  function startNextBatch() {
    if (returnValue.cancelled || currentBatch) {
      return;
    }
    if (batches.length === 0) {
      processPendingBatch(true);
      return;
    }
    currentBatch = batches.shift();
    getDiffs()
      .then(getBatchDocs)
      .then(writeDocs)
      .then(finishBatch)
      .then(startNextBatch)
      .catch(function (err) {
        abortReplication('batch processing terminated with error', err);
      });
  }


  function processPendingBatch(immediate) {
    if (pendingBatch.changes.length === 0) {
      if (batches.length === 0 && !currentBatch) {
        if ((continuous && changesOpts.live) || changesCompleted) {
          returnValue.state = 'pending';
          returnValue.emit('paused');
        }
        if (changesCompleted) {
          completeReplication();
        }
      }
      return;
    }
    if (
      immediate ||
      changesCompleted ||
      pendingBatch.changes.length >= batch_size
    ) {
      batches.push(pendingBatch);
      pendingBatch = {
        seq: 0,
        changes: [],
        docs: []
      };
      if (returnValue.state === 'pending' || returnValue.state === 'stopped') {
        returnValue.state = 'active';
        returnValue.emit('active');
      }
      startNextBatch();
    }
  }


  function abortReplication(reason, err) {
    if (replicationCompleted) {
      return;
    }
    if (!err.message) {
      err.message = reason;
    }
    result.ok = false;
    result.status = 'aborting';
    batches = [];
    pendingBatch = {
      seq: 0,
      changes: [],
      docs: []
    };
    completeReplication(err);
  }


  function completeReplication(fatalError) {
    if (replicationCompleted) {
      return;
    }
    /* istanbul ignore if */
    if (returnValue.cancelled) {
      result.status = 'cancelled';
      if (writingCheckpoint) {
        return;
      }
    }
    result.status = result.status || 'complete';
    result.end_time = new Date();
    result.last_seq = last_seq;
    replicationCompleted = true;

    if (fatalError) {
      // need to extend the error because Firefox considers ".result" read-only
      fatalError = createError(fatalError);
      fatalError.result = result;

      if (fatalError.name === 'unauthorized' || fatalError.name === 'forbidden') {
        returnValue.emit('error', fatalError);
        returnValue.removeAllListeners();
      } else {
        backOff(opts, returnValue, fatalError, function () {
          replicate(src, target, opts, returnValue);
        });
      }
    } else {
      returnValue.emit('complete', result);
      returnValue.removeAllListeners();
    }
  }


  function onChange(change) {
    /* istanbul ignore if */
    if (returnValue.cancelled) {
      return completeReplication();
    }
    var filter = filterChange(opts)(change);
    if (!filter) {
      return;
    }
    pendingBatch.seq = change.seq;
    pendingBatch.changes.push(change);
    processPendingBatch(batches.length === 0 && changesOpts.live);
  }


  function onChangesComplete(changes) {
    changesPending = false;
    /* istanbul ignore if */
    if (returnValue.cancelled) {
      return completeReplication();
    }

    // if no results were returned then we're done,
    // else fetch more
    if (changes.results.length > 0) {
      changesOpts.since = changes.last_seq;
      getChanges();
      processPendingBatch(true);
    } else {

      var complete = function () {
        if (continuous) {
          changesOpts.live = true;
          getChanges();
        } else {
          changesCompleted = true;
        }
        processPendingBatch(true);
      };

      // update the checkpoint so we start from the right seq next time
      if (!currentBatch && changes.results.length === 0) {
        writingCheckpoint = true;
        checkpointer.writeCheckpoint(changes.last_seq,
            session).then(function () {
          writingCheckpoint = false;
          result.last_seq = last_seq = changes.last_seq;
          complete();
        })
        .catch(onCheckpointError);
      } else {
        complete();
      }
    }
  }


  function onChangesError(err) {
    changesPending = false;
    /* istanbul ignore if */
    if (returnValue.cancelled) {
      return completeReplication();
    }
    abortReplication('changes rejected', err);
  }


  function getChanges() {
    if (!(
      !changesPending &&
      !changesCompleted &&
      batches.length < batches_limit
      )) {
      return;
    }
    changesPending = true;
    function abortChanges() {
      changes.cancel();
    }
    function removeListener() {
      returnValue.removeListener('cancel', abortChanges);
    }

    if (returnValue._changes) { // remove old changes() and listeners
      returnValue.removeListener('cancel', returnValue._abortChanges);
      returnValue._changes.cancel();
    }
    returnValue.once('cancel', abortChanges);

    var changes = src.changes(changesOpts)
      .on('change', onChange);
    changes.then(removeListener, removeListener);
    changes.then(onChangesComplete)
      .catch(onChangesError);

    if (opts.retry) {
      // save for later so we can cancel if necessary
      returnValue._changes = changes;
      returnValue._abortChanges = abortChanges;
    }
  }


  function startChanges() {
    initCheckpointer().then(function () {
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        return;
      }
      return checkpointer.getCheckpoint().then(function (checkpoint) {
        last_seq = checkpoint;
        changesOpts = {
          since: last_seq,
          limit: batch_size,
          batch_size: batch_size,
          style: 'all_docs',
          doc_ids: doc_ids,
          selector: selector,
          return_docs: true // required so we know when we're done
        };
        if (opts.filter) {
          if (typeof opts.filter !== 'string') {
            // required for the client-side filter in onChange
            changesOpts.include_docs = true;
          } else { // ddoc filter
            changesOpts.filter = opts.filter;
          }
        }
        if ('heartbeat' in opts) {
          changesOpts.heartbeat = opts.heartbeat;
        }
        if ('timeout' in opts) {
          changesOpts.timeout = opts.timeout;
        }
        if (opts.query_params) {
          changesOpts.query_params = opts.query_params;
        }
        if (opts.view) {
          changesOpts.view = opts.view;
        }
        getChanges();
      });
    }).catch(function (err) {
      abortReplication('getCheckpoint rejected with ', err);
    });
  }

  /* istanbul ignore next */
  function onCheckpointError(err) {
    writingCheckpoint = false;
    abortReplication('writeCheckpoint completed with error', err);
  }

  /* istanbul ignore if */
  if (returnValue.cancelled) { // cancelled immediately
    completeReplication();
    return;
  }

  if (!returnValue._addedListeners) {
    returnValue.once('cancel', completeReplication);

    if (typeof opts.complete === 'function') {
      returnValue.once('error', opts.complete);
      returnValue.once('complete', function (result) {
        opts.complete(null, result);
      });
    }
    returnValue._addedListeners = true;
  }

  if (typeof opts.since === 'undefined') {
    startChanges();
  } else {
    initCheckpointer().then(function () {
      writingCheckpoint = true;
      return checkpointer.writeCheckpoint(opts.since, session);
    }).then(function () {
      writingCheckpoint = false;
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        return;
      }
      last_seq = opts.since;
      startChanges();
    }).catch(onCheckpointError);
  }
}

// We create a basic promise so the caller can cancel the replication possibly
// before we have actually started listening to changes etc
inherits(Replication, events.EventEmitter);
function Replication() {
  events.EventEmitter.call(this);
  this.cancelled = false;
  this.state = 'pending';
  var self = this;
  var promise = new PouchPromise$1(function (fulfill, reject) {
    self.once('complete', fulfill);
    self.once('error', reject);
  });
  self.then = function (resolve, reject) {
    return promise.then(resolve, reject);
  };
  self.catch = function (reject) {
    return promise.catch(reject);
  };
  // As we allow error handling via "error" event as well,
  // put a stub in here so that rejecting never throws UnhandledError.
  self.catch(function () {});
}

Replication.prototype.cancel = function () {
  this.cancelled = true;
  this.state = 'cancelled';
  this.emit('cancel');
};

Replication.prototype.ready = function (src, target) {
  var self = this;
  if (self._readyCalled) {
    return;
  }
  self._readyCalled = true;

  function onDestroy() {
    self.cancel();
  }
  src.once('destroyed', onDestroy);
  target.once('destroyed', onDestroy);
  function cleanup() {
    src.removeListener('destroyed', onDestroy);
    target.removeListener('destroyed', onDestroy);
  }
  self.once('complete', cleanup);
};

function toPouch(db, opts) {
  var PouchConstructor = opts.PouchConstructor;
  if (typeof db === 'string') {
    return new PouchConstructor(db, opts);
  } else {
    return db;
  }
}

function replicateWrapper(src, target, opts, callback) {

  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  if (typeof opts === 'undefined') {
    opts = {};
  }

  if (opts.doc_ids && !Array.isArray(opts.doc_ids)) {
    throw createError(BAD_REQUEST,
                       "`doc_ids` filter parameter is not a list.");
  }

  opts.complete = callback;
  opts = clone(opts);
  opts.continuous = opts.continuous || opts.live;
  opts.retry = ('retry' in opts) ? opts.retry : false;
  /*jshint validthis:true */
  opts.PouchConstructor = opts.PouchConstructor || this;
  var replicateRet = new Replication(opts);
  var srcPouch = toPouch(src, opts);
  var targetPouch = toPouch(target, opts);
  replicate(srcPouch, targetPouch, opts, replicateRet);
  return replicateRet;
}

inherits(Sync, events.EventEmitter);
function sync$1(src, target, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  if (typeof opts === 'undefined') {
    opts = {};
  }
  opts = clone(opts);
  /*jshint validthis:true */
  opts.PouchConstructor = opts.PouchConstructor || this;
  src = toPouch(src, opts);
  target = toPouch(target, opts);
  return new Sync(src, target, opts, callback);
}

function Sync(src, target, opts, callback) {
  var self = this;
  this.canceled = false;

  var optsPush = opts.push ? $inject_Object_assign({}, opts, opts.push) : opts;
  var optsPull = opts.pull ? $inject_Object_assign({}, opts, opts.pull) : opts;

  this.push = replicateWrapper(src, target, optsPush);
  this.pull = replicateWrapper(target, src, optsPull);

  this.pushPaused = true;
  this.pullPaused = true;

  function pullChange(change) {
    self.emit('change', {
      direction: 'pull',
      change: change
    });
  }
  function pushChange(change) {
    self.emit('change', {
      direction: 'push',
      change: change
    });
  }
  function pushDenied(doc) {
    self.emit('denied', {
      direction: 'push',
      doc: doc
    });
  }
  function pullDenied(doc) {
    self.emit('denied', {
      direction: 'pull',
      doc: doc
    });
  }
  function pushPaused() {
    self.pushPaused = true;
    /* istanbul ignore if */
    if (self.pullPaused) {
      self.emit('paused');
    }
  }
  function pullPaused() {
    self.pullPaused = true;
    /* istanbul ignore if */
    if (self.pushPaused) {
      self.emit('paused');
    }
  }
  function pushActive() {
    self.pushPaused = false;
    /* istanbul ignore if */
    if (self.pullPaused) {
      self.emit('active', {
        direction: 'push'
      });
    }
  }
  function pullActive() {
    self.pullPaused = false;
    /* istanbul ignore if */
    if (self.pushPaused) {
      self.emit('active', {
        direction: 'pull'
      });
    }
  }

  var removed = {};

  function removeAll(type) { // type is 'push' or 'pull'
    return function (event, func) {
      var isChange = event === 'change' &&
        (func === pullChange || func === pushChange);
      var isDenied = event === 'denied' &&
        (func === pullDenied || func === pushDenied);
      var isPaused = event === 'paused' &&
        (func === pullPaused || func === pushPaused);
      var isActive = event === 'active' &&
        (func === pullActive || func === pushActive);

      if (isChange || isDenied || isPaused || isActive) {
        if (!(event in removed)) {
          removed[event] = {};
        }
        removed[event][type] = true;
        if (Object.keys(removed[event]).length === 2) {
          // both push and pull have asked to be removed
          self.removeAllListeners(event);
        }
      }
    };
  }

  if (opts.live) {
    this.push.on('complete', self.pull.cancel.bind(self.pull));
    this.pull.on('complete', self.push.cancel.bind(self.push));
  }

  function addOneListener(ee, event, listener) {
    if (ee.listeners(event).indexOf(listener) == -1) {
      ee.on(event, listener);
    }
  }

  this.on('newListener', function (event) {
    if (event === 'change') {
      addOneListener(self.pull, 'change', pullChange);
      addOneListener(self.push, 'change', pushChange);
    } else if (event === 'denied') {
      addOneListener(self.pull, 'denied', pullDenied);
      addOneListener(self.push, 'denied', pushDenied);
    } else if (event === 'active') {
      addOneListener(self.pull, 'active', pullActive);
      addOneListener(self.push, 'active', pushActive);
    } else if (event === 'paused') {
      addOneListener(self.pull, 'paused', pullPaused);
      addOneListener(self.push, 'paused', pushPaused);
    }
  });

  this.on('removeListener', function (event) {
    if (event === 'change') {
      self.pull.removeListener('change', pullChange);
      self.push.removeListener('change', pushChange);
    } else if (event === 'denied') {
      self.pull.removeListener('denied', pullDenied);
      self.push.removeListener('denied', pushDenied);
    } else if (event === 'active') {
      self.pull.removeListener('active', pullActive);
      self.push.removeListener('active', pushActive);
    } else if (event === 'paused') {
      self.pull.removeListener('paused', pullPaused);
      self.push.removeListener('paused', pushPaused);
    }
  });

  this.pull.on('removeListener', removeAll('pull'));
  this.push.on('removeListener', removeAll('push'));

  var promise = PouchPromise$1.all([
    this.push,
    this.pull
  ]).then(function (resp) {
    var out = {
      push: resp[0],
      pull: resp[1]
    };
    self.emit('complete', out);
    if (callback) {
      callback(null, out);
    }
    self.removeAllListeners();
    return out;
  }, function (err) {
    self.cancel();
    if (callback) {
      // if there's a callback, then the callback can receive
      // the error event
      callback(err);
    } else {
      // if there's no callback, then we're safe to emit an error
      // event, which would otherwise throw an unhandled error
      // due to 'error' being a special event in EventEmitters
      self.emit('error', err);
    }
    self.removeAllListeners();
    if (callback) {
      // no sense throwing if we're already emitting an 'error' event
      throw err;
    }
  });

  this.then = function (success, err) {
    return promise.then(success, err);
  };

  this.catch = function (err) {
    return promise.catch(err);
  };
}

Sync.prototype.cancel = function () {
  if (!this.canceled) {
    this.canceled = true;
    this.push.cancel();
    this.pull.cancel();
  }
};

function replication(PouchDB) {
  PouchDB.replicate = replicateWrapper;
  PouchDB.sync = sync$1;

  Object.defineProperty(PouchDB.prototype, 'replicate', {
    get: function () {
      var self = this;
      return {
        from: function (other, opts, callback) {
          return self.constructor.replicate(other, self, opts, callback);
        },
        to: function (other, opts, callback) {
          return self.constructor.replicate(self, other, opts, callback);
        }
      };
    }
  });

  PouchDB.prototype.sync = function (dbName, opts, callback) {
    return this.constructor.sync(this, dbName, opts, callback);
  };
}

PouchDB$3.plugin(IDBPouch)
  .plugin(WebSqlPouch)
  .plugin(HttpPouch$1)
  .plugin(mapreduce)
  .plugin(replication);

module.exports = PouchDB$3;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"argsarray":11,"debug":22,"events":14,"immediate":15,"inherits":16,"lie":18,"spark-md5":27,"vuvuzela":28}],22:[function(require,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window && typeof window.process !== 'undefined' && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document && 'WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window && window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  try {
    return exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (typeof process !== 'undefined' && 'env' in process) {
    return process.env.DEBUG;
  }
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,require('_process'))
},{"./debug":23,"_process":26}],23:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (namespaces || '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":24}],24:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000
var m = s * 60
var h = m * 60
var d = h * 24
var y = d * 365.25

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} options
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function (val, options) {
  options = options || {}
  var type = typeof val
  if (type === 'string' && val.length > 0) {
    return parse(val)
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ?
			fmtLong(val) :
			fmtShort(val)
  }
  throw new Error('val is not a non-empty string or a valid number. val=' + JSON.stringify(val))
}

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str)
  if (str.length > 10000) {
    return
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str)
  if (!match) {
    return
  }
  var n = parseFloat(match[1])
  var type = (match[2] || 'ms').toLowerCase()
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y
    case 'days':
    case 'day':
    case 'd':
      return n * d
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n
    default:
      return undefined
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd'
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h'
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm'
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's'
  }
  return ms + 'ms'
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms'
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name
  }
  return Math.ceil(ms / n) + ' ' + name + 's'
}

},{}],25:[function(require,module,exports){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(require('lie'));

/* istanbul ignore next */
var PouchPromise = typeof Promise === 'function' ? Promise : lie;

module.exports = PouchPromise;

},{"lie":18}],26:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],27:[function(require,module,exports){
(function (factory) {
    if (typeof exports === 'object') {
        // Node/CommonJS
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(factory);
    } else {
        // Browser globals (with support for web workers)
        var glob;

        try {
            glob = window;
        } catch (e) {
            glob = self;
        }

        glob.SparkMD5 = factory();
    }
}(function (undefined) {

    'use strict';

    /*
     * Fastest md5 implementation around (JKM md5).
     * Credits: Joseph Myers
     *
     * @see http://www.myersdaily.org/joseph/javascript/md5-text.html
     * @see http://jsperf.com/md5-shootout/7
     */

    /* this function is much faster,
      so if possible we use it. Some IEs
      are the only ones I know of that
      need the idiotic second function,
      generated by an if clause.  */
    var add32 = function (a, b) {
        return (a + b) & 0xFFFFFFFF;
    },
        hex_chr = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];


    function cmn(q, a, b, x, s, t) {
        a = add32(add32(a, q), add32(x, t));
        return add32((a << s) | (a >>> (32 - s)), b);
    }

    function md5cycle(x, k) {
        var a = x[0],
            b = x[1],
            c = x[2],
            d = x[3];

        a += (b & c | ~b & d) + k[0] - 680876936 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[1] - 389564586 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[2] + 606105819 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[3] - 1044525330 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[4] - 176418897 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[5] + 1200080426 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[6] - 1473231341 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[7] - 45705983 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[8] + 1770035416 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[9] - 1958414417 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[10] - 42063 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[11] - 1990404162 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;
        a += (b & c | ~b & d) + k[12] + 1804603682 | 0;
        a  = (a << 7 | a >>> 25) + b | 0;
        d += (a & b | ~a & c) + k[13] - 40341101 | 0;
        d  = (d << 12 | d >>> 20) + a | 0;
        c += (d & a | ~d & b) + k[14] - 1502002290 | 0;
        c  = (c << 17 | c >>> 15) + d | 0;
        b += (c & d | ~c & a) + k[15] + 1236535329 | 0;
        b  = (b << 22 | b >>> 10) + c | 0;

        a += (b & d | c & ~d) + k[1] - 165796510 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[6] - 1069501632 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[11] + 643717713 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[0] - 373897302 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[5] - 701558691 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[10] + 38016083 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[15] - 660478335 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[4] - 405537848 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[9] + 568446438 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[14] - 1019803690 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[3] - 187363961 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[8] + 1163531501 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;
        a += (b & d | c & ~d) + k[13] - 1444681467 | 0;
        a  = (a << 5 | a >>> 27) + b | 0;
        d += (a & c | b & ~c) + k[2] - 51403784 | 0;
        d  = (d << 9 | d >>> 23) + a | 0;
        c += (d & b | a & ~b) + k[7] + 1735328473 | 0;
        c  = (c << 14 | c >>> 18) + d | 0;
        b += (c & a | d & ~a) + k[12] - 1926607734 | 0;
        b  = (b << 20 | b >>> 12) + c | 0;

        a += (b ^ c ^ d) + k[5] - 378558 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[8] - 2022574463 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[11] + 1839030562 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[14] - 35309556 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[1] - 1530992060 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[4] + 1272893353 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[7] - 155497632 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[10] - 1094730640 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[13] + 681279174 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[0] - 358537222 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[3] - 722521979 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[6] + 76029189 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;
        a += (b ^ c ^ d) + k[9] - 640364487 | 0;
        a  = (a << 4 | a >>> 28) + b | 0;
        d += (a ^ b ^ c) + k[12] - 421815835 | 0;
        d  = (d << 11 | d >>> 21) + a | 0;
        c += (d ^ a ^ b) + k[15] + 530742520 | 0;
        c  = (c << 16 | c >>> 16) + d | 0;
        b += (c ^ d ^ a) + k[2] - 995338651 | 0;
        b  = (b << 23 | b >>> 9) + c | 0;

        a += (c ^ (b | ~d)) + k[0] - 198630844 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[7] + 1126891415 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[14] - 1416354905 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[5] - 57434055 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[12] + 1700485571 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[3] - 1894986606 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[10] - 1051523 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[1] - 2054922799 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[8] + 1873313359 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[15] - 30611744 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[6] - 1560198380 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[13] + 1309151649 | 0;
        b  = (b << 21 |b >>> 11) + c | 0;
        a += (c ^ (b | ~d)) + k[4] - 145523070 | 0;
        a  = (a << 6 | a >>> 26) + b | 0;
        d += (b ^ (a | ~c)) + k[11] - 1120210379 | 0;
        d  = (d << 10 | d >>> 22) + a | 0;
        c += (a ^ (d | ~b)) + k[2] + 718787259 | 0;
        c  = (c << 15 | c >>> 17) + d | 0;
        b += (d ^ (c | ~a)) + k[9] - 343485551 | 0;
        b  = (b << 21 | b >>> 11) + c | 0;

        x[0] = a + x[0] | 0;
        x[1] = b + x[1] | 0;
        x[2] = c + x[2] | 0;
        x[3] = d + x[3] | 0;
    }

    function md5blk(s) {
        var md5blks = [],
            i; /* Andy King said do it this way. */

        for (i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
        }
        return md5blks;
    }

    function md5blk_array(a) {
        var md5blks = [],
            i; /* Andy King said do it this way. */

        for (i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);
        }
        return md5blks;
    }

    function md51(s) {
        var n = s.length,
            state = [1732584193, -271733879, -1732584194, 271733878],
            i,
            length,
            tail,
            tmp,
            lo,
            hi;

        for (i = 64; i <= n; i += 64) {
            md5cycle(state, md5blk(s.substring(i - 64, i)));
        }
        s = s.substring(i - 64);
        length = s.length;
        tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
        }
        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(state, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Beware that the final length might not fit in 32 bits so we take care of that
        tmp = n * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;

        md5cycle(state, tail);
        return state;
    }

    function md51_array(a) {
        var n = a.length,
            state = [1732584193, -271733879, -1732584194, 271733878],
            i,
            length,
            tail,
            tmp,
            lo,
            hi;

        for (i = 64; i <= n; i += 64) {
            md5cycle(state, md5blk_array(a.subarray(i - 64, i)));
        }

        // Not sure if it is a bug, however IE10 will always produce a sub array of length 1
        // containing the last element of the parent array if the sub array specified starts
        // beyond the length of the parent array - weird.
        // https://connect.microsoft.com/IE/feedback/details/771452/typed-array-subarray-issue
        a = (i - 64) < n ? a.subarray(i - 64) : new Uint8Array(0);

        length = a.length;
        tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= a[i] << ((i % 4) << 3);
        }

        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(state, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Beware that the final length might not fit in 32 bits so we take care of that
        tmp = n * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;

        md5cycle(state, tail);

        return state;
    }

    function rhex(n) {
        var s = '',
            j;
        for (j = 0; j < 4; j += 1) {
            s += hex_chr[(n >> (j * 8 + 4)) & 0x0F] + hex_chr[(n >> (j * 8)) & 0x0F];
        }
        return s;
    }

    function hex(x) {
        var i;
        for (i = 0; i < x.length; i += 1) {
            x[i] = rhex(x[i]);
        }
        return x.join('');
    }

    // In some cases the fast add32 function cannot be used..
    if (hex(md51('hello')) !== '5d41402abc4b2a76b9719d911017c592') {
        add32 = function (x, y) {
            var lsw = (x & 0xFFFF) + (y & 0xFFFF),
                msw = (x >> 16) + (y >> 16) + (lsw >> 16);
            return (msw << 16) | (lsw & 0xFFFF);
        };
    }

    // ---------------------------------------------------

    /**
     * ArrayBuffer slice polyfill.
     *
     * @see https://github.com/ttaubert/node-arraybuffer-slice
     */

    if (typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.prototype.slice) {
        (function () {
            function clamp(val, length) {
                val = (val | 0) || 0;

                if (val < 0) {
                    return Math.max(val + length, 0);
                }

                return Math.min(val, length);
            }

            ArrayBuffer.prototype.slice = function (from, to) {
                var length = this.byteLength,
                    begin = clamp(from, length),
                    end = length,
                    num,
                    target,
                    targetArray,
                    sourceArray;

                if (to !== undefined) {
                    end = clamp(to, length);
                }

                if (begin > end) {
                    return new ArrayBuffer(0);
                }

                num = end - begin;
                target = new ArrayBuffer(num);
                targetArray = new Uint8Array(target);

                sourceArray = new Uint8Array(this, begin, num);
                targetArray.set(sourceArray);

                return target;
            };
        })();
    }

    // ---------------------------------------------------

    /**
     * Helpers.
     */

    function toUtf8(str) {
        if (/[\u0080-\uFFFF]/.test(str)) {
            str = unescape(encodeURIComponent(str));
        }

        return str;
    }

    function utf8Str2ArrayBuffer(str, returnUInt8Array) {
        var length = str.length,
           buff = new ArrayBuffer(length),
           arr = new Uint8Array(buff),
           i;

        for (i = 0; i < length; i += 1) {
            arr[i] = str.charCodeAt(i);
        }

        return returnUInt8Array ? arr : buff;
    }

    function arrayBuffer2Utf8Str(buff) {
        return String.fromCharCode.apply(null, new Uint8Array(buff));
    }

    function concatenateArrayBuffers(first, second, returnUInt8Array) {
        var result = new Uint8Array(first.byteLength + second.byteLength);

        result.set(new Uint8Array(first));
        result.set(new Uint8Array(second), first.byteLength);

        return returnUInt8Array ? result : result.buffer;
    }

    function hexToBinaryString(hex) {
        var bytes = [],
            length = hex.length,
            x;

        for (x = 0; x < length - 1; x += 2) {
            bytes.push(parseInt(hex.substr(x, 2), 16));
        }

        return String.fromCharCode.apply(String, bytes);
    }

    // ---------------------------------------------------

    /**
     * SparkMD5 OOP implementation.
     *
     * Use this class to perform an incremental md5, otherwise use the
     * static methods instead.
     */

    function SparkMD5() {
        // call reset to init the instance
        this.reset();
    }

    /**
     * Appends a string.
     * A conversion will be applied if an utf8 string is detected.
     *
     * @param {String} str The string to be appended
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.append = function (str) {
        // Converts the string to utf8 bytes if necessary
        // Then append as binary
        this.appendBinary(toUtf8(str));

        return this;
    };

    /**
     * Appends a binary string.
     *
     * @param {String} contents The binary string to be appended
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.appendBinary = function (contents) {
        this._buff += contents;
        this._length += contents.length;

        var length = this._buff.length,
            i;

        for (i = 64; i <= length; i += 64) {
            md5cycle(this._hash, md5blk(this._buff.substring(i - 64, i)));
        }

        this._buff = this._buff.substring(i - 64);

        return this;
    };

    /**
     * Finishes the incremental computation, reseting the internal state and
     * returning the result.
     *
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.prototype.end = function (raw) {
        var buff = this._buff,
            length = buff.length,
            i,
            tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ret;

        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= buff.charCodeAt(i) << ((i % 4) << 3);
        }

        this._finish(tail, length);
        ret = hex(this._hash);

        if (raw) {
            ret = hexToBinaryString(ret);
        }

        this.reset();

        return ret;
    };

    /**
     * Resets the internal state of the computation.
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.reset = function () {
        this._buff = '';
        this._length = 0;
        this._hash = [1732584193, -271733879, -1732584194, 271733878];

        return this;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @return {Object} The state
     */
    SparkMD5.prototype.getState = function () {
        return {
            buff: this._buff,
            length: this._length,
            hash: this._hash
        };
    };

    /**
     * Gets the internal state of the computation.
     *
     * @param {Object} state The state
     *
     * @return {SparkMD5} The instance itself
     */
    SparkMD5.prototype.setState = function (state) {
        this._buff = state.buff;
        this._length = state.length;
        this._hash = state.hash;

        return this;
    };

    /**
     * Releases memory used by the incremental buffer and other additional
     * resources. If you plan to use the instance again, use reset instead.
     */
    SparkMD5.prototype.destroy = function () {
        delete this._hash;
        delete this._buff;
        delete this._length;
    };

    /**
     * Finish the final calculation based on the tail.
     *
     * @param {Array}  tail   The tail (will be modified)
     * @param {Number} length The length of the remaining buffer
     */
    SparkMD5.prototype._finish = function (tail, length) {
        var i = length,
            tmp,
            lo,
            hi;

        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) {
            md5cycle(this._hash, tail);
            for (i = 0; i < 16; i += 1) {
                tail[i] = 0;
            }
        }

        // Do the final computation based on the tail and length
        // Beware that the final length may not fit in 32 bits so we take care of that
        tmp = this._length * 8;
        tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
        lo = parseInt(tmp[2], 16);
        hi = parseInt(tmp[1], 16) || 0;

        tail[14] = lo;
        tail[15] = hi;
        md5cycle(this._hash, tail);
    };

    /**
     * Performs the md5 hash on a string.
     * A conversion will be applied if utf8 string is detected.
     *
     * @param {String}  str The string
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.hash = function (str, raw) {
        // Converts the string to utf8 bytes if necessary
        // Then compute it using the binary function
        return SparkMD5.hashBinary(toUtf8(str), raw);
    };

    /**
     * Performs the md5 hash on a binary string.
     *
     * @param {String}  content The binary string
     * @param {Boolean} raw     True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.hashBinary = function (content, raw) {
        var hash = md51(content),
            ret = hex(hash);

        return raw ? hexToBinaryString(ret) : ret;
    };

    // ---------------------------------------------------

    /**
     * SparkMD5 OOP implementation for array buffers.
     *
     * Use this class to perform an incremental md5 ONLY for array buffers.
     */
    SparkMD5.ArrayBuffer = function () {
        // call reset to init the instance
        this.reset();
    };

    /**
     * Appends an array buffer.
     *
     * @param {ArrayBuffer} arr The array to be appended
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.append = function (arr) {
        var buff = concatenateArrayBuffers(this._buff.buffer, arr, true),
            length = buff.length,
            i;

        this._length += arr.byteLength;

        for (i = 64; i <= length; i += 64) {
            md5cycle(this._hash, md5blk_array(buff.subarray(i - 64, i)));
        }

        this._buff = (i - 64) < length ? new Uint8Array(buff.buffer.slice(i - 64)) : new Uint8Array(0);

        return this;
    };

    /**
     * Finishes the incremental computation, reseting the internal state and
     * returning the result.
     *
     * @param {Boolean} raw True to get the raw string, false to get the hex string
     *
     * @return {String} The result
     */
    SparkMD5.ArrayBuffer.prototype.end = function (raw) {
        var buff = this._buff,
            length = buff.length,
            tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            i,
            ret;

        for (i = 0; i < length; i += 1) {
            tail[i >> 2] |= buff[i] << ((i % 4) << 3);
        }

        this._finish(tail, length);
        ret = hex(this._hash);

        if (raw) {
            ret = hexToBinaryString(ret);
        }

        this.reset();

        return ret;
    };

    /**
     * Resets the internal state of the computation.
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.reset = function () {
        this._buff = new Uint8Array(0);
        this._length = 0;
        this._hash = [1732584193, -271733879, -1732584194, 271733878];

        return this;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @return {Object} The state
     */
    SparkMD5.ArrayBuffer.prototype.getState = function () {
        var state = SparkMD5.prototype.getState.call(this);

        // Convert buffer to a string
        state.buff = arrayBuffer2Utf8Str(state.buff);

        return state;
    };

    /**
     * Gets the internal state of the computation.
     *
     * @param {Object} state The state
     *
     * @return {SparkMD5.ArrayBuffer} The instance itself
     */
    SparkMD5.ArrayBuffer.prototype.setState = function (state) {
        // Convert string to buffer
        state.buff = utf8Str2ArrayBuffer(state.buff, true);

        return SparkMD5.prototype.setState.call(this, state);
    };

    SparkMD5.ArrayBuffer.prototype.destroy = SparkMD5.prototype.destroy;

    SparkMD5.ArrayBuffer.prototype._finish = SparkMD5.prototype._finish;

    /**
     * Performs the md5 hash on an array buffer.
     *
     * @param {ArrayBuffer} arr The array buffer
     * @param {Boolean}     raw True to get the raw string, false to get the hex one
     *
     * @return {String} The result
     */
    SparkMD5.ArrayBuffer.hash = function (arr, raw) {
        var hash = md51_array(new Uint8Array(arr)),
            ret = hex(hash);

        return raw ? hexToBinaryString(ret) : ret;
    };

    return SparkMD5;
}));

},{}],28:[function(require,module,exports){
'use strict';

/**
 * Stringify/parse functions that don't operate
 * recursively, so they avoid call stack exceeded
 * errors.
 */
exports.stringify = function stringify(input) {
  var queue = [];
  queue.push({obj: input});

  var res = '';
  var next, obj, prefix, val, i, arrayPrefix, keys, k, key, value, objPrefix;
  while ((next = queue.pop())) {
    obj = next.obj;
    prefix = next.prefix || '';
    val = next.val || '';
    res += prefix;
    if (val) {
      res += val;
    } else if (typeof obj !== 'object') {
      res += typeof obj === 'undefined' ? null : JSON.stringify(obj);
    } else if (obj === null) {
      res += 'null';
    } else if (Array.isArray(obj)) {
      queue.push({val: ']'});
      for (i = obj.length - 1; i >= 0; i--) {
        arrayPrefix = i === 0 ? '' : ',';
        queue.push({obj: obj[i], prefix: arrayPrefix});
      }
      queue.push({val: '['});
    } else { // object
      keys = [];
      for (k in obj) {
        if (obj.hasOwnProperty(k)) {
          keys.push(k);
        }
      }
      queue.push({val: '}'});
      for (i = keys.length - 1; i >= 0; i--) {
        key = keys[i];
        value = obj[key];
        objPrefix = (i > 0 ? ',' : '');
        objPrefix += JSON.stringify(key) + ':';
        queue.push({obj: value, prefix: objPrefix});
      }
      queue.push({val: '{'});
    }
  }
  return res;
};

// Convenience function for the parse function.
// This pop function is basically copied from
// pouchCollate.parseIndexableString
function pop(obj, stack, metaStack) {
  var lastMetaElement = metaStack[metaStack.length - 1];
  if (obj === lastMetaElement.element) {
    // popping a meta-element, e.g. an object whose value is another object
    metaStack.pop();
    lastMetaElement = metaStack[metaStack.length - 1];
  }
  var element = lastMetaElement.element;
  var lastElementIndex = lastMetaElement.index;
  if (Array.isArray(element)) {
    element.push(obj);
  } else if (lastElementIndex === stack.length - 2) { // obj with key+value
    var key = stack.pop();
    element[key] = obj;
  } else {
    stack.push(obj); // obj with key only
  }
}

exports.parse = function (str) {
  var stack = [];
  var metaStack = []; // stack for arrays and objects
  var i = 0;
  var collationIndex,parsedNum,numChar;
  var parsedString,lastCh,numConsecutiveSlashes,ch;
  var arrayElement, objElement;
  while (true) {
    collationIndex = str[i++];
    if (collationIndex === '}' ||
        collationIndex === ']' ||
        typeof collationIndex === 'undefined') {
      if (stack.length === 1) {
        return stack.pop();
      } else {
        pop(stack.pop(), stack, metaStack);
        continue;
      }
    }
    switch (collationIndex) {
      case ' ':
      case '\t':
      case '\n':
      case ':':
      case ',':
        break;
      case 'n':
        i += 3; // 'ull'
        pop(null, stack, metaStack);
        break;
      case 't':
        i += 3; // 'rue'
        pop(true, stack, metaStack);
        break;
      case 'f':
        i += 4; // 'alse'
        pop(false, stack, metaStack);
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
      case '-':
        parsedNum = '';
        i--;
        while (true) {
          numChar = str[i++];
          if (/[\d\.\-e\+]/.test(numChar)) {
            parsedNum += numChar;
          } else {
            i--;
            break;
          }
        }
        pop(parseFloat(parsedNum), stack, metaStack);
        break;
      case '"':
        parsedString = '';
        lastCh = void 0;
        numConsecutiveSlashes = 0;
        while (true) {
          ch = str[i++];
          if (ch !== '"' || (lastCh === '\\' &&
              numConsecutiveSlashes % 2 === 1)) {
            parsedString += ch;
            lastCh = ch;
            if (lastCh === '\\') {
              numConsecutiveSlashes++;
            } else {
              numConsecutiveSlashes = 0;
            }
          } else {
            break;
          }
        }
        pop(JSON.parse('"' + parsedString + '"'), stack, metaStack);
        break;
      case '[':
        arrayElement = { element: [], index: stack.length };
        stack.push(arrayElement.element);
        metaStack.push(arrayElement);
        break;
      case '{':
        objElement = { element: {}, index: stack.length };
        stack.push(objElement.element);
        metaStack.push(objElement);
        break;
      default:
        throw new Error(
          'unexpectedly reached end of input: ' + collationIndex);
    }
  }
};

},{}],29:[function(require,module,exports){
/*jshint expr:true */
'use strict';

var WorkerPouch = require('../lib/client');

window.PouchDB = require('pouchdb-browser');

window.PouchDB.adapter('worker', WorkerPouch);
window.PouchDB.preferredAdapters = ['worker'];

window.workerPouch = WorkerPouch;

},{"../lib/client":3,"pouchdb-browser":21}]},{},[29]);
