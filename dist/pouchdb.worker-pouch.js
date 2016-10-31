(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
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
  if (!worker || !worker.postMessage) {
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
    worker.postMessage({
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
    worker.postMessage({
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

var Promise = _dereq_(19);
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
},{"19":19,"2":2}],5:[function(_dereq_,module,exports){
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

var Promise = _dereq_(19);

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

var binUtil = _dereq_(18);

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,_dereq_(20),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"18":18,"19":19,"20":20,"7":7}],9:[function(_dereq_,module,exports){
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
module.exports = "!function e(t,n,r){function o(s,a){if(!n[s]){if(!t[s]){var u=\"function\"==typeof require&&require;if(!a&&u)return u(s,!0);if(i)return i(s,!0);var c=new Error(\"Cannot find module '\"+s+\"'\");throw c.code=\"MODULE_NOT_FOUND\",c}var f=n[s]={exports:{}};t[s][0].call(f.exports,function(e){var n=t[s][1][e];return o(n?n:e)},f,f.exports,e,t,n,r)}return n[s].exports}for(var i=\"function\"==typeof require&&require,s=0;s<r.length;s++)o(r[s]);return o}({1:[function(e,t,n){\"use strict\";var r=e(3),o=e(4);r(self,o)},{3:3,4:4}],2:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}var o=e(13);o(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),s=r&&i.filter(function(e){var t=o[e];return t.message===r})[0]||i[0];return s?o[s]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,s,a=n;return r=e.error===!0&&\"string\"==typeof e.name?e.name:e.error,s=e.reason,o=a.getErrorTypeByProp(\"name\",r,s),e.missing||\"missing\"===s||\"deleted\"===s||\"not_found\"===r?o=a.MISSING_DOC:\"doc_validation\"===r?(o=a.DOC_VALIDATION,i=s):\"bad_request\"===r&&o.message!==s&&(0===s.indexOf(\"unknown stub attachment\")?(o=a.MISSING_STUB,i=s):o=a.BAD_REQUEST),o||(o=a.getErrorTypeByProp(\"status\",e.status,s)||a.UNKNOWN_ERROR),t=a.error(o,s,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{13:13}],3:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){f(\" -> sendUncaughtError\",t,n),e.postMessage({type:\"uncaughtError\",id:t,content:s.createError(n)})}function r(t,n,r){f(\" -> sendError\",t,n,r),e.postMessage({type:\"error\",id:t,messageId:n,content:s.createError(r)})}function l(t,n,r){f(\" -> sendSuccess\",t,n),e.postMessage({type:\"success\",id:t,messageId:n,content:r})}function d(t,n,r){f(\" -> sendUpdate\",t,n),e.postMessage({type:\"update\",id:t,messageId:n,content:r})}function p(e,t,n,i){var s=u[\"$\"+e];return s?void o.resolve().then(function(){return s[t].apply(s,i)}).then(function(t){l(e,n,t)}).catch(function(t){r(e,n,t)}):r(e,n,{error:\"db not found\"})}function h(e,t,n){var r=n[0];r&&\"object\"==typeof r&&(r.returnDocs=!0,r.return_docs=!0),p(e,\"changes\",t,n)}function v(e,t,n){var s=u[\"$\"+e];return s?void o.resolve().then(function(){var r=n[0],o=n[1],a=n[2];return\"object\"!=typeof a&&(a={}),s.get(r,a).then(function(r){if(!r._attachments||!r._attachments[o])throw i.MISSING_DOC;return s.getAttachment.apply(s,n).then(function(n){l(e,t,n)})})}).catch(function(n){r(e,t,n)}):r(e,t,{error:\"db not found\"})}function y(e,t,n){var i=\"$\"+e,s=u[i];return s?(delete u[i],void o.resolve().then(function(){return s.destroy.apply(s,n)}).then(function(n){l(e,t,n)}).catch(function(n){r(e,t,n)})):r(e,t,{error:\"db not found\"})}function _(e,t,n){var i=u[\"$\"+e];return i?void o.resolve().then(function(){var o=i.changes(n[0]);c[t]=o,o.on(\"change\",function(n){d(e,t,n)}).on(\"complete\",function(n){o.removeAllListeners(),delete c[t],l(e,t,n)}).on(\"error\",function(n){o.removeAllListeners(),delete c[t],r(e,t,n)})}):r(e,t,{error:\"db not found\"})}function m(e){var t=c[e];t&&t.cancel()}function g(e,t){return o.resolve().then(function(){e.on(\"error\",function(e){n(t,e)})})}function b(e,n,o){var i=\"$\"+e,s=u[i];if(s)return g(s,e).then(function(){return l(e,n,{ok:!0,exists:!0})});var a=\"string\"==typeof o[0]?o[0]:o[0].name;return a?(s=u[i]=t(o[0]),void g(s,e).then(function(){l(e,n,{ok:!0})}).catch(function(t){r(e,n,t)})):r(e,n,{error:\"you must provide a database name\"})}function w(e,t,n,o){switch(f(\"onReceiveMessage\",t,e,n,o),t){case\"createDatabase\":return b(e,n,o);case\"id\":return void l(e,n,e);case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return p(e,t,n,o);case\"changes\":return h(e,n,o);case\"getAttachment\":return v(e,n,o);case\"liveChanges\":return _(e,n,o);case\"cancelChanges\":return m(n);case\"destroy\":return y(e,n,o);default:return r(e,n,{error:\"unknown API method: \"+t})}}function k(e,t){var n=e.type,r=e.messageId,o=a(e.args);w(t,n,r,o)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete u[\"$\"+t]):k(e.data,t)}})}var o=e(32),i=e(2),s=e(6),a=s.decodeArgs,u={},c={},f=e(8)(\"pouchdb:worker\");t.exports=r},{2:2,32:32,6:6,8:8}],4:[function(e,t,n){\"use strict\";t.exports=e(24).plugin(e(17)).plugin(e(16)).plugin(e(29)).plugin(e(33))},{16:16,17:17,24:24,29:29,33:33}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(e.message.indexOf(\"Bad special document member\")!==-1?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){function r(){return\"WebkitAppearance\"in document.documentElement.style||window.console&&(console.firebug||console.exception&&console.table)||navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31}function o(){var e=arguments,t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),!t)return e;var r=\"color: \"+this.color;e=[e[0],r,\"color: inherit\"].concat(Array.prototype.slice.call(e,1));var o=0,i=0;return e[0].replace(/%[a-z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r),e}function i(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function s(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function a(){var e;try{e=n.storage.debug}catch(e){}return e}function u(){try{return window.localStorage}catch(e){}}n=t.exports=e(9),n.log=i,n.formatArgs=o,n.save=s,n.load=a,n.useColors=r,n.storage=\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage?chrome.storage.local:u(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){return JSON.stringify(e)},n.enable(a())},{9:9}],9:[function(e,t,n){function r(){return n.colors[f++%n.colors.length]}function o(e){function t(){}function o(){var e=o,t=+new Date,i=t-(c||t);e.diff=i,e.prev=c,e.curr=t,c=t,null==e.useColors&&(e.useColors=n.useColors()),null==e.color&&e.useColors&&(e.color=r());var s=Array.prototype.slice.call(arguments);s[0]=n.coerce(s[0]),\"string\"!=typeof s[0]&&(s=[\"%o\"].concat(s));var a=0;s[0]=s[0].replace(/%([a-z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var i=s[a];t=o.call(e,i),s.splice(a,1),a--}return t}),\"function\"==typeof n.formatArgs&&(s=n.formatArgs.apply(e,s));var u=o.log||n.log||console.log.bind(console);u.apply(e,s)}t.enabled=!1,o.enabled=!0;var i=n.enabled(e)?o:t;return i.namespace=e,i}function i(e){n.save(e);for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function s(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o,n.coerce=u,n.disable=s,n.enable=i,n.enabled=a,n.humanize=e(15),n.names=[],n.skips=[],n.formatters={};var c,f=0},{15:15}],10:[function(e,t,n){!function(e,r){\"function\"==typeof define&&define.amd?define([],r):\"object\"==typeof n?t.exports=r():(e.PromisePool=r(),e.promisePool=e.PromisePool)}(this,function(){\"use strict\";var e=function(){this._listeners={}};e.prototype.addEventListener=function(e,t){this._listeners[e]=this._listeners[e]||[],this._listeners[e].indexOf(t)<0&&this._listeners[e].push(t)},e.prototype.removeEventListener=function(e,t){if(this._listeners[e]){var n=this._listeners[e].indexOf(t);n>=0&&this._listeners[e].splice(n,1)}},e.prototype.dispatchEvent=function(e){if(this._listeners[e.type]&&this._listeners[e.type].length)for(var t=this._listeners[e.type].slice(),n=0,r=t.length;n<r;++n)t[n].call(this,e)};var t=function(e){return\"function\"==typeof e.constructor&&\"GeneratorFunction\"===e.constructor.name},n=function(e){return{next:function(){var t=e();return t?{value:t}:{done:!0}}}},r=function(e){var t=!1;return{next:function(){return t?{done:!0}:(t=!0,{value:e})}}},o=function(e,o){var i=typeof e;if(\"object\"===i){if(\"function\"==typeof e.next)return e;if(\"function\"==typeof e.then)return r(e)}return\"function\"===i?t(e)?e():n(e):r(o.resolve(e))},i=function(e,t,n){this.target=e,this.type=t,this.data=n},s=function(t,n,r){if(e.call(this),\"number\"!=typeof n||Math.floor(n)!==n||n<1)throw new Error(\"Invalid concurrency\");this._concurrency=n,this._options=r||{},this._options.promise=this._options.promise||Promise,this._iterator=o(t,this._options.promise),this._done=!1,this._size=0,this._promise=null,this._callbacks=null};return s.prototype=new e,s.prototype.constructor=s,s.prototype.concurrency=function(e){return\"undefined\"!=typeof e&&(this._concurrency=e,this.active()&&this._proceed()),this._concurrency},s.prototype.size=function(){return this._size},s.prototype.active=function(){return!!this._promise},s.prototype.promise=function(){return this._promise},s.prototype.start=function(){var e=this,t=this._options.promise;return this._promise=new t(function(t,n){e._callbacks={reject:n,resolve:t},e._proceed()}),this._promise},s.prototype._fireEvent=function(e,t){this.dispatchEvent(new i(this,e,t))},s.prototype._settle=function(e){e?this._callbacks.reject(e):this._callbacks.resolve(),this._promise=null,this._callbacks=null},s.prototype._onPooledPromiseFulfilled=function(e,t){this._size--,this.active()&&(this._fireEvent(\"fulfilled\",{promise:e,result:t}),this._proceed())},s.prototype._onPooledPromiseRejected=function(e,t){this._size--,this.active()&&(this._fireEvent(\"rejected\",{promise:e,error:t}),this._settle(t||new Error(\"Unknown error\")))},s.prototype._trackPromise=function(e){var t=this;e.then(function(n){t._onPooledPromiseFulfilled(e,n)},function(n){t._onPooledPromiseRejected(e,n)}).catch(function(e){t._settle(new Error(\"Promise processing failed: \"+e))})},s.prototype._proceed=function(){if(!this._done){for(var e=null;this._size<this._concurrency&&!(e=this._iterator.next()).done;)this._size++,this._trackPromise(e.value);this._done=null===e||!!e.done}this._done&&0===this._size&&this._settle()},s.PromisePoolEvent=i,s.PromisePool=s,s})},{}],11:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function s(e){return\"object\"==typeof e&&null!==e}function a(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||e<0||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,u,c;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||s(this._events.error)&&!this._events.error.length)){if(t=arguments[1],t instanceof Error)throw t;throw TypeError('Uncaught, unspecified \"error\" event.')}if(n=this._events[e],a(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:for(r=arguments.length,i=new Array(r-1),u=1;u<r;u++)i[u-1]=arguments[u];n.apply(this,i)}else if(s(n)){for(r=arguments.length,i=new Array(r-1),u=1;u<r;u++)i[u-1]=arguments[u];for(c=n.slice(),r=c.length,u=0;u<r;u++)c[u].apply(this,i)}return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");if(this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?s(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,s(this._events[e])&&!this._events[e].warned){var n;n=a(this._maxListeners)?r.defaultMaxListeners:this._maxListeners,n&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace())}return this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,a;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(s(n)){for(a=i;a-- >0;)if(n[a]===t||n[a].listener&&n[a].listener===t){r=a;break}if(r<0)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){var t;return t=this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.listenerCount=function(e,t){var n;return n=e._events&&e._events[t]?o(e._events[t])?1:e._events[t].length:0}},{}],12:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var s=0,a=new i(n),u=e.document.createTextNode(\"\");a.observe(u,{characterData:!0}),o=function(){u.data=s=++s%2}}else if(e.setImmediate||\"undefined\"==typeof e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var c=new e.MessageChannel;c.port1.onmessage=n,o=function(){c.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],13:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],14:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function s(e,t,n){h(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function a(e){var t=e&&e.then;if(e&&\"object\"==typeof e&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,s=c(o);\"error\"===s.status&&n(s.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){function t(e,t){function r(e){s[t]=e,++a!==o||i||(i=!0,v.resolve(c,s))}n.resolve(e).then(r,function(e){i||(i=!0,v.reject(c,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,i=!1;if(!o)return this.resolve([]);for(var s=new Array(o),a=0,u=-1,c=new this(r);++u<o;)t(e[u],u);return c}function p(e){function t(e){n.resolve(e).then(function(e){i||(i=!0,v.resolve(a,e))},function(e){i||(i=!0,v.reject(a,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,i=!1;if(!o)return this.resolve([]);for(var s=-1,a=new this(r);++s<o;)t(e[s]);return a}var h=e(12),v={},y=[\"REJECTED\"],_=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===_||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){var o=this.state===_?e:t;s(n,o,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){s(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){s(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(a,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=_,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=p},{12:12}],15:[function(e,t,n){function r(e){if(e=\"\"+e,!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]),r=(t[2]||\"ms\").toLowerCase();switch(r){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function i(e){return s(e,f,\"day\")||s(e,c,\"hour\")||s(e,u,\"minute\")||s(e,a,\"second\")||e+\" ms\"}function s(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,u=60*a,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){return t=t||{},\"string\"==typeof e?r(e):t.long?i(e):o(e)}},{}],16:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];n.data=m.base64StringToBlobOrBuffer(n.data,n.content_type)})}function i(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function s(e){return e._attachments&&Object.keys(e._attachments)?v.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];if(n.data&&\"string\"!=typeof n.data)return new v(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e})})):v.resolve()}function a(e){if(!e.prefix)return!1;var t=h.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}function u(e,t){if(a(t)){var n=t.name.substr(t.prefix.length);e=t.prefix+encodeURIComponent(n)}var r=h.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var o=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=o.pop(),r.db.indexOf(\"%\")===-1&&(r.db=encodeURIComponent(r.db)),r.path=o.join(\"/\"),r}function c(e,t){return f(e,e.db+\"/\"+t)}function f(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function l(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function d(e,t){function n(e,t,n){var r=e.ajax||{},o=h.jsExtend(h.clone(I),r,t);return O(o.method+\" \"+o.url),w._ajax(o,n)}function r(e,t){return new v(function(r,o){n(e,t,function(e,t){return e?o(e):void r(t)})})}function a(e,t){return h.adapterFun(e,_(function(e){d().then(function(){return t.apply(this,e)}).catch(function(t){var n=e.pop();n(t)})}))}function d(){if(e.skipSetup||e.skip_setup)return v.resolve();if(q)return q;var t={method:\"GET\",url:A};return q=r({},t).catch(function(e){return e&&e.status&&404===e.status?(h.explainError(404,\"PouchDB is just detecting if the remote exists.\"),r({},{method:\"PUT\",url:A})):v.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||v.reject(e)}),q.catch(function(){q=null}),q}function p(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}var w=this,j=u(e.name,e),A=c(j,\"\");e=h.clone(e);var I=e.ajax||{};if(e.auth||j.auth){var D=e.auth||j.auth,x=D.username+\":\"+D.password,C=m.btoa(unescape(encodeURIComponent(x)));I.headers=I.headers||{},I.headers.Authorization=\"Basic \"+C}w._ajax=y;var q;setTimeout(function(){t(null,w)}),w.type=function(){return\"http\"},w.id=a(\"id\",function(e){n({},{method:\"GET\",url:f(j,\"\")},function(t,n){var r=n&&n.uuid?n.uuid+j.db:c(j,\"\");e(null,r)})}),w.request=a(\"request\",function(e,t){e.url=c(j,e.url),n({},e,t)}),w.compact=a(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=h.clone(e),n(e,{url:c(j,\"_compact\"),method:\"POST\"},function(){function n(){w.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0}):setTimeout(n,e.interval||200)})}n()})}),w.bulkGet=h.adapterFun(\"bulkGet\",function(e,t){function r(t){var r={};e.revs&&(r.revs=!0),e.attachments&&(r.attachments=!0),n({},{url:c(j,\"_bulk_get\"+l(r)),method:\"POST\",body:{docs:e.docs}},t)}function o(){function n(e){return function(n,r){a[e]=r.results,++s===o&&t(null,{results:h.flatten(a)})}}for(var r=E,o=Math.ceil(e.docs.length/r),s=0,a=new Array(o),u=0;u<o;u++){var c=h.pick(e,[\"revs\",\"attachments\"]);c.ajax=I,c.docs=e.docs.slice(u*r,Math.min(e.docs.length,(u+1)*r)),h.bulkGetShim(i,c,n(u))}}var i=this,s=f(j,\"\"),a=S[s];\"boolean\"!=typeof a?r(function(e,n){if(e){var r=Math.floor(e.status/100);4===r||5===r?(S[s]=!1,h.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),o()):t(e)}else S[s]=!0,t(null,n)}):a?r(t):o()}),w._info=function(e){d().then(function(){n({},{method:\"GET\",url:c(j,\"\")},function(t,n){return t?e(t):(n.host=c(j,\"\"),void e(null,n))})}).catch(e)},w.get=a(\"get\",function(e,t,n){function o(e){function n(){if(!s.length)return null;var n=s.pop(),a=o[n],u=i(e._id)+\"/\"+p(n)+\"?rev=\"+e._rev;return r(t,{method:\"GET\",url:c(j,u),binary:!0}).then(function(e){return t.binary?e:new v(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete a.stub,delete a.length,a.data=e})}var o=e._attachments,s=o&&Object.keys(o);if(o&&s.length)return new g(n,5,{promise:v}).start()}function s(e){return Array.isArray(e)?v.all(e.map(function(e){if(e.ok)return o(e.ok)})):o(e)}\"function\"==typeof t&&(n=t,t={}),t=h.clone(t);var a={};t.revs&&(a.revs=!0),t.revs_info&&(a.revs_info=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),a.open_revs=t.open_revs),t.rev&&(a.rev=t.rev),t.conflicts&&(a.conflicts=t.conflicts),e=i(e);var u={method:\"GET\",url:c(j,e+l(a))};r(t,u).then(function(e){return v.resolve().then(function(){if(t.attachments)return s(e)}).then(function(){n(null,e)})}).catch(n)}),w.remove=a(\"remove\",function(e,t,r,o){var s;\"string\"==typeof t?(s={_id:e,_rev:t},\"function\"==typeof r&&(o=r,r={})):(s=e,\"function\"==typeof t?(o=t,r={}):(o=r,r=t));var a=s._rev||r.rev;n(r,{method:\"DELETE\",url:c(j,i(s._id))+\"?rev=\"+a},o)}),w.getAttachment=a(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var s=r.rev?\"?rev=\"+r.rev:\"\",a=c(j,i(e))+\"/\"+p(t)+s;n(r,{method:\"GET\",url:a,binary:!0},o)}),w.removeAttachment=a(\"removeAttachment\",function(e,t,r,o){var s=c(j,i(e)+\"/\"+p(t))+\"?rev=\"+r;n({},{method:\"DELETE\",url:s},o)}),w.putAttachment=a(\"putAttachment\",function(e,t,r,o,s,a){\"function\"==typeof s&&(a=s,s=o,o=r,r=null);var u=i(e)+\"/\"+p(t),f=c(j,u);if(r&&(f+=\"?rev=\"+r),\"string\"==typeof o){var l;try{l=m.atob(o)}catch(e){return a(b.createError(b.BAD_ARG,\"Attachment is not a valid base64 string\"))}o=l?m.binaryStringToBlobOrBuffer(l,s):\"\"}var d={headers:{\"Content-Type\":s},method:\"PUT\",url:f,processData:!1,body:o,timeout:I.timeout||6e4};n({},d,a)}),w._bulkDocs=function(e,t,r){e.new_edits=t.new_edits,d().then(function(){return v.all(e.docs.map(s))}).then(function(){n(t,{method:\"POST\",url:c(j,\"_bulk_docs\"),timeout:t.timeout,body:e},function(e,t){return e?r(e):(t.forEach(function(e){e.ok=!0}),void r(null,t))})}).catch(r)},w._put=function(e,t,r){d().then(function(){return s(e)}).then(function(){n(t,{method:\"PUT\",url:c(j,i(e._id)),body:e},function(e,t){return e?r(e):void r(null,t)})}).catch(r)},w.allDocs=a(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=h.clone(e);var n,i={},s=\"GET\";e.conflicts&&(i.conflicts=!0),e.descending&&(i.descending=!0),e.include_docs&&(i.include_docs=!0),e.attachments&&(i.attachments=!0),e.key&&(i.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(i.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(i.endkey=JSON.stringify(e.endkey)),\"undefined\"!=typeof e.inclusive_end&&(i.inclusive_end=!!e.inclusive_end),\"undefined\"!=typeof e.limit&&(i.limit=e.limit),\"undefined\"!=typeof e.skip&&(i.skip=e.skip);var a=l(i);\"undefined\"!=typeof e.keys&&(s=\"POST\",n={keys:e.keys}),r(e,{method:s,url:c(j,\"_all_docs\"+a),body:n}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.rows.forEach(o),t(null,n)}).catch(t)}),w._changes=function(e){var t=\"batch_size\"in e?e.batch_size:k;e=h.clone(e),e.timeout=\"timeout\"in e?e.timeout:\"timeout\"in I?I.timeout:3e4;var r,i=e.timeout?{timeout:e.timeout-5e3}:{},s=\"undefined\"!=typeof e.limit&&e.limit;r=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var a=s;if(e.style&&(i.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(i.include_docs=!0),e.attachments&&(i.attachments=!0),e.continuous&&(i.feed=\"longpoll\"),e.conflicts&&(i.conflicts=!0),e.descending&&(i.descending=!0),\"heartbeat\"in e?e.heartbeat&&(i.heartbeat=e.heartbeat):i.heartbeat=1e4,e.filter&&\"string\"==typeof e.filter&&(i.filter=e.filter),e.view&&\"string\"==typeof e.view&&(i.filter=\"_view\",i.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var u in e.query_params)e.query_params.hasOwnProperty(u)&&(i[u]=e.query_params[u]);var f,p=\"GET\";e.doc_ids&&(i.filter=\"_doc_ids\",p=\"POST\",f={doc_ids:e.doc_ids});var v,y,_=function(r,o){if(!e.aborted){i.since=r,\"object\"==typeof i.since&&(i.since=JSON.stringify(i.since)),e.descending?s&&(i.limit=a):i.limit=!s||a>t?t:a;var u={method:p,url:c(j,\"_changes\"+l(i)),timeout:e.timeout,body:f};y=r,e.aborted||d().then(function(){v=n(e,u,o)}).catch(o)}},m={results:[]},g=function(n,i){if(!e.aborted){var u=0;if(i&&i.results){u=i.results.length,m.last_seq=i.last_seq;var c={};c.query=e.query_params,i.results=i.results.filter(function(t){a--;var n=h.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&o(t),r&&m.results.push(t),e.onChange(t)),n})}else if(n)return e.aborted=!0,void e.complete(n);i&&i.last_seq&&(y=i.last_seq);var f=s&&a<=0||i&&u<t||e.descending;(!e.continuous||s&&a<=0)&&f?e.complete(null,m):setTimeout(function(){_(y,g)},0)}};return _(e.since||0,g),{cancel:function(){e.aborted=!0,v&&v.abort()}}},w.revsDiff=a(\"revsDiff\",function(e,t,r){\"function\"==typeof t&&(r=t,t={}),n(t,{method:\"POST\",url:c(j,\"_revs_diff\"),body:e},r)}),w._close=function(e){e()},w._destroy=function(e,t){n(e,{url:c(j,\"\"),method:\"DELETE\"},function(e,n){return e&&e.status&&404!==e.status?t(e):void t(null,n)})}}function p(e){e.adapter(\"http\",d,!1),e.adapter(\"https\",d,!1)}var h=e(34),v=r(e(32)),y=r(e(19)),_=r(e(7)),m=e(20),g=r(e(10)),b=e(25),w=r(e(8)),k=25,E=50,S={},O=w(\"pouchdb:http\");d.valid=function(){return!0},t.exports=p},{10:10,19:19,20:20,25:25,32:32,34:34,7:7,8:8}],17:[function(e,t,n){(function(n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t,n,r){\ntry{e.apply(t,n)}catch(e){r.emit(\"error\",e)}}function i(e){if(!U.running&&U.queue.length){U.running=!0;var t=U.queue.shift();t.action(function(r,s){o(t.callback,this,[r,s],e),U.running=!1,n.nextTick(function(){i(e)})})}}function s(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(I.createError(I.IDB_ERROR,n,t.type))}}function a(e,t,n){return{data:C.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function u(e){if(!e)return null;var t=C.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function c(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function f(e,t,n,r){n?r(e?\"string\"!=typeof e?e:q.base64StringToBlobOrBuffer(e,t):q.blob([\"\"],{type:t})):e?\"string\"!=typeof e?q.readAsBinaryString(e,function(e){r(q.btoa(e))}):r(e):r(\"\")}function l(e,t,n,r){function o(){++a===s.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest,s=n.objectStore(B).get(i);s.onsuccess=function(e){r.body=e.target.result.body,o()}}var s=Object.keys(e._attachments||{});if(!s.length)return r&&r();var a=0;s.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function d(e,t){return x.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return x.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new x(function(s){f(o,i,t,function(t){e.doc._attachments[n]=O.jsExtend(O.pick(r,[\"digest\",\"content_type\"]),{data:t}),s()})})}}))}}))}function p(e,t,n){function r(){c--,c||o()}function o(){i.length&&i.forEach(function(e){var t=u.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1));t.onsuccess=function(t){var n=t.target.result;n||a.delete(e)}})}var i=[],s=n.objectStore(T),a=n.objectStore(B),u=n.objectStore(N),c=e.length;e.forEach(function(e){var n=s.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();s.delete(t);var n=u.index(\"seq\").openCursor(IDBKeyRange.only(t));n.onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),u.delete(t.primaryKey),t.continue()}else r()}}})}function h(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}function v(e,t,n,r,o,i,c){function f(){var e=[L,T,B,M,N],t=h(o,e,\"readwrite\");return t.error?c(t.error):(E=t.txn,E.onabort=s(c),E.ontimeout=s(c),E.oncomplete=v,S=E.objectStore(L),O=E.objectStore(T),x=E.objectStore(B),C=E.objectStore(N),void _(function(e){return e?(z=!0,c(e)):void d()}))}function l(){D.processDocs(e.revs_limit,R,r,K,E,V,m,n)}function d(){function e(){++n===R.length&&l()}function t(t){var n=u(t.target.result);n&&K.set(n.id,n),e()}if(R.length)for(var n=0,r=0,o=R.length;r<o;r++){var i=R[r];if(i._id&&D.isLocalId(i._id))e();else{var s=S.get(i.metadata.id);s.onsuccess=t}}}function v(){z||(i.notify(r._meta.name),r._meta.docCount+=P,c(null,V))}function y(e,t){var n=x.get(e);n.onsuccess=function(n){if(n.target.result)t();else{var r=I.createError(I.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function _(e){function t(){++o===n.length&&e(r)}var n=[];if(R.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){y(e,function(e){e&&!r&&(r=e),t()})})}function m(e,t,n,r,o,i,s,a){P+=i,e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0);var c=u._attachments&&Object.keys(u._attachments).length;return c?b(e,t,n,o,s,a):void g(e,t,n,o,s,a)}function g(e,t,n,o,i,s){function u(i){var s=e.stemmedRevs||[];o&&r.auto_compaction&&(s=s.concat(j.compactTree(e.metadata))),s&&s.length&&p(s,e.metadata.id,E),d.seq=i.target.result,delete d.rev;var u=a(d,t,n),c=S.put(u);c.onsuccess=f}function c(e){e.preventDefault(),e.stopPropagation();var t=O.index(\"_doc_id_rev\"),n=t.getKey(l._doc_id_rev);n.onsuccess=function(e){var t=O.put(l,e.target.result);t.onsuccess=u}}function f(){V[i]={ok:!0,id:d.id,rev:t},K.set(e.metadata.id,e.metadata),w(e,d.seq,s)}var l=e.data,d=e.metadata;l._doc_id_rev=d.id+\"::\"+d.rev,delete l._id,delete l._rev;var h=O.put(l);h.onsuccess=u,h.onerror=c}function b(e,t,n,r,o,i){function s(){c===f.length&&g(e,t,n,r,o,i)}function a(){c++,s()}var u=e.data,c=0,f=Object.keys(u._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)c++,s();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);var i=r.digest;k(i,o,a)}})}function w(e,t,n){function r(){++i===s.length&&n()}function o(n){var o=e.data._attachments[n].digest,i=C.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}var i=0,s=Object.keys(e.data._attachments||{});if(!s.length)return n();for(var a=0;a<s.length;a++)o(s[a])}function k(e,t,n){var r=x.count(e);r.onsuccess=function(r){var o=r.target.result;if(o)return n();var i={digest:e,body:t},s=x.put(i);s.onsuccess=n}}for(var E,S,O,x,C,q,R=t.docs,P=0,F=0,U=R.length;F<U;F++){var G=R[F];G._id&&D.isLocalId(G._id)||(G=R[F]=D.parseDoc(G,n.new_edits),G.error&&!q&&(q=G))}if(q)return c(q);var V=new Array(R.length),K=new A.Map,z=!1,J=r._meta.blobSupport?\"blob\":\"base64\";D.preprocessAttachments(R,J,function(e){return e?c(e):void f()})}function y(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}function _(e,t,n,r){return\"DataError\"===n.name&&0===n.code?r(null,{total_rows:e._meta.docCount,offset:t.skip,rows:[]}):void r(I.createError(I.IDB_ERROR,n.name,n.message))}function m(e,t,n,r){function o(e,r){function o(t,n,r){var o=t.id+\"::\"+r;C.get(o).onsuccess=function(r){n.doc=c(r.target.result),e.conflicts&&(n.doc._conflicts=j.collectConflicts(t)),l(n.doc,e,A)}}function i(t,n,r){var i={id:r.id,key:r.id,value:{rev:n}},s=r.deleted;if(\"ok\"===e.deleted)q.push(i),s?(i.value.deleted=!0,i.doc=null):e.include_docs&&o(r,i,n);else if(!s&&g--<=0&&(q.push(i),e.include_docs&&o(r,i,n),0===--b))return;t.continue()}function s(e){R=t._meta.docCount;var n=e.target.result;if(n){var r=u(n.value),o=r.winningRev;i(n,o,r)}}function a(){r(null,{total_rows:R,offset:e.skip,rows:q})}function f(){e.attachments?d(q,e.binary).then(a):a()}var p=\"startkey\"in e&&e.startkey,v=\"endkey\"in e&&e.endkey,m=\"key\"in e&&e.key,g=e.skip||0,b=\"number\"==typeof e.limit?e.limit:-1,w=e.inclusive_end!==!1,k=\"descending\"in e&&e.descending?\"prev\":null,E=y(p,v,w,m,k);if(E&&E.error)return _(t,e,E.error,r);var S=[L,T];e.attachments&&S.push(B);var O=h(n,S,\"readonly\");if(O.error)return r(O.error);var A=O.txn,I=A.objectStore(L),D=A.objectStore(T),x=k?I.openCursor(E,k):I.openCursor(E),C=D.index(\"_doc_id_rev\"),q=[],R=0;A.oncomplete=f,x.onsuccess=s}function i(e,n){return 0===e.limit?n(null,{total_rows:t._meta.docCount,offset:e.skip,rows:[]}):void o(e,n)}i(e,r)}function g(e){return new x(function(t){var n=q.blob([\"\"]);e.objectStore(F).put(n,\"key\"),e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)},e.oncomplete=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)}}).catch(function(){return!1})}function b(e,t){var n=this;U.queue.push({action:function(t){w(n,e,t)},callback:t}),i(n.constructor)}function w(e,t,r){function o(e){var t=e.createObjectStore(L,{keyPath:\"id\"});e.createObjectStore(T,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(B,{keyPath:\"digest\"}),e.createObjectStore(P,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(F),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(M,{keyPath:\"_id\"});var n=e.createObjectStore(N,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function i(e,t){var n=e.objectStore(L);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=j.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r.continue()}else t()}}function y(e){e.createObjectStore(M,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function _(e,t){var n=e.objectStore(M),r=e.objectStore(L),o=e.objectStore(T),i=r.openCursor();i.onsuccess=function(e){var i=e.target.result;if(i){var s=i.value,a=s.id,u=j.isLocalId(a),c=j.winningRev(s);if(u){var f=a+\"::\"+c,l=a+\"::\",d=a+\"::~\",p=o.index(\"_doc_id_rev\"),h=IDBKeyRange.bound(l,d,!1,!1),v=p.openCursor(h);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o.delete(v.primaryKey),v.continue()}else r.delete(i.primaryKey),i.continue()}}else i.continue()}else t&&t()}}function b(e){var t=e.createObjectStore(N,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function w(e,t){var n=e.objectStore(T),r=e.objectStore(B),o=e.objectStore(N),i=r.count();i.onsuccess=function(e){var r=e.target.result;return r?void(n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,s=Object.keys(r._attachments||{}),a={},u=0;u<s.length;u++){var c=r._attachments[s[u]];a[c.digest]=!0}var f=Object.keys(a);for(u=0;u<f.length;u++){var l=f[u];o.put({seq:i,digestSeq:l+\"::\"+i})}n.continue()}):t()}}function E(e){function t(e){return e.data?u(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(T),r=e.objectStore(L),o=r.openCursor();o.onsuccess=function(e){function o(){var e=u.id+\"::\",t=u.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return u.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t.continue()}}function i(){var e=a(u,u.winningRev,u.deleted),t=r.put(e);t.onsuccess=function(){s.continue()}}var s=e.target.result;if(s){var u=t(s.value);return u.winningRev=u.winningRev||j.winningRev(u),u.seq?i():void o()}}}var D=t.name,x=null;e._meta=null,e.type=function(){return\"idb\"},e._id=O.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){v(t,n,r,e,x,V,o)},e._get=function(e,t,n){function r(){n(s,{doc:o,metadata:i,ctx:a})}var o,i,s,a=t.ctx;if(!a){var f=h(x,[L,T,B],\"readonly\");if(f.error)return n(f.error);a=f.txn}a.objectStore(L).get(e).onsuccess=function(e){if(i=u(e.target.result),!i)return s=I.createError(I.MISSING_DOC,\"missing\"),r();if(j.isDeleted(i)&&!t.rev)return s=I.createError(I.MISSING_DOC,\"deleted\"),r();var n=a.objectStore(T),f=t.rev||i.winningRev,l=i.id+\"::\"+f;n.index(\"_doc_id_rev\").get(l).onsuccess=function(e){return o=e.target.result,o&&(o=c(o)),o?void r():(s=I.createError(I.MISSING_DOC,\"missing\"),r())}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var s=h(x,[L,T,B],\"readonly\");if(s.error)return o(s.error);i=s.txn}var a=n.digest,u=n.content_type;i.objectStore(B).get(a).onsuccess=function(e){var t=e.target.result.body;f(t,u,r.binary,function(e){o(null,e)})}},e._info=function(t){if(null===x||!G.has(D)){var n=new Error(\"db isn't open\");return n.id=\"idbNull\",t(n)}var r,o,i=h(x,[T],\"readonly\");if(i.error)return t(i.error);var s=i.txn,a=s.objectStore(T).openCursor(null,\"prev\");a.onsuccess=function(t){var n=t.target.result;r=n?n.key:0,o=e._meta.docCount},s.oncomplete=function(){t(null,{doc_count:o,update_seq:r,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(t,n){m(t,e,x,n)},e._changes=function(t){function n(e){function n(){return a.seq!==s?e.continue():(p=s,a.winningRev===i._rev?o(i):void r())}function r(){var e=i._id+\"::\"+a.winningRev,t=b.get(e);t.onsuccess=function(e){o(c(e.target.result))}}function o(n){var r=t.processChange(n,a,t);r.seq=a.seq;var o=E(r);return\"object\"==typeof o?t.complete(o):(o&&(k++,y&&w.push(r),t.attachments&&t.include_docs?l(n,t,_,function(){d([r],t.binary).then(function(){t.onChange(r)})}):t.onChange(r)),void(k!==v&&e.continue()))}var i=c(e.value),s=e.key;if(f&&!f.has(i._id))return e.continue();var a;return(a=S.get(i._id))?n():void(g.get(i._id).onsuccess=function(e){a=u(e.target.result),S.set(i._id,a),n()})}function r(e){var t=e.target.result;t&&n(t)}function o(){var e=[L,T];t.attachments&&e.push(B);var n=h(x,e,\"readonly\");if(n.error)return t.complete(n.error);_=n.txn,_.onabort=s(t.complete),_.oncomplete=i,m=_.objectStore(T),g=_.objectStore(L),b=m.index(\"_doc_id_rev\");var o;o=t.descending?m.openCursor(null,\"prev\"):m.openCursor(IDBKeyRange.lowerBound(t.since,!0)),o.onsuccess=r}function i(){function e(){t.complete(null,{results:w,last_seq:p})}!t.continuous&&t.attachments?d(w).then(e):e()}if(t=O.clone(t),t.continuous){var a=D+\":\"+O.uuid();return V.addListener(D,a,e,t),V.notify(D),{cancel:function(){V.removeListener(D,a)}}}var f=t.doc_ids&&new A.Set(t.doc_ids);t.since=t.since||0;var p=t.since,v=\"limit\"in t?t.limit:-1;0===v&&(v=1);var y;y=\"return_docs\"in t?t.return_docs:!(\"returnDocs\"in t)||t.returnDocs;var _,m,g,b,w=[],k=0,E=O.filterChange(t),S=new A.Map;o()},e._close=function(e){return null===x?e(I.createError(I.NOT_OPEN)):(x.close(),G.delete(D),x=null,void e())},e._getRevisionTree=function(e,t){var n=h(x,[L],\"readonly\");if(n.error)return t(n.error);var r=n.txn,o=r.objectStore(L).get(e);o.onsuccess=function(e){var n=u(e.target.result);n?t(null,n.rev_tree):t(I.createError(I.MISSING_DOC))}},e._doCompaction=function(e,t,n){var r=[L,T,B,N],o=h(x,r,\"readwrite\");if(o.error)return n(o.error);var i=o.txn,c=i.objectStore(L);c.get(e).onsuccess=function(n){var r=u(n.target.result);j.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var s=n+\"-\"+r;t.indexOf(s)!==-1&&(i.status=\"missing\")}),p(t,e,i);var o=r.winningRev,s=r.deleted;i.objectStore(L).put(a(r,o,s))},i.onabort=s(n),i.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=h(x,[M],\"readonly\");if(n.error)return t(n.error);var r=n.txn,o=r.objectStore(M).get(e);o.onerror=s(t),o.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(I.createError(I.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var r=e._rev,o=e._id;r?e._rev=\"0-\"+(parseInt(r.split(\"-\")[1],10)+1):e._rev=\"0-1\";var i,a=t.ctx;if(!a){var u=h(x,[M],\"readwrite\");if(u.error)return n(u.error);a=u.txn,a.onerror=s(n),a.oncomplete=function(){i&&n(null,i)}}var c,f=a.objectStore(M);r?(c=f.get(o),c.onsuccess=function(o){var s=o.target.result;if(s&&s._rev===r){var a=f.put(e);a.onsuccess=function(){i={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,i)}}else n(I.createError(I.REV_CONFLICT))}):(c=f.add(e),c.onerror=function(e){n(I.createError(I.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},c.onsuccess=function(){i={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,i)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var r=t.ctx;if(!r){var o=h(x,[M],\"readwrite\");if(o.error)return n(o.error);r=o.txn,r.oncomplete=function(){i&&n(null,i)}}var i,a=e._id,u=r.objectStore(M),c=u.get(a);c.onerror=s(n),c.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(u.delete(a),i={ok:!0,id:a,rev:\"0-0\"},t.ctx&&n(null,i)):n(I.createError(I.MISSING_DOC))}},e._destroy=function(e,t){V.removeAllListeners(D);var n=K.get(D);n&&n.result&&(n.result.close(),G.delete(D));var r=indexedDB.deleteDatabase(D);r.onsuccess=function(){K.delete(D),O.hasLocalStorage()&&D in localStorage&&delete localStorage[D],t(null,{ok:!0})},r.onerror=s(t)};var C=G.get(D);if(C)return x=C.idb,e._meta=C.global,void n.nextTick(function(){r(null,e)});var q;q=t.storage?k(D,t.storage):indexedDB.open(D,R),K.set(D,q),q.onupgradeneeded=function(e){function t(){var e=s[a-1];a++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return o(n);var r=e.currentTarget.transaction;e.oldVersion<3&&y(n),e.oldVersion<4&&b(n);var s=[i,_,w,E],a=e.oldVersion;t()},q.onsuccess=function(t){x=t.target.result,x.onversionchange=function(){x.close(),G.delete(D)},x.onabort=function(e){O.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),x.close(),G.delete(D)};var n=x.transaction([P,F,L],\"readwrite\"),o=n.objectStore(P).get(P),i=null,s=null,a=null;o.onsuccess=function(t){var o=function(){null!==i&&null!==s&&null!==a&&(e._meta={name:D,instanceId:a,blobSupport:i,docCount:s},G.set(D,{idb:x,global:e._meta}),r(null,e))},u=t.target.result||{id:P};D+\"_id\"in u?(a=u[D+\"_id\"],o()):(a=O.uuid(),u[D+\"_id\"]=a,n.objectStore(P).put(u).onsuccess=function(){o()}),S||(S=g(n)),S.then(function(e){i=e,o()});var c=n.objectStore(L).index(\"deletedOrLocal\");c.count(IDBKeyRange.only(\"0\")).onsuccess=function(e){s=e.target.result,o()}}},q.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";O.guardedConsole(\"error\",e),r(I.createError(I.IDB_ERROR,e))}}function k(e,t){try{return indexedDB.open(e,{version:R,storage:t})}catch(t){return indexedDB.open(e,R)}}function E(e){e.adapter(\"idb\",b,!0)}var S,O=e(34),j=e(31),A=e(23),I=e(25),D=e(18),x=r(e(32)),C=e(27),q=e(20),R=5,L=\"document-store\",T=\"by-sequence\",B=\"attach-store\",N=\"attach-seq-store\",P=\"meta-store\",M=\"local-store\",F=\"detect-blob-support\",U={running:!1,queue:[]},G=new A.Map,V=new O.changesHandler,K=new A.Map;b.valid=function(){var e=\"undefined\"!=typeof openDatabase&&/(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)&&!/BlackBerry/.test(navigator.platform);return!e&&\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange},t.exports=E}).call(this,e(35))},{18:18,20:20,23:23,25:25,27:27,31:31,32:32,34:34,35:35}],18:[function(e,t,n){\"use strict\";function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function o(e){if(!/^\\d+\\-./.test(e))return y.createError(y.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function i(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,s=r.length;i<s;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function s(e,t){var n,r,s,a={status:\"available\"};if(e._deleted&&(a.deleted=!0),t)if(e._id||(e._id=v.uuid()),r=v.uuid(32,16).toLowerCase(),e._rev){if(s=o(e._rev),s.error)return s;e._rev_tree=[{pos:s.prefix,ids:[s.id,{status:\"missing\"},[[r,a,[]]]]}],n=s.prefix+1}else e._rev_tree=[{pos:1,ids:[r,a,[]]}],n=1;else if(e._revisions&&(e._rev_tree=i(e._revisions,a),n=e._revisions.start,r=e._revisions.ids[0]),!e._rev_tree){if(s=o(e._rev),s.error)return s;n=s.prefix,r=s.id,e._rev_tree=[{pos:n,ids:[r,a,[]]}]}v.invalidIdError(e._id),e._rev=n+\"-\"+r;var u={metadata:{},data:{}};for(var c in e)if(Object.prototype.hasOwnProperty.call(e,c)){var f=\"_\"===c[0];if(f&&!w[c]){var l=y.createError(y.DOC_VALIDATION,c);throw l.message=y.DOC_VALIDATION.message+\": \"+c,l}f&&!k[c]?u.metadata[c.slice(1)]=e[c]:u.data[c]=e[c]}return u}function a(e){try{return m.atob(e)}catch(e){var t=y.createError(y.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:t}}}function u(e,t,n){var r=a(e.data);return r.error?n(r.error):(e.length=r.length,\"blob\"===t?e.data=m.binaryStringToBlobOrBuffer(r,e.content_type):\"base64\"===t?e.data=m.btoa(r):e.data=r,void g.binaryMd5(r,function(t){e.digest=\"md5-\"+t,n()}))}function c(e,t,n){g.binaryMd5(e.data,function(r){e.digest=\"md5-\"+r,e.length=e.data.size||e.data.length||0,\"binary\"===t?m.blobOrBufferToBinaryString(e.data,function(t){e.data=t,n()}):\"base64\"===t?m.blobOrBufferToBase64(e.data,function(t){e.data=t,n()}):n()})}function f(e,t,n){return e.stub?n():void(\"string\"==typeof e.data?u(e,t,n):c(e,t,n))}function l(e,t,n){function r(){i++,e.length===i&&(o?n(o):n())}if(!e.length)return n();var o,i=0;e.forEach(function(e){function n(e){o=e,s++,s===i.length&&r()}var i=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],s=0;if(!i.length)return r();for(var a in e.data._attachments)e.data._attachments.hasOwnProperty(a)&&f(e.data._attachments[a],t,n)})}function d(e,t,n,r,o,i,a,u){if(_.revExists(t.rev_tree,n.metadata.rev))return r[o]=n,i();var c=t.winningRev||_.winningRev(t),f=\"deleted\"in t?t.deleted:_.isDeleted(t,c),l=\"deleted\"in n.metadata?n.metadata.deleted:_.isDeleted(n.metadata),d=/^1-/.test(n.metadata.rev);if(f&&!l&&u&&d){var p=n.data;p._rev=c,p._id=n.metadata.id,n=s(p,u)}var h=_.merge(t.rev_tree,n.metadata.rev_tree[0],e),v=u&&(f&&l||!f&&\"new_leaf\"!==h.conflicts||f&&!l&&\"new_branch\"===h.conflicts);if(v){var m=y.createError(y.REV_CONFLICT);return r[o]=m,i()}var g=n.metadata.rev;n.metadata.rev_tree=h.tree,n.stemmedRevs=h.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var b,w=_.winningRev(n.metadata),k=_.isDeleted(n.metadata,w),E=f===k?0:f<k?-1:1;b=g===w?k:_.isDeleted(n.metadata,g),a(n,w,k,b,!0,E,o,i)}function p(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function h(e,t,n,r,o,i,s,a,u){function c(e,t,n){var r=_.winningRev(e.metadata),o=_.isDeleted(e.metadata,r);if(\"was_delete\"in a&&o)return i[t]=y.createError(y.MISSING_DOC,\"deleted\"),n();var u=l&&p(e);if(u){var c=y.createError(y.REV_CONFLICT);return i[t]=c,n()}var f=o?0:1;s(e,r,o,o,!1,f,t,n)}function f(){++v===m&&u&&u()}e=e||1e3;var l=a.new_edits,h=new b.Map,v=0,m=t.length;t.forEach(function(e,t){if(e._id&&_.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,f()})}var s=e.metadata.id;h.has(s)?(m--,h.get(s).push([e,t])):h.set(s,[[e,t]])}),h.forEach(function(t,n){function o(){++u<t.length?a():f()}function a(){var a=t[u],f=a[0],p=a[1];if(r.has(n))d(e,r.get(n),f,i,p,o,s,l);else{var h=_.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=h.tree,f.stemmedRevs=h.stemmedRevs||[],c(f,p,o)}}var u=0;a()})}Object.defineProperty(n,\"__esModule\",{value:!0});var v=e(34),y=e(25),_=e(31),m=e(20),g=e(30),b=e(23),w=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),k=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);n.invalidIdError=v.invalidIdError,n.isDeleted=_.isDeleted,n.isLocalId=_.isLocalId,n.normalizeDdocFunctionName=v.normalizeDdocFunctionName,n.parseDdocFunctionName=v.parseDdocFunctionName,n.parseDoc=s,n.preprocessAttachments=l,n.processDocs=h,n.updateDoc=d},{20:20,23:23,25:25,30:30,31:31,34:34}],19:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(){for(var e={},t=new p(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,p.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){e.resolve(t)}).catch(function(t){e.reject(t)}),e}function i(e,t){var n,r,i,s=new Headers,a={method:e.method,credentials:\"include\",headers:s};return e.json&&(s.set(\"Accept\",\"application/json\"),s.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){a.body=e}):e.body&&e.processData&&\"string\"!=typeof e.body?a.body=JSON.stringify(e.body):\"body\"in e?a.body=e.body:a.body=null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&s.set(t,e.headers[t])}),n=o(e.url,a),e.timeout>0&&(r=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(r),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):t(e,i)}).catch(function(e){t(e,i)}),{abort:n.reject}}function s(e,t){var n,r,o=!1,i=function(){n.abort(),u()},s=function(){o=!0,n.abort(),u()},a={abort:i},u=function(){clearTimeout(r),a.abort=function(){},n&&(n.onprogress=void 0,n.upload&&(n.upload.onprogress=void 0),n.onreadystatechange=void 0,n=void 0)};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(e){return t(new Error(e.name||\"Url is invalid\"))}n.withCredentials=!(\"withCredentials\"in e)||e.withCredentials,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var c in e.headers)e.headers.hasOwnProperty(c)&&n.setRequestHeader(c,e.headers[c]);return e.timeout>0&&(r=setTimeout(s,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(s,e.timeout))},\"undefined\"!=typeof n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?d.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var s={};if(o)s=new Error(\"ETIMEDOUT\"),s.code=\"ETIMEDOUT\";else if(\"string\"==typeof n.response)try{s=JSON.parse(n.response)}catch(e){}s.status=n.status,t(s)}u()}},e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),a}function a(){try{return new XMLHttpRequest,!0}catch(e){return!1}}function u(e,t){return y||e.xhr?s(e,t):i(e,t)}function c(){return\"\"}function f(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(e){return r(e)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?v.generateErrorFromResponse(e):e})),e.binary&&_(t,n),r(null,t,n)}e=h.clone(e);var r={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=h.jsExtend(r,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),u(e,function(r,o,i){if(r)return t(v.generateErrorFromResponse(r));var s,a=o.headers&&o.headers[\"content-type\"],u=i||c();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof u&&(/json/.test(a)||/^[\\s]*\\{/.test(u)&&/\\}[\\s]*$/.test(u)))try{u=JSON.parse(u.toString())}catch(e){}o.statusCode>=200&&o.statusCode<300?n(u,o,t):(s=v.generateErrorFromResponse(u),s.status=o.statusCode,t(s))})}function l(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=n.indexOf(\"safari\")!==-1&&n.indexOf(\"chrome\")===-1,o=n.indexOf(\"msie\")!==-1,i=n.indexOf(\"edge\")!==-1,s=r||(o||i)&&\"GET\"===e.method,a=!(\"cache\"in e)||e.cache,u=/^blob:/.test(e.url);if(!u&&(s||!a)){var c=e.url.indexOf(\"?\")!==-1;e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return f(e,t)}var d=e(20),p=r(e(32)),h=e(34),v=e(25),y=a(),_=function(){};t.exports=l},{20:20,25:25,32:32,34:34}],20:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function s(e,t){return i(p(e),t)}function a(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){if(\"undefined\"==typeof FileReader)return t(a((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";return r?t(n):void t(a(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(h(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var p=function(e){return atob(e)},h=function(e){return btoa(e)};n.atob=p,n.btoa=h,n.base64StringToBlobOrBuffer=s,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],21:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t,n,r,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"===e.type()&&l.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:r,_id:t,history:[],replicator:h,version:p};throw n}).then(function(s){if(!i.cancelled&&s.last_seq!==n)return s.history=(s.history||[]).filter(function(e){return e.session_id!==r}),s.history.unshift({last_seq:n,session_id:r}),s.history=s.history.slice(0,v),s.version=p,s.replicator=h,s.session_id=r,s.last_seq=n,e.put(s).catch(function(s){if(409===s.status)return o(e,t,n,r,i);throw s})})}function i(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function s(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:a(e.history,t.history)}function a(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);if(!n||0===t.length)return{last_seq:y,history:[]};var s=n.session_id;if(u(s,t))return{last_seq:n.last_seq,history:e};var c=o.session_id;return u(c,r)?{last_seq:o.last_seq,history:i}:a(r,i)}function u(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||u(e,r))}function c(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var f=r(e(32)),l=e(34),d=e(22),p=1,h=\"pouchdb\",v=5,y=0;i.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},i.prototype.updateTarget=function(e,t){return o(this.target,this.id,e,t,this.returnValue)},i.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?f.resolve(!0):o(this.src,this.id,e,t,this.returnValue).catch(function(e){if(c(e))return n.readOnlySource=!0,!0;throw e})};var _={undefined:function(e,t){return 0===d.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return s(t,e).last_seq}};i.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?f.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return y;var n;return n=t.version?t.version.toString():\"undefined\",n in _?_[n](t,e):y},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:y}).then(function(){return y},function(n){return c(n)?(e.readOnlySource=!0,t.last_seq):y});throw n})}).catch(function(e){if(404!==e.status)throw e;return y})},t.exports=i},{22:22,32:32,34:34}],22:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){var o=r(e,t,n);return o+e}function i(e,t){if(e===t)return 0;e=s(e),t=s(t);var n=v(e),r=v(t);if(n-r!==0)return n-r;if(null===e)return 0;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e===t?0:e<t?-1:1;case\"string\":return p(e,t)}return Array.isArray(e)?d(e,t):h(e,t)}function s(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-(1/0)||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=s(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];\"undefined\"!=typeof i&&(e[o]=s(i))}}}}return e}function a(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return y(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";\nif(t)for(;++r<o;)i+=u(n[r]);else for(;++r<o;){var s=n[r];i+=u(s)+u(e[s])}return i}return\"\"}function u(e){var t=\"\\0\";return e=s(e),v(e)+g+a(e)+t}function c(e,t){var n,r=t,o=\"1\"===e[t];if(o)n=0,t++;else{var i=\"0\"===e[t];t++;var s=\"\",a=e.substring(t,t+m),u=parseInt(a,10)+_;for(i&&(u=-u),t+=m;;){var c=e[t];if(\"\\0\"===c)break;s+=c,t++}s=s.split(\".\"),n=1===s.length?parseInt(s,10):parseFloat(s[0]+\".\"+s[1]),i&&(n-=10),0!==u&&(n=parseFloat(n+\"e\"+u))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var s=e.pop();o[s]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=c(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var s=\"\";;){var a=e[r];if(\"\\0\"===a)break;s+=a,r++}s=s.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(s);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function p(e,t){return e===t?0:e>t?1:-1}function h(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),s=0;s<o;s++){var a=i(n[s],r[s]);if(0!==a)return a;if(a=i(e[n[s]],t[r[s]]),0!==a)return a}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function y(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",s=(r?-n:n)-_,a=o(s.toString(),\"0\",m);i+=g+a;var u=Math.abs(parseFloat(t[0]));r&&(u=10-u);var c=u.toFixed(20);return c=c.replace(/\\.?0+$/,\"\"),i+=g+c}Object.defineProperty(n,\"__esModule\",{value:!0});var _=-324,m=3,g=\"\";n.collate=i,n.normalizeKey=s,n.toIndexableString=u,n.parseIndexableString=l},{}],23:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this.store={}}function s(e){if(this.store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this.store[t]},i.prototype.set=function(e,t){var n=r(e);return this.store[n]=t,!0},i.prototype.has=function(e){var t=r(e);return t in this.store},i.prototype.delete=function(e){var t=r(e),n=t in this.store;return delete this.store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this.store),n=0,r=t.length;n<r;n++){var i=t[n],s=this.store[i];i=o(i),e(s,i)}},s.prototype.add=function(e){return this.store.set(e,!0)},s.prototype.has=function(e){return this.store.has(e)},n.Set=s,n.Map=i},{}],24:[function(e,t,n){(function(n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return q('\"use strict\";\\nreturn '+e+\";\",{})}function i(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return q(t,{})}function s(e,t){try{e.emit(\"change\",t)}catch(e){S.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}function a(e,t,n){function r(){o.cancel()}D.EventEmitter.call(this);var o=this;this.db=e,t=t?S.clone(t):{};var i=t.complete=S.once(function(t,n){t?S.listenerCount(o,\"error\")>0&&o.emit(\"error\",t):o.emit(\"complete\",n),o.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(o.on(\"complete\",function(e){n(null,e)}),o.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){t.isCancelled||s(o,e)};var a=new A(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});o.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=a.then.bind(a),this.catch=a.catch.bind(a),this.then(function(e){i(null,e)},i),e.taskqueue.isReady?o.doChanges(t):e.taskqueue.addTask(function(e){e?t.complete(e):o.isCancelled?o.emit(\"cancel\"):o.doChanges(t)})}function u(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=C.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return C.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=C.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function c(e,t){return e<t?-1:e>t?1:0}function f(e,t){for(var n=0;n<e.length;n++)if(t(e[n],n)===!0)return e[n]}function l(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function d(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=S.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function p(e,t){var n=c(e._id,t._id);if(0!==n)return n;var r=e._revisions?e._revisions.start:0,o=t._revisions?t._revisions.start:0;return c(r,o)}function h(e){var t={},n=[];return C.traverseRevTree(e,function(e,r,o,i){var s=r+\"-\"+o;return e&&(t[s]=0),void 0!==i&&n.push({from:i,to:s}),s}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function v(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return A.all(r.map(function(n){var r=S.jsExtend({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new A(function(t,i){e._allDocs(r,function(e,r){return e?i(e):(o.total_rows=r.total_rows,void t(r.rows[0]||{key:n,error:\"not_found\"}))})})})).then(function(e){return o.rows=e,o})}function y(e){var t=e._compactionQueue[0],r=t.opts,o=t.callback;e.get(\"_local/compaction\").catch(function(){return!1}).then(function(t){t&&t.last_seq&&(r.last_seq=t.last_seq),e._compact(r,function(t,r){t?o(t):o(null,r),n.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&y(e)})})})}function _(e){return\"_\"===e.charAt(0)&&e+\"is not a valid attachment name, attachment names cannot start with '_'\"}function m(){D.EventEmitter.call(this)}function g(){this.isReady=!1,this.failed=!1,this.queue=[]}function b(e,t){var n=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(n)return e=/http(s?)/.test(n[1])?n[1]+\"://\"+n[2]:n[2],{name:e,adapter:n[1]};var r,o=\"idb\"in k.adapters&&\"websql\"in k.adapters&&S.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+k.prefix+e];if(t.adapter)r=t.adapter;else if(\"undefined\"!=typeof t&&t.db)r=\"leveldb\";else for(var i=0;i<k.preferredAdapters.length;++i){r=k.preferredAdapters[i];{if(!o||\"idb\"!==r)break;S.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.')}}var s=k.adapters[r],a=!(s&&\"use_prefix\"in s)||s.use_prefix;return{name:a?k.prefix+e:e,adapter:r}}function w(e){function t(){e.constructor.emit(\"destroyed\",e.name)}function n(){e.removeListener(\"destroyed\",t),e.emit(\"destroyed\",e)}var r=e.constructor._destructionListeners;e.once(\"destroyed\",t),r.has(e.name)||r.set(e.name,[]),r.get(e.name).push(n)}function k(e,t){if(!(this instanceof k))return new k(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(t=e,e=t.name,delete t.name),this.__opts=t=S.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=k.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=(t.prefix||\"\")+e,o=b(r,t);if(t.name=o.name,t.adapter=t.adapter||o.adapter,n.name=e,n._adapter=t.adapter,O(\"pouchdb:adapter\")(\"Picked adapter: \"+t.adapter),!k.adapters[t.adapter]||!k.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);m.call(n),n.taskqueue=new g,n.adapter=t.adapter,k.adapters[t.adapter].call(n,t,function(e){return e?n.taskqueue.fail(e):(w(n),n.emit(\"created\",n),k.emit(\"created\",n.name),void n.taskqueue.ready(n))})}function E(e){Object.keys(D.EventEmitter.prototype).forEach(function(t){\"function\"==typeof D.EventEmitter.prototype[t]&&(e[t]=L[t].bind(L))});var t=e._destructionListeners=new I.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t.delete(e)})}var S=e(34),O=r(e(8)),j=r(e(13)),A=r(e(32)),I=e(23),D=e(11),x=r(e(7)),C=e(31),q=r(e(36)),R=e(25);j(a,D.EventEmitter),a.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},a.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=S.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=u,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){return t.isCancelled?void n(null,{status:\"cancelled\"}):(e.since=r.update_seq,void t.doChanges(e))},n);if(e.view&&!e.filter&&(e.filter=\"_view\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=S.normalizeDdocFunctionName(e.view):e.filter=S.normalizeDdocFunctionName(e.filter),\"http\"!==this.db.type()&&!e.doc_ids))return this.filterChanges(e);\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=x(function(e){r.cancel(),o.apply(this,e)})}},a.prototype.filterChanges=function(e){var t=this,n=e.complete;if(\"_view\"===e.filter){if(!e.view||\"string\"!=typeof e.view){var r=R.createError(R.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(r)}var s=S.parseDdocFunctionName(e.view);this.db.get(\"_design/\"+s[0],function(r,o){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(R.generateErrorFromResponse(r));var a=o&&o.views&&o.views[s[1]]&&o.views[s[1]].map;return a?(e.filter=i(a),void t.doChanges(e)):n(R.createError(R.MISSING_DOC,o.views?\"missing json key: \"+s[1]:\"missing json key: views\"))})}else{var a=S.parseDdocFunctionName(e.filter);if(!a)return t.doChanges(e);this.db.get(\"_design/\"+a[0],function(r,i){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(R.generateErrorFromResponse(r));var s=i&&i.filters&&i.filters[a[1]];return s?(e.filter=o(s),void t.doChanges(e)):n(R.createError(R.MISSING_DOC,i&&i.filters?\"missing json key: \"+a[1]:\"missing json key: filters\"))})}},j(m,D.EventEmitter),m.prototype.post=S.adapterFun(\"post\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(R.createError(R.NOT_AN_OBJECT)):void this.bulkDocs({docs:[e]},t,l(n))}),m.prototype.put=S.adapterFun(\"put\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(R.createError(R.NOT_AN_OBJECT)):(S.invalidIdError(e._id),C.isLocalId(e._id)&&\"function\"==typeof this._putLocal?e._deleted?this._removeLocal(e,n):this._putLocal(e,n):void(\"function\"==typeof this._put&&t.new_edits!==!1?this._put(e,t,n):this.bulkDocs({docs:[e]},t,l(n))))}),m.prototype.putAttachment=S.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},s.put(e)}var s=this;return\"function\"==typeof o&&(o=r,r=n,n=null),\"undefined\"==typeof o&&(o=r,r=n,n=null),s.get(e).then(function(e){if(e._rev!==n)throw R.createError(R.REV_CONFLICT);return i(e)},function(t){if(t.reason===R.MISSING_DOC.message)return i({_id:e});throw t})}),m.prototype.removeAttachment=S.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(R.createError(R.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),m.prototype.remove=S.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};return i._deleted=!0,C.isLocalId(i._id)&&\"function\"==typeof this._removeLocal?this._removeLocal(o,r):void this.bulkDocs({docs:[i]},n,l(r))}),m.prototype.revsDiff=S.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){a.has(e)||a.set(e,{missing:[]}),a.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);C.traverseRevTree(n,function(e,n,i,s,a){var u=n+\"-\"+i,c=o.indexOf(u);c!==-1&&(o.splice(c,1),\"available\"!==a.status&&r(t,u))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var s=0,a=new I.Map;i.map(function(t){this._getRevisionTree(t,function(r,u){if(r&&404===r.status&&\"missing\"===r.message)a.set(t,{missing:e[t]});else{if(r)return n(r);o(t,u)}if(++s===i.length){var c={};return a.forEach(function(e,t){c[t]=e}),n(null,c)}})},this)}),m.prototype.bulkGet=S.adapterFun(\"bulkGet\",function(e,t){S.bulkGetShim(this,e,t)}),m.prototype.compactDocument=S.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var s=h(i),a=[],u=[];Object.keys(s).forEach(function(e){s[e]>t&&a.push(e)}),C.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&a.indexOf(i)!==-1&&u.push(i)}),r._doCompaction(e,u,n)})}),m.prototype.compact=S.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&y(n)}),m.prototype._compact=function(e,t){function n(e){s.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;A.all(s).then(function(){return S.upsert(o,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<n)&&(e.last_seq=n,e)})}).then(function(){t(null,{ok:!0})}).catch(t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},s=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},m.prototype.get=S.adapterFun(\"get\",function(e,t,n){function r(){var r=[],s=o.length;return s?void o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,attachments:t.attachments},function(e,t){e?r.push({missing:o}):r.push({ok:t}),s--,s||n(null,r)})}):n(null,r)}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(R.createError(R.INVALID_ID));if(C.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,s=r.metadata,a=r.ctx;if(t.conflicts){var u=C.collectConflicts(s);u.length&&(o._conflicts=u)}if(C.isDeleted(s,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){var c=C.rootToLeaf(s.rev_tree),l=f(c,function(e){return e.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])!==-1}),d=l.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,p=l.ids.length-d;if(l.ids.splice(d,p),l.ids.reverse(),t.revs&&(o._revisions={start:l.pos+l.ids.length-1,ids:l.ids.map(function(e){return e.id})}),t.revs_info){var h=l.pos+l.ids.length;o._revs_info=l.ids.map(function(e){return h--,{rev:h+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var v=o._attachments,y=Object.keys(v).length;if(0===y)return n(null,o);Object.keys(v).forEach(function(e){this._getAttachment(o._id,e,v[e],{rev:o._rev,binary:t.binary,ctx:a},function(t,r){var i=o._attachments[e];i.data=r,delete i.stub,delete i.length,--y||n(null,o)})},i)}else{if(o._attachments)for(var _ in o._attachments)o._attachments.hasOwnProperty(_)&&(o._attachments[_].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){return e?n(e):(o=C.collectLeaves(t).map(function(e){return e.rev}),void r())});else{if(!Array.isArray(t.open_revs))return n(R.createError(R.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var s=0;s<o.length;s++){var a=o[s];if(\"string\"!=typeof a||!/^\\d+-/.test(a))return n(R.createError(R.INVALID_REV))}r()}}),m.prototype.getAttachment=S.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,s){return i?r(i):s.doc._attachments&&s.doc._attachments[t]?(n.ctx=s.ctx,n.binary=!0,o._getAttachment(e,t,s.doc._attachments[t],n,r),void 0):r(R.createError(R.MISSING_DOC))})}),m.prototype.allDocs=S.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=\"undefined\"!=typeof e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(R.createError(R.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(\"http\"!==this.type())return v(this,e,t)}return this._allDocs(e,t)}),m.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new a(this,e,t)},m.prototype.close=S.adapterFun(\"close\",function(e){return this._closed=!0,this._close(e)}),m.prototype.info=S.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){return n?e(n):(r.db_name=r.db_name||t.name,r.auto_compaction=!(!t.auto_compaction||\"http\"===t.type()),r.adapter=t.type(),void e(null,r))})}),m.prototype.id=S.adapterFun(\"id\",function(e){return this._id(e)}),m.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},m.prototype.bulkDocs=S.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(R.createError(R.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(R.createError(R.NOT_AN_OBJECT));var o;return e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(e){o=o||_(e)})}),o?n(R.createError(R.BAD_REQUEST,o)):(\"new_edits\"in t||(\"new_edits\"in e?t.new_edits=e.new_edits:t.new_edits=!0),t.new_edits||\"http\"===this.type()||e.docs.sort(p),d(e.docs),this._bulkDocs(e,t,function(e,r){return e?n(e):(t.new_edits||(r=r.filter(function(e){return e.error})),void n(null,r))}))}),m.prototype.registerDependentDatabase=S.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},!t.dependentDbs[e]&&(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);S.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})}).catch(t)}),m.prototype.destroy=S.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){return e?t(e):(r._destroyed=!0,r.emit(\"destroyed\"),void t(null,n||{ok:!0}))})}\"function\"==typeof e&&(t=e,e={});var r=this,o=!(\"use_prefix\"in r)||r.use_prefix;return\"http\"===r.type()?n():void r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var s=i.dependentDbs,a=r.constructor,u=Object.keys(s).map(function(e){var t=o?e.replace(new RegExp(\"^\"+a.prefix),\"\"):e;return new a(t,r.__opts).destroy()});A.all(u).then(n,t)})}),g.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},g.prototype.fail=function(e){this.failed=e,this.execute()},g.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},g.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},j(k,m),k.debug=O,k.adapters={},k.preferredAdapters=[],k.prefix=\"_pouch_\";var L=new D.EventEmitter;E(k),k.adapter=function(e,t,n){t.valid()&&(k.adapters[e]=t,n&&k.preferredAdapters.push(e))},k.plugin=function(e){if(\"function\"==typeof e)e(k);else{if(\"object\"!=typeof e||0===Object.keys(e).length)throw new Error(\"Invalid plugin: object passed in is empty or not an object\");Object.keys(e).forEach(function(t){k.prototype[t]=e[t]})}return k},k.defaults=function(e){function t(n,r){return this instanceof t?(r=r||{},n&&\"object\"==typeof n&&(r=n,n=r.name,delete r.name),r=S.jsExtend({},e,r),void k.call(this,n,r)):new t(n,r)}return j(t,k),t.preferredAdapters=k.preferredAdapters.slice(),Object.keys(k).forEach(function(e){e in t||(t[e]=k[e])}),t};var T=\"6.0.7\";k.version=T,t.exports=k}).call(this,e(35))},{11:11,13:13,23:23,25:25,31:31,32:32,34:34,35:35,36:36,7:7,8:8}],25:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){Error.call(this,e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}function i(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=o.prototype,new n(t)}function s(e){if(\"object\"!=typeof e){var t=e;e=y,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0});var a=r(e(13));a(o,Error),o.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var u=new o({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),c=new o({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),f=new o({status:404,error:\"not_found\",reason:\"missing\"}),l=new o({status:409,error:\"conflict\",reason:\"Document update conflict\"}),d=new o({status:400,error:\"bad_request\",reason:\"_id field must contain a string\"}),p=new o({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),h=new o({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),v=new o({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),y=new o({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),_=new o({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),m=new o({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),g=new o({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),b=new o({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),w=new o({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),k=new o({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),E=new o({status:404,error:\"not_found\",reason:\"Database not found\"}),S=new o({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),O=new o({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),j=new o({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),A=new o({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),I=new o({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),D=new o({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),x=new o({status:412,error:\"missing_stub\"}),C=new o({status:413,error:\"invalid_url\",reason:\"Provided URL is invalid\"});n.UNAUTHORIZED=u,n.MISSING_BULK_DOCS=c,n.MISSING_DOC=f,n.REV_CONFLICT=l,n.INVALID_ID=d,n.MISSING_ID=p,n.RESERVED_ID=h,n.NOT_OPEN=v,n.UNKNOWN_ERROR=y,n.BAD_ARG=_,n.INVALID_REQUEST=m,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=b,n.BAD_REQUEST=w,n.NOT_AN_OBJECT=k,n.DB_MISSING=E,n.WSQ_ERROR=O,n.LDB_ERROR=j,n.FORBIDDEN=A,n.INVALID_REV=I,n.FILE_EXISTS=D,n.MISSING_STUB=x,n.IDB_ERROR=S,n.INVALID_URL=C,n.createError=i,n.generateErrorFromResponse=s},{13:13}],26:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return Object.keys(e).sort(u.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function i(e,t,n){var r=n.doc_ids?n.doc_ids.sort(u.collate):\"\",i=n.filter?n.filter.toString():\"\",c=\"\",f=\"\";return n.filter&&n.query_params&&(c=JSON.stringify(o(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),s.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+i+f+c+r;return new s(function(e){a.binaryMd5(t,e)})}).then(function(e){return e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"),\"_local/\"+e})}var s=r(e(32)),a=e(30),u=e(22);t.exports=i},{22:22,30:30,32:32}],27:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){try{return JSON.parse(e)}catch(t){return a.parse(e)}}function i(e){return e.length<5e4?JSON.parse(e):o(e)}function s(e){try{return JSON.stringify(e)}catch(t){return a.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var a=r(e(38));n.safeJsonParse=i,n.safeJsonStringify=s},{38:38}],28:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(7)),i=function(e,n){return n&&e.then(function(e){t.nextTick(function(){n(null,e)})},function(e){t.nextTick(function(){n(e)})}),e},s=function(e){return o(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&i(r,n),r})},a=function(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})},u=function(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}},c=function(e){for(var t={},n=0,r=e.length;n<r;n++)t[\"$\"+e[n]]=!0;var o=Object.keys(t),i=new Array(o.length);for(n=0,r=o.length;n<r;n++)i[n]=o[n].substring(1);return i};n.uniq=c,n.sequentialize=u,n.fin=a,n.callbackify=s,n.promisedCallback=i}).call(this,e(35))},{35:35,7:7}],29:[function(e,t,n){(function(n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(){this.promise=new K(function(e){e()})}function i(e){var t,n=e.db,r=e.viewName,o=e.map,i=e.reduce,s=e.temporary,a=o.toString()+(i&&i.toString())+\"undefined\";if(!s&&(t=n._cachedViews=n._cachedViews||{},t[a]))return t[a];var u=n.info().then(function(e){function u(e){e.views=e.views||{};var t=r;t.indexOf(\"/\")===-1&&(t=r+\"/\"+r);var n=e.views[t]=e.views[t]||{};if(!n[c])return n[c]=!0,e}var c=e.db_name+\"-mrview-\"+(s?\"temp\":z.stringMd5(a));return U.upsert(n,\"_local/mrviews\",u).then(function(){return n.registerDependentDatabase(c).then(function(e){var r=e.db;r.auto_compaction=!0;var s={name:c,db:r,sourceDB:n,adapter:n.adapter,mapFun:o,reduceFun:i};return s.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return s.seq=e?e.seq:0,t&&s.db.once(\"destroyed\",function(){delete t[a]}),s})})})});return t&&(t[a]=u),u}function s(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,s)}catch(e){}}function a(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,a)}catch(e){}}function u(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,u)}catch(e){}}function c(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new u(t)}function f(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];if(\"number\"!=typeof o){if(!Array.isArray(o))throw c(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var i=0,s=o.length;i<s;i++){var a=o[i];if(\"number\"!=typeof a)throw c(\"_sum\");\"undefined\"==typeof t[i]?t.push(a):t[i]+=a}}else\"number\"==typeof t?t+=o:t[0]+=o}return t}function l(e,t){return J(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:f,log:W,isArray:H,toJSON:Y})}function d(e){return e.indexOf(\"/\")===-1?[e,e]:e.split(\"/\")}function p(e){return 1===e.length&&/^1-/.test(e[0].rev)}function h(e,t){try{e.emit(\"error\",t)}catch(e){U.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),U.guardedConsole(\"error\",t)}}function v(e,t,n){try{return{output:t.apply(null,n)}}catch(t){return h(e,t),{error:t}}}function y(e,t){var n=V.collate(e.key,t.key);return 0!==n?n:V.collate(e.value,t.value)}function _(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function m(e){var t=e.value,n=t&&\"object\"==typeof t&&t._id||e.id;return n}function g(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=G.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function b(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&g(t),t}}function w(e,t,n,r){var o=t[e];\"undefined\"!=typeof o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function k(e){if(\"undefined\"!=typeof e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function E(e){return e.group_level=k(e.group_level),e.limit=k(e.limit),e.skip=k(e.skip),e}function S(e){if(e){if(\"number\"!=typeof e)return new s('Invalid value for integer: \"'+e+'\"');if(e<0)return new s('Invalid value for positive integer: \"'+e+'\"')}}function O(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(\"undefined\"!=typeof e[n]&&\"undefined\"!=typeof e[r]&&V.collate(e[n],e[r])>0)throw new s(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&e.reduce!==!1){if(e.include_docs)throw new s(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new s(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=S(e[t]);if(n)throw n})}function j(e,t,n){var r,o=[],i=\"GET\";if(w(\"reduce\",n,o),w(\"include_docs\",n,o),w(\"attachments\",n,o),w(\"limit\",n,o),w(\"descending\",n,o),w(\"group\",n,o),w(\"group_level\",n,o),w(\"skip\",n,o),w(\"stale\",n,o),w(\"conflicts\",n,o),w(\"startkey\",n,o,!0),w(\"start_key\",n,o,!0),w(\"endkey\",n,o,!0),w(\"end_key\",n,o,!0),w(\"inclusive_end\",n,o),w(\"key\",n,o,!0),o=o.join(\"&\"),o=\"\"===o?\"\":\"?\"+o,\"undefined\"!=typeof n.keys){var s=2e3,a=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));a.length+o.length+1<=s?o+=(\"?\"===o[0]?\"&\":\"?\")+a:(i=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var u=d(t);return e.request({method:i,url:\"_design/\"+u[0]+\"/_view/\"+u[1]+o,body:r}).then(b(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.request({method:\"POST\",url:\"_temp_view\"+o,body:r}).then(b(n))}function A(e,t,n){return new K(function(r,o){e._query(t,n,function(e,t){return e?o(e):void r(t)})})}function I(e){return new K(function(t,n){e._viewCleanup(function(e,r){return e?n(e):void t(r)})})}function D(e){return function(t){if(404===t.status)return e;throw t}}function x(e,t,n){function r(){return p(f)?K.resolve(a):t.db.get(s).catch(D(a))}function o(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):K.resolve({rows:[]})}function i(e,t){for(var n=[],r={},o=0,i=t.rows.length;o<i;o++){var s=t.rows[o],a=s.doc;if(a&&(n.push(a),r[a._id]=!0,a._deleted=!c[a._id],!a._deleted)){var u=c[a._id];\"value\"in u&&(a.value=u.value)}}var f=Object.keys(c);return f.forEach(function(e){if(!r[e]){var t={_id:e},o=c[e];\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=$.uniq(f.concat(e.keys)),n.push(e),n}var s=\"_local/doc_\"+e,a={_id:s,keys:[]},u=n[e],c=u.indexableKeysToKeyValues,f=u.changes;return r().then(function(e){return o(e).then(function(t){return i(e,t)})})}function C(e,t,n){var r=\"_local/lastSeq\";return e.db.get(r).catch(D({_id:r,seq:0})).then(function(r){var o=Object.keys(t);return K.all(o.map(function(n){return x(n,e,t)})).then(function(t){var o=U.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function q(e){var t=\"string\"==typeof e?e:e.name,n=X[t];return n||(n=X[t]=new o),n}function R(e){return $.sequentialize(q(e),function(){return L(e)})()}function L(e){function t(e,t){var n={id:i._id,key:V.normalizeKey(e)};\"undefined\"!=typeof t&&null!==t&&(n.value=V.normalizeKey(t)),r.push(n)}function n(t,n){\nreturn function(){return C(e,t,n)}}var r,i,s;if(\"function\"==typeof e.mapFun&&2===e.mapFun.length){var a=e.mapFun;s=function(e){return a(e,t)}}else s=l(e.mapFun.toString(),t);var u=e.seq||0,c=new o;return new K(function(t,o){function a(){c.finish().then(function(){e.seq=u,t()})}function f(){function t(e){o(e)}e.sourceDB.changes({conflicts:!0,include_docs:!0,style:\"all_docs\",since:u,limit:ee}).on(\"complete\",function(t){var o=t.results;if(!o.length)return a();for(var l={},d=0,p=o.length;d<p;d++){var h=o[d];if(\"_\"!==h.doc._id[0]){r=[],i=h.doc,i._deleted||v(e.sourceDB,s,[i]),r.sort(y);for(var _,m={},g=0,b=r.length;g<b;g++){var w=r[g],k=[w.key,w.id];0===V.collate(w.key,_)&&k.push(g);var E=V.toIndexableString(k);m[E]=w,_=w.key}l[h.doc._id]={indexableKeysToKeyValues:m,changes:h.changes}}u=h.seq}return c.add(n(l,u)),o.length<ee?a():f()}).on(\"error\",t)}f()})}function T(e,t,n){0===n.group_level&&delete n.group_level;var r,o=n.group||n.group_level;r=te[e.reduceFun]?te[e.reduceFun]:l(e.reduceFun.toString());var i=[],s=isNaN(n.group_level)?Number.POSITIVE_INFINITY:n.group_level;t.forEach(function(e){var t=i[i.length-1],n=o?e.key:null;return o&&Array.isArray(n)&&(n=n.slice(0,s)),t&&0===V.collate(t.groupKey,n)?(t.keys.push([e.key,e.id]),void t.values.push(e.value)):void i.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var a=0,c=i.length;a<c;a++){var f=i[a],d=v(e.sourceDB,r,[f.keys,f.values,!1]);if(d.error&&d.error instanceof u)throw d.error;t.push({value:d.error?null:d.output,key:f.groupKey})}return{rows:_(t,n.limit,n.skip)}}function B(e,t){return $.sequentialize(q(e),function(){return N(e,t)})()}function N(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=V.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?T(e,n,t):{total_rows:o,offset:s,rows:n},t.include_docs){var a=$.uniq(n.map(m));return e.sourceDB.allDocs({keys:a,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t={};return e.rows.forEach(function(e){e.doc&&(t[\"$\"+e.id]=e.doc)}),n.forEach(function(e){var n=m(e),r=t[\"$\"+n];r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&t.reduce!==!1,s=t.skip||0;if(\"undefined\"==typeof t.keys||t.keys.length||(t.limit=0,delete t.keys),\"undefined\"!=typeof t.keys){var a=t.keys,u=a.map(function(e){var t={startkey:V.toIndexableString([e]),endkey:V.toIndexableString([e,{}])};return n(t)});return K.all(u).then(U.flatten).then(r)}var c={descending:t.descending};if(t.start_key&&(t.startkey=t.start_key),t.end_key&&(t.endkey=t.end_key),\"undefined\"!=typeof t.startkey&&(c.startkey=t.descending?V.toIndexableString([t.startkey,{}]):V.toIndexableString([t.startkey])),\"undefined\"!=typeof t.endkey){var f=t.inclusive_end!==!1;t.descending&&(f=!f),c.endkey=V.toIndexableString(f?[t.endkey,{}]:[t.endkey])}if(\"undefined\"!=typeof t.key){var l=V.toIndexableString([t.key]),d=V.toIndexableString([t.key,{}]);c.descending?(c.endkey=l,c.startkey=d):(c.startkey=l,c.endkey=d)}return i||(\"number\"==typeof t.limit&&(c.limit=t.limit),c.skip=s),n(c).then(r)}function P(e){return e.request({method:\"POST\",url:\"_view_cleanup\"})}function M(e){return e.get(\"_local/mrviews\").then(function(t){var n={};Object.keys(t.views).forEach(function(e){var t=d(e),r=\"_design/\"+t[0],o=t[1];n[r]=n[r]||{},n[r][o]=!0});var r={keys:Object.keys(n),include_docs:!0};return e.allDocs(r).then(function(r){var o={};r.rows.forEach(function(e){var r=e.key.substring(8);Object.keys(n[e.key]).forEach(function(n){var i=r+\"/\"+n;t.views[i]||(i=n);var s=Object.keys(t.views[i]),a=e.doc&&e.doc.views&&e.doc.views[n];s.forEach(function(e){o[e]=o[e]||a})})});var i=Object.keys(o).filter(function(e){return!o[e]}),s=i.map(function(t){return $.sequentialize(q(t),function(){return new e.constructor(t,e.__opts).destroy()})()});return K.all(s).then(function(){return{ok:!0}})})},D({ok:!0}))}function F(e,t,r){if(\"http\"===e.type())return j(e,t,r);if(\"function\"==typeof e._query)return A(e,t,r);if(\"string\"!=typeof t){O(r,t);var o={db:e,viewName:\"temp_view/temp_view\",map:t.map,reduce:t.reduce,temporary:!0};return Z.add(function(){return i(o).then(function(e){function t(){return e.db.destroy()}return $.fin(R(e).then(function(){return B(e,r)}),t)})}),Z.finish()}var s=t,u=d(s),c=u[0],f=u[1];return e.get(\"_design/\"+c).then(function(t){var o=t.views&&t.views[f];if(!o||\"string\"!=typeof o.map)throw new a(\"ddoc \"+c+\" has no view named \"+f);O(r,o);var u={db:e,viewName:s,map:o.map,reduce:o.reduce};return i(u).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&n.nextTick(function(){R(e)}),B(e,r)):R(e).then(function(){return B(e,r)})})})}var U=e(34),G=e(20),V=e(22),K=r(e(32)),z=e(30),J=r(e(36)),Q=r(e(13)),$=e(28);o.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},o.prototype.finish=function(){return this.promise},Q(s,Error),Q(a,Error),Q(u,Error);var W=U.guardedConsole.bind(null,\"log\"),H=Array.isArray,Y=JSON.parse,X={},Z=new o,ee=50,te={_sum:function(e,t){return f(t)},_count:function(e,t){return t.length},_stats:function(e,t){function n(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];t+=o*o}return t}return{sum:f(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:n(t)}}},ne=$.callbackify(function(){var e=this;return\"http\"===e.type()?P(e):\"function\"==typeof e._viewCleanup?I(e):M(e)}),re=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),t=t?E(t):{},\"function\"==typeof e&&(e={map:e});var r=this,o=K.resolve().then(function(){return F(r,e,t)});return $.promisedCallback(o,n),o},oe={query:re,viewCleanup:ne};t.exports=oe}).call(this,e(35))},{13:13,20:20,22:22,28:28,30:30,32:32,34:34,35:35,36:36}],30:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return f.btoa(e)}function i(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function s(e,t,n,r,o){(n>0||r<t.size)&&(t=i(t,n,r)),f.readAsArrayBuffer(t,function(t){e.append(t),o()})}function a(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function u(e,t){function n(){d(i)}function r(){var e=y.end(!0),n=o(e);t(n),y.destroy()}function i(){var t=v*f,o=t+f;v++,v<h?_(y,e,t,o,n):_(y,e,t,o,r)}var u=\"string\"==typeof e,c=u?e.length:e.size,f=Math.min(p,c),h=Math.ceil(c/f),v=0,y=u?new l:new l.ArrayBuffer,_=u?a:s;i()}function c(e){return l.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var f=e(20),l=r(e(37)),d=t.setImmediate||t.setTimeout,p=32768;n.binaryMd5=u,n.stringMd5=c}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{20:20,37:37}],31:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var s=o.ids,a=s[2],u=o.pos;if(a.length)for(var c=0,f=a.length;c<f;c++)i.push({pos:u+1,ids:a[c]});else{var l=!!s[1].deleted,d=s[0];t&&!(r!==l?r:n!==u?n<u:t<d)||(t=d,n=u,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,s=i[2],a=t(0===s.length,o,i[0],n.ctx,i[1]),u=0,c=s.length;u<c;u++)r.push({pos:o+1,ids:s[u],ctx:a})}function i(e,t){return e.pos-t.pos}function s(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;n<r;n++)delete t[n].pos;return t}function a(e){for(var t=r(e),n=s(e.rev_tree),o=[],i=0,a=n.length;i<a;i++){var u=n[i];u.rev===t||u.opts.deleted||o.push(u.rev)}return o}function u(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function c(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,s=i[0],a=i[1],u=i[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:s,opts:a}),c&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=u.length;l<d;l++)r.push({pos:o+1,ids:u[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;o<i;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function p(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var s=e[o],a=[s.id,s.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function h(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,s=o.tree2;(i[1].status||s[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===s[1].status?\"available\":\"missing\");for(var a=0;a<s[2].length;a++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===s[2][a][0]&&(n.push({tree1:i[2][c],tree2:s[2][a]}),u=!0);u||(r=\"new_branch\",d(i[2],s[2][a],h))}else r=\"new_leaf\",i[2][0]=s[2][a]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,s=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var a=0,u=e.length;a<u;a++){var c=e[a];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=v(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,s=!0;else if(n!==!0){var l=c.pos<t.pos?c:t,d=c.pos<t.pos?t:c,p=d.pos-l.pos,h=[],y=[];for(y.push({ids:l.ids,diff:p,parent:null,parentIdx:null});y.length>0;){var _=y.pop();if(0!==_.diff)for(var m=_.ids[2],g=0,b=m.length;g<b;g++)y.push({ids:m[g],diff:_.diff-1,parent:_.ids,parentIdx:g});else _.ids[0]===d.ids[0]&&h.push(_)}var w=h[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,s=!0):o.push(c)}else o.push(c)}return s||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function _(e,t){for(var n,r=c(e),i={},s=0,a=r.length;s<a;s++){for(var u=r[s],f=u.ids,l=Math.max(0,f.length-t),d={pos:u.pos+l,ids:p(f,l)},h=0;h<l;h++){var v=u.pos+h+\"-\"+f[h].id;i[v]=!0}n=n?y(n,d,!0).tree:[d]}return o(n,function(e,t,n){delete i[t+\"-\"+n]}),{tree:n,revs:Object.keys(i)}}function m(e,t,n){var r=y(e,t),o=_(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function g(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),s=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===s)return!0;for(var a=n.ids[2],u=0,c=a.length;u<c;u++)r.push({pos:n.pos+1,ids:a[u]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=a,n.collectLeaves=s,n.compactTree=u,n.isDeleted=w,n.isLocalId=k,n.merge=m,n.revExists=g,n.rootToLeaf=c,n.traverseRevTree=o,n.winningRev=r},{}],32:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}var o=r(e(14)),i=\"function\"==typeof Promise?Promise:o;t.exports=i},{14:14}],33:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function s(e,t){var n=Object.keys(t._attachments);return g.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function a(e,t,n){var r=\"http\"===t.type()&&\"http\"!==e.type(),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return g.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))}).catch(function(e){if(404!==e.status)throw e;return s(t,n)}):s(t,n)}function u(e){var t=[];return Object.keys(e).forEach(function(n){var r=e[n].missing;r.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0}}function c(e,t,n,r){function i(){var o=u(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return g.all(n.results.map(function(n){return g.all(n.docs.map(function(n){var r=n.ok;return n.error&&(h=!1),r&&r._attachments?a(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){p=p.concat(m.flatten(e).filter(Boolean))})})}function s(e){return e._attachments&&Object.keys(e._attachments).length>0}function c(e){return e._conflicts&&e._conflicts.length>0}function f(t){return e.allDocs({keys:t,include_docs:!0,conflicts:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!o(e.value.rev)||s(e.doc)||c(e.doc)||(p.push(e.doc),delete n[e.id])})})}function l(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});if(e.length>0)return f(e)}function d(){return{ok:h,docs:p}}n=m.clone(n);var p=[],h=!0;return g.resolve().then(l).then(i).then(d)}function f(e,t,n,r){if(e.retry===!1)return t.emit(\"error\",n),void t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=m.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var o=function(){e.current_back_off=O},i=function(){t.removeListener(\"active\",o)};t.once(\"paused\",i),t.once(\"active\",o)}e.current_back_off=e.current_back_off||O,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}function l(e,t,n,r,o){function i(){return D?g.resolve():w(e,t,n).then(function(n){I=n,D=new b(e,t,I,r)})}function s(){if(U=[],0!==A.docs.length){var e=A.docs,i={timeout:n.timeout};return t.bulkDocs({docs:e,new_edits:!1},i).then(function(t){if(r.cancelled)throw y(),new Error(\"cancelled\");var n=Object.create(null);t.forEach(function(e){e.error&&(n[e.id]=e)});var i=Object.keys(n).length;o.doc_write_failures+=i,o.docs_written+=e.length-i,e.forEach(function(e){var t=n[e._id];if(t){if(o.errors.push(t),\"unauthorized\"!==t.name&&\"forbidden\"!==t.name)throw t;r.emit(\"denied\",m.clone(t))}else U.push(e)})},function(t){throw o.doc_write_failures+=e.length,t})}}function a(){if(A.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=T=A.seq;var e=m.clone(o);return U.length&&(e.docs=U,r.emit(\"change\",e)),q=!0,D.writeCheckpoint(A.seq,G).then(function(){if(q=!1,r.cancelled)throw y(),new Error(\"cancelled\");A=void 0,S()}).catch(function(e){throw j(e),e})}function u(){var e={};return A.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw y(),new Error(\"cancelled\");A.diffs=e})}function d(){return c(e,t,A.diffs,r).then(function(e){A.error=!e.ok,e.docs.forEach(function(e){delete A.diffs[e._id],o.docs_read++,A.docs.push(e)})})}function p(){if(!r.cancelled&&!A){if(0===x.length)return void h(!0);A=x.shift(),u().then(d).then(s).then(a).then(p).catch(function(e){v(\"batch processing terminated with error\",e)})}}function h(e){return 0===C.changes.length?void(0!==x.length||A||((B&&V.live||R)&&(r.state=\"pending\",r.emit(\"paused\")),R&&y())):void((e||R||C.changes.length>=N)&&(x.push(C),C={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),p()))}function v(e,t){L||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",x=[],C={seq:0,changes:[],docs:[]},y(t))}function y(i){L||r.cancelled&&(o.status=\"cancelled\",q)||(o.status=o.status||\"complete\",o.end_time=new Date,o.last_seq=T,L=!0,i?(i.result=o,\"unauthorized\"===i.name||\"forbidden\"===i.name?(r.emit(\"error\",i),r.removeAllListeners()):f(n,r,i,function(){l(e,t,n,r)})):(r.emit(\"complete\",o),r.removeAllListeners()))}function _(e){if(r.cancelled)return y();var t=m.filterChange(n)(e);t&&(C.seq=e.seq,C.changes.push(e),h(0===x.length&&V.live))}function k(e){if(M=!1,r.cancelled)return y();if(e.results.length>0)V.since=e.last_seq,S(),h(!0);else{var t=function(){B?(V.live=!0,S()):R=!0,h(!0)};A||0!==e.results.length?t():(q=!0,D.writeCheckpoint(e.last_seq,G).then(function(){q=!1,o.last_seq=T=e.last_seq,t()}).catch(j))}}function E(e){return M=!1,r.cancelled?y():void v(\"changes rejected\",e)}function S(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!M&&!R&&x.length<P){M=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(V).on(\"change\",_);i.then(o,o),i.then(k).catch(E),n.retry&&(r._changes=i,r._abortChanges=t)}}function O(){i().then(function(){return r.cancelled?void y():D.getCheckpoint().then(function(e){T=e,V={since:T,limit:N,batch_size:N,style:\"all_docs\",doc_ids:F,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?V.include_docs=!0:V.filter=n.filter),\"heartbeat\"in n&&(V.heartbeat=n.heartbeat),\"timeout\"in n&&(V.timeout=n.timeout),n.query_params&&(V.query_params=n.query_params),n.view&&(V.view=n.view),S()})}).catch(function(e){v(\"getCheckpoint rejected with \",e)})}function j(e){q=!1,v(\"writeCheckpoint completed with error\",e)}var A,I,D,x=[],C={seq:0,changes:[],docs:[]},q=!1,R=!1,L=!1,T=0,B=n.continuous||n.live||!1,N=n.batch_size||100,P=n.batches_limit||10,M=!1,F=n.doc_ids,U=[],G=m.uuid();o=o||{ok:!0,start_time:new Date,docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var V={};return r.ready(e,t),r.cancelled?void y():(r._addedListeners||(r.once(\"cancel\",y),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void(\"undefined\"==typeof n.since?O():i().then(function(){return q=!0,D.writeCheckpoint(n.since,G)}).then(function(){return q=!1,r.cancelled?void y():(T=n.since,void O())}).catch(j)))}function d(){k.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new g(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e.catch=function(e){return t.catch(e)},e.catch(function(){})}function p(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function h(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),\"undefined\"==typeof n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw S.createError(S.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=m.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n),i=p(e,n),s=p(t,n);return l(i,s,n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),\"undefined\"==typeof n&&(n={}),n=m.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=p(e,n),t=p(t,n),new y(e,t,n,r)}function y(e,t,n,r){function o(e){p.emit(\"change\",{direction:\"pull\",change:e})}function i(e){p.emit(\"change\",{direction:\"push\",change:e})}function s(e){p.emit(\"denied\",{direction:\"push\",doc:e})}function a(e){p.emit(\"denied\",{direction:\"pull\",doc:e})}function u(){p.pushPaused=!0,p.pullPaused&&p.emit(\"paused\")}function c(){p.pullPaused=!0,p.pushPaused&&p.emit(\"paused\")}function f(){p.pushPaused=!1,p.pullPaused&&p.emit(\"active\",{direction:\"push\"})}function l(){p.pullPaused=!1,p.pushPaused&&p.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===a||n===s),h=\"paused\"===t&&(n===c||n===u),v=\"active\"===t&&(n===l||n===f);(r||d||h||v)&&(t in _||(_[t]={}),_[t][e]=!0,2===Object.keys(_[t]).length&&p.removeAllListeners(t))}}var p=this;this.canceled=!1;var v=n.push?m.jsExtend({},n,n.push):n,y=n.pull?m.jsExtend({},n,n.pull):n;this.push=h(e,t,v),this.pull=h(t,e,y),this.pushPaused=!0,this.pullPaused=!0;var _={};n.live&&(this.push.on(\"complete\",p.pull.cancel.bind(p.pull)),this.pull.on(\"complete\",p.push.cancel.bind(p.push))),this.on(\"newListener\",function(e){\"change\"===e?(p.pull.on(\"change\",o),p.push.on(\"change\",i)):\"denied\"===e?(p.pull.on(\"denied\",a),p.push.on(\"denied\",s)):\"active\"===e?(p.pull.on(\"active\",l),p.push.on(\"active\",f)):\"paused\"===e&&(p.pull.on(\"paused\",c),p.push.on(\"paused\",u))}),this.on(\"removeListener\",function(e){\"change\"===e?(p.pull.removeListener(\"change\",o),p.push.removeListener(\"change\",i)):\"denied\"===e?(p.pull.removeListener(\"denied\",a),p.push.removeListener(\"denied\",s)):\"active\"===e?(p.pull.removeListener(\"active\",l),p.push.removeListener(\"active\",f)):\"paused\"===e&&(p.pull.removeListener(\"paused\",c),p.push.removeListener(\"paused\",u))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var b=g.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return p.emit(\"complete\",t),r&&r(null,t),p.removeAllListeners(),t},function(e){if(p.cancel(),r?r(e):p.emit(\"error\",e),p.removeAllListeners(),r)throw e});this.then=function(e,t){return b.then(e,t)},this.catch=function(e){return b.catch(e)}}function _(e){e.replicate=h,e.sync=v,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var e=this;return{from:function(t,n,r){return e.constructor.replicate(t,e,n,r)},to:function(t,n,r){return e.constructor.replicate(e,t,n,r)}}}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}var m=e(34),g=r(e(32)),b=r(e(21)),w=r(e(26)),k=e(11),E=r(e(13)),S=e(25),O=0;E(d,k.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},E(y,k.EventEmitter),y.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=_},{11:11,13:13,21:21,25:25,26:26,32:32,34:34}],34:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function s(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function a(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&$.call(n)==W}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return s(e);if(!a(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);\"undefined\"!=typeof i&&(t[n]=i)}return t}function c(e){var t=!1;return V(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return V(function(n){n=u(n);var r,o=this,i=\"function\"==typeof n[n.length-1]&&n.pop();i&&(r=function(e,n){t.nextTick(function(){i(e,n)})});var s=new G(function(t,r){var i;try{var s=c(function(e,n){e?r(e):t(n)});n.push(s),i=e.apply(o,n),i&&\"function\"==typeof i.then&&t(i)}catch(e){r(e)}});return r&&s.then(function(e){r(null,e)},r),s})}function l(e,t){function n(e,t,n){if(H.enabled){for(var r=[e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);H.apply(null,r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),H.apply(null,o),i(n,r)}}}return f(V(function(r){if(this._closed)return G.reject(new Error(\"database is closed\"));if(this._destroyed)return G.reject(new Error(\"database is destroyed\"));var o=this;return n(o,e,r),this.taskqueue.isReady?t.apply(this,r):new G(function(t,n){o.taskqueue.addTask(function(i){i?n(i):t(o[e].apply(o,r))})})}))}function d(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function h(e){return[{ok:e}]}function v(e,t,n){function r(){var e=[];v.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){v[e]={id:t,docs:n},o()}function s(){if(!(_>=y.length)){var e=Math.min(_+Y,y.length),t=y.slice(_,e);a(t,_),_+=t.length}}function a(n,r){n.forEach(function(n,o){var a=r+o,u=c[n],f=d(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=h),[\"revs\",\"attachments\",\"binary\",\"ajax\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(a,n,r),s()})})}var u=t.docs,c={};u.forEach(function(e){e.id in c?c[e.id].push(e):c[e.id]=[e]});var f=Object.keys(c).length,l=0,v=new Array(f),y=Object.keys(c),_=0;s()}function y(){return\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage&&\"undefined\"!=typeof chrome.storage.local}function _(){return U}function m(e){y()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):_()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function g(){z.EventEmitter.call(this),this._listeners={},m(this)}function b(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){var n=6e5;e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>n&&(e=n>>1,t=n);var r=Math.random(),o=t-e;return~~(o*r+e)}function k(e){var t=0;return e||(t=2e3),w(e,t)}function E(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function S(e,t){for(var n in t)if(t.hasOwnProperty(n)){var r=u(t[n]);\"undefined\"!=typeof r&&(e[n]=r)}}function O(e,t,n){return S(e,t),n&&S(e,n),e}function j(e){if(\"object\"!=typeof e)throw e+\" is not an object\";var t=Z.call(arguments,1);return ee.call(t,function(t){if(t)for(var n in t)\"object\"==typeof t[n]&&e[n]?j.call(e,e[n],t[n]):e[n]=t[n]}),e}function A(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return Q.createError(Q.BAD_REQUEST,r)}}function I(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&A(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function D(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function x(){}function C(e){var t;if(e?\"string\"!=typeof e?t=Q.createError(Q.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=Q.createError(Q.RESERVED_ID)):t=Q.createError(Q.MISSING_ID),t)throw t}function q(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function R(e,t){return\"listenerCount\"in e?e.listenerCount(t):z.EventEmitter.listenerCount(e,t)}function L(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function T(e){var t=L(e);return t?t.join(\"/\"):null}function B(e){for(var t=se.exec(e),n={},r=14;r--;){var o=re[r],i=t[r]||\"\",s=[\"user\",\"password\"].indexOf(o)!==-1;n[o]=s?decodeURIComponent(i):i}return n[oe]={},n[re[12]].replace(ie,function(e,t,r){t&&(n[oe][t]=r)}),n}function N(e,t,n){return new G(function(r,o){e.get(t,function(i,s){if(i){if(404!==i.status)return o(i);s={}}var a=s._rev,u=n(s);return u?(u._id=t,u._rev=a,void r(P(e,u,n))):r({updated:!1,rev:a})})})}function P(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return N(e,t._id,n)})}function M(e){return 0|Math.random()*e}function F(e,t){t=t||ae.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=ae[M(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=ae[3&M(16)|8];break;default:n+=ae[M(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var U,G=r(e(32)),V=r(e(7)),K=r(e(8)),z=e(11),J=r(e(13)),Q=e(25),$=Function.prototype.toString,W=$.call(Object),H=K(\"pouchdb:api\"),Y=6;if(y())U=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),U=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){U=!1}J(g,z.EventEmitter),g.prototype.addListener=function(e,t,n,r){function o(){function e(){s=!1}if(i._listeners[t]){if(s)return void(s=\"waiting\");s=!0;var a=d(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(a).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===s&&setTimeout(function(){o()},0),s=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,s=!1;this._listeners[t]=o,this.on(e,o)}},g.prototype.removeListener=function(e,t){t in this._listeners&&(z.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},g.prototype.notifyLocalWindows=function(e){y()?chrome.storage.local.set({dbName:e}):_()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},g.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var X,Z=Array.prototype.slice,ee=Array.prototype.forEach,te=x.name;X=te?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ne=X,re=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],oe=\"queryKey\",ie=/(?:^|&)([^&=]*)=?([^&]*)/g,se=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ae=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=l,n.bulkGetShim=v,n.changesHandler=g,n.clone=u,n.defaultBackOff=k,n.explainError=E,n.extend=O,n.jsExtend=j,n.filterChange=I,n.flatten=D,n.functionName=ne,n.guardedConsole=b,n.hasLocalStorage=_,n.invalidIdError=C,n.isChromeApp=y,n.isCordova=q,n.listenerCount=R,n.normalizeDdocFunctionName=T,n.once=c,n.parseDdocFunctionName=L,n.parseUri=B,n.pick=d,n.toPromise=f,n.upsert=N,n.uuid=F}).call(this,e(35))},{11:11,13:13,25:25,32:32,35:35,7:7,8:8}],35:[function(e,t,n){function r(){if(!a){a=!0;for(var e,t=s.length;t;){e=s,s=[];for(var n=-1;++n<t;)e[n]();t=s.length}a=!1}}function o(){}var i=t.exports={},s=[],a=!1;i.nextTick=function(e){s.push(e),a||setTimeout(r,0)},i.title=\"browser\",i.browser=!0,i.env={},i.argv=[],i.version=\"\",i.versions={},i.on=o,i.addListener=o,i.once=o,i.off=o,i.removeListener=o,i.removeAllListeners=o,i.emit=o,i.binding=function(e){throw new Error(\"process.binding is not supported\")},i.cwd=function(){return\"/\"},i.chdir=function(e){throw new Error(\"process.chdir is not supported\")},i.umask=function(){return 0}},{}],36:[function(e,t,n){(function(){var e={}.hasOwnProperty,n=[].slice;t.exports=function(t,r){var o,i,s,a;i=[],a=[];for(o in r)e.call(r,o)&&(s=r[o],\"this\"!==o&&(i.push(o),a.push(s)));return Function.apply(null,n.call(i).concat([t])).apply(r.this,a)}}).call(this)},{}],37:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t,n,r,o,i){return t=g(g(t,e),g(r,i)),g(t<<o|t>>>32-o,n)}function n(e,n,r,o,i,s,a){return t(n&r|~n&o,e,n,i,s,a)}function r(e,n,r,o,i,s,a){return t(n&o|r&~o,e,n,i,s,a)}function o(e,n,r,o,i,s,a){return t(n^r^o,e,n,i,s,a)}function i(e,n,r,o,i,s,a){return t(r^(n|~o),e,n,i,s,a)}function s(e,t){var s=e[0],a=e[1],u=e[2],c=e[3];s=n(s,a,u,c,t[0],7,-680876936),c=n(c,s,a,u,t[1],12,-389564586),u=n(u,c,s,a,t[2],17,606105819),a=n(a,u,c,s,t[3],22,-1044525330),s=n(s,a,u,c,t[4],7,-176418897),c=n(c,s,a,u,t[5],12,1200080426),u=n(u,c,s,a,t[6],17,-1473231341),a=n(a,u,c,s,t[7],22,-45705983),s=n(s,a,u,c,t[8],7,1770035416),c=n(c,s,a,u,t[9],12,-1958414417),u=n(u,c,s,a,t[10],17,-42063),a=n(a,u,c,s,t[11],22,-1990404162),s=n(s,a,u,c,t[12],7,1804603682),c=n(c,s,a,u,t[13],12,-40341101),u=n(u,c,s,a,t[14],17,-1502002290),a=n(a,u,c,s,t[15],22,1236535329),s=r(s,a,u,c,t[1],5,-165796510),\nc=r(c,s,a,u,t[6],9,-1069501632),u=r(u,c,s,a,t[11],14,643717713),a=r(a,u,c,s,t[0],20,-373897302),s=r(s,a,u,c,t[5],5,-701558691),c=r(c,s,a,u,t[10],9,38016083),u=r(u,c,s,a,t[15],14,-660478335),a=r(a,u,c,s,t[4],20,-405537848),s=r(s,a,u,c,t[9],5,568446438),c=r(c,s,a,u,t[14],9,-1019803690),u=r(u,c,s,a,t[3],14,-187363961),a=r(a,u,c,s,t[8],20,1163531501),s=r(s,a,u,c,t[13],5,-1444681467),c=r(c,s,a,u,t[2],9,-51403784),u=r(u,c,s,a,t[7],14,1735328473),a=r(a,u,c,s,t[12],20,-1926607734),s=o(s,a,u,c,t[5],4,-378558),c=o(c,s,a,u,t[8],11,-2022574463),u=o(u,c,s,a,t[11],16,1839030562),a=o(a,u,c,s,t[14],23,-35309556),s=o(s,a,u,c,t[1],4,-1530992060),c=o(c,s,a,u,t[4],11,1272893353),u=o(u,c,s,a,t[7],16,-155497632),a=o(a,u,c,s,t[10],23,-1094730640),s=o(s,a,u,c,t[13],4,681279174),c=o(c,s,a,u,t[0],11,-358537222),u=o(u,c,s,a,t[3],16,-722521979),a=o(a,u,c,s,t[6],23,76029189),s=o(s,a,u,c,t[9],4,-640364487),c=o(c,s,a,u,t[12],11,-421815835),u=o(u,c,s,a,t[15],16,530742520),a=o(a,u,c,s,t[2],23,-995338651),s=i(s,a,u,c,t[0],6,-198630844),c=i(c,s,a,u,t[7],10,1126891415),u=i(u,c,s,a,t[14],15,-1416354905),a=i(a,u,c,s,t[5],21,-57434055),s=i(s,a,u,c,t[12],6,1700485571),c=i(c,s,a,u,t[3],10,-1894986606),u=i(u,c,s,a,t[10],15,-1051523),a=i(a,u,c,s,t[1],21,-2054922799),s=i(s,a,u,c,t[8],6,1873313359),c=i(c,s,a,u,t[15],10,-30611744),u=i(u,c,s,a,t[6],15,-1560198380),a=i(a,u,c,s,t[13],21,1309151649),s=i(s,a,u,c,t[4],6,-145523070),c=i(c,s,a,u,t[11],10,-1120210379),u=i(u,c,s,a,t[2],15,718787259),a=i(a,u,c,s,t[9],21,-343485551),e[0]=g(s,e[0]),e[1]=g(a,e[1]),e[2]=g(u,e[2]),e[3]=g(c,e[3])}function a(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function u(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function c(e){var t,n,r,o,i,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=c;t+=64)s(f,a(e.substring(t-64,t)));for(e=e.substring(t-64),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e.charCodeAt(t)<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(s(f,r),t=0;t<16;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),u=parseInt(o[1],16)||0,r[14]=i,r[15]=u,s(f,r),f}function f(e){var t,n,r,o,i,a,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=c;t+=64)s(f,u(e.subarray(t-64,t)));for(e=t-64<c?e.subarray(t-64):new Uint8Array(0),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e[t]<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(s(f,r),t=0;t<16;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),a=parseInt(o[1],16)||0,r[14]=i,r[15]=a,s(f,r),f}function l(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=b[e>>8*t+4&15]+b[e>>8*t&15];return n}function d(e){var t;for(t=0;t<e.length;t+=1)e[t]=l(e[t]);return e.join(\"\")}function p(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function h(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function v(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function y(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function _(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function m(){this.reset()}var g=function(e,t){return e+t&4294967295},b=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==d(c(\"hello\"))&&(g=function(e,t){var n=(65535&e)+(65535&t),r=(e>>16)+(t>>16)+(n>>16);return r<<16|65535&n}),\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||!function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,s,a,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),s=new Uint8Array(i),a=new Uint8Array(this,c,o),s.set(a),i)}}(),m.prototype.append=function(e){return this.appendBinary(p(e)),this},m.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var t,n=this._buff.length;for(t=64;t<=n;t+=64)s(this._hash,a(this._buff.substring(t-64,t)));return this._buff=this._buff.substring(t-64),this},m.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=_(n)),this.reset(),n},m.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},m.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},m.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},m.prototype._finish=function(e,t){var n,r,o,i=t;if(e[i>>2]|=128<<(i%4<<3),i>55)for(s(this._hash,e),i=0;i<16;i+=1)e[i]=0;n=8*this._length,n=n.toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(n[2],16),o=parseInt(n[1],16)||0,e[14]=r,e[15]=o,s(this._hash,e)},m.hash=function(e,t){return m.hashBinary(p(e),t)},m.hashBinary=function(e,t){var n=c(e),r=d(n);return t?_(r):r},m.ArrayBuffer=function(){this.reset()},m.ArrayBuffer.prototype.append=function(e){var t,n=y(this._buff.buffer,e,!0),r=n.length;for(this._length+=e.byteLength,t=64;t<=r;t+=64)s(this._hash,u(n.subarray(t-64,t)));return this._buff=t-64<r?new Uint8Array(n.buffer.slice(t-64)):new Uint8Array(0),this},m.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=_(n)),this.reset(),n},m.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.ArrayBuffer.prototype.getState=function(){var e=m.prototype.getState.call(this);return e.buff=v(e.buff),e},m.ArrayBuffer.prototype.setState=function(e){return e.buff=h(e.buff,!0),m.prototype.setState.call(this,e)},m.ArrayBuffer.prototype.destroy=m.prototype.destroy,m.ArrayBuffer.prototype._finish=m.prototype._finish,m.ArrayBuffer.hash=function(e,t){var n=f(new Uint8Array(e)),r=d(n);return t?_(r):r},m})},{}],38:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var s=t.pop();o[s]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,s,a,u,c,f,l,d,p=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",p+=o,i)p+=i;else if(\"object\"!=typeof r)p+=\"undefined\"==typeof r?null:JSON.stringify(r);else if(null===r)p+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),s=r.length-1;s>=0;s--)a=0===s?\"\":\",\",t.push({obj:r[s],prefix:a});t.push({val:\"[\"})}else{u=[];for(c in r)r.hasOwnProperty(c)&&u.push(c);for(t.push({val:\"}\"}),s=u.length-1;s>=0;s--)f=u[s],l=r[f],d=s>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return p},n.parse=function(e){for(var t,n,o,i,s,a,u,c,f,l=[],d=[],p=0;;)if(t=e[p++],\"}\"!==t&&\"]\"!==t&&\"undefined\"!=typeof t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":p+=3,r(null,l,d);break;case\"t\":p+=3,r(!0,l,d);break;case\"f\":p+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",p--;;){if(o=e[p++],!/[\\d\\.\\-e\\+]/.test(o)){p--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",s=void 0,a=0;;){if(u=e[p++],'\"'===u&&(\"\\\\\"!==s||a%2!==1))break;i+=u,s=u,\"\\\\\"===s?a++:a=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":c={element:[],index:l.length},l.push(c.element),d.push(c);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[1]);";
},{}],11:[function(_dereq_,module,exports){

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
  // is webkit? http://stackoverflow.com/a/16459606/376773
  return ('WebkitAppearance' in document.documentElement.style) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (window.console && (console.firebug || (console.exception && console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31);
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  return JSON.stringify(v);
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs() {
  var args = arguments;
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return args;

  var c = 'color: ' + this.color;
  args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
  return args;
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

function localstorage(){
  try {
    return window.localStorage;
  } catch (e) {}
}

},{"12":12}],12:[function(_dereq_,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = debug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = _dereq_(17);

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lowercased letter, i.e. "n".
 */

exports.formatters = {};

/**
 * Previously assigned color.
 */

var prevColor = 0;

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 *
 * @return {Number}
 * @api private
 */

function selectColor() {
  return exports.colors[prevColor++ % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function debug(namespace) {

  // define the `disabled` version
  function disabled() {
  }
  disabled.enabled = false;

  // define the `enabled` version
  function enabled() {

    var self = enabled;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // add the `color` if not set
    if (null == self.useColors) self.useColors = exports.useColors();
    if (null == self.color && self.useColors) self.color = selectColor();

    var args = Array.prototype.slice.call(arguments);

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %o
      args = ['%o'].concat(args);
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
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

    if ('function' === typeof exports.formatArgs) {
      args = exports.formatArgs.apply(self, args);
    }
    var logFn = enabled.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }
  enabled.enabled = true;

  var fn = exports.enabled(namespace) ? enabled : disabled;

  fn.namespace = namespace;

  return fn;
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

},{"17":17}],13:[function(_dereq_,module,exports){
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
  if (obj && typeof obj === 'object' && typeof then === 'function') {
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

},{"13":13}],17:[function(_dereq_,module,exports){
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
 * @param {Object} options
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options){
  options = options || {};
  if ('string' == typeof val) return parse(val);
  return options["long"]
    ? long(val)
    : short(val);
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = '' + str;
  if (str.length > 10000) return;
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
  if (!match) return;
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
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function short(ms) {
  if (ms >= d) return Math.round(ms / d) + 'd';
  if (ms >= h) return Math.round(ms / h) + 'h';
  if (ms >= m) return Math.round(ms / m) + 'm';
  if (ms >= s) return Math.round(ms / s) + 's';
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function long(ms) {
  return plural(ms, d, 'day')
    || plural(ms, h, 'hour')
    || plural(ms, m, 'minute')
    || plural(ms, s, 'second')
    || ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) return;
  if (ms < n * 1.5) return Math.floor(ms / n) + ' ' + name;
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],18:[function(_dereq_,module,exports){
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
},{}],19:[function(_dereq_,module,exports){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(_dereq_(16));

/* istanbul ignore next */
var PouchPromise = typeof Promise === 'function' ? Promise : lie;

module.exports = PouchPromise;
},{"16":16}],20:[function(_dereq_,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;

function drainQueue() {
    if (draining) {
        return;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        var i = -1;
        while (++i < len) {
            currentQueue[i]();
        }
        len = queue.length;
    }
    draining = false;
}
process.nextTick = function (fun) {
    queue.push(fun);
    if (!draining) {
        setTimeout(drainQueue, 0);
    }
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

// TODO(shtylman)
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