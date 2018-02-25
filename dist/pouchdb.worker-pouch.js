(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s}return e})()({1:[function(_dereq_,module,exports){
'use strict';

var utils = _dereq_(8);
var clientUtils = _dereq_(5);
var uuid = _dereq_(9);
var errors = _dereq_(6);
var log = _dereq_(11)('pouchdb:worker:client');
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

  api._remote = false;

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
    })["catch"](callback);

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
    auto_compaction: !!opts.auto_compaction,
    storage: opts.storage
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

},{"11":11,"5":5,"6":6,"8":8,"9":9}],2:[function(_dereq_,module,exports){
'use strict';
/* global webkitURL */

module.exports = function createWorker(code) {
  var createBlob = _dereq_(8).createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([code], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};
},{"8":8}],3:[function(_dereq_,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker

var extend = _dereq_(15).extend;
var WorkerPouchCore = _dereq_(1);
var createWorker = _dereq_(2);
var isSupportedBrowser = _dereq_(4);
var workerCode = _dereq_(10);

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
},{"1":1,"10":10,"15":15,"2":2,"4":4}],4:[function(_dereq_,module,exports){
(function (global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));
var createWorker = _dereq_(2);

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
},{"18":18,"2":2}],5:[function(_dereq_,module,exports){
(function (process){
'use strict';

var utils = _dereq_(8);
var log = _dereq_(11)('pouchdb:worker:client');
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
}).call(this,_dereq_(20))
},{"11":11,"20":20,"8":8}],6:[function(_dereq_,module,exports){
"use strict";

var inherits = _dereq_(14);
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

},{"14":14}],7:[function(_dereq_,module,exports){
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

},{}],8:[function(_dereq_,module,exports){
(function (process,global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));

exports.lastIndexOf = function lastIndexOf(str, char) {
  for (var i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i;
    }
  }
  return -1;
};

exports.clone = _dereq_(7);

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

exports.inherits = _dereq_(14);
exports.Promise = Promise;

var binUtil = _dereq_(17);

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,_dereq_(20),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"17":17,"18":18,"20":20,"7":7}],9:[function(_dereq_,module,exports){
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


},{}],10:[function(_dereq_,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function(){function e(t,n,r){function o(s,a){if(!n[s]){if(!t[s]){var u=\"function\"==typeof require&&require;if(!a&&u)return u(s,!0);if(i)return i(s,!0);var c=new Error(\"Cannot find module '\"+s+\"'\");throw c.code=\"MODULE_NOT_FOUND\",c}var f=n[s]={exports:{}};t[s][0].call(f.exports,function(e){var n=t[s][1][e];return o(n||e)},f,f.exports,e,t,n,r)}return n[s].exports}for(var i=\"function\"==typeof require&&require,s=0;s<r.length;s++)o(r[s]);return o}return e}()({1:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}e(12)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),s=r&&i.filter(function(e){return o[e].message===r})[0]||i[0];return s?o[s]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,s,a=n;return r=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,s=e.reason,o=a.getErrorTypeByProp(\"name\",r,s),e.missing||\"missing\"===s||\"deleted\"===s||\"not_found\"===r?o=a.MISSING_DOC:\"doc_validation\"===r?(o=a.DOC_VALIDATION,i=s):\"bad_request\"===r&&o.message!==s&&(0===s.indexOf(\"unknown stub attachment\")?(o=a.MISSING_STUB,i=s):o=a.BAD_REQUEST),o||(o=a.getErrorTypeByProp(\"status\",e.status,s)||a.UNKNOWN_ERROR),t=a.error(o,s,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],2:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){\"function\"!=typeof e.postMessage?n.ports[0].postMessage(t):e.postMessage(t)}function r(e,t,r){f(\" -> sendUncaughtError\",e,t),n({type:\"uncaughtError\",id:e,content:s.createError(t)},r)}function l(e,t,r,o){f(\" -> sendError\",e,t,r),n({type:\"error\",id:e,messageId:t,content:s.createError(r)},o)}function d(e,t,r,o){f(\" -> sendSuccess\",e,t),n({type:\"success\",id:e,messageId:t,content:r},o)}function h(e,t,r,o){f(\" -> sendUpdate\",e,t),n({type:\"update\",id:e,messageId:t,content:r},o)}function p(e,t,n,r,i){var s=u[\"$\"+e];if(!s)return l(e,n,{error:\"db not found\"},i);o.resolve().then(function(){return s[t].apply(s,r)}).then(function(t){d(e,n,t,i)}).catch(function(t){l(e,n,t,i)})}function v(e,t,n,r){var o=n[0];o&&\"object\"==typeof o&&(o.returnDocs=!0,o.return_docs=!0),p(e,\"changes\",t,n,r)}function y(e,t,n,r){var s=u[\"$\"+e];if(!s)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=n[0],a=n[1],u=n[2];return\"object\"!=typeof u&&(u={}),s.get(o,u).then(function(o){if(!o._attachments||!o._attachments[a])throw i.MISSING_DOC;return s.getAttachment.apply(s,n).then(function(n){d(e,t,n,r)})})}).catch(function(n){l(e,t,n,r)})}function g(e,t,n,r){var i=\"$\"+e,s=u[i];if(!s)return l(e,t,{error:\"db not found\"},r);delete u[i],o.resolve().then(function(){return s.destroy.apply(s,n)}).then(function(n){d(e,t,n,r)}).catch(function(n){l(e,t,n,r)})}function m(e,t,n,r){var i=u[\"$\"+e];if(!i)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=i.changes(n[0]);c[t]=o,o.on(\"change\",function(n){h(e,t,n,r)}).on(\"complete\",function(n){o.removeAllListeners(),delete c[t],d(e,t,n,r)}).on(\"error\",function(n){o.removeAllListeners(),delete c[t],l(e,t,n,r)})})}function _(e){var t=c[e];t&&t.cancel()}function b(e,t,n){return o.resolve().then(function(){e.on(\"error\",function(e){r(t,e,n)})})}function w(e,n,r,o){var i=\"$\"+e,s=u[i];return s?b(s,e,o).then(function(){return d(e,n,{ok:!0,exists:!0},o)}):(\"string\"==typeof r[0]?r[0]:r[0].name)?(s=u[i]=t(r[0]),void b(s,e,o).then(function(){d(e,n,{ok:!0},o)}).catch(function(t){l(e,n,t,o)})):l(e,n,{error:\"you must provide a database name\"},o)}function k(e,t,n,r,o){switch(f(\"onReceiveMessage\",t,e,n,r,o),t){case\"createDatabase\":return w(e,n,r,o);case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return p(e,t,n,r,o);case\"changes\":return v(e,n,r,o);case\"getAttachment\":return y(e,n,r,o);case\"liveChanges\":return m(e,n,r,o);case\"cancelChanges\":return _(n);case\"destroy\":return g(e,n,r,o);default:return l(e,n,{error:\"unknown API method: \"+t},o)}}function E(e,t,n){k(t,e.type,e.messageId,a(e.args),n)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete u[\"$\"+t]):E(e.data,t,e)}})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),i=e(1),s=e(6),a=s.decodeArgs,u={},c={},f=e(8)(\"pouchdb:worker\");t.exports=r},{1:1,36:36,6:6,8:8}],3:[function(e,t,n){\"use strict\";var r=e(2),o=e(4);r(self,o)},{2:2,4:4}],4:[function(e,t,n){\"use strict\";t.exports=e(24).plugin(e(16)).plugin(e(15)).plugin(e(33)).plugin(e(38))},{15:15,16:16,24:24,33:33,38:38}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document.documentElement&&document.documentElement.style&&document.documentElement.style.WebkitAppearance||\"undefined\"!=typeof window&&window.console&&(window.console.firebug||window.console.exception&&window.console.table)||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){var e;try{e=n.storage.debug}catch(e){}return!e&&void 0!==r&&\"env\"in r&&(e=r.env.DEBUG),e}n=t.exports=e(9),n.log=s,n.formatArgs=i,n.save=a,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(41))},{41:41,9:9}],9:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r);e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),s=0;s<i.length;s++)i[s]=arguments[s];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var a=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(\"string\"==typeof e?e:\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(13),n.names=[],n.skips=[],n.formatters={};var c},{13:13}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function s(e){return\"object\"==typeof e&&null!==e}function a(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||e<0||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,u,c;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||s(this._events.error)&&!this._events.error.length)){if((t=arguments[1])instanceof Error)throw t;var f=new Error('Uncaught, unspecified \"error\" event. ('+t+\")\");throw f.context=t,f}if(n=this._events[e],a(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:i=Array.prototype.slice.call(arguments,1),n.apply(this,i)}else if(s(n))for(i=Array.prototype.slice.call(arguments,1),c=n.slice(),r=c.length,u=0;u<r;u++)c[u].apply(this,i);return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");return this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?s(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,s(this._events[e])&&!this._events[e].warned&&(n=a(this._maxListeners)?r.defaultMaxListeners:this._maxListeners)&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace()),this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,a;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(s(n)){for(a=i;a-- >0;)if(n[a]===t||n[a].listener&&n[a].listener===t){r=a;break}if(r<0)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else if(n)for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){return this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.prototype.listenerCount=function(e){if(this._events){var t=this._events[e];if(o(t))return 1;if(t)return t.length}return 0},r.listenerCount=function(e,t){return e.listenerCount(t)}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var s=0,a=new i(n),u=e.document.createTextNode(\"\");a.observe(u,{characterData:!0}),o=function(){u.data=s=++s%2}}else if(e.setImmediate||void 0===e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var c=new e.MessageChannel;c.port1.onmessage=n,o=function(){c.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){function r(e){if(e=String(e),!(e.length>100)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,c,\"hour\")||s(e,u,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,u=60*a,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],14:[function(e,t,n){\"use strict\";function r(){this.promise=new l(function(e){e()})}function o(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function i(e,t){return o(e)+o(t)+\"undefined\"}function s(e,t,n,r,o,s){var a,u=i(n,r);if(!o&&(a=e._cachedViews=e._cachedViews||{},a[u]))return a[u];var c=e.info().then(function(i){function c(e){e.views=e.views||{};var n=t;-1===n.indexOf(\"/\")&&(n=t+\"/\"+t);var r=e.views[n]=e.views[n]||{};if(!r[f])return r[f]=!0,e}var f=i.db_name+\"-mrview-\"+(o?\"temp\":y.stringMd5(u));return h.upsert(e,\"_local/\"+s,c).then(function(){return e.registerDependentDatabase(f).then(function(t){var o=t.db;o.auto_compaction=!0;var i={name:f,db:o,sourceDB:e,adapter:e.adapter,mapFun:n,reduceFun:r};return i.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return i.seq=e?e.seq:0,a&&i.db.once(\"destroyed\",function(){delete a[u]}),i})})})});return a&&(a[u]=c),c}function a(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function u(e){return 1===e.length&&/^1-/.test(e[0].rev)}function c(e,t){try{e.emit(\"error\",t)}catch(e){h.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),h.guardedConsole(\"error\",t)}}function f(e,t,n,o){function i(e,t,n){try{t(n)}catch(t){c(e,t)}}function f(e,t,n,r,o){try{return{output:t(n,r,o)}}catch(t){return c(e,t),{error:t}}}function y(e,t){var n=v.collate(e.key,t.key);return 0!==n?n:v.collate(e.value,t.value)}function w(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function k(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function E(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=p.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function S(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&E(t),t}}function O(e,t,n,r){var o=t[e];void 0!==o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function A(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function j(e){return e.group_level=A(e.group_level),e.limit=A(e.limit),e.skip=A(e.skip),e}function I(e){if(e){if(\"number\"!=typeof e)return new g.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new g.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}function D(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(void 0!==e[n]&&void 0!==e[r]&&v.collate(e[n],e[r])>0)throw new g.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&!1!==e.reduce){if(e.include_docs)throw new g.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new g.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=I(e[t]);if(n)throw n})}function x(e,t,n){var r,o=[],i=\"GET\";if(O(\"reduce\",n,o),O(\"include_docs\",n,o),O(\"attachments\",n,o),O(\"limit\",n,o),O(\"descending\",n,o),O(\"group\",n,o),O(\"group_level\",n,o),O(\"skip\",n,o),O(\"stale\",n,o),O(\"conflicts\",n,o),O(\"startkey\",n,o,!0),O(\"start_key\",n,o,!0),O(\"endkey\",n,o,!0),O(\"end_key\",n,o,!0),O(\"inclusive_end\",n,o),O(\"key\",n,o,!0),o=o.join(\"&\"),o=\"\"===o?\"\":\"?\"+o,void 0!==n.keys){var s=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));s.length+o.length+1<=2e3?o+=(\"?\"===o[0]?\"&\":\"?\")+s:(i=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var u=a(t);return e.request({method:i,url:\"_design/\"+u[0]+\"/_view/\"+u[1]+o,body:r}).then(S(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.request({method:\"POST\",url:\"_temp_view\"+o,body:r}).then(S(n))}function C(e,t,n){return new l(function(r,o){e._query(t,n,function(e,t){if(e)return o(e);r(t)})})}function R(e){return new l(function(t,n){e._viewCleanup(function(e,r){if(e)return n(e);t(r)})})}function q(e){return function(t){if(404===t.status)return e;throw t}}function T(e,t,n){function r(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):l.resolve({rows:[]})}function o(e,t){for(var n=[],r=new d.Set,o=0,i=t.rows.length;o<i;o++){var s=t.rows[o],a=s.doc;if(a&&(n.push(a),r.add(a._id),a._deleted=!c.has(a._id),!a._deleted)){var u=c.get(a._id);\"value\"in u&&(a.value=u.value)}}var f=g.mapToKeysArray(c);return f.forEach(function(e){if(!r.has(e)){var t={_id:e},o=c.get(e);\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=g.uniq(f.concat(e.keys)),n.push(e),n}var i=\"_local/doc_\"+e,s={_id:i,keys:[]},a=n.get(e),c=a[0],f=a[1];return function(){return u(f)?l.resolve(s):t.db.get(i).catch(q(s))}().then(function(e){return r(e).then(function(t){return o(e,t)})})}function L(e,t,n){return e.db.get(\"_local/lastSeq\").catch(q({_id:\"_local/lastSeq\",seq:0})).then(function(r){var o=g.mapToKeysArray(t);return l.all(o.map(function(n){return T(n,e,t)})).then(function(t){var o=h.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function B(e){var t=\"string\"==typeof e?e:e.name,n=m[t];return n||(n=m[t]=new r),n}function N(e){return g.sequentialize(B(e),function(){return M(e)})()}function M(e){function n(e,t){var n={id:l._id,key:v.normalizeKey(e)};void 0!==t&&null!==t&&(n.value=v.normalizeKey(t)),f.push(n)}function o(t,n){return function(){return L(e,t,n)}}function s(){return e.sourceDB.changes({conflicts:!0,include_docs:!0,style:\"all_docs\",since:p,limit:b}).then(a)}function a(e){var t=e.results;if(t.length){var n=u(t);if(g.add(o(n,p)),!(t.length<b))return s()}}function u(t){for(var n=new d.Map,r=0,o=t.length;r<o;r++){var s=t[r];if(\"_\"!==s.doc._id[0]){f=[],l=s.doc,l._deleted||i(e.sourceDB,h,l),f.sort(y);var a=c(f);n.set(s.doc._id,[a,s.changes])}p=s.seq}return n}function c(e){for(var t,n=new d.Map,r=0,o=e.length;r<o;r++){var i=e[r],s=[i.key,i.id];r>0&&0===v.collate(i.key,t)&&s.push(r),n.set(v.toIndexableString(s),i),t=i.key}return n}var f,l,h=t(e.mapFun,n),p=e.seq||0,g=new r;return s().then(function(){return g.finish()}).then(function(){e.seq=p})}function $(e,t,r){0===r.group_level&&delete r.group_level;var o=r.group||r.group_level,i=n(e.reduceFun),s=[],a=isNaN(r.group_level)?Number.POSITIVE_INFINITY:r.group_level;t.forEach(function(e){var t=s[s.length-1],n=o?e.key:null;if(o&&Array.isArray(n)&&(n=n.slice(0,a)),t&&0===v.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);s.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var u=0,c=s.length;u<c;u++){var l=s[u],d=f(e.sourceDB,i,l.keys,l.values,!1);if(d.error&&d.error instanceof g.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:w(t,r.limit,r.skip)}}function F(e,t){return g.sequentialize(B(e),function(){return P(e,t)})()}function P(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=v.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?$(e,n,t):{total_rows:o,offset:s,rows:n},t.include_docs){var a=g.uniq(n.map(k));return e.sourceDB.allDocs({keys:a,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t=new d.Map;return e.rows.forEach(function(e){t.set(e.id,e.doc)}),n.forEach(function(e){var n=k(e),r=t.get(n);r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&!1!==t.reduce,s=t.skip||0;if(void 0===t.keys||t.keys.length||(t.limit=0,delete t.keys),void 0!==t.keys){var a=t.keys,u=a.map(function(e){return n({startkey:v.toIndexableString([e]),endkey:v.toIndexableString([e,{}])})});return l.all(u).then(h.flatten).then(r)}var c,f,p={descending:t.descending};if(\"start_key\"in t&&(c=t.start_key),\"startkey\"in t&&(c=t.startkey),\"end_key\"in t&&(f=t.end_key),\"endkey\"in t&&(f=t.endkey),void 0!==c&&(p.startkey=t.descending?v.toIndexableString([c,{}]):v.toIndexableString([c])),void 0!==f){var y=!1!==t.inclusive_end;t.descending&&(y=!y),p.endkey=v.toIndexableString(y?[f,{}]:[f])}if(void 0!==t.key){var m=v.toIndexableString([t.key]),_=v.toIndexableString([t.key,{}]);p.descending?(p.endkey=m,p.startkey=_):(p.startkey=m,p.endkey=_)}return i||(\"number\"==typeof t.limit&&(p.limit=t.limit),p.skip=s),n(p).then(r)}function U(e){return e.request({method:\"POST\",url:\"_view_cleanup\"})}function G(t){return t.get(\"_local/\"+e).then(function(e){var n=new d.Map;Object.keys(e.views).forEach(function(e){var t=a(e),r=\"_design/\"+t[0],o=t[1],i=n.get(r);i||(i=new d.Set,n.set(r,i)),i.add(o)});var r={keys:g.mapToKeysArray(n),include_docs:!0};return t.allDocs(r).then(function(r){var o={};r.rows.forEach(function(t){var r=t.key.substring(8);n.get(t.key).forEach(function(n){var i=r+\"/\"+n;e.views[i]||(i=n);var s=Object.keys(e.views[i]),a=t.doc&&t.doc.views&&t.doc.views[n];s.forEach(function(e){o[e]=o[e]||a})})});var i=Object.keys(o).filter(function(e){return!o[e]}),s=i.map(function(e){return g.sequentialize(B(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return l.all(s).then(function(){return{ok:!0}})})},q({ok:!0}))}function z(t,n,r){if(\"function\"==typeof t._query)return C(t,n,r);if(h.isRemote(t))return x(t,n,r);if(\"string\"!=typeof n)return D(r,n),_.add(function(){return s(t,\"temp_view/temp_view\",n.map,n.reduce,!0,e).then(function(e){return g.fin(N(e).then(function(){return F(e,r)}),function(){return e.db.destroy()})})}),_.finish();var i=n,u=a(i),c=u[0],f=u[1];return t.get(\"_design/\"+c).then(function(n){var a=n.views&&n.views[f];if(!a)throw new g.NotFoundError(\"ddoc \"+n._id+\" has no view named \"+f);return o(n,f),D(r,a),s(t,i,a.map,a.reduce,!1,e).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&h.nextTick(function(){N(e)}),F(e,r)):N(e).then(function(){return F(e,r)})})})}function K(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?j(t):{},\"function\"==typeof e&&(e={map:e});var o=l.resolve().then(function(){return z(r,e,t)});return g.promisedCallback(o,n),o}return{query:K,viewCleanup:g.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?R(e):h.isRemote(e)?U(e):G(e)})}}var l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),d=e(23),h=e(40),p=e(19),v=e(22),y=e(34),g=e(32);r.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},r.prototype.finish=function(){return this.promise};var m={},_=new r,b=50;t.exports=f},{19:19,22:22,23:23,32:32,34:34,36:36,40:40}],15:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){return new p(function(n,r){function o(){f++,e[l++]().then(s,a)}function i(){++d===h?c?r(c):n():u()}function s(){f--,i()}function a(e){f--,c=c||e,i()}function u(){for(;f<t&&l<h;)o()}var c,f=0,l=0,d=0,h=e.length;u()})}function i(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];n.data=m.base64StringToBlobOrBuffer(n.data,n.content_type)})}function s(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function a(e){return e._attachments&&Object.keys(e._attachments)?p.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];if(n.data&&\"string\"!=typeof n.data)return new p(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e})})):p.resolve()}function u(e){if(!e.prefix)return!1;var t=v.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}function c(e,t){if(u(t)){var n=t.name.substr(t.prefix.length);e=t.prefix+encodeURIComponent(n)}var r=v.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var o=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=o.pop(),-1===r.db.indexOf(\"%\")&&(r.db=encodeURIComponent(r.db)),r.path=o.join(\"/\"),r}function f(e,t){return l(e,e.db+\"/\"+t)}function l(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function d(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function h(e,t){function n(e,t,n){var r=e.ajax||{},o=v.assign(v.clone(j),r,t),i=v.clone(j.headers||{});return o.headers=v.assign(i,r.headers,t.headers||{}),S.constructor.listeners(\"debug\").length&&S.constructor.emit(\"debug\",[\"http\",o.method,o.url]),S._ajax(o,n)}function r(e,t){return new p(function(r,o){n(e,t,function(e,t){if(e)return o(e);r(t)})})}function u(e,t){return v.adapterFun(e,g(function(e){h().then(function(){return t.apply(this,e)}).catch(function(t){e.pop()(t)})}))}function h(){return e.skipSetup||e.skip_setup?p.resolve():C||(C=r({},{method:\"GET\",url:A}).catch(function(e){return e&&e.status&&404===e.status?(v.explainError(404,\"PouchDB is just detecting if the remote exists.\"),r({},{method:\"PUT\",url:A})):p.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||p.reject(e)}),C.catch(function(){C=null}),C)}function E(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}var S=this,O=c(e.name,e),A=f(O,\"\");e=v.clone(e);var j=e.ajax||{};if(e.auth||O.auth){var I=e.auth||O.auth,D=I.username+\":\"+I.password,x=m.btoa(unescape(encodeURIComponent(D)));j.headers=j.headers||{},j.headers.Authorization=\"Basic \"+x}S._ajax=y;var C;v.nextTick(function(){t(null,S)}),S._remote=!0,S.type=function(){return\"http\"},S.id=u(\"id\",function(e){n({},{method:\"GET\",url:l(O,\"\")},function(t,n){var r=n&&n.uuid?n.uuid+O.db:f(O,\"\");e(null,r)})}),S.request=u(\"request\",function(e,t){e.url=f(O,e.url),n({},e,t)}),S.compact=u(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e),n(e,{url:f(O,\"_compact\"),method:\"POST\"},function(){function n(){S.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0}):setTimeout(n,e.interval||200)})}n()})}),S.bulkGet=v.adapterFun(\"bulkGet\",function(e,t){function r(t){var r={};e.revs&&(r.revs=!0),e.attachments&&(r.attachments=!0),e.latest&&(r.latest=!0),n(e,{url:f(O,\"_bulk_get\"+d(r)),method:\"POST\",body:{docs:e.docs}},t)}function o(){for(var n=w,r=Math.ceil(e.docs.length/n),o=0,s=new Array(r),a=0;a<r;a++){var u=v.pick(e,[\"revs\",\"attachments\",\"latest\"]);u.ajax=j,\nu.docs=e.docs.slice(a*n,Math.min(e.docs.length,(a+1)*n)),v.bulkGetShim(i,u,function(e){return function(n,i){s[e]=i.results,++o===r&&t(null,{results:v.flatten(s)})}}(a))}}var i=this,s=l(O,\"\"),a=k[s];\"boolean\"!=typeof a?r(function(e,n){e?(k[s]=!1,v.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),o()):(k[s]=!0,t(null,n))}):a?r(t):o()}),S._info=function(e){h().then(function(){n({},{method:\"GET\",url:f(O,\"\")},function(t,n){if(t)return e(t);n.host=f(O,\"\"),e(null,n)})}).catch(e)},S.get=u(\"get\",function(e,t,n){function i(e){function n(n){var o=i[n],a=s(e._id)+\"/\"+E(n)+\"?rev=\"+e._rev;return r(t,{method:\"GET\",url:f(O,a),binary:!0}).then(function(e){return t.binary?e:new p(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete o.stub,delete o.length,o.data=e})}var i=e._attachments,a=i&&Object.keys(i);if(i&&a.length){return o(a.map(function(e){return function(){return n(e)}}),5)}}function a(e){return Array.isArray(e)?p.all(e.map(function(e){if(e.ok)return i(e.ok)})):i(e)}\"function\"==typeof t&&(n=t,t={}),t=v.clone(t);var u={};t.revs&&(u.revs=!0),t.revs_info&&(u.revs_info=!0),t.latest&&(u.latest=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),u.open_revs=t.open_revs),t.rev&&(u.rev=t.rev),t.conflicts&&(u.conflicts=t.conflicts),e=s(e);var c={method:\"GET\",url:f(O,e+d(u))};r(t,c).then(function(e){return p.resolve().then(function(){if(t.attachments)return a(e)}).then(function(){n(null,e)})}).catch(n)}),S.remove=u(\"remove\",function(e,t,r,o){var i;\"string\"==typeof t?(i={_id:e,_rev:t},\"function\"==typeof r&&(o=r,r={})):(i=e,\"function\"==typeof t?(o=t,r={}):(o=r,r=t));var a=i._rev||r.rev;n(r,{method:\"DELETE\",url:f(O,s(i._id))+\"?rev=\"+a},o)}),S.getAttachment=u(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var i=r.rev?\"?rev=\"+r.rev:\"\";n(r,{method:\"GET\",url:f(O,s(e))+\"/\"+E(t)+i,binary:!0},o)}),S.removeAttachment=u(\"removeAttachment\",function(e,t,r,o){n({},{method:\"DELETE\",url:f(O,s(e)+\"/\"+E(t))+\"?rev=\"+r},o)}),S.putAttachment=u(\"putAttachment\",function(e,t,r,o,i,a){\"function\"==typeof i&&(a=i,i=o,o=r,r=null);var u=s(e)+\"/\"+E(t),c=f(O,u);if(r&&(c+=\"?rev=\"+r),\"string\"==typeof o){var l;try{l=m.atob(o)}catch(e){return a(_.createError(_.BAD_ARG,\"Attachment is not a valid base64 string\"))}o=l?m.binaryStringToBlobOrBuffer(l,i):\"\"}n({},{headers:{\"Content-Type\":i},method:\"PUT\",url:c,processData:!1,body:o,timeout:j.timeout||6e4},a)}),S._bulkDocs=function(e,t,r){e.new_edits=t.new_edits,h().then(function(){return p.all(e.docs.map(a))}).then(function(){n(t,{method:\"POST\",url:f(O,\"_bulk_docs\"),timeout:t.timeout,body:e},function(e,t){if(e)return r(e);t.forEach(function(e){e.ok=!0}),r(null,t)})}).catch(r)},S._put=function(e,t,r){h().then(function(){return a(e)}).then(function(){n(t,{method:\"PUT\",url:f(O,s(e._id)),body:e},function(e,t){if(e)return r(e);r(null,t)})}).catch(r)},S.allDocs=u(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e);var n,o={},s=\"GET\";e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),e.include_docs&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.key&&(o.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(o.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(o.endkey=JSON.stringify(e.endkey)),void 0!==e.inclusive_end&&(o.inclusive_end=!!e.inclusive_end),void 0!==e.limit&&(o.limit=e.limit),void 0!==e.skip&&(o.skip=e.skip);var a=d(o);void 0!==e.keys&&(s=\"POST\",n={keys:e.keys}),r(e,{method:s,url:f(O,\"_all_docs\"+a),body:n}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.rows.forEach(i),t(null,n)}).catch(t)}),S._changes=function(e){var t=\"batch_size\"in e?e.batch_size:b;e=v.clone(e),e.timeout=\"timeout\"in e?e.timeout:\"timeout\"in j?j.timeout:3e4;var r,o=e.timeout?{timeout:e.timeout-5e3}:{},s=void 0!==e.limit&&e.limit;r=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var a=s;if(e.style&&(o.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.continuous&&(o.feed=\"longpoll\"),e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),\"heartbeat\"in e?e.heartbeat&&(o.heartbeat=e.heartbeat):e.continuous&&(o.heartbeat=1e4),e.filter&&\"string\"==typeof e.filter&&(o.filter=e.filter),e.view&&\"string\"==typeof e.view&&(o.filter=\"_view\",o.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var u in e.query_params)e.query_params.hasOwnProperty(u)&&(o[u]=e.query_params[u]);var c,l=\"GET\";e.doc_ids?(o.filter=\"_doc_ids\",l=\"POST\",c={doc_ids:e.doc_ids}):e.selector&&(o.filter=\"_selector\",l=\"POST\",c={selector:e.selector});var p,y,g=function(r,i){if(!e.aborted){o.since=r,\"object\"==typeof o.since&&(o.since=JSON.stringify(o.since)),e.descending?s&&(o.limit=a):o.limit=!s||a>t?t:a;var u={method:l,url:f(O,\"_changes\"+d(o)),timeout:e.timeout,body:c};y=r,e.aborted||h().then(function(){p=n(e,u,i)}).catch(i)}},m={results:[]},_=function(n,o){if(!e.aborted){var u=0;if(o&&o.results){u=o.results.length,m.last_seq=o.last_seq;({}).query=e.query_params,o.results=o.results.filter(function(t){a--;var n=v.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&i(t),r&&m.results.push(t),e.onChange(t)),n})}else if(n)return e.aborted=!0,void e.complete(n);o&&o.last_seq&&(y=o.last_seq);var c=s&&a<=0||o&&u<t||e.descending;(!e.continuous||s&&a<=0)&&c?e.complete(null,m):v.nextTick(function(){g(y,_)})}};return g(e.since||0,_),{cancel:function(){e.aborted=!0,p&&p.abort()}}},S.revsDiff=u(\"revsDiff\",function(e,t,r){\"function\"==typeof t&&(r=t,t={}),n(t,{method:\"POST\",url:f(O,\"_revs_diff\"),body:e},r)}),S._close=function(e){e()},S._destroy=function(e,t){n(e,{url:f(O,\"\"),method:\"DELETE\"},function(e,n){if(e&&e.status&&404!==e.status)return t(e);t(null,n)})}}var p=r(e(36)),v=e(40),y=r(e(18)),g=r(e(7)),m=e(19),_=e(29),b=25,w=50,k={};h.valid=function(){return!0};var E=function(e){e.adapter(\"http\",h,!1),e.adapter(\"https\",h,!1)};t.exports=E},{18:18,19:19,29:29,36:36,40:40,7:7}],16:[function(e,t,n){\"use strict\";function r(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(x.createError(x.IDB_ERROR,n,t.type))}}function o(e,t,n){return{data:q.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function i(e){if(!e)return null;var t=q.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function s(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function a(e,t,n,r){n?r(e?\"string\"!=typeof e?e:T.base64StringToBlobOrBuffer(e,t):T.blob([\"\"],{type:t})):e?\"string\"!=typeof e?T.readAsBinaryString(e,function(e){r(T.btoa(e))}):r(e):r(\"\")}function u(e,t,n,r){function o(){++a===s.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest;n.objectStore(M).get(i).onsuccess=function(e){r.body=e.target.result.body,o()}}var s=Object.keys(e._attachments||{});if(!s.length)return r&&r();var a=0;s.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function c(e,t){return R.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return R.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new R(function(s){a(o,i,t,function(t){e.doc._attachments[n]=I.assign(I.pick(r,[\"digest\",\"content_type\"]),{data:t}),s()})})}}))}}))}function f(e,t,n){function r(){--c||o()}function o(){i.length&&i.forEach(function(e){u.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1)).onsuccess=function(t){t.target.result||a.delete(e)}})}var i=[],s=n.objectStore(N),a=n.objectStore(M),u=n.objectStore($),c=e.length;e.forEach(function(e){var n=s.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();s.delete(t),u.index(\"seq\").openCursor(IDBKeyRange.only(t)).onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),u.delete(t.primaryKey),t.continue()}else r()}}})}function l(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}function d(e,t,n,s,a,u){function c(){var e=[B,N,M,P,$,F],t=l(a,e,\"readwrite\");if(t.error)return u(t.error);S=t.txn,S.onabort=r(u),S.ontimeout=r(u),S.oncomplete=y,O=S.objectStore(B),A=S.objectStore(N),I=S.objectStore(M),R=S.objectStore($),q=S.objectStore(F),q.get(F).onsuccess=function(e){L=e.target.result,p()},m(function(e){if(e)return Z=!0,u(e);v()})}function d(){V=!0,p()}function h(){C.processDocs(e.revs_limit,U,s,H,S,W,_,n,d)}function p(){L&&V&&(L.docCount+=Q,q.put(L))}function v(){function e(){++n===U.length&&h()}function t(t){var n=i(t.target.result);n&&H.set(n.id,n),e()}if(U.length)for(var n=0,r=0,o=U.length;r<o;r++){var s=U[r];if(s._id&&C.isLocalId(s._id))e();else{var a=O.get(s.metadata.id);a.onsuccess=t}}}function y(){Z||(G.notify(s._meta.name),u(null,W))}function g(e,t){I.get(e).onsuccess=function(n){if(n.target.result)t();else{var r=x.createError(x.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function m(e){function t(){++o===n.length&&e(r)}var n=[];if(U.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){g(e,function(e){e&&!r&&(r=e),t()})})}function _(e,t,n,r,o,i,s,a){e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;if(u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0),u._attachments&&Object.keys(u._attachments).length)return w(e,t,n,o,s,a);Q+=i,p(),b(e,t,n,o,s,a)}function b(e,t,n,r,i,a){function u(i){var a=e.stemmedRevs||[];r&&s.auto_compaction&&(a=a.concat(D.compactTree(e.metadata))),a&&a.length&&f(a,e.metadata.id,S),h.seq=i.target.result;var u=o(h,t,n);O.put(u).onsuccess=l}function c(e){e.preventDefault(),e.stopPropagation(),A.index(\"_doc_id_rev\").getKey(d._doc_id_rev).onsuccess=function(e){A.put(d,e.target.result).onsuccess=u}}function l(){W[i]={ok:!0,id:h.id,rev:h.rev},H.set(e.metadata.id,e.metadata),k(e,h.seq,a)}var d=e.data,h=e.metadata;d._doc_id_rev=h.id+\"::\"+h.rev,delete d._id,delete d._rev;var p=A.put(d);p.onsuccess=u,p.onerror=c}function w(e,t,n,r,o,i){function s(){c===f.length&&b(e,t,n,r,o,i)}function a(){c++,s()}var u=e.data,c=0,f=Object.keys(u._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)c++,s();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);E(r.digest,o,a)}})}function k(e,t,n){function r(){++o===i.length&&n()}var o=0,i=Object.keys(e.data._attachments||{});if(!i.length)return n();for(var s=0;s<i.length;s++)!function(n){var o=e.data._attachments[n].digest,i=R.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}(i[s])}function E(e,t,n){I.count(e).onsuccess=function(r){if(r.target.result)return n();var o={digest:e,body:t};I.put(o).onsuccess=n}}for(var S,O,A,I,R,q,T,L,U=t.docs,z=0,K=U.length;z<K;z++){var J=U[z];J._id&&C.isLocalId(J._id)||(J=U[z]=C.parseDoc(J,n.new_edits),J.error&&!T&&(T=J))}if(T)return u(T);var V=!1,Q=0,W=new Array(U.length),H=new j.Map,Z=!1,Y=s._meta.blobSupport?\"blob\":\"base64\";C.preprocessAttachments(U,Y,function(e){if(e)return u(e);c()})}function h(e,t,n,r,o){function i(e){f=e.target.result,c&&o(c,f,l)}function s(e){c=e.target.result,f&&o(c,f,l)}function a(){if(!c.length)return o();var n,a=c[c.length-1];if(t&&t.upper)try{n=IDBKeyRange.bound(a,t.upper,!0,t.upperOpen)}catch(e){if(\"DataError\"===e.name&&0===e.code)return o()}else n=IDBKeyRange.lowerBound(a,!0);t=n,c=null,f=null,e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s}function u(e){var t=e.target.result;if(!t)return o();o([t.key],[t.value],t)}var c,f,l,d=\"function\"==typeof e.getAll&&\"function\"==typeof e.getAllKeys&&r>1&&!n;d?(l={continue:a},e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=s):n?e.openCursor(t,\"prev\").onsuccess=u:e.openCursor(t).onsuccess=u}function p(e,t,n){function r(e){var t=e.target.result;t?(o.push(t.value),t.continue()):n({target:{result:o}})}if(\"function\"==typeof e.getAll)return void(e.getAll(t).onsuccess=n);var o=[];e.openCursor(t).onsuccess=r}function v(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}function y(e,t,n){function o(t,n,r){var o=t.id+\"::\"+r;$.get(o).onsuccess=function(r){if(n.doc=s(r.target.result),e.conflicts){var o=D.collectConflicts(t);o.length&&(n.doc._conflicts=o)}u(n.doc,e,C)}}function a(t,n){var r={id:n.id,key:n.id,value:{rev:t}},i=n.deleted;\"ok\"===e.deleted?(P.push(r),i?(r.value.deleted=!0,r.doc=null):e.include_docs&&o(n,r,t)):!i&&k--<=0&&(P.push(r),e.include_docs&&o(n,r,t))}function f(e){for(var t=0,n=e.length;t<n&&P.length!==E;t++){var r=e[t],o=i(r);a(o.winningRev,o)}}function d(e,t,n){n&&(f(t),P.length<E&&n.continue())}function y(t){var n=t.target.result;e.descending&&(n=n.reverse()),f(n)}function g(){n(null,{total_rows:R,offset:e.skip,rows:P})}function m(){e.attachments?c(P,e.binary).then(g):g()}var _=\"startkey\"in e&&e.startkey,b=\"endkey\"in e&&e.endkey,w=\"key\"in e&&e.key,k=e.skip||0,E=\"number\"==typeof e.limit?e.limit:-1,S=!1!==e.inclusive_end,O=v(_,b,S,w,e.descending),A=O&&O.error;if(A&&(\"DataError\"!==A.name||0!==A.code))return n(x.createError(x.IDB_ERROR,A.name,A.message));var j=[B,N,F];e.attachments&&j.push(M);var I=l(t,j,\"readonly\");if(I.error)return n(I.error);var C=I.txn;C.oncomplete=m,C.onabort=r(n);var R,q=C.objectStore(B),T=C.objectStore(N),L=C.objectStore(F),$=T.index(\"_doc_id_rev\"),P=[];return L.get(F).onsuccess=function(e){R=e.target.result.docCount},A||0===E?void 0:-1===E?p(q,O,y):void h(q,O,e.descending,E+k,d)}function g(e){return new R(function(t){var n=T.blob([\"\"]);e.objectStore(U).put(n,\"key\").onsuccess=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)},e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)}}).catch(function(){return!1})}function m(e,t){e.objectStore(B).index(\"deletedOrLocal\").count(IDBKeyRange.only(\"0\")).onsuccess=function(e){t(e.target.result)}}function _(e,t,n,r){try{e(t,n)}catch(t){r.emit(\"error\",t)}}function b(){!z&&K.length&&(z=!0,K.shift()())}function w(e,t,n){K.push(function(){e(function(e,r){_(t,e,r,n),z=!1,I.nextTick(function(){b(n)})})}),b()}function k(e,t,n,o){function a(t,n,r){function o(t,n){var r=e.processChange(n,t,e);m=r.seq=t.seq;var o=D(r);if(\"object\"==typeof o)return e.complete(o);o&&(A++,b&&O.push(r),e.attachments&&e.include_docs?u(n,e,w,function(){c([r],e.binary).then(function(){e.onChange(r)})}):e.onChange(r))}function i(){for(var e=0,t=a.length;e<t&&A!==_;e++){var n=a[e];if(n){o(f[e],n)}}A!==_&&r.continue()}if(r&&t.length){var a=new Array(t.length),f=new Array(t.length),l=0;n.forEach(function(e,n){d(s(e),t[n],function(e,r){f[n]=e,a[n]=r,++l===t.length&&i()})})}}function f(e,t,n,r){if(n.seq!==t)return r();if(n.winningRev===e._rev)return r(n,e);var o=e._id+\"::\"+n.winningRev;S.get(o).onsuccess=function(e){r(n,s(e.target.result))}}function d(e,t,n){if(g&&!g.has(e._id))return n();var r=x.get(e._id);if(r)return f(e,t,r,n);E.get(e._id).onsuccess=function(o){r=i(o.target.result),x.set(e._id,r),f(e,t,r,n)}}function p(){e.complete(null,{results:O,last_seq:m})}function v(){!e.continuous&&e.attachments?c(O).then(p):p()}if(e=I.clone(e),e.continuous){var y=n+\":\"+I.uuid();return G.addListener(n,y,t,e),G.notify(n),{cancel:function(){G.removeListener(n,y)}}}var g=e.doc_ids&&new j.Set(e.doc_ids);e.since=e.since||0;var m=e.since,_=\"limit\"in e?e.limit:-1;0===_&&(_=1);var b;b=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var w,k,E,S,O=[],A=0,D=I.filterChange(e),x=new j.Map,C=[B,N];e.attachments&&C.push(M);var R=l(o,C,\"readonly\");if(R.error)return e.complete(R.error);w=R.txn,w.onabort=r(e.complete),w.oncomplete=v,k=w.objectStore(N),E=w.objectStore(B),S=k.index(\"_doc_id_rev\"),h(k,e.since&&!e.descending?IDBKeyRange.lowerBound(e.since,!0):null,e.descending,_,a)}function E(e,t){var n=this;w(function(t){S(n,e,t)},t,n.constructor)}function S(e,t,n){function u(e){var t=e.createObjectStore(B,{keyPath:\"id\"});e.createObjectStore(N,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(M,{keyPath:\"digest\"}),e.createObjectStore(F,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(U),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(P,{keyPath:\"_id\"});var n=e.createObjectStore($,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function c(e,t){var n=e.objectStore(B);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=D.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r.continue()}else t()}}function h(e){e.createObjectStore(P,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function p(e,t){var n=e.objectStore(P),r=e.objectStore(B),o=e.objectStore(N);r.openCursor().onsuccess=function(e){var i=e.target.result;if(i){var s=i.value,a=s.id,u=D.isLocalId(a),c=D.winningRev(s);if(u){var f=a+\"::\"+c,l=a+\"::\",d=a+\"::~\",h=o.index(\"_doc_id_rev\"),p=IDBKeyRange.bound(l,d,!1,!1),v=h.openCursor(p);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o.delete(v.primaryKey),v.continue()}else r.delete(i.primaryKey),i.continue()}}else i.continue()}else t&&t()}}function v(e){var t=e.createObjectStore($,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function _(e,t){var n=e.objectStore(N),r=e.objectStore(M),o=e.objectStore($);r.count().onsuccess=function(e){if(!e.target.result)return t();n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,s=Object.keys(r._attachments||{}),a={},u=0;u<s.length;u++)a[r._attachments[s[u]].digest]=!0;var c=Object.keys(a);for(u=0;u<c.length;u++){var f=c[u];o.put({seq:i,digestSeq:f+\"::\"+i})}n.continue()}}}function b(e){function t(e){return e.data?i(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(N),r=e.objectStore(B);r.openCursor().onsuccess=function(e){function i(){var e=o(a,a.winningRev,a.deleted);r.put(e).onsuccess=function(){s.continue()}}var s=e.target.result;if(s){var a=t(s.value);if(a.winningRev=a.winningRev||D.winningRev(a),a.seq)return i();!function(){var e=a.id+\"::\",t=a.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return a.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t.continue()}}()}}}var w=t.name,E=null;e._meta=null,e._remote=!1,e.type=function(){return\"idb\"},e._id=I.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){d(t,n,r,e,E,o)},e._get=function(e,t,n){function r(){n(u,{doc:o,metadata:a,ctx:c})}var o,a,u,c=t.ctx;if(!c){var f=l(E,[B,N,M],\"readonly\");if(f.error)return n(f.error);c=f.txn}c.objectStore(B).get(e).onsuccess=function(e){if(!(a=i(e.target.result)))return u=x.createError(x.MISSING_DOC,\"missing\"),r();var n;if(t.rev)n=t.latest?D.latest(t.rev,a):t.rev;else{n=a.winningRev;if(D.isDeleted(a))return u=x.createError(x.MISSING_DOC,\"deleted\"),r()}var f=c.objectStore(N),l=a.id+\"::\"+n;f.index(\"_doc_id_rev\").get(l).onsuccess=function(e){if(o=e.target.result,o&&(o=s(o)),!o)return u=x.createError(x.MISSING_DOC,\"missing\"),r();r()}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var s=l(E,[B,N,M],\"readonly\");if(s.error)return o(s.error);i=s.txn}var u=n.digest,c=n.content_type;i.objectStore(M).get(u).onsuccess=function(e){a(e.target.result.body,c,r.binary,function(e){o(null,e)})}},e._info=function(t){var n,r,o=l(E,[F,N],\"readonly\");if(o.error)return t(o.error);var i=o.txn;i.objectStore(F).get(F).onsuccess=function(e){r=e.target.result.docCount},i.objectStore(N).openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result;n=t?t.key:0},i.oncomplete=function(){t(null,{doc_count:r,update_seq:n,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(e,t){y(e,E,t)},e._changes=function(t){k(t,e,w,E)},e._close=function(e){E.close(),J.delete(w),e()},e._getRevisionTree=function(e,t){var n=l(E,[B],\"readonly\");if(n.error)return t(n.error);n.txn.objectStore(B).get(e).onsuccess=function(e){var n=i(e.target.result);n?t(null,n.rev_tree):t(x.createError(x.MISSING_DOC))}},e._doCompaction=function(e,t,n){var s=[B,N,M,$],a=l(E,s,\"readwrite\");if(a.error)return n(a.error);var u=a.txn;u.objectStore(B).get(e).onsuccess=function(n){var r=i(n.target.result);D.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var s=n+\"-\"+r;-1!==t.indexOf(s)&&(i.status=\"missing\")}),f(t,e,u);var s=r.winningRev,a=r.deleted;u.objectStore(B).put(o(r,s,a))},u.onabort=r(n),u.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=l(E,[P],\"readonly\");if(n.error)return t(n.error);var o=n.txn,i=o.objectStore(P).get(e);i.onerror=r(t),i.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(x.createError(x.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var o=e._rev,i=e._id;e._rev=o?\"0-\"+(parseInt(o.split(\"-\")[1],10)+1):\"0-1\";var s,a=t.ctx;if(!a){var u=l(E,[P],\"readwrite\");if(u.error)return n(u.error);a=u.txn,a.onerror=r(n),a.oncomplete=function(){s&&n(null,s)}}var c,f=a.objectStore(P);o?(c=f.get(i),c.onsuccess=function(r){var i=r.target.result;if(i&&i._rev===o){f.put(e).onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)}}else n(x.createError(x.REV_CONFLICT))}):(c=f.add(e),c.onerror=function(e){n(x.createError(x.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},c.onsuccess=function(){s={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,s)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var o=t.ctx;if(!o){var i=l(E,[P],\"readwrite\");if(i.error)return n(i.error);o=i.txn,o.oncomplete=function(){s&&n(null,s)}}var s,a=e._id,u=o.objectStore(P),c=u.get(a);c.onerror=r(n),c.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(u.delete(a),s={ok:!0,id:a,rev:\"0-0\"},t.ctx&&n(null,s)):n(x.createError(x.MISSING_DOC))}},e._destroy=function(e,t){G.removeAllListeners(w);var n=V.get(w);n&&n.result&&(n.result.close(),J.delete(w));var o=indexedDB.deleteDatabase(w);o.onsuccess=function(){V.delete(w),I.hasLocalStorage()&&w in localStorage&&delete localStorage[w],t(null,{ok:!0})},o.onerror=r(t)};var S=J.get(w);if(S)return E=S.idb,e._meta=S.global,I.nextTick(function(){n(null,e)});var j;j=t.storage?O(w,t.storage):indexedDB.open(w,L),V.set(w,j),j.onupgradeneeded=function(e){function t(){var e=o[i-1];i++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return u(n);var r=e.currentTarget.transaction;e.oldVersion<3&&h(n),e.oldVersion<4&&v(n);var o=[c,p,_,b],i=e.oldVersion;t()},j.onsuccess=function(t){function r(){void 0!==a&&f&&(e._meta={name:w,instanceId:u,blobSupport:a},J.set(w,{idb:E,global:e._meta}),n(null,e))}function o(){if(void 0!==s&&void 0!==i){var e=w+\"_id\";e in i?u=i[e]:i[e]=u=I.uuid(),i.docCount=s,c.objectStore(F).put(i)}}E=t.target.result,E.onversionchange=function(){E.close(),J.delete(w)},E.onabort=function(e){I.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),E.close(),J.delete(w)};var i,s,a,u,c=E.transaction([F,U,B],\"readwrite\"),f=!1;c.objectStore(F).get(F).onsuccess=function(e){i=e.target.result||{id:F},o()},m(c,function(e){s=e,o()}),A||(A=g(c)),A.then(function(e){a=e,r()}),c.oncomplete=function(){f=!0,r()}},j.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";I.guardedConsole(\"error\",e),n(x.createError(x.IDB_ERROR,e))}}function O(e,t){try{return indexedDB.open(e,{version:L,storage:t})}catch(t){return indexedDB.open(e,L)}}var A,j=e(23),I=e(40),D=e(35),x=e(29),C=e(17),R=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),q=e(31),T=e(19),L=5,B=\"document-store\",N=\"by-sequence\",M=\"attach-store\",$=\"attach-seq-store\",F=\"meta-store\",P=\"local-store\",U=\"detect-blob-support\",G=new I.changesHandler,z=!1,K=[],J=new j.Map,V=new j.Map;E.valid=function(){return!(\"undefined\"!=typeof openDatabase&&/(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)&&!/BlackBerry/.test(navigator.platform))&&\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange};var Q=function(e){e.adapter(\"idb\",E,!0)};t.exports=Q},{17:17,19:19,23:23,29:29,31:31,35:35,36:36,40:40}],17:[function(e,t,n){\"use strict\";function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function o(e){if(!/^\\d+\\-./.test(e))return y.createError(y.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function i(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,s=r.length;i<s;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function s(e,t){var n,r,s,a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=v.uuid()),r=v.uuid(32,16).toLowerCase(),e._rev){if(s=o(e._rev),s.error)return s;e._rev_tree=[{pos:s.prefix,ids:[s.id,{status:\"missing\"},[[r,a,[]]]]}],n=s.prefix+1}else e._rev_tree=[{pos:1,ids:[r,a,[]]}],n=1;else if(e._revisions&&(e._rev_tree=i(e._revisions,a),n=e._revisions.start,r=e._revisions.ids[0]),!e._rev_tree){if(s=o(e._rev),s.error)return s;n=s.prefix,r=s.id,e._rev_tree=[{pos:n,ids:[r,a,[]]}]}v.invalidIdError(e._id),e._rev=n+\"-\"+r;var u={metadata:{},data:{}};for(var c in e)if(Object.prototype.hasOwnProperty.call(e,c)){var f=\"_\"===c[0];if(f&&!w[c]){var l=y.createError(y.DOC_VALIDATION,c);throw l.message=y.DOC_VALIDATION.message+\": \"+c,l}f&&!k[c]?u.metadata[c.slice(1)]=e[c]:u.data[c]=e[c]}return u}function a(e){try{return m.atob(e)}catch(e){var t=y.createError(y.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:t}}}function u(e,t,n){var r=a(e.data);if(r.error)return n(r.error);e.length=r.length,e.data=\"blob\"===t?m.binaryStringToBlobOrBuffer(r,e.content_type):\"base64\"===t?m.btoa(r):r,_.binaryMd5(r,function(t){e.digest=\"md5-\"+t,n()})}function c(e,t,n){_.binaryMd5(e.data,function(r){e.digest=\"md5-\"+r,e.length=e.data.size||e.data.length||0,\"binary\"===t?m.blobOrBufferToBinaryString(e.data,function(t){e.data=t,n()}):\"base64\"===t?m.blobOrBufferToBase64(e.data,function(t){e.data=t,n()}):n()})}function f(e,t,n){if(e.stub)return n();\"string\"==typeof e.data?u(e,t,n):c(e,t,n)}function l(e,t,n){function r(){i++,e.length===i&&(o?n(o):n())}if(!e.length)return n();var o,i=0;e.forEach(function(e){function n(e){o=e,++s===i.length&&r()}var i=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],s=0;if(!i.length)return r();for(var a in e.data._attachments)e.data._attachments.hasOwnProperty(a)&&f(e.data._attachments[a],t,n)})}function d(e,t,n,r,o,i,a,u){if(g.revExists(t.rev_tree,n.metadata.rev))return r[o]=n,i();var c=t.winningRev||g.winningRev(t),f=\"deleted\"in t?t.deleted:g.isDeleted(t,c),l=\"deleted\"in n.metadata?n.metadata.deleted:g.isDeleted(n.metadata),d=/^1-/.test(n.metadata.rev);if(f&&!l&&u&&d){var h=n.data;h._rev=c,h._id=n.metadata.id,n=s(h,u)}var p=g.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(u&&(f&&l&&\"new_leaf\"!==p.conflicts||!f&&\"new_leaf\"!==p.conflicts||f&&!l&&\"new_branch\"===p.conflicts)){var v=y.createError(y.REV_CONFLICT);return r[o]=v,i()}var m=n.metadata.rev;n.metadata.rev_tree=p.tree,n.stemmedRevs=p.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var _,b=g.winningRev(n.metadata),w=g.isDeleted(n.metadata,b),k=f===w?0:f<w?-1:1;_=m===b?w:g.isDeleted(n.metadata,m),a(n,b,w,_,!0,k,o,i)}function h(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function p(e,t,n,r,o,i,s,a,u){function c(e,t,n){var r=g.winningRev(e.metadata),o=g.isDeleted(e.metadata,r);if(\"was_delete\"in a&&o)return i[t]=y.createError(y.MISSING_DOC,\"deleted\"),n();if(l&&h(e)){var u=y.createError(y.REV_CONFLICT);return i[t]=u,n()}s(e,r,o,o,!1,o?0:1,t,n)}function f(){++v===m&&u&&u()}e=e||1e3;var l=a.new_edits,p=new b.Map,v=0,m=t.length;t.forEach(function(e,t){if(e._id&&g.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,f()})}var s=e.metadata.id;p.has(s)?(m--,p.get(s).push([e,t])):p.set(s,[[e,t]])}),p.forEach(function(t,n){function o(){++u<t.length?a():f()}function a(){var a=t[u],f=a[0],h=a[1];if(r.has(n))d(e,r.get(n),f,i,h,o,s,l);else{var p=g.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=p.tree,f.stemmedRevs=p.stemmedRevs||[],c(f,h,o)}}var u=0;a()})}Object.defineProperty(n,\"__esModule\",{value:!0});var v=e(40),y=e(29),g=e(35),m=e(19),_=e(34),b=e(23),w=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),k=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);n.invalidIdError=v.invalidIdError,n.isDeleted=g.isDeleted,n.isLocalId=g.isLocalId,n.normalizeDdocFunctionName=v.normalizeDdocFunctionName,n.parseDdocFunctionName=v.parseDdocFunctionName,n.parseDoc=s,n.preprocessAttachments=l,n.processDocs=p,n.updateDoc=d},{19:19,23:23,29:29,34:34,35:35,40:40}],18:[function(e,t,n){\"use strict\";function r(){for(var e={},t=new l(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,l.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){e.resolve(t)}).catch(function(t){e.reject(t)}),e}function o(e,t){var n,o,i,s=new Headers,a={method:e.method,credentials:\"include\",headers:s};return e.json&&(s.set(\"Accept\",\"application/json\"),s.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.processData&&\"string\"!=typeof e.body?a.body=JSON.stringify(e.body):a.body=\"body\"in e?e.body:null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&s.set(t,e.headers[t])}),n=r(e.url,a),e.timeout>0&&(o=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(o),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):(e.status=i.statusCode,t(e))}).catch(function(e){e||(e=new Error(\"canceled\")),t(e)}),{abort:n.reject}}function i(e,t){var n,r,o=!1,i=function(){n.abort(),u()},s=function(){o=!0,n.abort(),u()},a={abort:i},u=function(){clearTimeout(r),a.abort=function(){},n&&(n.onprogress=void 0,n.upload&&(n.upload.onprogress=void 0),n.onreadystatechange=void 0,n=void 0)};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(e){return t(new Error(e.name||\"Url is invalid\"))}n.withCredentials=!(\"withCredentials\"in e)||e.withCredentials,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var c in e.headers)e.headers.hasOwnProperty(c)&&n.setRequestHeader(c,e.headers[c]);return e.timeout>0&&(r=setTimeout(s,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(s,e.timeout))},void 0!==n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?d.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var s={}\n;if(o)s=new Error(\"ETIMEDOUT\"),s.code=\"ETIMEDOUT\";else if(\"string\"==typeof n.response)try{s=JSON.parse(n.response)}catch(e){}s.status=n.status,t(s)}u()}},e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),a}function s(e,t){return p||e.xhr?i(e,t):o(e,t)}function a(){return\"\"}function u(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(e){return r(e)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?h.generateErrorFromResponse(e):e})),e.binary&&v(t,n),r(null,t,n)}e=f.clone(e);var r={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=f.assign(r,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),s(e,function(r,o,i){if(r)return t(h.generateErrorFromResponse(r));var s,u=o.headers&&o.headers[\"content-type\"],c=i||a();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof c&&(/json/.test(u)||/^[\\s]*\\{/.test(c)&&/\\}[\\s]*$/.test(c)))try{c=JSON.parse(c.toString())}catch(e){}o.statusCode>=200&&o.statusCode<300?n(c,o,t):(s=h.generateErrorFromResponse(c),s.status=o.statusCode,t(s))})}function c(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=-1!==n.indexOf(\"safari\")&&-1===n.indexOf(\"chrome\"),o=-1!==n.indexOf(\"msie\"),i=-1!==n.indexOf(\"edge\"),s=r||(o||i)&&\"GET\"===e.method,a=!(\"cache\"in e)||e.cache;if(!/^blob:/.test(e.url)&&(s||!a)){var c=-1!==e.url.indexOf(\"?\");e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return u(e,t)}var f=e(40),l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),d=e(19),h=e(29),p=function(){try{return new XMLHttpRequest,!0}catch(e){return!1}}(),v=function(){};t.exports=c},{19:19,29:29,36:36,40:40}],19:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function s(e,t){return i(h(e),t)}function a(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){if(\"undefined\"==typeof FileReader)return t(a((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(a(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=s,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],20:[function(e,t,n){\"use strict\";function r(e){return l.scopeEval('\"use strict\";\\nreturn '+e+\";\",{})}function o(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return l.scopeEval(t,{})}function i(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){var n=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+n+'\"'))}t()}function s(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=l.normalizeDdocFunctionName(e.view):e.filter=l.normalizeDdocFunctionName(e.filter))}function a(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!l.isRemote(e.db)}function u(e,t){var n=t.complete;if(\"_view\"===t.filter){if(!t.view||\"string\"!=typeof t.view){var i=f.createError(f.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(i)}var s=l.parseDdocFunctionName(t.view);e.db.get(\"_design/\"+s[0],function(r,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(f.generateErrorFromResponse(r));var a=i&&i.views&&i.views[s[1]]&&i.views[s[1]].map;if(!a)return n(f.createError(f.MISSING_DOC,i.views?\"missing json key: \"+s[1]:\"missing json key: views\"));t.filter=o(a),e.doChanges(t)})}else if(t.selector)t.filter=function(e){return d.matchesSelector(e,t.selector)},e.doChanges(t);else{var a=l.parseDdocFunctionName(t.filter);e.db.get(\"_design/\"+a[0],function(o,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(o)return n(f.generateErrorFromResponse(o));var s=i&&i.filters&&i.filters[a[1]];if(!s)return n(f.createError(f.MISSING_DOC,i&&i.filters?\"missing json key: \"+a[1]:\"missing json key: filters\"));t.filter=r(s),e.doChanges(t)})}}function c(e){e._changesFilterPlugin={validate:i,normalize:s,shouldFilter:a,filter:u}}var f=e(29),l=e(40),d=e(39);t.exports=c},{29:29,39:39,40:40}],21:[function(e,t,n){\"use strict\";function r(e,t,n,o,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"!==e.adapter&&\"https\"!==e.adapter||f.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:o,_id:t,history:[],replicator:h,version:d};throw n}).then(function(s){if(!i.cancelled&&s.last_seq!==n)return s.history=(s.history||[]).filter(function(e){return e.session_id!==o}),s.history.unshift({last_seq:n,session_id:o}),s.history=s.history.slice(0,p),s.version=d,s.replicator=h,s.session_id=o,s.last_seq=n,e.put(s).catch(function(s){if(409===s.status)return r(e,t,n,o,i);throw s})})}function o(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function i(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:s(e.history,t.history)}function s(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);return n&&0!==t.length?a(n.session_id,t)?{last_seq:n.last_seq,history:e}:a(o.session_id,r)?{last_seq:o.last_seq,history:i}:s(r,i):{last_seq:v,history:[]}}function a(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||a(e,r))}function u(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var c=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),f=e(40),l=e(22),d=1,h=\"pouchdb\",p=5,v=0;o.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},o.prototype.updateTarget=function(e,t){return r(this.target,this.id,e,t,this.returnValue)},o.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?c.resolve(!0):r(this.src,this.id,e,t,this.returnValue).catch(function(e){if(u(e))return n.readOnlySource=!0,!0;throw e})};var y={undefined:function(e,t){return 0===l.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return i(t,e).last_seq}};o.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?c.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return v;var n;return n=t.version?t.version.toString():\"undefined\",n in y?y[n](t,e):v},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:v}).then(function(){return v},function(n){return u(n)?(e.readOnlySource=!0,t.last_seq):v});throw n})}).catch(function(e){if(404!==e.status)throw e;return v})},t.exports=o},{22:22,36:36,40:40}],22:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){return r(e,t,n)+e}function i(e,t){if(e===t)return 0;e=s(e),t=s(t);var n=v(e),r=v(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return h(e,t)}return Array.isArray(e)?d(e,t):p(e,t)}function s(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=s(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];void 0!==i&&(e[o]=s(i))}}}}return e}function a(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return y(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=u(n[r]);else for(;++r<o;){var s=n[r];i+=u(s)+u(e[s])}return i}return\"\"}function u(e){return e=s(e),v(e)+_+a(e)+\"\\0\"}function c(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",s=e.substring(t,t+m),a=parseInt(s,10)+g;for(o&&(a=-a),t+=m;;){var u=e[t];if(\"\\0\"===u)break;i+=u,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==a&&(n=parseFloat(n+\"e\"+a))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var s=e.pop();o[s]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=c(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var s=\"\";;){var a=e[r];if(\"\\0\"===a)break;s+=a,r++}s=s.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(s);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function h(e,t){return e===t?0:e>t?1:-1}function p(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),s=0;s<o;s++){var a=i(n[s],r[s]);if(0!==a)return a;if(0!==(a=i(e[n[s]],t[r[s]])))return a}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function y(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",s=(r?-n:n)-g,a=o(s.toString(),\"0\",m);i+=_+a;var u=Math.abs(parseFloat(t[0]));r&&(u=10-u);var c=u.toFixed(20);return c=c.replace(/\\.?0+$/,\"\"),i+=_+c}Object.defineProperty(n,\"__esModule\",{value:!0});var g=-324,m=3,_=\"\";n.collate=i,n.normalizeKey=s,n.toIndexableString=u,n.parseIndexableString=l},{}],23:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this._store={}}function s(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n],s=this._store[i];i=o(i),e(s,i)}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),s.prototype.add=function(e){return this._store.set(e,!0)},s.prototype.has=function(e){return this._store.has(e)},s.prototype.forEach=function(e){this._store.forEach(function(t,n){e(n)})},Object.defineProperty(s.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=s,n.Map=i):(n.Set=Set,n.Map=Map)},{}],24:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){try{e.emit(\"change\",t)}catch(e){b.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}function i(e,t,n){function r(){i.cancel()}S.EventEmitter.call(this);var i=this;this.db=e,t=t?b.clone(t):{};var s=t.complete=b.once(function(t,n){t?b.listenerCount(i,\"error\")>0&&i.emit(\"error\",t):i.emit(\"complete\",n),i.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(i.on(\"complete\",function(e){n(null,e)}),i.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){i.isCancelled||o(i,e)};var a=new E(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});i.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=a.then.bind(a),this.catch=a.catch.bind(a),this.then(function(e){s(null,e)},s),e.taskqueue.isReady?i.validateChanges(t):e.taskqueue.addTask(function(e){e?t.complete(e):i.isCancelled?i.emit(\"cancel\"):i.validateChanges(t)})}function s(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=A.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return A.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=A.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function a(e,t){return e<t?-1:e>t?1:0}function u(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function c(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=b.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function f(e,t){var n=a(e._id,t._id);return 0!==n?n:a(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function l(e){var t={},n=[];return A.traverseRevTree(e,function(e,r,o,i){var s=r+\"-\"+o;return e&&(t[s]=0),void 0!==i&&n.push({from:i,to:s}),s}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function d(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return E.all(r.map(function(n){var r=b.assign({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new E(function(t,i){e._allDocs(r,function(e,r){if(e)return i(e);o.total_rows=r.total_rows,t(r.rows[0]||{key:n,error:\"not_found\"})})})})).then(function(e){return o.rows=e,o})}function h(e){var t=e._compactionQueue[0],n=t.opts,r=t.callback;e.get(\"_local/compaction\").catch(function(){return!1}).then(function(t){t&&t.last_seq&&(n.last_seq=t.last_seq),e._compact(n,function(t,n){t?r(t):r(null,n),b.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&h(e)})})})}function p(e){return\"_\"===e.charAt(0)&&e+\" is not a valid attachment name, attachment names cannot start with '_'\"}function v(){S.EventEmitter.call(this)}function y(){this.isReady=!1,this.failed=!1,this.queue=[]}function g(e,t){var n=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=_.adapters,o=_.preferredAdapters,i=_.prefix,s=t.adapter;if(!s)for(var a=0;a<o.length;++a){s=o[a];{if(!(\"idb\"===s&&\"websql\"in r&&b.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]))break;b.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.')}}var u=r[s];return{name:u&&\"use_prefix\"in u&&!u.use_prefix?e:i+e,adapter:s}}function m(e){function t(){e.removeListener(\"closed\",r),e.constructor.emit(\"destroyed\",e.name)}function n(){e.removeListener(\"destroyed\",t),e.removeListener(\"closed\",r),e.emit(\"destroyed\")}function r(){e.removeListener(\"destroyed\",t),o.delete(e.name)}var o=e.constructor._destructionListeners;e.once(\"destroyed\",t),e.once(\"closed\",r),o.has(e.name)||o.set(e.name,[]),o.get(e.name).push(n)}function _(e,t){if(!(this instanceof _))return new _(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(t=e,e=t.name,delete t.name),this.__opts=t=b.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=_.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=(t.prefix||\"\")+e,o=g(r,t);if(t.name=o.name,t.adapter=t.adapter||o.adapter,n.name=e,n._adapter=t.adapter,_.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!_.adapters[t.adapter]||!_.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);v.call(n),n.taskqueue=new y,n.adapter=t.adapter,_.adapters[t.adapter].call(n,t,function(e){if(e)return n.taskqueue.fail(e);m(n),n.emit(\"created\",n),_.emit(\"created\",n.name),n.taskqueue.ready(n)})}var b=e(40),w=e(23),k=r(e(12)),E=r(e(36)),S=e(10),O=r(e(7)),A=e(35),j=e(29),I=r(e(25)),D=r(e(20));k(i,S.EventEmitter),i.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},i.prototype.validateChanges=function(e){var t=e.complete,n=this;_._changesFilterPlugin?_._changesFilterPlugin.validate(e,function(r){if(r)return t(r);n.doChanges(e)}):n.doChanges(e)},i.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=b.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=s,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){if(t.isCancelled)return void n(null,{status:\"cancelled\"});e.since=r.update_seq,t.doChanges(e)},n);if(_._changesFilterPlugin){if(_._changesFilterPlugin.normalize(e),_._changesFilterPlugin.shouldFilter(this,e))return _._changesFilterPlugin.filter(this,e)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(t){t in e&&b.guardedConsole(\"warn\",'The \"'+t+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=O(function(e){r.cancel(),o.apply(this,e)})}},k(v,S.EventEmitter),v.prototype.post=b.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(j.createError(j.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,u(n))}),v.prototype.put=b.adapterFun(\"put\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(j.createError(j.NOT_AN_OBJECT)):(b.invalidIdError(e._id),A.isLocalId(e._id)&&\"function\"==typeof this._putLocal?e._deleted?this._removeLocal(e,n):this._putLocal(e,n):void(\"function\"==typeof this._put&&!1!==t.new_edits?this._put(e,t,n):this.bulkDocs({docs:[e]},t,u(n))))}),v.prototype.putAttachment=b.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},s.put(e)}var s=this;return\"function\"==typeof o&&(o=r,r=n,n=null),void 0===o&&(o=r,r=n,n=null),o||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e,\"is missing content_type\"),s.get(e).then(function(e){if(e._rev!==n)throw j.createError(j.REV_CONFLICT);return i(e)},function(t){if(t.reason===j.MISSING_DOC.message)return i({_id:e});throw t})}),v.prototype.removeAttachment=b.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(j.createError(j.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),v.prototype.remove=b.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};if(i._deleted=!0,A.isLocalId(i._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[i]},n,u(r))}),v.prototype.revsDiff=b.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){a.has(e)||a.set(e,{missing:[]}),a.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);A.traverseRevTree(n,function(e,n,i,s,a){var u=n+\"-\"+i,c=o.indexOf(u);-1!==c&&(o.splice(c,1),\"available\"!==a.status&&r(t,u))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var s=0,a=new w.Map;i.map(function(t){this._getRevisionTree(t,function(r,u){if(r&&404===r.status&&\"missing\"===r.message)a.set(t,{missing:e[t]});else{if(r)return n(r);o(t,u)}if(++s===i.length){var c={};return a.forEach(function(e,t){c[t]=e}),n(null,c)}})},this)}),v.prototype.bulkGet=b.adapterFun(\"bulkGet\",function(e,t){b.bulkGetShim(this,e,t)}),v.prototype.compactDocument=b.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var s=l(i),a=[],u=[];Object.keys(s).forEach(function(e){s[e]>t&&a.push(e)}),A.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(i)&&u.push(i)}),r._doCompaction(e,u,n)})}),v.prototype.compact=b.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&h(n)}),v.prototype._compact=function(e,t){function n(e){s.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;E.all(s).then(function(){return b.upsert(o,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<n)&&(e.last_seq=n,e)})}).then(function(){t(null,{ok:!0})}).catch(t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},s=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},v.prototype.get=b.adapterFun(\"get\",function(e,t,n){function r(){var r=[],s=o.length;if(!s)return n(null,r);o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,latest:t.latest,attachments:t.attachments},function(e,t){if(e)r.push({missing:o});else{for(var i,a=0,u=r.length;a<u;a++)if(r[a].ok&&r[a].ok._rev===t._rev){i=!0;break}i||r.push({ok:t})}--s||n(null,r)})})}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(j.createError(j.INVALID_ID));if(A.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,s=r.metadata,a=r.ctx;if(t.conflicts){var u=A.collectConflicts(s);u.length&&(o._conflicts=u)}if(A.isDeleted(s,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){for(var c=o._rev.split(\"-\"),f=parseInt(c[0],10),l=c[1],d=A.rootToLeaf(s.rev_tree),h=null,p=0;p<d.length;p++){var v=d[p],y=v.ids.map(function(e){return e.id}).indexOf(l);(y===f-1||!h&&-1!==y)&&(h=v)}var g=h.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,m=h.ids.length-g;if(h.ids.splice(g,m),h.ids.reverse(),t.revs&&(o._revisions={start:h.pos+h.ids.length-1,ids:h.ids.map(function(e){return e.id})}),t.revs_info){var _=h.pos+h.ids.length;o._revs_info=h.ids.map(function(e){return _--,{rev:_+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var b=o._attachments,w=Object.keys(b).length;if(0===w)return n(null,o);Object.keys(b).forEach(function(e){this._getAttachment(o._id,e,b[e],{rev:o._rev,binary:t.binary,ctx:a},function(t,r){var i=o._attachments[e];i.data=r,delete i.stub,delete i.length,--w||n(null,o)})},i)}else{if(o._attachments)for(var k in o._attachments)o._attachments.hasOwnProperty(k)&&(o._attachments[k].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){if(e)return n(e);o=A.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(t.open_revs))return n(j.createError(j.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var s=0;s<o.length;s++){var a=o[s];if(\"string\"!=typeof a||!/^\\d+-/.test(a))return n(j.createError(j.INVALID_REV))}r()}}),v.prototype.getAttachment=b.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,s){return i?r(i):s.doc._attachments&&s.doc._attachments[t]?(n.ctx=s.ctx,n.binary=!0,o._getAttachment(e,t,s.doc._attachments[t],n,r),void 0):r(j.createError(j.MISSING_DOC))})}),v.prototype.allDocs=b.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=void 0!==e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(j.createError(j.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!b.isRemote(this))return d(this,e,t)}return this._allDocs(e,t)}),v.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new i(this,e,t)},v.prototype.close=b.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),v.prototype.info=b.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){if(n)return e(n);r.db_name=r.db_name||t.name,r.auto_compaction=!(!t.auto_compaction||b.isRemote(t)),r.adapter=t.adapter,e(null,r)})}),v.prototype.id=b.adapterFun(\"id\",function(e){return this._id(e)}),v.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},v.prototype.bulkDocs=b.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(j.createError(j.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(j.createError(j.NOT_AN_OBJECT));var o;if(e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(t){o=o||p(t),e._attachments[t].content_type||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e._id,\"is missing content_type\")})}),o)return n(j.createError(j.BAD_REQUEST,o));\"new_edits\"in t||(t.new_edits=!(\"new_edits\"in e)||e.new_edits);var i=this;t.new_edits||b.isRemote(i)||e.docs.sort(f),c(e.docs);var s=e.docs.map(function(e){return e._id});return this._bulkDocs(e,t,function(e,r){if(e)return n(e);if(t.new_edits||(r=r.filter(function(e){return e.error})),!b.isRemote(i))for(var o=0,a=r.length;o<a;o++)r[o].id=r[o].id||s[o];n(null,r)})}),v.prototype.registerDependentDatabase=b.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},!t.dependentDbs[e]&&(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);b.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})}).catch(t)}),v.prototype.destroy=b.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){if(e)return t(e);r._destroyed=!0,r.emit(\"destroyed\"),t(null,n||{ok:!0})})}\"function\"==typeof e&&(t=e,e={});var r=this,o=!(\"use_prefix\"in r)||r.use_prefix;if(b.isRemote(r))return n();r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var s=i.dependentDbs,a=r.constructor,u=Object.keys(s).map(function(e){var t=o?e.replace(new RegExp(\"^\"+a.prefix),\"\"):e;return new a(t,r.__opts).destroy()});E.all(u).then(n,t)})}),y.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},y.prototype.fail=function(e){this.failed=e,this.execute()},y.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},y.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},k(_,v),_.adapters={},_.preferredAdapters=[],_.prefix=\"_pouch_\";var x=new S.EventEmitter;!function(e){Object.keys(S.EventEmitter.prototype).forEach(function(t){\"function\"==typeof S.EventEmitter.prototype[t]&&(e[t]=x[t].bind(x))});var t=e._destructionListeners=new w.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t.delete(e)})}(_),_.adapter=function(e,t,n){t.valid()&&(_.adapters[e]=t,n&&_.preferredAdapters.push(e))},_.plugin=function(e){if(\"function\"==typeof e)e(_);else{if(\"object\"!=typeof e||0===Object.keys(e).length)throw new Error('Invalid plugin: got \"'+e+'\", expected an object or a function');Object.keys(e).forEach(function(t){_.prototype[t]=e[t]})}return this.__defaults&&(_.__defaults=b.assign({},this.__defaults)),_},_.defaults=function(e){function t(e,n){if(!(this instanceof t))return new t(e,n);n=n||{},e&&\"object\"==typeof e&&(n=e,e=n.name,delete n.name),n=b.assign({},t.__defaults,n),_.call(this,e,n)}return k(t,_),t.preferredAdapters=_.preferredAdapters.slice(),Object.keys(_).forEach(function(e){e in t||(t[e]=_[e])}),t.__defaults=b.assign({},this.__defaults,e),t};_.plugin(I),_.plugin(D),_.version=\"6.2.0\",t.exports=_},{10:10,12:12,20:20,23:23,25:25,29:29,35:35,36:36,40:40,7:7}],25:[function(e,t,n){\"use strict\";function r(e){e.debug=o;var t={};e.on(\"debug\",function(e){var n=e[0],r=e.slice(1);t[n]||(t[n]=o(\"pouchdb:\"+n)),t[n].apply(null,r)})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(26));t.exports=r},{26:26}],26:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window||void 0===window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document&&\"WebkitAppearance\"in document.documentElement.style||\"undefined\"!=typeof window&&window&&window.console&&(console.firebug||console.exception&&console.table)||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){try{return n.storage.debug}catch(e){}if(void 0!==r&&\"env\"in r)return r.env.DEBUG}n=t.exports=e(27),n.log=s,n.formatArgs=i,n.save=a,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(41))},{27:27,41:41}],27:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r);e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),s=0;s<i.length;s++)i[s]=arguments[s];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var a=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}\nreturn t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(28),n.names=[],n.skips=[],n.formatters={};var c},{28:28}],28:[function(e,t,n){function r(e){if(e=String(e),!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,c,\"hour\")||s(e,u,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,u=60*a,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],29:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}function o(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=r.prototype,new n(t)}function i(e){if(\"object\"!=typeof e){var t=e;e=p,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0}),function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(12))(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var s=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),a=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),u=new r(404,\"not_found\",\"missing\"),c=new r(409,\"conflict\",\"Document update conflict\"),f=new r(400,\"bad_request\",\"_id field must contain a string\"),l=new r(412,\"missing_id\",\"_id is required for puts\"),d=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),h=new r(412,\"precondition_failed\",\"Database not open\"),p=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),v=new r(500,\"badarg\",\"Some query argument is invalid\"),y=new r(400,\"invalid_request\",\"Request was invalid\"),g=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),m=new r(500,\"doc_validation\",\"Bad special document member\"),_=new r(400,\"bad_request\",\"Something wrong with the request\"),b=new r(400,\"bad_request\",\"Document must be a JSON object\"),w=new r(404,\"not_found\",\"Database not found\"),k=new r(500,\"indexed_db_went_bad\",\"unknown\"),E=new r(500,\"web_sql_went_bad\",\"unknown\"),S=new r(500,\"levelDB_went_went_bad\",\"unknown\"),O=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),A=new r(400,\"bad_request\",\"Invalid rev format\"),j=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),I=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),D=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=s,n.MISSING_BULK_DOCS=a,n.MISSING_DOC=u,n.REV_CONFLICT=c,n.INVALID_ID=f,n.MISSING_ID=l,n.RESERVED_ID=d,n.NOT_OPEN=h,n.UNKNOWN_ERROR=p,n.BAD_ARG=v,n.INVALID_REQUEST=y,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=m,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=b,n.DB_MISSING=w,n.WSQ_ERROR=E,n.LDB_ERROR=S,n.FORBIDDEN=O,n.INVALID_REV=A,n.FILE_EXISTS=j,n.MISSING_STUB=I,n.IDB_ERROR=k,n.INVALID_URL=D,n.createError=o,n.generateErrorFromResponse=i},{12:12}],30:[function(e,t,n){\"use strict\";function r(e){return Object.keys(e).sort(a.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function o(e,t,n){var o=n.doc_ids?n.doc_ids.sort(a.collate):\"\",u=n.filter?n.filter.toString():\"\",c=\"\",f=\"\",l=\"\";return n.selector&&(l=JSON.stringify(n.selector)),n.filter&&n.query_params&&(c=JSON.stringify(r(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),i.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+u+f+c+o+l;return new i(function(e){s.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(36)),s=e(34),a=e(22);t.exports=o},{22:22,34:34,36:36}],31:[function(e,t,n){\"use strict\";function r(e){try{return JSON.parse(e)}catch(t){return i.parse(e)}}function o(e){try{return JSON.stringify(e)}catch(t){return i.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(43));n.safeJsonParse=r,n.safeJsonStringify=o},{43:43}],32:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,o)}catch(e){}}function i(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,i)}catch(e){}}function s(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,s)}catch(e){}}function a(e,t){return t&&e.then(function(e){v.nextTick(function(){t(null,e)})},function(e){v.nextTick(function(){t(e)})}),e}function u(e){return p(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&a(r,n),r})}function c(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})}function f(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}}function l(e){var t=new h.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n}function d(e){var t=new Array(e.size),n=-1;return e.forEach(function(e,r){t[++n]=r}),t}Object.defineProperty(n,\"__esModule\",{value:!0});var h=e(23),p=r(e(7)),v=e(40),y=r(e(12));y(o,Error),y(i,Error),y(s,Error),n.uniq=l,n.sequentialize=f,n.fin=c,n.callbackify=u,n.promisedCallback=a,n.mapToKeysArray=d,n.QueryParseError=o,n.NotFoundError=i,n.BuiltInError=s},{12:12,23:23,40:40,7:7}],33:[function(e,t,n){\"use strict\";function r(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new d.BuiltInError(t)}function o(e){for(var t=0,n=0,o=e.length;n<o;n++){var i=e[n];if(\"number\"!=typeof i){if(!Array.isArray(i))throw r(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var s=0,a=i.length;s<a;s++){var u=i[s];if(\"number\"!=typeof u)throw r(\"_sum\");void 0===t[s]?t.push(u):t[s]+=u}}else\"number\"==typeof t?t+=i:t[0]+=i}return t}function i(e,t){return l.scopeEval(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:o,log:p,isArray:v,toJSON:y})}function s(e,t){if(\"function\"==typeof e&&2===e.length){var n=e;return function(e){return n(e,t)}}return i(e.toString(),t)}function a(e){return g[e]?g[e]:i(e.toString())}function u(e,t){var n=e.views&&e.views[t];if(\"string\"!=typeof n.map)throw new d.NotFoundError(\"ddoc \"+e._id+\" has no string view named \"+t+\", instead found object of type: \"+typeof n.map)}function c(e,t,n){return m.query.call(this,e,t,n)}function f(e){return m.viewCleanup.call(this,e)}var l=e(40),d=e(32),h=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(14)),p=l.guardedConsole.bind(null,\"log\"),v=Array.isArray,y=JSON.parse,g={_sum:function(e,t){return o(t)},_count:function(e,t){return t.length},_stats:function(e,t){return{sum:o(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:function(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];t+=o*o}return t}(t)}}},m=h(\"mrviews\",s,a,u),_={query:c,viewCleanup:f};t.exports=_},{14:14,32:32,40:40}],34:[function(e,t,n){(function(t){\"use strict\";function r(e){return c.btoa(e)}function o(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function i(e,t,n,r,i){(n>0||r<t.size)&&(t=o(t,n,r)),c.readAsArrayBuffer(t,function(t){e.append(t),i()})}function s(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function a(e,t){function n(){l(a)}function o(){var e=y.end(!0),n=r(e);t(n),y.destroy()}function a(){var t=v*h,r=t+h;v++,v<p?g(y,e,t,r,n):g(y,e,t,r,o)}var u=\"string\"==typeof e,c=u?e.length:e.size,h=Math.min(d,c),p=Math.ceil(c/h),v=0,y=u?new f:new f.ArrayBuffer,g=u?s:i;a()}function u(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var c=e(19),f=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(42)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=a,n.stringMd5=u}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{19:19,42:42}],35:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var s=o.ids,a=s[2],u=o.pos;if(a.length)for(var c=0,f=a.length;c<f;c++)i.push({pos:u+1,ids:a[c]});else{var l=!!s[1].deleted,d=s[0];t&&!(r!==l?r:n!==u?n<u:t<d)||(t=d,n=u,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,s=i[2],a=t(0===s.length,o,i[0],n.ctx,i[1]),u=0,c=s.length;u<c;u++)r.push({pos:o+1,ids:s[u],ctx:a})}function i(e,t){return e.pos-t.pos}function s(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;n<r;n++)delete t[n].pos;return t}function a(e){for(var t=r(e),n=s(e.rev_tree),o=[],i=0,a=n.length;i<a;i++){var u=n[i];u.rev===t||u.opts.deleted||o.push(u.rev)}return o}function u(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function c(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,s=i[0],a=i[1],u=i[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:s,opts:a}),c&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=u.length;l<d;l++)r.push({pos:o+1,ids:u[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;o<i;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function h(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var s=e[o],a=[s.id,s.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function p(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,s=o.tree2;(i[1].status||s[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===s[1].status?\"available\":\"missing\");for(var a=0;a<s[2].length;a++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===s[2][a][0]&&(n.push({tree1:i[2][c],tree2:s[2][a]}),u=!0);u||(r=\"new_branch\",d(i[2],s[2][a],p))}else r=\"new_leaf\",i[2][0]=s[2][a]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,s=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var a=0,u=e.length;a<u;a++){var c=e[a];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=v(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,s=!0;else if(!0!==n){var l=c.pos<t.pos?c:t,d=c.pos<t.pos?t:c,h=d.pos-l.pos,p=[],y=[];for(y.push({ids:l.ids,diff:h,parent:null,parentIdx:null});y.length>0;){var g=y.pop();if(0!==g.diff)for(var m=g.ids[2],_=0,b=m.length;_<b;_++)y.push({ids:m[_],diff:g.diff-1,parent:g.ids,parentIdx:_});else g.ids[0]===d.ids[0]&&p.push(g)}var w=p[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,s=!0):o.push(c)}else o.push(c)}return s||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function g(e,t){for(var n,r,i=c(e),s=0,a=i.length;s<a;s++){var u,f=i[s],l=f.ids;if(l.length>t){n||(n={});var d=l.length-t;u={pos:f.pos+d,ids:h(l,d)};for(var p=0;p<d;p++){var v=f.pos+p+\"-\"+l[p].id;n[v]=!0}}else u={pos:f.pos,ids:h(l,0)};r=r?y(r,u,!0).tree:[u]}return n&&o(r,function(e,t,r){delete n[t+\"-\"+r]}),{tree:r,revs:n?Object.keys(n):[]}}function m(e,t,n){var r=y(e,t),o=g(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function _(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),s=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===s)return!0;for(var a=n.ids[2],u=0,c=a.length;u<c;u++)r.push({pos:n.pos+1,ids:a[u]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}function E(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,s=i[0],a=i[1],u=i[2],c=0===u.length,f=n.history?n.history.slice():[];if(f.push({id:s,pos:o,opts:a}),c)for(var l=0,d=f.length;l<d;l++){var h=f[l],p=h.pos+\"-\"+h.id;if(p===e)return o+\"-\"+s}for(var v=0,y=u.length;v<y;v++)r.push({pos:o+1,ids:u[v],history:f})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=a,n.collectLeaves=s,n.compactTree=u,n.isDeleted=w,n.isLocalId=k,n.merge=m,n.revExists=_,n.rootToLeaf=c,n.traverseRevTree=o,n.winningRev=r,n.latest=E},{}],36:[function(e,t,n){\"use strict\";var r=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(37)),o=\"function\"==typeof Promise?Promise:r;t.exports=o},{37:37}],37:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function s(e,t,n){p(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function a(e){var t=e&&e.then;if(e&&(\"object\"==typeof e||\"function\"==typeof e)&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,s=c(o);\"error\"===s.status&&n(s.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=new Array(n),s=0,a=-1,u=new this(r);++a<n;)!function(e,r){function a(e){i[r]=e,++s!==n||o||(o=!0,v.resolve(u,i))}t.resolve(e).then(a,function(e){o||(o=!0,v.reject(u,e))})}(e[a],a);return u}function h(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=-1,s=new this(r);++i<n;)!function(e){t.resolve(e).then(function(e){o||(o=!0,v.resolve(s,e))},function(e){o||(o=!0,v.reject(s,e))})}(e[i]);return s}var p=e(11),v={},y=[\"REJECTED\"],g=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===g||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){s(n,this.state===g?e:t,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){s(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){s(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(a,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=g,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],38:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function s(e,t){var n=Object.keys(t._attachments);return m.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function a(e,t,n){var r=_.isRemote(t)&&!_.isRemote(e),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return m.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))}).catch(function(e){if(404!==e.status)throw e;return s(t,n)}):s(t,n)}function u(e){var t=[];return Object.keys(e).forEach(function(n){e[n].missing.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0,latest:!0}}function c(e,t,n,r){function i(){var o=u(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return m.all(n.results.map(function(n){return m.all(n.docs.map(function(n){var r=n.ok;return n.error&&(p=!1),r&&r._attachments?a(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){h=h.concat(_.flatten(e).filter(Boolean))})})}function s(e){return e._attachments&&Object.keys(e._attachments).length>0}function c(e){return e._conflicts&&e._conflicts.length>0}function f(t){return e.allDocs({keys:t,include_docs:!0,conflicts:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!o(e.value.rev)||s(e.doc)||c(e.doc)||(e.doc._conflicts&&delete e.doc._conflicts,h.push(e.doc),delete n[e.id])})})}function l(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});if(e.length>0)return f(e)}function d(){return{ok:p,docs:h}}n=_.clone(n);var h=[],p=!0;return m.resolve().then(l).then(i).then(d)}function f(e,t,n,r){if(!1===e.retry)return t.emit(\"error\",n),void t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=_.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var o=function(){e.current_back_off=O},i=function(){t.removeListener(\"active\",o)};t.once(\"paused\",i),t.once(\"active\",o)}e.current_back_off=e.current_back_off||O,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}function l(e,t,n,r,o){function i(){return x?m.resolve():w(e,t,n).then(function(n){D=n,x=new b(e,t,D,r)})}function s(){if(G=[],0!==I.docs.length){var e=I.docs,i={timeout:n.timeout};return t.bulkDocs({docs:e,new_edits:!1},i).then(function(t){if(r.cancelled)throw y(),new Error(\"cancelled\");var n=Object.create(null);t.forEach(function(e){e.error&&(n[e.id]=e)});var i=Object.keys(n).length;o.doc_write_failures+=i,o.docs_written+=e.length-i,e.forEach(function(e){var t=n[e._id];if(t){if(o.errors.push(t),\"unauthorized\"!==t.name&&\"forbidden\"!==t.name)throw t;r.emit(\"denied\",_.clone(t))}else G.push(e)})},function(t){throw o.doc_write_failures+=e.length,t})}}function a(){if(I.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=B=I.seq;var e=_.clone(o);return G.length&&(e.docs=G,r.emit(\"change\",e)),q=!0,x.writeCheckpoint(I.seq,z).then(function(){if(q=!1,r.cancelled)throw y(),new Error(\"cancelled\");I=void 0,O()}).catch(function(e){throw j(e),e})}function u(){var e={};return I.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw y(),new Error(\"cancelled\");I.diffs=e})}function d(){return c(e,t,I.diffs,r).then(function(e){I.error=!e.ok,e.docs.forEach(function(e){delete I.diffs[e._id],o.docs_read++,I.docs.push(e)})})}function h(){if(!r.cancelled&&!I){if(0===C.length)return void p(!0);I=C.shift(),u().then(d).then(s).then(a).then(h).catch(function(e){v(\"batch processing terminated with error\",e)})}}function p(e){if(0===R.changes.length)return void(0!==C.length||I||((N&&K.live||T)&&(r.state=\"pending\",r.emit(\"paused\")),T&&y()));(e||T||R.changes.length>=M)&&(C.push(R),R={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),h())}function v(e,t){L||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",C=[],R={seq:0,changes:[],docs:[]},y(t))}function y(i){L||r.cancelled&&(o.status=\"cancelled\",q)||(o.status=o.status||\"complete\",o.end_time=new Date,o.last_seq=B,L=!0,i?(i=k.createError(i),i.result=o,\"unauthorized\"===i.name||\"forbidden\"===i.name?(r.emit(\"error\",i),r.removeAllListeners()):f(n,r,i,function(){l(e,t,n,r)})):(r.emit(\"complete\",o),r.removeAllListeners()))}function g(e){if(r.cancelled)return y();_.filterChange(n)(e)&&(R.seq=e.seq,R.changes.push(e),p(0===C.length&&K.live))}function E(e){if(F=!1,r.cancelled)return y();if(e.results.length>0)K.since=e.last_seq,O(),p(!0);else{var t=function(){N?(K.live=!0,O()):T=!0,p(!0)};I||0!==e.results.length?t():(q=!0,x.writeCheckpoint(e.last_seq,z).then(function(){q=!1,o.last_seq=B=e.last_seq,t()}).catch(j))}}function S(e){if(F=!1,r.cancelled)return y();v(\"changes rejected\",e)}function O(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!F&&!T&&C.length<$){F=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(K).on(\"change\",g);i.then(o,o),i.then(E).catch(S),n.retry&&(r._changes=i,r._abortChanges=t)}}function A(){i().then(function(){return r.cancelled?void y():x.getCheckpoint().then(function(e){B=e,K={since:B,limit:M,batch_size:M,style:\"all_docs\",doc_ids:P,selector:U,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?K.include_docs=!0:K.filter=n.filter),\"heartbeat\"in n&&(K.heartbeat=n.heartbeat),\"timeout\"in n&&(K.timeout=n.timeout),n.query_params&&(K.query_params=n.query_params),n.view&&(K.view=n.view),O()})}).catch(function(e){v(\"getCheckpoint rejected with \",e)})}function j(e){q=!1,v(\"writeCheckpoint completed with error\",e)}var I,D,x,C=[],R={seq:0,changes:[],docs:[]},q=!1,T=!1,L=!1,B=0,N=n.continuous||n.live||!1,M=n.batch_size||100,$=n.batches_limit||10,F=!1,P=n.doc_ids,U=n.selector,G=[],z=_.uuid();o=o||{ok:!0,start_time:new Date,docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var K={};if(r.ready(e,t),r.cancelled)return void y();r._addedListeners||(r.once(\"cancel\",y),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void 0===n.since?A():i().then(function(){return q=!0,x.writeCheckpoint(n.since,z)}).then(function(){if(q=!1,r.cancelled)return void y();B=n.since,A()}).catch(j)}function d(){E.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new m(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e.catch=function(e){return t.catch(e)},e.catch(function(){})}function h(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function p(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw k.createError(k.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=_.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n);return l(h(e,n),h(t,n),n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n=_.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=h(e,n),t=h(t,n),new y(e,t,n,r)}function y(e,t,n,r){function o(e){v.emit(\"change\",{direction:\"pull\",change:e})}function i(e){v.emit(\"change\",{direction:\"push\",change:e})}function s(e){v.emit(\"denied\",{direction:\"push\",doc:e})}function a(e){v.emit(\"denied\",{direction:\"pull\",doc:e})}function u(){v.pushPaused=!0,v.pullPaused&&v.emit(\"paused\")}function c(){v.pullPaused=!0,v.pushPaused&&v.emit(\"paused\")}function f(){v.pushPaused=!1,v.pullPaused&&v.emit(\"active\",{direction:\"push\"})}function l(){v.pullPaused=!1,v.pushPaused&&v.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===a||n===s),h=\"paused\"===t&&(n===c||n===u),p=\"active\"===t&&(n===l||n===f);(r||d||h||p)&&(t in b||(b[t]={}),b[t][e]=!0,2===Object.keys(b[t]).length&&v.removeAllListeners(t))}}function h(e,t,n){-1==e.listeners(t).indexOf(n)&&e.on(t,n)}var v=this;this.canceled=!1;var y=n.push?_.assign({},n,n.push):n,g=n.pull?_.assign({},n,n.pull):n;this.push=p(e,t,y),this.pull=p(t,e,g),this.pushPaused=!0,this.pullPaused=!0;var b={};n.live&&(this.push.on(\"complete\",v.pull.cancel.bind(v.pull)),this.pull.on(\"complete\",v.push.cancel.bind(v.push))),this.on(\"newListener\",function(e){\"change\"===e?(h(v.pull,\"change\",o),h(v.push,\"change\",i)):\"denied\"===e?(h(v.pull,\"denied\",a),h(v.push,\"denied\",s)):\"active\"===e?(h(v.pull,\"active\",l),h(v.push,\"active\",f)):\"paused\"===e&&(h(v.pull,\"paused\",c),h(v.push,\"paused\",u))}),this.on(\"removeListener\",function(e){\"change\"===e?(v.pull.removeListener(\"change\",o),v.push.removeListener(\"change\",i)):\"denied\"===e?(v.pull.removeListener(\"denied\",a),v.push.removeListener(\"denied\",s)):\"active\"===e?(v.pull.removeListener(\"active\",l),v.push.removeListener(\"active\",f)):\"paused\"===e&&(v.pull.removeListener(\"paused\",c),v.push.removeListener(\"paused\",u))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var w=m.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return v.emit(\"complete\",t),r&&r(null,t),v.removeAllListeners(),t},function(e){if(v.cancel(),r?r(e):v.emit(\"error\",e),v.removeAllListeners(),r)throw e});this.then=function(e,t){return w.then(e,t)},this.catch=function(e){return w.catch(e)}}function g(e){e.replicate=p,e.sync=v,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var e=this;return{from:function(t,n,r){return e.constructor.replicate(t,e,n,r)},to:function(t,n,r){return e.constructor.replicate(e,t,n,r)}}}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}var m=r(e(36)),_=e(40),b=r(e(21)),w=r(e(30)),k=e(29),E=e(10),S=r(e(12)),O=0;S(d,E.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},S(y,E.EventEmitter),y.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=g},{10:10,12:12,21:21,29:29,30:30,36:36,40:40}],39:[function(e,t,n){\"use strict\";function r(e,t){for(var n=e,r=0,o=t.length;r<o;r++){if(!(n=n[t[r]]))break}return n}function o(e,t,n){for(var r=0,o=t.length;r<o-1;r++){e=e[t[r]]={}}e[t[o-1]]=n}function i(e,t){return e<t?-1:e>t?1:0}function s(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?r>0&&\"\\\\\"===e[r-1]?n=n.substring(0,n.length-1)+\".\":(t.push(n),n=\"\"):n+=i}return t.push(n),t}function a(e){return T.indexOf(e)>-1}function u(e){return Object.keys(e)[0]}function c(e){return e[u(e)]}function f(e){var t={};return e.forEach(function(e){Object.keys(e).forEach(function(n){var r=e[n];if(\"object\"!=typeof r&&(r={$eq:r}),a(n))r instanceof Array?t[n]=r.map(function(e){return f([e])}):t[n]=f([r]);else{var o=t[n]=t[n]||{};Object.keys(r).forEach(function(e){var t=r[e];return\"$gt\"===e||\"$gte\"===e?l(e,t,o):\"$lt\"===e||\"$lte\"===e?d(e,t,o):\"$ne\"===e?h(t,o):\"$eq\"===e?p(t,o):void(o[e]=t)})}})}),t}function l(e,t,n){void 0===n.$eq&&(void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t)}function d(e,t,n){void 0===n.$eq&&(void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t)}function h(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}function p(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}function v(e){var t=R.clone(e),n=!1;\"$and\"in t&&(t=f(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=f([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],s=t[i];\"object\"!=typeof s||null===s?s={$eq:s}:\"$ne\"in s&&!n&&(s.$ne=[s.$ne]),t[i]=s}return t}function y(e){function t(t){return e.map(function(e){var n=u(e),o=s(n);return r(t,o)})}return function(e,n){var r=t(e.doc),o=t(n.doc),s=q.collate(r,o);return 0!==s?s:i(e.doc._id,n.doc._id)}}function g(e,t,n){if(e=e.filter(function(e){return m(e.doc,t.selector,n)}),t.sort){var r=y(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===c(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var o=t.skip||0,i=(\"limit\"in t?t.limit:e.length)+o;e=e.slice(o,i)}return e}function m(e,t,n){return n.every(function(n){if(_(e))return!1;var o=t[n],i=s(n),u=r(e,i);return a(n)?w(n,o,e):b(o,e,i,u)})}function _(e){return/^_design\\//.test(e._id)}function b(e,t,n,r){return!e||Object.keys(e).every(function(o){var i=e[o];return k(o,t,i,n,r)})}function w(e,t,n){return\"$or\"===e?t.some(function(e){return m(n,e,Object.keys(e))}):\"$not\"===e?!m(n,t,Object.keys(t)):!t.find(function(e){return m(n,e,Object.keys(e))})}function k(e,t,n,r,o){if(!L[e])throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type or $all');return L[e](t,n,r,o)}function E(e){return void 0!==e&&null!==e}function S(e){return void 0!==e}function O(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}function A(e,t){return t.some(function(t){return e instanceof Array?e.indexOf(t)>-1:e===t})}function j(e,t){return t.every(function(t){return e.indexOf(t)>-1})}function I(e,t){return e.length===t}function D(e,t){return new RegExp(t).test(e)}function x(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}function C(e,t){if(\"object\"!=typeof t)throw\"Selector error: expected a JSON object\";t=v(t);var n={doc:e},r=g([n],{selector:t},Object.keys(t));return r&&1===r.length}Object.defineProperty(n,\"__esModule\",{value:!0});var R=e(40),q=e(22),T=[\"$or\",\"$nor\",\"$not\"],L={$elemMatch:function(e,t,n,r){\nreturn!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.some(function(e){return m(e,t,Object.keys(t))}):r.some(function(r){return b(t,e,n,r)})))},$eq:function(e,t,n,r){return S(r)&&0===q.collate(r,t)},$gte:function(e,t,n,r){return S(r)&&q.collate(r,t)>=0},$gt:function(e,t,n,r){return S(r)&&q.collate(r,t)>0},$lte:function(e,t,n,r){return S(r)&&q.collate(r,t)<=0},$lt:function(e,t,n,r){return S(r)&&q.collate(r,t)<0},$exists:function(e,t,n,r){return t?S(r):!S(r)},$mod:function(e,t,n,r){return E(r)&&O(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==q.collate(r,e)})},$in:function(e,t,n,r){return E(r)&&A(r,t)},$nin:function(e,t,n,r){return E(r)&&!A(r,t)},$size:function(e,t,n,r){return E(r)&&I(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&j(r,t)},$regex:function(e,t,n,r){return E(r)&&D(r,t)},$type:function(e,t,n,r){return x(r,t)}};n.massageSelector=v,n.matchesSelector=C,n.filterInMemoryFields=g,n.createFieldSorter=y,n.rowFilter=m,n.isCombinationalField=a,n.getKey=u,n.getValue=c,n.getFieldFromDoc=r,n.setFieldInDoc=o,n.compare=i,n.parseField=s},{22:22,40:40}],40:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function s(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function a(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&W.call(n)==H}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return s(e);if(!a(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);void 0!==i&&(t[n]=i)}return t}function c(e){var t=!1;return G(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return G(function(t){t=u(t);var n=this,r=\"function\"==typeof t[t.length-1]&&t.pop(),o=new U(function(r,o){var i;try{var s=c(function(e,t){e?o(e):r(t)});t.push(s),i=e.apply(n,t),i&&\"function\"==typeof i.then&&r(i)}catch(e){o(e)}});return r&&o.then(function(e){r(null,e)},r),o})}function l(e,t,n){if(e.constructor.listeners(\"debug\").length){for(var r=[\"api\",e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);e.constructor.emit(\"debug\",r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[\"api\",e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),e.constructor.emit(\"debug\",o),i(n,r)}}}function d(e,t){return f(G(function(n){if(this._closed)return U.reject(new Error(\"database is closed\"));if(this._destroyed)return U.reject(new Error(\"database is destroyed\"));var r=this;return l(r,e,n),this.taskqueue.isReady?t.apply(this,n):new U(function(t,o){r.taskqueue.addTask(function(i){i?o(i):t(r[e].apply(r,n))})})}))}function h(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function v(e){return[{ok:e}]}function y(e,t,n){function r(){var e=[];d.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){d[e]={id:t,docs:n},o()}function s(){if(!(g>=y.length)){var e=Math.min(g+Z,y.length),t=y.slice(g,e);a(t,g),g+=t.length}}function a(n,r){n.forEach(function(n,o){var a=r+o,u=c.get(n),f=h(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=v),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(a,n,r),s()})})}var u=t.docs,c=new z.Map;u.forEach(function(e){c.has(e.id)?c.get(e.id).push(e):c.set(e.id,[e])});var f=c.size,l=0,d=new Array(f),y=[];c.forEach(function(e,t){y.push(t)});var g=0;s()}function g(){return\"undefined\"!=typeof chrome&&void 0!==chrome.storage&&void 0!==chrome.storage.local}function m(){return P}function _(e){g()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):m()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function b(){K.EventEmitter.call(this),this._listeners={},_(this)}function w(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function k(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function E(e){var t=0;return e||(t=2e3),k(e,t)}function S(e,t){w(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function O(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return Q.createError(Q.BAD_REQUEST,r)}}function A(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&O(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function j(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function I(){}function D(e){var t;if(e?\"string\"!=typeof e?t=Q.createError(Q.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=Q.createError(Q.RESERVED_ID)):t=Q.createError(Q.MISSING_ID),t)throw t}function x(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function C(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(w(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())}function R(e,t){return\"listenerCount\"in e?e.listenerCount(t):K.EventEmitter.listenerCount(e,t)}function q(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function T(e){var t=q(e);return t?t.join(\"/\"):null}function L(e){for(var t=se.exec(e),n={},r=14;r--;){var o=re[r],i=t[r]||\"\",s=-1!==[\"user\",\"password\"].indexOf(o);n[o]=s?decodeURIComponent(i):i}return n[oe]={},n[re[12]].replace(ie,function(e,t,r){t&&(n[oe][t]=r)}),n}function B(e,t){var n=[],r=[];for(var o in t)t.hasOwnProperty(o)&&(n.push(o),r.push(t[o]));return n.push(e),Function.apply(null,n).apply(null,r)}function N(e,t,n){return new U(function(r,o){e.get(t,function(i,s){if(i){if(404!==i.status)return o(i);s={}}var a=s._rev,u=n(s);if(!u)return r({updated:!1,rev:a});u._id=t,u._rev=a,r(M(e,u,n))})})}function M(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return N(e,t._id,n)})}function $(e){return 0|Math.random()*e}function F(e,t){t=t||ae.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=ae[$(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=ae[3&$(16)|8];break;default:n+=ae[$(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var P,U=r(e(36)),G=r(e(7)),z=e(23),K=e(10),J=r(e(12)),V=r(e(11)),Q=e(29),W=Function.prototype.toString,H=W.call(Object),Z=6;if(g())P=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),P=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){P=!1}J(b,K.EventEmitter),b.prototype.addListener=function(e,t,n,r){function o(){function e(){s=!1}if(i._listeners[t]){if(s)return void(s=\"waiting\");s=!0;var a=h(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(a).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===s&&V(o),s=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,s=!1;this._listeners[t]=o,this.on(e,o)}},b.prototype.removeListener=function(e,t){t in this._listeners&&(K.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},b.prototype.notifyLocalWindows=function(e){g()?chrome.storage.local.set({dbName:e}):m()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},b.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var Y;Y=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};var X,ee=Y,te=I.name;X=te?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ne=X,re=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],oe=\"queryKey\",ie=/(?:^|&)([^&=]*)=?([^&]*)/g,se=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ae=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=d,n.bulkGetShim=y,n.changesHandler=b,n.clone=u,n.defaultBackOff=E,n.explainError=S,n.assign=ee,n.filterChange=A,n.flatten=j,n.functionName=ne,n.guardedConsole=w,n.hasLocalStorage=m,n.invalidIdError=D,n.isChromeApp=g,n.isCordova=x,n.isRemote=C,n.listenerCount=R,n.nextTick=V,n.normalizeDdocFunctionName=T,n.once=c,n.parseDdocFunctionName=q,n.parseUri=L,n.pick=h,n.scopeEval=B,n.toPromise=f,n.upsert=N,n.uuid=F},{10:10,11:11,12:12,23:23,29:29,36:36,7:7}],41:[function(e,t,n){function r(){throw new Error(\"setTimeout has not been defined\")}function o(){throw new Error(\"clearTimeout has not been defined\")}function i(e){if(l===setTimeout)return setTimeout(e,0);if((l===r||!l)&&setTimeout)return l=setTimeout,setTimeout(e,0);try{return l(e,0)}catch(t){try{return l.call(null,e,0)}catch(t){return l.call(this,e,0)}}}function s(e){if(d===clearTimeout)return clearTimeout(e);if((d===o||!d)&&clearTimeout)return d=clearTimeout,clearTimeout(e);try{return d(e)}catch(t){try{return d.call(null,e)}catch(t){return d.call(this,e)}}}function a(){y&&p&&(y=!1,p.length?v=p.concat(v):g=-1,v.length&&u())}function u(){if(!y){var e=i(a);y=!0;for(var t=v.length;t;){for(p=v,v=[];++g<t;)p&&p[g].run();g=-1,t=v.length}p=null,y=!1,s(e)}}function c(e,t){this.fun=e,this.array=t}function f(){}var l,d,h=t.exports={};!function(){try{l=\"function\"==typeof setTimeout?setTimeout:r}catch(e){l=r}try{d=\"function\"==typeof clearTimeout?clearTimeout:o}catch(e){d=o}}();var p,v=[],y=!1,g=-1;h.nextTick=function(e){var t=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];v.push(new c(e,t)),1!==v.length||y||i(u)},c.prototype.run=function(){this.fun.apply(null,this.array)},h.title=\"browser\",h.browser=!0,h.env={},h.argv=[],h.version=\"\",h.versions={},h.on=f,h.addListener=f,h.once=f,h.off=f,h.removeListener=f,h.removeAllListeners=f,h.emit=f,h.prependListener=f,h.prependOnceListener=f,h.listeners=function(e){return[]},h.binding=function(e){throw new Error(\"process.binding is not supported\")},h.cwd=function(){return\"/\"},h.chdir=function(e){throw new Error(\"process.chdir is not supported\")},h.umask=function(){return 0}},{}],42:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t){var n=e[0],r=e[1],o=e[2],i=e[3];n+=(r&o|~r&i)+t[0]-680876936|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[1]-389564586|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[2]+606105819|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[3]-1044525330|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[4]-176418897|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[5]+1200080426|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[6]-1473231341|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[7]-45705983|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[8]+1770035416|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[9]-1958414417|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[10]-42063|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[11]-1990404162|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[12]+1804603682|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[13]-40341101|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[14]-1502002290|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[15]+1236535329|0,r=(r<<22|r>>>10)+o|0,n+=(r&i|o&~i)+t[1]-165796510|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[6]-1069501632|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[11]+643717713|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[0]-373897302|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[5]-701558691|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[10]+38016083|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[15]-660478335|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[4]-405537848|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[9]+568446438|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[14]-1019803690|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[3]-187363961|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[8]+1163531501|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[13]-1444681467|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[2]-51403784|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[7]+1735328473|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[12]-1926607734|0,r=(r<<20|r>>>12)+o|0,n+=(r^o^i)+t[5]-378558|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[8]-2022574463|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[11]+1839030562|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[14]-35309556|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[1]-1530992060|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[4]+1272893353|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[7]-155497632|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[10]-1094730640|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[13]+681279174|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[0]-358537222|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[3]-722521979|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[6]+76029189|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[9]-640364487|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[12]-421815835|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[15]+530742520|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[2]-995338651|0,r=(r<<23|r>>>9)+o|0,n+=(o^(r|~i))+t[0]-198630844|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[7]+1126891415|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[14]-1416354905|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[5]-57434055|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[12]+1700485571|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[3]-1894986606|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[10]-1051523|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[1]-2054922799|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[8]+1873313359|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[15]-30611744|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[6]-1560198380|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[13]+1309151649|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[4]-145523070|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[11]-1120210379|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[2]+718787259|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[9]-343485551|0,r=(r<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function n(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function r(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function o(e){var r,o,i,s,a,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(r=64;r<=c;r+=64)t(f,n(e.substring(r-64,r)));for(e=e.substring(r-64),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],r=0;r<o;r+=1)i[r>>2]|=e.charCodeAt(r)<<(r%4<<3);if(i[r>>2]|=128<<(r%4<<3),r>55)for(t(f,i),r=0;r<16;r+=1)i[r]=0;return s=8*c,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),u=parseInt(s[1],16)||0,i[14]=a,i[15]=u,t(f,i),f}function i(e){var n,o,i,s,a,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(n=64;n<=c;n+=64)t(f,r(e.subarray(n-64,n)));for(e=n-64<c?e.subarray(n-64):new Uint8Array(0),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],n=0;n<o;n+=1)i[n>>2]|=e[n]<<(n%4<<3);if(i[n>>2]|=128<<(n%4<<3),n>55)for(t(f,i),n=0;n<16;n+=1)i[n]=0;return s=8*c,s=s.toString(16).match(/(.*?)(.{0,8})$/),a=parseInt(s[2],16),u=parseInt(s[1],16)||0,i[14]=a,i[15]=u,t(f,i),f}function s(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=p[e>>8*t+4&15]+p[e>>8*t&15];return n}function a(e){var t;for(t=0;t<e.length;t+=1)e[t]=s(e[t]);return e.join(\"\")}function u(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function c(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function f(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function l(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function d(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function h(){this.reset()}var p=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==a(o(\"hello\"))&&function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n},\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,s,a,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),s=new Uint8Array(i),a=new Uint8Array(this,c,o),s.set(a),i)}}(),h.prototype.append=function(e){return this.appendBinary(u(e)),this},h.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var r,o=this._buff.length;for(r=64;r<=o;r+=64)t(this._hash,n(this._buff.substring(r-64,r)));return this._buff=this._buff.substring(r-64),this},h.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},h.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},h.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},h.prototype._finish=function(e,n){var r,o,i,s=n;if(e[s>>2]|=128<<(s%4<<3),s>55)for(t(this._hash,e),s=0;s<16;s+=1)e[s]=0;r=8*this._length,r=r.toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(r[2],16),i=parseInt(r[1],16)||0,e[14]=o,e[15]=i,t(this._hash,e)},h.hash=function(e,t){return h.hashBinary(u(e),t)},h.hashBinary=function(e,t){var n=o(e),r=a(n);return t?d(r):r},h.ArrayBuffer=function(){this.reset()},h.ArrayBuffer.prototype.append=function(e){var n,o=l(this._buff.buffer,e,!0),i=o.length;for(this._length+=e.byteLength,n=64;n<=i;n+=64)t(this._hash,r(o.subarray(n-64,n)));return this._buff=n-64<i?new Uint8Array(o.buffer.slice(n-64)):new Uint8Array(0),this},h.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=a(this._hash),e&&(n=d(n)),this.reset(),n},h.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.ArrayBuffer.prototype.getState=function(){var e=h.prototype.getState.call(this);return e.buff=f(e.buff),e},h.ArrayBuffer.prototype.setState=function(e){return e.buff=c(e.buff,!0),h.prototype.setState.call(this,e)},h.ArrayBuffer.prototype.destroy=h.prototype.destroy,h.ArrayBuffer.prototype._finish=h.prototype._finish,h.ArrayBuffer.hash=function(e,t){var n=i(new Uint8Array(e)),r=a(n);return t?d(r):r},h})},{}],43:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var s=t.pop();o[s]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,s,a,u,c,f,l,d,h=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",h+=o,i)h+=i;else if(\"object\"!=typeof r)h+=void 0===r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),s=r.length-1;s>=0;s--)a=0===s?\"\":\",\",t.push({obj:r[s],prefix:a});t.push({val:\"[\"})}else{u=[];for(c in r)r.hasOwnProperty(c)&&u.push(c);for(t.push({val:\"}\"}),s=u.length-1;s>=0;s--)f=u[s],l=r[f],d=s>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,o,i,s,a,u,c,f,l=[],d=[],h=0;;)if(\"}\"!==(t=e[h++])&&\"]\"!==t&&void 0!==t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,r(null,l,d);break;case\"t\":h+=3,r(!0,l,d);break;case\"f\":h+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(o=e[h++],!/[\\d\\.\\-e\\+]/.test(o)){h--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",s=void 0,a=0;;){if('\"'===(u=e[h++])&&(\"\\\\\"!==s||a%2!=1))break;i+=u,s=u,\"\\\\\"===s?a++:a=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":c={element:[],index:l.length},l.push(c.element),d.push(c);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[3]);";
},{}],11:[function(_dereq_,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = _dereq_(12);
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
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
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

}).call(this,_dereq_(20))
},{"12":12,"20":20}],12:[function(_dereq_,module,exports){

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
exports.humanize = _dereq_(16);

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

},{"16":16}],13:[function(_dereq_,module,exports){
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
},{}],14:[function(_dereq_,module,exports){
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

},{}],15:[function(_dereq_,module,exports){
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

},{}],16:[function(_dereq_,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

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

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options["long"] ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
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
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
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
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],17:[function(_dereq_,module,exports){
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
},{}],18:[function(_dereq_,module,exports){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(_dereq_(19));

/* istanbul ignore next */
var PouchPromise = typeof Promise === 'function' ? Promise : lie;

module.exports = PouchPromise;

},{"19":19}],19:[function(_dereq_,module,exports){
'use strict';
var immediate = _dereq_(13);

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

},{"13":13}],20:[function(_dereq_,module,exports){
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
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],21:[function(_dereq_,module,exports){
'use strict';

module.exports = _dereq_(3);
},{"3":3}]},{},[21])(21)
});