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
      worker.removeEventListener('message', workerListener);
      api.emit('destroyed');
      callback(null, res);
    });
  });

  api._instanceId = opts.originalName;
  api._callbacks = {};
  api._changesListeners = {};
  api._name = opts.originalName;

  worker.addEventListener('message', workerListener);

  var workerOpts = {
    name: api._name,
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
    var logArgs = [self._db_name, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = [self._db_name, name];
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
module.exports = "!function e(t,n,r){function o(a,s){if(!n[a]){if(!t[a]){var u=\"function\"==typeof require&&require;if(!s&&u)return u(a,!0);if(i)return i(a,!0);var c=new Error(\"Cannot find module '\"+a+\"'\");throw c.code=\"MODULE_NOT_FOUND\",c}var f=n[a]={exports:{}};t[a][0].call(f.exports,function(e){var n=t[a][1][e];return o(n?n:e)},f,f.exports,e,t,n,r)}return n[a].exports}for(var i=\"function\"==typeof require&&require,a=0;a<r.length;a++)o(r[a]);return o}({1:[function(e,t,n){\"use strict\";var r=e(3),o=e(4);r(self,o)},{3:3,4:4}],2:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}var o=e(12);o(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),a=r&&i.filter(function(e){var t=o[e];return t.message===r})[0]||i[0];return a?o[a]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,a,s=n;return r=e.error===!0&&\"string\"==typeof e.name?e.name:e.error,a=e.reason,o=s.getErrorTypeByProp(\"name\",r,a),e.missing||\"missing\"===a||\"deleted\"===a||\"not_found\"===r?o=s.MISSING_DOC:\"doc_validation\"===r?(o=s.DOC_VALIDATION,i=a):\"bad_request\"===r&&o.message!==a&&(0===a.indexOf(\"unknown stub attachment\")?(o=s.MISSING_STUB,i=a):o=s.BAD_REQUEST),o||(o=s.getErrorTypeByProp(\"status\",e.status,a)||s.UNKNOWN_ERROR),t=s.error(o,a,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],3:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){f(\" -> sendUncaughtError\",t,n),e.postMessage({type:\"uncaughtError\",id:t,content:a.createError(n)})}function r(t,n,r){f(\" -> sendError\",t,n,r),e.postMessage({type:\"error\",id:t,messageId:n,content:a.createError(r)})}function l(t,n,r){f(\" -> sendSuccess\",t,n),e.postMessage({type:\"success\",id:t,messageId:n,content:r})}function d(t,n,r){f(\" -> sendUpdate\",t,n),e.postMessage({type:\"update\",id:t,messageId:n,content:r})}function h(e,t,n,i){var a=u[\"$\"+e];return a?void o.resolve().then(function(){return a[t].apply(a,i)}).then(function(t){l(e,n,t)})[\"catch\"](function(t){r(e,n,t)}):r(e,n,{error:\"db not found\"})}function p(e,t,n){var r=n[0];r&&\"object\"==typeof r&&(r.returnDocs=!0,r.return_docs=!0),h(e,\"changes\",t,n)}function v(e,t,n){var a=u[\"$\"+e];return a?void o.resolve().then(function(){var r=n[0],o=n[1],s=n[2];return\"object\"!=typeof s&&(s={}),a.get(r,s).then(function(r){if(!r._attachments||!r._attachments[o])throw i.MISSING_DOC;return a.getAttachment.apply(a,n).then(function(n){l(e,t,n)})})})[\"catch\"](function(n){r(e,t,n)}):r(e,t,{error:\"db not found\"})}function y(e,t,n){var i=\"$\"+e,a=u[i];return a?(delete u[i],void o.resolve().then(function(){return a.destroy.apply(a,n)}).then(function(n){l(e,t,n)})[\"catch\"](function(n){r(e,t,n)})):r(e,t,{error:\"db not found\"})}function _(e,t,n){var i=u[\"$\"+e];return i?void o.resolve().then(function(){var o=i.changes(n[0]);c[t]=o,o.on(\"change\",function(n){d(e,t,n)}).on(\"complete\",function(n){o.removeAllListeners(),delete c[t],l(e,t,n)}).on(\"error\",function(n){o.removeAllListeners(),delete c[t],r(e,t,n)})}):r(e,t,{error:\"db not found\"})}function m(e){var t=c[e];t&&t.cancel()}function g(e,t){return o.resolve().then(function(){e.on(\"error\",function(e){n(t,e)})})}function b(e,n,o){var i=\"$\"+e,a=u[i];if(a)return g(a,e).then(function(){return l(e,n,{ok:!0,exists:!0})});var s=\"string\"==typeof o[0]?o[0]:o[0].name;return s?(a=u[i]=t(o[0]),void g(a,e).then(function(){l(e,n,{ok:!0})})[\"catch\"](function(t){r(e,n,t)})):r(e,n,{error:\"you must provide a database name\"})}function w(e,t,n,o){switch(f(\"onReceiveMessage\",t,e,n,o),t){case\"createDatabase\":return b(e,n,o);case\"id\":return void l(e,n,e);case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return h(e,t,n,o);case\"changes\":return p(e,n,o);case\"getAttachment\":return v(e,n,o);case\"liveChanges\":return _(e,n,o);case\"cancelChanges\":return m(n);case\"destroy\":return y(e,n,o);default:return r(e,n,{error:\"unknown API method: \"+t})}}function k(e,t){var n=e.type,r=e.messageId,o=s(e.args);w(t,n,r,o)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete u[\"$\"+t]):k(e.data,t)}})}var o=e(33),i=e(2),a=e(6),s=a.decodeArgs,u={},c={},f=e(8)(\"pouchdb:worker\");t.exports=r},{2:2,33:33,6:6,8:8}],4:[function(e,t,n){\"use strict\";t.exports=e(25).plugin(e(17)).plugin(e(16)).plugin(e(30)).plugin(e(34))},{16:16,17:17,25:25,30:30,34:34}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){function r(){return\"WebkitAppearance\"in document.documentElement.style||window.console&&(console.firebug||console.exception&&console.table)||navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31}function o(){var e=arguments,t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),!t)return e;var r=\"color: \"+this.color;e=[e[0],r,\"color: inherit\"].concat(Array.prototype.slice.call(e,1));var o=0,i=0;return e[0].replace(/%[a-z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r),e}function i(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(t){}}function s(){var e;try{e=n.storage.debug}catch(t){}return e}function u(){try{return window.localStorage}catch(e){}}n=t.exports=e(9),n.log=i,n.formatArgs=o,n.save=a,n.load=s,n.useColors=r,n.storage=\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage?chrome.storage.local:u(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){return JSON.stringify(e)},n.enable(s())},{9:9}],9:[function(e,t,n){function r(){return n.colors[f++%n.colors.length]}function o(e){function t(){}function o(){var e=o,t=+new Date,i=t-(c||t);e.diff=i,e.prev=c,e.curr=t,c=t,null==e.useColors&&(e.useColors=n.useColors()),null==e.color&&e.useColors&&(e.color=r());var a=Array.prototype.slice.call(arguments);a[0]=n.coerce(a[0]),\"string\"!=typeof a[0]&&(a=[\"%o\"].concat(a));var s=0;a[0]=a[0].replace(/%([a-z%])/g,function(t,r){if(\"%%\"===t)return t;s++;var o=n.formatters[r];if(\"function\"==typeof o){var i=a[s];t=o.call(e,i),a.splice(s,1),s--}return t}),\"function\"==typeof n.formatArgs&&(a=n.formatArgs.apply(e,a));var u=o.log||n.log||console.log.bind(console);u.apply(e,a)}t.enabled=!1,o.enabled=!0;var i=n.enabled(e)?o:t;return i.namespace=e,i}function i(e){n.save(e);for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;r>o;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function a(){n.enable(\"\")}function s(e){var t,r;for(t=0,r=n.skips.length;r>t;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;r>t;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o,n.coerce=u,n.disable=a,n.enable=i,n.enabled=s,n.humanize=e(15),n.names=[],n.skips=[],n.formatters={};var c,f=0},{15:15}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function a(e){return\"object\"==typeof e&&null!==e}function s(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||0>e||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,u,c;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||a(this._events.error)&&!this._events.error.length)){if(t=arguments[1],t instanceof Error)throw t;throw TypeError('Uncaught, unspecified \"error\" event.')}if(n=this._events[e],s(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:for(r=arguments.length,i=new Array(r-1),u=1;r>u;u++)i[u-1]=arguments[u];n.apply(this,i)}else if(a(n)){for(r=arguments.length,i=new Array(r-1),u=1;r>u;u++)i[u-1]=arguments[u];for(c=n.slice(),r=c.length,u=0;r>u;u++)c[u].apply(this,i)}return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");if(this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?a(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,a(this._events[e])&&!this._events[e].warned){var n;n=s(this._maxListeners)?r.defaultMaxListeners:this._maxListeners,n&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace())}return this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,s;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(a(n)){for(s=i;s-- >0;)if(n[s]===t||n[s].listener&&n[s].listener===t){r=s;break}if(0>r)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){var t;return t=this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.listenerCount=function(e,t){var n;return n=e._events&&e._events[t]?o(e._events[t])?1:e._events[t].length:0}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var a=0,s=new i(n),u=e.document.createTextNode(\"\");s.observe(u,{characterData:!0}),o=function(){u.data=a=++a%2}}else if(e.setImmediate||\"undefined\"==typeof e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var c=new e.MessageChannel;c.port1.onmessage=n,o=function(){c.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){(function(e){e(\"object\"==typeof n?n:this)}).call(this,function(e){var t=Array.prototype.slice,n=Array.prototype.forEach,r=function(e){if(\"object\"!=typeof e)throw e+\" is not an object\";var o=t.call(arguments,1);return n.call(o,function(t){if(t)for(var n in t)\"object\"==typeof t[n]&&e[n]?r.call(e,e[n],t[n]):e[n]=t[n]}),e};e.extend=r})},{}],14:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function a(e,t,n){p(function(){var r;try{r=t(n)}catch(o){return v.reject(e,o)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function s(e){var t=e&&e.then;return e&&\"object\"==typeof e&&\"function\"==typeof t?function(){t.apply(e,arguments)}:void 0}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,a=c(o);\"error\"===a.status&&n(a.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(r){n.status=\"error\",n.value=r}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){function t(e,t){function r(e){a[t]=e,++s!==o||i||(i=!0,v.resolve(c,a))}n.resolve(e).then(r,function(e){i||(i=!0,v.reject(c,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,i=!1;if(!o)return this.resolve([]);for(var a=new Array(o),s=0,u=-1,c=new this(r);++u<o;)t(e[u],u);return c}function h(e){function t(e){n.resolve(e).then(function(e){i||(i=!0,v.resolve(s,e))},function(e){i||(i=!0,v.reject(s,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,i=!1;if(!o)return this.resolve([]);for(var a=-1,s=new this(r);++a<o;)t(e[a]);return s}var p=e(11),v={},y=[\"REJECTED\"],_=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype[\"catch\"]=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===_||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){var o=this.state===_?e:t;a(n,o,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){a(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){a(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(s,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=_,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],15:[function(e,t,n){function r(e){if(e=\"\"+e,!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]),r=(t[2]||\"ms\").toLowerCase();switch(r){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*s;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=s?Math.round(e/s)+\"s\":e+\"ms\"}function i(e){return a(e,f,\"day\")||a(e,c,\"hour\")||a(e,u,\"minute\")||a(e,s,\"second\")||e+\" ms\"}function a(e,t,n){return t>e?void 0:1.5*t>e?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var s=1e3,u=60*s,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){return t=t||{},\"string\"==typeof e?r(e):t[\"long\"]?i(e):o(e)}},{}],16:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];n.data=m.base64StringToBlobOrBuffer(n.data,n.content_type)})}function i(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function a(e){return e._attachments&&Object.keys(e._attachments)?p.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];return n.data&&\"string\"!=typeof n.data?new p(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e}):void 0})):p.resolve()}function s(e){var t=_.parseUri(e);(t.user||t.password)&&(t.auth={username:t.user,password:t.password});var n=t.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return t.db=n.pop(),-1===t.db.indexOf(\"%\")&&(t.db=encodeURIComponent(t.db)),t.path=n.join(\"/\"),t}function u(e,t){return c(e,e.db+\"/\"+t)}function c(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function f(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function l(e,t){function n(e,t,n){var r=e.ajax||{},o=h.extend(_.clone(x),r,t);return O(o.method+\" \"+o.url),A._ajax(o,n)}function r(e,t){return new p(function(r,o){n(e,t,function(e,t){return e?o(e):void r(t)})})}function l(e,t){return _.adapterFun(e,y(function(e){d().then(function(){return t.apply(this,e)})[\"catch\"](function(t){var n=e.pop();n(t)})}))}function d(){if(e.skipSetup||e.skip_setup)return p.resolve();if(L)return L;var t={method:\"GET\",url:j};return L=r({},t)[\"catch\"](function(e){return e&&e.status&&404===e.status?(_.explainError(404,\"PouchDB is just detecting if the remote exists.\"),r({},{method:\"PUT\",url:j})):p.reject(e)})[\"catch\"](function(e){return e&&e.status&&412===e.status?!0:p.reject(e)}),L[\"catch\"](function(){L=null}),L}function b(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}var A=this,I=s;e.getHost&&(I=e.getHost);var D=I(e.name,e),j=u(D,\"\");e=_.clone(e);var x=e.ajax||{};if(A.getUrl=function(){return j},A.getHeaders=function(){return x.headers||{}},e.auth||D.auth){var C=e.auth||D.auth,q=C.username+\":\"+C.password,R=m.btoa(unescape(encodeURIComponent(q)));x.headers=x.headers||{},x.headers.Authorization=\"Basic \"+R}A._ajax=v;var L;setTimeout(function(){t(null,A)}),A.type=function(){return\"http\"},A.id=l(\"id\",function(e){n({},{method:\"GET\",url:c(D,\"\")},function(t,n){var r=n&&n.uuid?n.uuid+D.db:u(D,\"\");e(null,r)})}),A.request=l(\"request\",function(e,t){e.url=u(D,e.url),n({},e,t)}),A.compact=l(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=_.clone(e),n(e,{url:u(D,\"_compact\"),method:\"POST\"},function(){function n(){A.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0}):setTimeout(n,e.interval||200)})}n()})}),A.bulkGet=_.adapterFun(\"bulkGet\",function(e,t){function r(t){var r={};e.revs&&(r.revs=!0),e.attachments&&(r.attachments=!0),n({},{url:u(D,\"_bulk_get\"+f(r)),method:\"POST\",body:{docs:e.docs}},t)}function o(){function n(e){return function(n,r){s[e]=r.results,++a===o&&t(null,{results:_.flatten(s)})}}for(var r=k,o=Math.ceil(e.docs.length/r),a=0,s=new Array(o),u=0;o>u;u++){var c=_.pick(e,[\"revs\",\"attachments\"]);c.ajax=x,c.docs=e.docs.slice(u*r,Math.min(e.docs.length,(u+1)*r)),_.bulkGetShim(i,c,n(u))}}var i=this,a=c(D,\"\"),s=E[a];\"boolean\"!=typeof s?r(function(e,n){if(e){var r=Math.floor(e.status/100);4===r||5===r?(E[a]=!1,_.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),o()):t(e)}else E[a]=!0,t(null,n)}):s?r(t):o()}),A._info=function(e){d().then(function(){n({},{method:\"GET\",url:u(D,\"\")},function(t,n){return t?e(t):(n.host=u(D,\"\"),void e(null,n))})})[\"catch\"](e)},A.get=l(\"get\",function(e,t,n){function o(e){var n=e._attachments,o=n&&Object.keys(n);return n&&o.length?p.all(o.map(function(o){var a=n[o],s=i(e._id)+\"/\"+b(o)+\"?rev=\"+e._rev;return r(t,{method:\"GET\",url:u(D,s),binary:!0}).then(function(e){return t.binary?e:new p(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete a.stub,delete a.length,a.data=e})})):void 0}function a(e){return Array.isArray(e)?p.all(e.map(function(e){return e.ok?o(e.ok):void 0})):o(e)}\"function\"==typeof t&&(n=t,t={}),t=_.clone(t);var s={};t.revs&&(s.revs=!0),t.revs_info&&(s.revs_info=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),s.open_revs=t.open_revs),t.rev&&(s.rev=t.rev),t.conflicts&&(s.conflicts=t.conflicts),e=i(e);var c={method:\"GET\",url:u(D,e+f(s))};r(t,c).then(function(e){return p.resolve().then(function(){return t.attachments?a(e):void 0}).then(function(){n(null,e)})})[\"catch\"](n)}),A.remove=l(\"remove\",function(e,t,r,o){var a;\"string\"==typeof t?(a={_id:e,_rev:t},\"function\"==typeof r&&(o=r,r={})):(a=e,\"function\"==typeof t?(o=t,r={}):(o=r,r=t));var s=a._rev||r.rev;n(r,{method:\"DELETE\",url:u(D,i(a._id))+\"?rev=\"+s},o)}),A.getAttachment=l(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var a=r.rev?\"?rev=\"+r.rev:\"\",s=u(D,i(e))+\"/\"+b(t)+a;n(r,{method:\"GET\",url:s,binary:!0},o)}),A.removeAttachment=l(\"removeAttachment\",function(e,t,r,o){var a=u(D,i(e)+\"/\"+b(t))+\"?rev=\"+r;n({},{method:\"DELETE\",url:a},o)}),A.putAttachment=l(\"putAttachment\",function(e,t,r,o,a,s){\"function\"==typeof a&&(s=a,a=o,o=r,r=null);var c=i(e)+\"/\"+b(t),f=u(D,c);if(r&&(f+=\"?rev=\"+r),\"string\"==typeof o){var l;try{l=m.atob(o)}catch(d){return s(g.createError(g.BAD_ARG,\"Attachment is not a valid base64 string\"))}o=l?m.binaryStringToBlobOrBuffer(l,a):\"\"}var h={headers:{\"Content-Type\":a},method:\"PUT\",url:f,processData:!1,body:o,timeout:x.timeout||6e4};n({},h,s)}),A._bulkDocs=function(e,t,r){e.new_edits=t.new_edits,d().then(function(){return p.all(e.docs.map(a))}).then(function(){n(t,{method:\"POST\",url:u(D,\"_bulk_docs\"),body:e},function(e,t){return e?r(e):(t.forEach(function(e){e.ok=!0}),void r(null,t))})})[\"catch\"](r)},A.allDocs=l(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=_.clone(e);var n,i={},a=\"GET\";e.conflicts&&(i.conflicts=!0),e.descending&&(i.descending=!0),e.include_docs&&(i.include_docs=!0),e.attachments&&(i.attachments=!0),e.key&&(i.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(i.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(i.endkey=JSON.stringify(e.endkey)),\"undefined\"!=typeof e.inclusive_end&&(i.inclusive_end=!!e.inclusive_end),\"undefined\"!=typeof e.limit&&(i.limit=e.limit),\"undefined\"!=typeof e.skip&&(i.skip=e.skip);var s=f(i);if(\"undefined\"!=typeof e.keys){var c=\"keys=\"+encodeURIComponent(JSON.stringify(e.keys));c.length+s.length+1<=S?s+=\"&\"+c:(a=\"POST\",n={keys:e.keys})}r(e,{method:a,url:u(D,\"_all_docs\"+s),body:n}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.rows.forEach(o),t(null,n)})[\"catch\"](t)}),A._changes=function(e){var t=\"batch_size\"in e?e.batch_size:w;e=_.clone(e),e.timeout=\"timeout\"in e?e.timeout:\"timeout\"in x?x.timeout:3e4;var r,i=e.timeout?{timeout:e.timeout-5e3}:{},a=\"undefined\"!=typeof e.limit?e.limit:!1;r=\"return_docs\"in e?e.return_docs:\"returnDocs\"in e?e.returnDocs:!0;var s=a;if(e.style&&(i.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(i.include_docs=!0),e.attachments&&(i.attachments=!0),e.continuous&&(i.feed=\"longpoll\"),e.conflicts&&(i.conflicts=!0),e.descending&&(i.descending=!0),\"heartbeat\"in e?e.heartbeat&&(i.heartbeat=e.heartbeat):i.heartbeat=1e4,e.filter&&\"string\"==typeof e.filter&&(i.filter=e.filter),e.view&&\"string\"==typeof e.view&&(i.filter=\"_view\",i.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var c in e.query_params)e.query_params.hasOwnProperty(c)&&(i[c]=e.query_params[c]);var l,h=\"GET\";if(e.doc_ids){i.filter=\"_doc_ids\";var p=JSON.stringify(e.doc_ids);p.length<S?i.doc_ids=p:(h=\"POST\",l={doc_ids:e.doc_ids})}var v,y,m=function(r,o){if(!e.aborted){i.since=r,\"object\"==typeof i.since&&(i.since=JSON.stringify(i.since)),e.descending?a&&(i.limit=s):i.limit=!a||s>t?t:s;var c={method:h,url:u(D,\"_changes\"+f(i)),timeout:e.timeout,body:l};y=r,e.aborted||d().then(function(){v=n(e,c,o)})[\"catch\"](o)}},g={results:[]},b=function(n,i){if(!e.aborted){var u=0;if(i&&i.results){u=i.results.length,g.last_seq=i.last_seq;var c={};c.query=e.query_params,i.results=i.results.filter(function(t){s--;var n=_.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&o(t),r&&g.results.push(t),e.onChange(t)),n})}else if(n)return e.aborted=!0,void e.complete(n);i&&i.last_seq&&(y=i.last_seq);var f=a&&0>=s||i&&t>u||e.descending;(!e.continuous||a&&0>=s)&&f?e.complete(null,g):setTimeout(function(){m(y,b)},0)}};return m(e.since||0,b),{cancel:function(){e.aborted=!0,v&&v.abort()}}},A.revsDiff=l(\"revsDiff\",function(e,t,r){\"function\"==typeof t&&(r=t,t={}),n(t,{method:\"POST\",url:u(D,\"_revs_diff\"),body:e},r)}),A._close=function(e){e()},A._destroy=function(e,t){n(e,{url:u(D,\"\"),method:\"DELETE\"},function(e,n){return e&&e.status&&404!==e.status?t(e):void t(null,n)})}}function d(e){e.adapter(\"http\",l,!1),e.adapter(\"https\",l,!1)}var h=e(13),p=r(e(33)),v=r(e(19)),y=r(e(7)),_=e(35),m=e(20),g=e(26),b=r(e(8)),w=25,k=50,E={},S=1800,O=b(\"pouchdb:http\");l.valid=function(){return!0},t.exports=d},{13:13,19:19,20:20,26:26,33:33,35:35,7:7,8:8}],17:[function(e,t,n){(function(n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e,t,n,r){try{e.apply(t,n)}catch(o){r.emit(\"error\",o)}}function i(e){if(!G.running&&G.queue.length){G.running=!0;var t=G.queue.shift();t.action(function(r,a){o(t.callback,this,[r,a],e),G.running=!1,n.nextTick(function(){i(e)})})}}function a(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(D.createError(D.IDB_ERROR,n,t.type))}}function s(e,t,n){return{data:q.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function u(e){if(!e)return null;var t=q.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function c(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function f(e,t,n,r){n?r(e?\"string\"!=typeof e?e:R.base64StringToBlobOrBuffer(e,t):R.blob([\"\"],{type:t})):e?\"string\"!=typeof e?R.readAsBinaryString(e,function(e){r(R.btoa(e))}):r(e):r(\"\")}function l(e,t,n,r){function o(){++s===a.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest,a=n.objectStore(N).get(i);a.onsuccess=function(e){r.body=e.target.result.body,o()}}var a=Object.keys(e._attachments||{});if(!a.length)return r&&r();var s=0;a.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function d(e,t){return C.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return C.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new C(function(a){f(o,i,t,function(t){e.doc._attachments[n]=x.extend(O.pick(r,[\"digest\",\"content_type\"]),{data:t}),a()})})}}))}}))}function h(e,t,n){function r(){c--,c||o()}function o(){i.length&&i.forEach(function(e){var t=u.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1));t.onsuccess=function(t){var n=t.target.result;n||s[\"delete\"](e)}})}var i=[],a=n.objectStore(B),s=n.objectStore(N),u=n.objectStore(M),c=e.length;e.forEach(function(e){var n=a.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();a[\"delete\"](t);var n=u.index(\"seq\").openCursor(IDBKeyRange.only(t));n.onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),u[\"delete\"](t.primaryKey),t[\"continue\"]()}else r()}}})}function p(e,t,n){try{return{txn:e.transaction(t,n)}}catch(r){return{error:r}}}function v(e,t,n,r,o,i,c){function f(){var e=[T,B,N,P,M],t=p(o,e,\"readwrite\");return t.error?c(t.error):(E=t.txn,E.onabort=a(c),E.ontimeout=a(c),E.oncomplete=v,S=E.objectStore(T),O=E.objectStore(B),x=E.objectStore(N),C=E.objectStore(M),void _(function(e){return e?(J=!0,c(e)):void d()}))}function l(){j.processDocs(e.revs_limit,R,r,K,E,V,m,n);\n}function d(){function e(){++n===R.length&&l()}function t(t){var n=u(t.target.result);n&&K.set(n.id,n),e()}if(R.length)for(var n=0,r=0,o=R.length;o>r;r++){var i=R[r];if(i._id&&j.isLocalId(i._id))e();else{var a=S.get(i.metadata.id);a.onsuccess=t}}}function v(){J||(i.notify(r._meta.name),r._meta.docCount+=L,c(null,V))}function y(e,t){var n=x.get(e);n.onsuccess=function(n){if(n.target.result)t();else{var r=D.createError(D.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function _(e){function t(){++o===n.length&&e(r)}var n=[];if(R.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){y(e,function(e){e&&!r&&(r=e),t()})})}function m(e,t,n,r,o,i,a,s){L+=i,e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0);var c=u._attachments&&Object.keys(u._attachments).length;return c?b(e,t,n,o,a,s):void g(e,t,n,o,a,s)}function g(e,t,n,o,i,a){function u(i){var a=e.stemmedRevs||[];o&&r.auto_compaction&&(a=a.concat(A.compactTree(e.metadata))),a&&a.length&&h(a,e.metadata.id,E),d.seq=i.target.result,delete d.rev;var u=s(d,t,n),c=S.put(u);c.onsuccess=f}function c(e){e.preventDefault(),e.stopPropagation();var t=O.index(\"_doc_id_rev\"),n=t.getKey(l._doc_id_rev);n.onsuccess=function(e){var t=O.put(l,e.target.result);t.onsuccess=u}}function f(){V[i]={ok:!0,id:d.id,rev:t},K.set(e.metadata.id,e.metadata),w(e,d.seq,a)}var l=e.data,d=e.metadata;l._doc_id_rev=d.id+\"::\"+d.rev,delete l._id,delete l._rev;var p=O.put(l);p.onsuccess=u,p.onerror=c}function b(e,t,n,r,o,i){function a(){c===f.length&&g(e,t,n,r,o,i)}function s(){c++,a()}var u=e.data,c=0,f=Object.keys(u._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)c++,a();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);var i=r.digest;k(i,o,s)}})}function w(e,t,n){function r(){++i===a.length&&n()}function o(n){var o=e.data._attachments[n].digest,i=C.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}var i=0,a=Object.keys(e.data._attachments||{});if(!a.length)return n();for(var s=0;s<a.length;s++)o(a[s])}function k(e,t,n){var r=x.count(e);r.onsuccess=function(r){var o=r.target.result;if(o)return n();var i={digest:e,body:t},a=x.put(i);a.onsuccess=n}}for(var E,S,O,x,C,q,R=t.docs,L=0,F=0,U=R.length;U>F;F++){var G=R[F];G._id&&j.isLocalId(G._id)||(G=R[F]=j.parseDoc(G,n.new_edits),G.error&&!q&&(q=G))}if(q)return c(q);var V=new Array(R.length),K=new I.Map,J=!1,z=r._meta.blobSupport?\"blob\":\"base64\";j.preprocessAttachments(R,z,function(e){return e?c(e):void f()})}function y(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(i){return{error:i}}return null}function _(e,t,n,r){return\"DataError\"===n.name&&0===n.code?r(null,{total_rows:e._meta.docCount,offset:t.skip,rows:[]}):void r(D.createError(D.IDB_ERROR,n.name,n.message))}function m(e,t,n,r){function o(e,r){function o(t,n,r){var o=t.id+\"::\"+r;C.get(o).onsuccess=function(r){n.doc=c(r.target.result),e.conflicts&&(n.doc._conflicts=A.collectConflicts(t)),l(n.doc,e,I)}}function i(t,n,r){var i={id:r.id,key:r.id,value:{rev:n}},a=r.deleted;if(\"ok\"===e.deleted)q.push(i),a?(i.value.deleted=!0,i.doc=null):e.include_docs&&o(r,i,n);else if(!a&&g--<=0&&(q.push(i),e.include_docs&&o(r,i,n),0===--b))return;t[\"continue\"]()}function a(e){R=t._meta.docCount;var n=e.target.result;if(n){var r=u(n.value),o=r.winningRev;i(n,o,r)}}function s(){r(null,{total_rows:R,offset:e.skip,rows:q})}function f(){e.attachments?d(q,e.binary).then(s):s()}var h=\"startkey\"in e?e.startkey:!1,v=\"endkey\"in e?e.endkey:!1,m=\"key\"in e?e.key:!1,g=e.skip||0,b=\"number\"==typeof e.limit?e.limit:-1,w=e.inclusive_end!==!1,k=\"descending\"in e&&e.descending?\"prev\":null,E=y(h,v,w,m,k);if(E&&E.error)return _(t,e,E.error,r);var S=[T,B];e.attachments&&S.push(N);var O=p(n,S,\"readonly\");if(O.error)return r(O.error);var I=O.txn,D=I.objectStore(T),j=I.objectStore(B),x=k?D.openCursor(E,k):D.openCursor(E),C=j.index(\"_doc_id_rev\"),q=[],R=0;I.oncomplete=f,x.onsuccess=a}function i(e,n){return 0===e.limit?n(null,{total_rows:t._meta.docCount,offset:e.skip,rows:[]}):void o(e,n)}i(e,r)}function g(e){return new C(function(t){var n=R.blob([\"\"]);e.objectStore(U).put(n,\"key\"),e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)},e.oncomplete=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)}})[\"catch\"](function(){return!1})}function b(e,t){var n=this;G.queue.push({action:function(t){w(n,e,t)},callback:t}),i(n.constructor)}function w(e,t,r){function o(e){var t=e.createObjectStore(T,{keyPath:\"id\"});e.createObjectStore(B,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(N,{keyPath:\"digest\"}),e.createObjectStore(F,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(U),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(P,{keyPath:\"_id\"});var n=e.createObjectStore(M,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function i(e,t){var n=e.objectStore(T);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=A.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r[\"continue\"]()}else t()}}function y(e){e.createObjectStore(P,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function _(e,t){var n=e.objectStore(P),r=e.objectStore(T),o=e.objectStore(B),i=r.openCursor();i.onsuccess=function(e){var i=e.target.result;if(i){var a=i.value,s=a.id,u=A.isLocalId(s),c=A.winningRev(a);if(u){var f=s+\"::\"+c,l=s+\"::\",d=s+\"::~\",h=o.index(\"_doc_id_rev\"),p=IDBKeyRange.bound(l,d,!1,!1),v=h.openCursor(p);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o[\"delete\"](v.primaryKey),v[\"continue\"]()}else r[\"delete\"](i.primaryKey),i[\"continue\"]()}}else i[\"continue\"]()}else t&&t()}}function b(e){var t=e.createObjectStore(M,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function w(e,t){var n=e.objectStore(B),r=e.objectStore(N),o=e.objectStore(M),i=r.count();i.onsuccess=function(e){var r=e.target.result;return r?void(n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,a=Object.keys(r._attachments||{}),s={},u=0;u<a.length;u++){var c=r._attachments[a[u]];s[c.digest]=!0}var f=Object.keys(s);for(u=0;u<f.length;u++){var l=f[u];o.put({seq:i,digestSeq:l+\"::\"+i})}n[\"continue\"]()}):t()}}function E(e){function t(e){return e.data?u(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(B),r=e.objectStore(T),o=r.openCursor();o.onsuccess=function(e){function o(){var e=u.id+\"::\",t=u.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return u.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t[\"continue\"]()}}function i(){var e=s(u,u.winningRev,u.deleted),t=r.put(e);t.onsuccess=function(){a[\"continue\"]()}}var a=e.target.result;if(a){var u=t(a.value);return u.winningRev=u.winningRev||A.winningRev(u),u.seq?i():void o()}}}var j=t.name,x=null;e._meta=null,e.type=function(){return\"idb\"},e._id=O.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){v(t,n,r,e,x,K,o)},e._get=function(e,t,n){function r(){n(a,{doc:o,metadata:i,ctx:s})}var o,i,a,s=t.ctx;if(!s){var f=p(x,[T,B,N],\"readonly\");if(f.error)return n(f.error);s=f.txn}s.objectStore(T).get(e).onsuccess=function(e){if(i=u(e.target.result),!i)return a=D.createError(D.MISSING_DOC,\"missing\"),r();if(A.isDeleted(i)&&!t.rev)return a=D.createError(D.MISSING_DOC,\"deleted\"),r();var n=s.objectStore(B),f=t.rev||i.winningRev,l=i.id+\"::\"+f;n.index(\"_doc_id_rev\").get(l).onsuccess=function(e){return o=e.target.result,o&&(o=c(o)),o?void r():(a=D.createError(D.MISSING_DOC,\"missing\"),r())}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var a=p(x,[T,B,N],\"readonly\");if(a.error)return o(a.error);i=a.txn}var s=n.digest,u=n.content_type;i.objectStore(N).get(s).onsuccess=function(e){var t=e.target.result.body;f(t,u,r.binary,function(e){o(null,e)})}},e._info=function(t){if(null===x||!V.has(j)){var n=new Error(\"db isn't open\");return n.id=\"idbNull\",t(n)}var r,o,i=p(x,[B],\"readonly\");if(i.error)return t(i.error);var a=i.txn,s=a.objectStore(B).openCursor(null,\"prev\");s.onsuccess=function(t){var n=t.target.result;r=n?n.key:0,o=e._meta.docCount},a.oncomplete=function(){t(null,{doc_count:o,update_seq:r,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(t,n){m(t,e,x,n)},e._changes=function(t){function n(e){function n(){return s.seq!==a?e[\"continue\"]():(h=a,s.winningRev===i._rev?o(i):void r())}function r(){var e=i._id+\"::\"+s.winningRev,t=b.get(e);t.onsuccess=function(e){o(c(e.target.result))}}function o(n){var r=t.processChange(n,s,t);r.seq=s.seq;var o=E(r);return\"object\"==typeof o?t.complete(o):(o&&(k++,y&&w.push(r),t.attachments&&t.include_docs?l(n,t,_,function(){d([r],t.binary).then(function(){t.onChange(r)})}):t.onChange(r)),void(k!==v&&e[\"continue\"]()))}var i=c(e.value),a=e.key;if(f&&!f.has(i._id))return e[\"continue\"]();var s;return(s=S.get(i._id))?n():void(g.get(i._id).onsuccess=function(e){s=u(e.target.result),S.set(i._id,s),n()})}function r(e){var t=e.target.result;t&&n(t)}function o(){var e=[T,B];t.attachments&&e.push(N);var n=p(x,e,\"readonly\");if(n.error)return t.complete(n.error);_=n.txn,_.onabort=a(t.complete),_.oncomplete=i,m=_.objectStore(B),g=_.objectStore(T),b=m.index(\"_doc_id_rev\");var o;o=t.descending?m.openCursor(null,\"prev\"):m.openCursor(IDBKeyRange.lowerBound(t.since,!0)),o.onsuccess=r}function i(){function e(){t.complete(null,{results:w,last_seq:h})}!t.continuous&&t.attachments?d(w).then(e):e()}if(t=O.clone(t),t.continuous){var s=j+\":\"+O.uuid();return K.addListener(j,s,e,t),K.notify(j),{cancel:function(){K.removeListener(j,s)}}}var f=t.doc_ids&&new I.Set(t.doc_ids);t.since=t.since||0;var h=t.since,v=\"limit\"in t?t.limit:-1;0===v&&(v=1);var y;y=\"return_docs\"in t?t.return_docs:\"returnDocs\"in t?t.returnDocs:!0;var _,m,g,b,w=[],k=0,E=O.filterChange(t),S=new I.Map;o()},e._close=function(e){return null===x?e(D.createError(D.NOT_OPEN)):(x.close(),V[\"delete\"](j),x=null,void e())},e._getRevisionTree=function(e,t){var n=p(x,[T],\"readonly\");if(n.error)return t(n.error);var r=n.txn,o=r.objectStore(T).get(e);o.onsuccess=function(e){var n=u(e.target.result);n?t(null,n.rev_tree):t(D.createError(D.MISSING_DOC))}},e._doCompaction=function(e,t,n){var r=[T,B,N,M],o=p(x,r,\"readwrite\");if(o.error)return n(o.error);var i=o.txn,c=i.objectStore(T);c.get(e).onsuccess=function(n){var r=u(n.target.result);A.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var a=n+\"-\"+r;-1!==t.indexOf(a)&&(i.status=\"missing\")}),h(t,e,i);var o=r.winningRev,a=r.deleted;i.objectStore(T).put(s(r,o,a))},i.onabort=a(n),i.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=p(x,[P],\"readonly\");if(n.error)return t(n.error);var r=n.txn,o=r.objectStore(P).get(e);o.onerror=a(t),o.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(D.createError(D.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var r=e._rev,o=e._id;r?e._rev=\"0-\"+(parseInt(r.split(\"-\")[1],10)+1):e._rev=\"0-1\";var i,s=t.ctx;if(!s){var u=p(x,[P],\"readwrite\");if(u.error)return n(u.error);s=u.txn,s.onerror=a(n),s.oncomplete=function(){i&&n(null,i)}}var c,f=s.objectStore(P);r?(c=f.get(o),c.onsuccess=function(o){var a=o.target.result;if(a&&a._rev===r){var s=f.put(e);s.onsuccess=function(){i={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,i)}}else n(D.createError(D.REV_CONFLICT))}):(c=f.add(e),c.onerror=function(e){n(D.createError(D.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},c.onsuccess=function(){i={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,i)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var r=t.ctx;if(!r){var o=p(x,[P],\"readwrite\");if(o.error)return n(o.error);r=o.txn,r.oncomplete=function(){i&&n(null,i)}}var i,s=e._id,u=r.objectStore(P),c=u.get(s);c.onerror=a(n),c.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(u[\"delete\"](s),i={ok:!0,id:s,rev:\"0-0\"},t.ctx&&n(null,i)):n(D.createError(D.MISSING_DOC))}},e._destroy=function(e,t){K.removeAllListeners(j);var n=J.get(j);n&&n.result&&(n.result.close(),V[\"delete\"](j));var r=indexedDB.deleteDatabase(j);r.onsuccess=function(){J[\"delete\"](j),O.hasLocalStorage()&&j in localStorage&&delete localStorage[j],t(null,{ok:!0})},r.onerror=a(t)};var C=V.get(j);if(C)return x=C.idb,e._meta=C.global,void n.nextTick(function(){r(null,e)});var q;q=t.storage?k(j,t.storage):indexedDB.open(j,L),J.set(j,q),q.onupgradeneeded=function(e){function t(){var e=a[s-1];s++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return o(n);var r=e.currentTarget.transaction;e.oldVersion<3&&y(n),e.oldVersion<4&&b(n);var a=[i,_,w,E],s=e.oldVersion;t()},q.onsuccess=function(t){x=t.target.result,x.onversionchange=function(){x.close(),V[\"delete\"](j)},x.onabort=function(e){O.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),x.close(),V[\"delete\"](j)};var n=x.transaction([F,U,T],\"readwrite\"),o=n.objectStore(F).get(F),i=null,a=null,s=null;o.onsuccess=function(t){var o=function(){null!==i&&null!==a&&null!==s&&(e._meta={name:j,instanceId:s,blobSupport:i,docCount:a},V.set(j,{idb:x,global:e._meta}),r(null,e))},u=t.target.result||{id:F};j+\"_id\"in u?(s=u[j+\"_id\"],o()):(s=O.uuid(),u[j+\"_id\"]=s,n.objectStore(F).put(u).onsuccess=function(){o()}),S||(S=g(n)),S.then(function(e){i=e,o()});var c=n.objectStore(T).index(\"deletedOrLocal\");c.count(IDBKeyRange.only(\"0\")).onsuccess=function(e){a=e.target.result,o()}}},q.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";O.guardedConsole(\"error\",e),r(D.createError(D.IDB_ERROR,e))}}function k(e,t){try{return indexedDB.open(e,{version:L,storage:t})}catch(n){return indexedDB.open(e,L)}}function E(e){e.adapter(\"idb\",b,!0)}var S,O=e(35),A=e(32),I=e(24),D=e(26),j=e(18),x=e(13),C=r(e(33)),q=e(28),R=e(20),L=5,T=\"document-store\",B=\"by-sequence\",N=\"attach-store\",M=\"attach-seq-store\",F=\"meta-store\",P=\"local-store\",U=\"detect-blob-support\",G={running:!1,queue:[]},V=new I.Map,K=new O.changesHandler,J=new I.Map;b.valid=function(){var e=\"undefined\"!=typeof openDatabase&&/(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)&&!/BlackBerry/.test(navigator.platform);return!e&&\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange},t.exports=E}).call(this,e(36))},{13:13,18:18,20:20,24:24,26:26,28:28,32:32,33:33,35:35,36:36}],18:[function(e,t,n){\"use strict\";function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function o(e){if(!/^\\d+\\-./.test(e))return d.createError(d.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function i(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,a=r.length;a>i;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function a(e,t){var n,r,a,s={status:\"available\"};if(e._deleted&&(s.deleted=!0),t)if(e._id||(e._id=l.uuid()),r=l.uuid(32,16).toLowerCase(),e._rev){if(a=o(e._rev),a.error)return a;e._rev_tree=[{pos:a.prefix,ids:[a.id,{status:\"missing\"},[[r,s,[]]]]}],n=a.prefix+1}else e._rev_tree=[{pos:1,ids:[r,s,[]]}],n=1;else if(e._revisions&&(e._rev_tree=i(e._revisions,s),n=e._revisions.start,r=e._revisions.ids[0]),!e._rev_tree){if(a=o(e._rev),a.error)return a;n=a.prefix,r=a.id,e._rev_tree=[{pos:n,ids:[r,s,[]]}]}l.invalidIdError(e._id),e._rev=n+\"-\"+r;var u={metadata:{},data:{}};for(var c in e)if(Object.prototype.hasOwnProperty.call(e,c)){var f=\"_\"===c[0];if(f&&!_[c]){var h=d.createError(d.DOC_VALIDATION,c);throw h.message=d.DOC_VALIDATION.message+\": \"+c,h}f&&!m[c]?u.metadata[c.slice(1)]=e[c]:u.data[c]=e[c]}return u}function s(e,t,n){function r(e){try{return p.atob(e)}catch(t){var n=d.createError(d.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:n}}}function o(e,n){if(e.stub)return n();if(\"string\"==typeof e.data){var o=r(e.data);if(o.error)return n(o.error);e.length=o.length,\"blob\"===t?e.data=p.binaryStringToBlobOrBuffer(o,e.content_type):\"base64\"===t?e.data=p.btoa(o):e.data=o,v.binaryMd5(o,function(t){e.digest=\"md5-\"+t,n()})}else p.readAsArrayBuffer(e.data,function(r){\"binary\"===t?e.data=p.arrayBufferToBinaryString(r):\"base64\"===t&&(e.data=p.arrayBufferToBase64(r)),v.binaryMd5(r,function(t){e.digest=\"md5-\"+t,e.length=r.byteLength,n()})})}function i(){s++,e.length===s&&(a?n(a):n())}if(!e.length)return n();var a,s=0;e.forEach(function(e){function t(e){a=e,r++,r===n.length&&i()}var n=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],r=0;if(!n.length)return i();for(var s in e.data._attachments)e.data._attachments.hasOwnProperty(s)&&o(e.data._attachments[s],t)})}function u(e,t,n,r,o,i,s,u){if(h.revExists(t.rev_tree,n.metadata.rev))return r[o]=n,i();var c=t.winningRev||h.winningRev(t),f=\"deleted\"in t?t.deleted:h.isDeleted(t,c),l=\"deleted\"in n.metadata?n.metadata.deleted:h.isDeleted(n.metadata),p=/^1-/.test(n.metadata.rev);if(f&&!l&&u&&p){var v=n.data;v._rev=c,v._id=n.metadata.id,n=a(v,u)}var y=h.merge(t.rev_tree,n.metadata.rev_tree[0],e),_=u&&(f&&l||!f&&\"new_leaf\"!==y.conflicts||f&&!l&&\"new_branch\"===y.conflicts);if(_){var m=d.createError(d.REV_CONFLICT);return r[o]=m,i()}var g=n.metadata.rev;n.metadata.rev_tree=y.tree,n.stemmedRevs=y.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var b,w=h.winningRev(n.metadata),k=h.isDeleted(n.metadata,w),E=f===k?0:k>f?-1:1;b=g===w?k:h.isDeleted(n.metadata,g),s(n,w,k,b,!0,E,o,i)}function c(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function f(e,t,n,r,o,i,a,s,f){function l(e,t,n){var r=h.winningRev(e.metadata),o=h.isDeleted(e.metadata,r);if(\"was_delete\"in s&&o)return i[t]=d.createError(d.MISSING_DOC,\"deleted\"),n();var u=v&&c(e);if(u){var f=d.createError(d.REV_CONFLICT);return i[t]=f,n()}var l=o?0:1;a(e,r,o,o,!1,l,t,n)}function p(){++m===g&&f&&f()}e=e||1e3;var v=s.new_edits,_=new y.Map,m=0,g=t.length;t.forEach(function(e,t){if(e._id&&h.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,p()})}var a=e.metadata.id;_.has(a)?(g--,_.get(a).push([e,t])):_.set(a,[[e,t]])}),_.forEach(function(t,n){function o(){++c<t.length?s():p()}function s(){var s=t[c],f=s[0],d=s[1];if(r.has(n))u(e,r.get(n),f,i,d,o,a,v);else{var p=h.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=p.tree,f.stemmedRevs=p.stemmedRevs||[],l(f,d,o)}}var c=0;s()})}Object.defineProperty(n,\"__esModule\",{value:!0});var l=e(35),d=e(26),h=e(32),p=e(20),v=e(31),y=e(24),_=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),m=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);n.invalidIdError=l.invalidIdError,n.isDeleted=h.isDeleted,n.isLocalId=h.isLocalId,n.normalizeDdocFunctionName=l.normalizeDdocFunctionName,n.parseDdocFunctionName=l.parseDdocFunctionName,n.parseDoc=a,n.preprocessAttachments=s,n.processDocs=f,n.updateDoc=u},{20:20,24:24,26:26,31:31,32:32,35:35}],19:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(){for(var e={},t=new h(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,h.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){e.resolve(t)})[\"catch\"](function(t){e.reject(t)}),e}function i(e,t){var n,r,i,a=new Headers,s={method:e.method,credentials:\"include\",headers:a};return e.json&&(a.set(\"Accept\",\"application/json\"),a.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){s.body=e}):e.body&&e.processData&&\"string\"!=typeof e.body?s.body=JSON.stringify(e.body):\"body\"in e?s.body=e.body:s.body=null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&a.set(t,e.headers[t])}),n=o(e.url,s),e.timeout>0&&(r=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(r),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):t(e,i)})[\"catch\"](function(e){t(e,i)}),{abort:n.reject}}function a(e,t){var n,r,o=!1,i=function(){n.abort()},a=function(){o=!0,n.abort()};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(s){t(s,{statusCode:413})}n.withCredentials=\"withCredentials\"in e?e.withCredentials:!0,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var u in e.headers)e.headers.hasOwnProperty(u)&&n.setRequestHeader(u,e.headers[u]);return e.timeout>0&&(r=setTimeout(a,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(a,e.timeout))},\"undefined\"!=typeof n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?d.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var a={};if(o)a=new Error(\"ETIMEDOUT\"),r.statusCode=400;else try{a=JSON.parse(n.response)}catch(s){}t(a,r)}}},e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),{abort:i}}function s(){try{return new XMLHttpRequest,!0}catch(e){return!1}}function u(e,t){return _||e.xhr?a(e,t):i(e,t)}function c(){return\"\"}function f(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(o){return r(o)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?v.generateErrorFromResponse(e):e})),e.binary&&m(t,n),r(null,t,n)}function r(e,t){var n,r;if(e.code&&e.status){var o=new Error(e.message||e.code);return o.status=e.status,t(o)}if(e.message&&\"ETIMEDOUT\"===e.message)return t(e);try{n=JSON.parse(e.responseText),r=v.generateErrorFromResponse(n)}catch(i){r=v.generateErrorFromResponse(e)}t(r)}e=y.clone(e);var o={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=p.extend(o,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),u(e,function(o,i,a){if(o)return o.status=i?i.statusCode:400,r(o,t);var s,u=i.headers&&i.headers[\"content-type\"],f=a||c();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof f&&(/json/.test(u)||/^[\\s]*\\{/.test(f)&&/\\}[\\s]*$/.test(f)))try{f=JSON.parse(f.toString())}catch(l){}i.statusCode>=200&&i.statusCode<300?n(f,i,t):(s=v.generateErrorFromResponse(f),s.status=i.statusCode,t(s))})}function l(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=-1!==n.indexOf(\"safari\")&&-1===n.indexOf(\"chrome\"),o=-1!==n.indexOf(\"msie\"),i=-1!==n.indexOf(\"edge\"),a=r||(o||i)&&\"GET\"===e.method,s=\"cache\"in e?e.cache:!0,u=/^blob:/.test(e.url);if(!u&&(a||!s)){var c=-1!==e.url.indexOf(\"?\");e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return f(e,t)}var d=e(20),h=r(e(33)),p=e(13),v=e(26),y=e(35),_=s(),m=function(){};t.exports=l},{13:13,20:20,26:26,33:33,35:35}],20:[function(e,t,n){\"use strict\";function r(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;r>o;o++)t+=String.fromCharCode(n[o]);return t}function o(e){return p(r(e))}function i(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(n){if(\"TypeError\"!==n.name)throw n;for(var r=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,o=new r,i=0;i<e.length;i+=1)o.append(e[i]);return o.getBlob(t.type)}}function a(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;t>o;o++)r[o]=e.charCodeAt(o);return n}function s(e,t){return i([a(e)],{type:t})}function u(e,t){return s(h(e),t)}function c(e,t){if(\"undefined\"==typeof FileReader)return t(r((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,o=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";return o?t(n):void t(r(n))},o?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.arrayBufferToBase64=o,n.arrayBufferToBinaryString=r,n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=u,n.binaryStringToArrayBuffer=a,n.binaryStringToBlobOrBuffer=s,n.blob=i,n.blobOrBufferToBase64=f,n.readAsArrayBuffer=l,n.readAsBinaryString=c,n.typedBuffer=d},{}],21:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e,t,n,r,i){return e.get(t)[\"catch\"](function(n){if(404===n.status)return\"http\"===e.type()&&l.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:r,_id:t,history:[],replicator:p,version:h};throw n}).then(function(a){return i.cancelled?void 0:(a.history=(a.history||[]).filter(function(e){return e.session_id!==r}),a.history.unshift({last_seq:n,session_id:r}),a.history=a.history.slice(0,v),a.version=h,a.replicator=p,a.session_id=r,a.last_seq=n,e.put(a)[\"catch\"](function(a){if(409===a.status)return o(e,t,n,r,i);throw a}))})}function i(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function a(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:s(e.history,t.history)}function s(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);if(!n||0===t.length)return{last_seq:y,history:[]};var a=n.session_id;if(u(a,t))return{last_seq:n.last_seq,history:e};var c=o.session_id;return u(c,r)?{last_seq:o.last_seq,history:i}:s(r,i)}function u(e,t){var n=t[0],r=t.slice(1);return e&&0!==t.length?e===n.session_id?!0:u(e,r):!1}function c(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var f=r(e(33)),l=e(35),d=e(22),h=1,p=\"pouchdb\",v=5,y=0;i.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},i.prototype.updateTarget=function(e,t){return o(this.target,this.id,e,t,this.returnValue)},i.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?f.resolve(!0):o(this.src,this.id,e,t,this.returnValue)[\"catch\"](function(e){if(c(e))return n.readOnlySource=!0,!0;throw e})};var _={undefined:function(e,t){return 0===d.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return a(t,e).last_seq}};i.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?f.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return y;var n;return n=t.version?t.version.toString():\"undefined\",n in _?_[n](t,e):y},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:y}).then(function(){return y},function(n){return c(n)?(e.readOnlySource=!0,t.last_seq):y});throw n})})[\"catch\"](function(e){if(404!==e.status)throw e;return y})},t.exports=i},{22:22,33:33,35:35}],22:[function(e,t,n){\"use strict\";function r(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return f(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),r=t?e:Object.keys(e),o=-1,i=r.length,a=\"\";if(t)for(;++o<i;)a+=n.toIndexableString(r[o]);else for(;++o<i;){var s=r[o];a+=n.toIndexableString(s)+n.toIndexableString(e[s])}return a}return\"\"}function o(e,t){var n,r=t,o=\"1\"===e[t];if(o)n=0,t++;else{var i=\"0\"===e[t];t++;var a=\"\",s=e.substring(t,t+d),u=parseInt(s,10)+l;for(i&&(u=-u),t+=d;;){var c=e[t];if(\"\\x00\"===c)break;a+=c,t++}a=a.split(\".\"),n=1===a.length?parseInt(a,10):parseFloat(a[0]+\".\"+a[1]),i&&(n-=10),0!==u&&(n=parseFloat(n+\"e\"+u))}return{num:n,length:t-r}}function i(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var a=e.pop();o[a]=n}else e.push(n)}}function a(e,t){for(var r=Math.min(e.length,t.length),o=0;r>o;o++){var i=n.collate(e[o],t[o]);if(0!==i)return i}return e.length===t.length?0:e.length>t.length?1:-1}function s(e,t){return e===t?0:e>t?1:-1}function u(e,t){for(var r=Object.keys(e),o=Object.keys(t),i=Math.min(r.length,o.length),a=0;i>a;a++){var s=n.collate(r[a],o[a]);if(0!==s)return s;if(s=n.collate(e[r[a]],t[o[a]]),0!==s)return s}return r.length===o.length?0:r.length>o.length?1:-1}function c(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:3>n?n+2:n+3:Array.isArray(e)?5:void 0}function f(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=0>e,o=r?\"0\":\"2\",i=(r?-n:n)-l,a=p.padLeft(i.toString(),\"0\",d);o+=h+a;var s=Math.abs(parseFloat(t[0]));r&&(s=10-s);var u=s.toFixed(20);return u=u.replace(/\\.?0+$/,\"\"),o+=h+u}var l=-324,d=3,h=\"\",p=e(23);n.collate=function(e,t){if(e===t)return 0;e=n.normalizeKey(e),t=n.normalizeKey(t);var r=c(e),o=c(t);if(r-o!==0)return r-o;if(null===e)return 0;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e===t?0:t>e?-1:1;case\"string\":return s(e,t)}return Array.isArray(e)?a(e,t):u(e,t)},n.normalizeKey=function(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-(1/0)||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var r=e.length;e=new Array(r);for(var o=0;r>o;o++)e[o]=n.normalizeKey(t[o])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var i in t)if(t.hasOwnProperty(i)){var a=t[i];\"undefined\"!=typeof a&&(e[i]=n.normalizeKey(a))}}}}return e},n.toIndexableString=function(e){var t=\"\\x00\";return e=n.normalizeKey(e),c(e)+h+r(e)+t},n.parseIndexableString=function(e){for(var t=[],n=[],r=0;;){var a=e[r++];if(\"\\x00\"!==a)switch(a){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var s=o(e,r);t.push(s.num),r+=s.length;break;case\"4\":for(var u=\"\";;){var c=e[r];if(\"\\x00\"===c)break;u+=c,r++}u=u.replace(/\\u0001\\u0001/g,\"\\x00\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(u);break;case\"5\":var f={element:[],index:t.length};t.push(f.element),n.push(f);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+a)}else{if(1===t.length)return t.pop();i(t,n)}}}},{23:23}],23:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}n.padLeft=function(e,t,n){var o=r(e,t,n);return o+e},n.padRight=function(e,t,n){var o=r(e,t,n);return e+o},n.stringLexCompare=function(e,t){var n,r=e.length,o=t.length;for(n=0;r>n;n++){if(n===o)return 1;var i=e.charAt(n),a=t.charAt(n);if(i!==a)return a>i?-1:1;\n}return o>r?-1:0},n.intToDecimalForm=function(e){var t=0>e,n=\"\";do{var r=t?-Math.ceil(e%10):Math.floor(e%10);n=r+n,e=t?Math.ceil(e/10):Math.floor(e/10)}while(e);return t&&\"0\"!==n&&(n=\"-\"+n),n}},{}],24:[function(e,t,n){\"use strict\";function r(){this.store={}}function o(e){if(this.store=new r,e&&Array.isArray(e))for(var t=0,n=e.length;n>t;t++)this.add(e[t])}n.Map=r,n.Set=o,r.prototype.mangle=function(e){if(\"string\"!=typeof e)throw new TypeError(\"key must be a string but Got \"+e);return\"$\"+e},r.prototype.unmangle=function(e){return e.substring(1)},r.prototype.get=function(e){var t=this.mangle(e);return t in this.store?this.store[t]:void 0},r.prototype.set=function(e,t){var n=this.mangle(e);return this.store[n]=t,!0},r.prototype.has=function(e){var t=this.mangle(e);return t in this.store},r.prototype[\"delete\"]=function(e){var t=this.mangle(e);return t in this.store?(delete this.store[t],!0):!1},r.prototype.forEach=function(e){for(var t=Object.keys(this.store),n=0,r=t.length;r>n;n++){var o=t[n],i=this.store[o];o=this.unmangle(o),e(i,o)}},o.prototype.add=function(e){return this.store.set(e,!0)},o.prototype.has=function(e){return this.store.has(e)},o.prototype[\"delete\"]=function(e){return this.store[\"delete\"](e)}},{}],25:[function(e,t,n){(function(n,r){\"use strict\";function o(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function i(e){return L(\"return \"+e+\";\",{})}function a(e){return new Function(\"doc\",[\"var emitted = false;\",\"var emit = function (a, b) {\",\"  emitted = true;\",\"};\",\"var view = \"+e+\";\",\"view(doc);\",\"if (emitted) {\",\"  return true;\",\"}\"].join(\"\\n\"))}function s(e,t){try{e.emit(\"change\",t)}catch(n){q.guardedConsole(\"error\",'Error in .on(\"change\", function):',n)}}function u(e,t,n){function r(){o.cancel()}C.EventEmitter.call(this);var o=this;this.db=e,t=t?q.clone(t):{};var i=t.complete=q.once(function(t,n){t?q.listenerCount(o,\"error\")>0&&o.emit(\"error\",t):o.emit(\"complete\",n),o.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(o.on(\"complete\",function(e){n(null,e)}),o.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){t.isCancelled||(s(o,e),o.startSeq&&o.startSeq<=e.seq&&(o.startSeq=!1))};var a=new D(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});o.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=a.then.bind(a),this[\"catch\"]=a[\"catch\"].bind(a),this.then(function(e){i(null,e)},i),e.taskqueue.isReady?o.doChanges(t):e.taskqueue.addTask(function(){o.isCancelled?o.emit(\"cancel\"):o.doChanges(t)})}function c(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=R.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return R.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=R.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function f(e,t){return t>e?-1:e>t?1:0}function l(e,t){for(var n=0;n<e.length;n++)if(t(e[n],n)===!0)return e[n]}function d(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function h(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=q.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function p(e,t){var n=f(e._id,t._id);if(0!==n)return n;var r=e._revisions?e._revisions.start:0,o=t._revisions?t._revisions.start:0;return f(r,o)}function v(e){var t={},n=[];return R.traverseRevTree(e,function(e,r,o,i){var a=r+\"-\"+o;return e&&(t[a]=0),void 0!==i&&n.push({from:i,to:a}),a}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function y(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return D.all(r.map(function(n){var r=O.extend({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new D(function(t,i){e._allDocs(r,function(e,r){return e?i(e):(o.total_rows=r.total_rows,void t(r.rows[0]||{key:n,error:\"not_found\"}))})})})).then(function(e){return o.rows=e,o})}function _(e){var t=e._compactionQueue[0],r=t.opts,o=t.callback;e.get(\"_local/compaction\")[\"catch\"](function(){return!1}).then(function(t){t&&t.last_seq&&(r.last_seq=t.last_seq),e._compact(r,function(t,r){t?o(t):o(null,r),n.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&_(e)})})})}function m(e){return\"_\"===e.charAt(0)?e+\"is not a valid attachment name, attachment names cannot start with '_'\":!1}function g(){C.EventEmitter.call(this)}function b(){this.isReady=!1,this.failed=!1,this.queue=[]}function w(e){e&&r.debug&&q.guardedConsole(\"error\",e)}function k(e,t){function n(){i.emit(\"destroyed\",o)}function r(){e.removeListener(\"destroyed\",n),e.emit(\"destroyed\",e)}var o=t.originalName,i=e.constructor,a=i._destructionListeners;e.once(\"destroyed\",n),a.has(o)||a.set(o,[]),a.get(o).push(r)}function E(e,t,n){if(!(this instanceof E))return new E(e,t,n);var r=this;if(\"function\"!=typeof t&&\"undefined\"!=typeof t||(n=t,t={}),e&&\"object\"==typeof e&&(t=e,e=void 0),\"undefined\"==typeof n)n=w;else{var o=n;n=function(){return q.guardedConsole(\"warn\",\"Using a callback for new PouchDB()is deprecated.\"),o.apply(null,arguments)}}e=e||t.name,t=q.clone(t),delete t.name,this.__opts=t;var i=n;r.auto_compaction=t.auto_compaction,r.prefix=E.prefix,g.call(r),r.taskqueue=new b;var a=new D(function(o,i){n=function(e,t){return e?i(e):(delete t.then,void o(t))},t=q.clone(t);var a,s;return function(){try{if(\"string\"!=typeof e)throw s=new Error(\"Missing/invalid DB name\"),s.code=400,s;var n=(t.prefix||\"\")+e;if(a=E.parseAdapter(n,t),t.originalName=e,t.name=a.name,t.adapter=t.adapter||a.adapter,r._adapter=t.adapter,A(\"pouchdb:adapter\")(\"Picked adapter: \"+t.adapter),r._db_name=e,!E.adapters[t.adapter])throw s=new Error(\"Adapter is missing\"),s.code=404,s;if(!E.adapters[t.adapter].valid())throw s=new Error(\"Invalid Adapter\"),s.code=404,s}catch(o){r.taskqueue.fail(o)}}(),s?i(s):(r.adapter=t.adapter,r.replicate={},r.replicate.from=function(e,t,n){return r.constructor.replicate(e,r,t,n)},r.replicate.to=function(e,t,n){return r.constructor.replicate(r,e,t,n)},r.sync=function(e,t,n){return r.constructor.sync(r,e,t,n)},r.replicate.sync=r.sync,void E.adapters[t.adapter].call(r,t,function(e){return e?(r.taskqueue.fail(e),void n(e)):(k(r,t),r.emit(\"created\",r),E.emit(\"created\",t.originalName),r.taskqueue.ready(r),void n(null,r))}))});a.then(function(e){i(null,e)},i),r.then=a.then.bind(a),r[\"catch\"]=a[\"catch\"].bind(a)}function S(e){Object.keys(C.EventEmitter.prototype).forEach(function(t){\"function\"==typeof C.EventEmitter.prototype[t]&&(e[t]=B[t].bind(B))});var t=e._destructionListeners=new j.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t[\"delete\"](e)})}var O=e(13),A=o(e(8)),I=o(e(12)),D=o(e(33)),j=e(24),x=o(e(7)),C=e(10),q=e(35),R=e(32),L=o(e(37)),T=e(26);I(u,C.EventEmitter),u.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},u.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=q.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=c,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){return t.isCancelled?void n(null,{status:\"cancelled\"}):(e.since=r.update_seq,void t.doChanges(e))},n);if(e.continuous&&\"now\"!==e.since&&this.db.info().then(function(e){t.startSeq=e.update_seq},function(e){if(\"idbNull\"!==e.id)throw e}),e.view&&!e.filter&&(e.filter=\"_view\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=q.normalizeDdocFunctionName(e.view):e.filter=q.normalizeDdocFunctionName(e.filter),\"http\"!==this.db.type()&&!e.doc_ids))return this.filterChanges(e);\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=x(function(e){r.cancel(),o.apply(this,e)})}},u.prototype.filterChanges=function(e){var t=this,n=e.complete;if(\"_view\"===e.filter){if(!e.view||\"string\"!=typeof e.view){var r=T.createError(T.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(r)}var o=q.parseDdocFunctionName(e.view);this.db.get(\"_design/\"+o[0],function(r,i){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(T.generateErrorFromResponse(r));var s=i&&i.views&&i.views[o[1]]&&i.views[o[1]].map;return s?(e.filter=a(s),void t.doChanges(e)):n(T.createError(T.MISSING_DOC,i.views?\"missing json key: \"+o[1]:\"missing json key: views\"))})}else{var s=q.parseDdocFunctionName(e.filter);if(!s)return t.doChanges(e);this.db.get(\"_design/\"+s[0],function(r,o){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(T.generateErrorFromResponse(r));var a=o&&o.filters&&o.filters[s[1]];return a?(e.filter=i(a),void t.doChanges(e)):n(T.createError(T.MISSING_DOC,o&&o.filters?\"missing json key: \"+s[1]:\"missing json key: filters\"))})}},I(g,C.EventEmitter),g.prototype.post=q.adapterFun(\"post\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(T.createError(T.NOT_AN_OBJECT)):void this.bulkDocs({docs:[e]},t,d(n))}),g.prototype.put=q.adapterFun(\"put\",x(function(e){function t(){a||(q.guardedConsole(\"warn\",\"db.put(doc, id, rev) has been deprecated and will be removed in a future release, please use db.put({_id: id, _rev: rev}) instead\"),a=!0)}var n,r,o,i,a=!1,s=e.shift(),u=\"_id\"in s;if(\"object\"!=typeof s||Array.isArray(s))return(i=e.pop())(T.createError(T.NOT_AN_OBJECT));for(;;)if(n=e.shift(),r=typeof n,\"string\"!==r||u?\"string\"!==r||!u||\"_rev\"in s?\"object\"===r?o=n:\"function\"===r&&(i=n):(t(),s._rev=n):(t(),s._id=n,u=!0),!e.length)break;return o=o||{},q.invalidIdError(s._id),R.isLocalId(s._id)&&\"function\"==typeof this._putLocal?s._deleted?this._removeLocal(s,i):this._putLocal(s,i):void this.bulkDocs({docs:[s]},o,d(i))})),g.prototype.putAttachment=q.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},a.put(e)}var a=this;return\"function\"==typeof o&&(o=r,r=n,n=null),\"undefined\"==typeof o&&(o=r,r=n,n=null),a.get(e).then(function(e){if(e._rev!==n)throw T.createError(T.REV_CONFLICT);return i(e)},function(t){if(t.reason===T.MISSING_DOC.message)return i({_id:e});throw t})}),g.prototype.removeAttachment=q.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(T.createError(T.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),g.prototype.remove=q.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};return i._deleted=!0,R.isLocalId(i._id)&&\"function\"==typeof this._removeLocal?this._removeLocal(o,r):void this.bulkDocs({docs:[i]},n,d(r))}),g.prototype.revsDiff=q.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){s.has(e)||s.set(e,{missing:[]}),s.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);R.traverseRevTree(n,function(e,n,i,a,s){var u=n+\"-\"+i,c=o.indexOf(u);-1!==c&&(o.splice(c,1),\"available\"!==s.status&&r(t,u))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var a=0,s=new j.Map;i.map(function(t){this._getRevisionTree(t,function(r,u){if(r&&404===r.status&&\"missing\"===r.message)s.set(t,{missing:e[t]});else{if(r)return n(r);o(t,u)}if(++a===i.length){var c={};return s.forEach(function(e,t){c[t]=e}),n(null,c)}})},this)}),g.prototype.bulkGet=q.adapterFun(\"bulkGet\",function(e,t){q.bulkGetShim(this,e,t)}),g.prototype.compactDocument=q.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var a=v(i),s=[],u=[];Object.keys(a).forEach(function(e){a[e]>t&&s.push(e)}),R.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&-1!==s.indexOf(i)&&u.push(i)}),r._doCompaction(e,u,n)})}),g.prototype.compact=q.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&_(n)}),g.prototype._compact=function(e,t){function n(e){a.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;D.all(a).then(function(){return q.upsert(o,\"_local/compaction\",function(e){return!e.last_seq||e.last_seq<n?(e.last_seq=n,e):!1})}).then(function(){t(null,{ok:!0})})[\"catch\"](t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},a=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},g.prototype.get=q.adapterFun(\"get\",function(e,t,n){function r(){var r=[],a=o.length;return a?void o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,attachments:t.attachments},function(e,t){e?r.push({missing:o}):r.push({ok:t}),a--,a||n(null,r)})}):n(null,r)}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(T.createError(T.INVALID_ID));if(R.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,a=r.metadata,s=r.ctx;if(t.conflicts){var u=R.collectConflicts(a);u.length&&(o._conflicts=u)}if(R.isDeleted(a,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){var c=R.rootToLeaf(a.rev_tree),f=l(c,function(e){return-1!==e.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])}),d=f.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,h=f.ids.length-d;if(f.ids.splice(d,h),f.ids.reverse(),t.revs&&(o._revisions={start:f.pos+f.ids.length-1,ids:f.ids.map(function(e){return e.id})}),t.revs_info){var p=f.pos+f.ids.length;o._revs_info=f.ids.map(function(e){return p--,{rev:p+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var v=o._attachments,y=Object.keys(v).length;if(0===y)return n(null,o);Object.keys(v).forEach(function(e){this._getAttachment(o._id,e,v[e],{rev:o._rev,binary:t.binary,ctx:s},function(t,r){var i=o._attachments[e];i.data=r,delete i.stub,delete i.length,--y||n(null,o)})},i)}else{if(o._attachments)for(var _ in o._attachments)o._attachments.hasOwnProperty(_)&&(o._attachments[_].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){return e?n(e):(o=R.collectLeaves(t).map(function(e){return e.rev}),void r())});else{if(!Array.isArray(t.open_revs))return n(T.createError(T.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var a=0;a<o.length;a++){var s=o[a];if(\"string\"!=typeof s||!/^\\d+-/.test(s))return n(T.createError(T.INVALID_REV))}r()}}),g.prototype.getAttachment=q.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,a){return i?r(i):a.doc._attachments&&a.doc._attachments[t]?(n.ctx=a.ctx,n.binary=!0,o._getAttachment(e,t,a.doc._attachments[t],n,r),void 0):r(T.createError(T.MISSING_DOC))})}),g.prototype.allDocs=q.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=\"undefined\"!=typeof e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(T.createError(T.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(\"http\"!==this.type())return y(this,e,t)}return this._allDocs(e,t)}),g.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new u(this,e,t)},g.prototype.close=q.adapterFun(\"close\",function(e){return this._closed=!0,this._close(e)}),g.prototype.info=q.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){return n?e(n):(r.db_name=r.db_name||t._db_name,r.auto_compaction=!(!t.auto_compaction||\"http\"===t.type()),r.adapter=t.type(),void e(null,r))})}),g.prototype.id=q.adapterFun(\"id\",function(e){return this._id(e)}),g.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},g.prototype.bulkDocs=q.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(T.createError(T.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(T.createError(T.NOT_AN_OBJECT));var o;return e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(e){o=o||m(e)})}),o?n(T.createError(T.BAD_REQUEST,o)):(\"new_edits\"in t||(\"new_edits\"in e?t.new_edits=e.new_edits:t.new_edits=!0),t.new_edits||\"http\"===this.type()||e.docs.sort(p),h(e.docs),this._bulkDocs(e,t,function(e,r){return e?n(e):(t.new_edits||(r=r.filter(function(e){return e.error})),void n(null,r))}))}),g.prototype.registerDependentDatabase=q.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},t.dependentDbs[e]?!1:(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);q.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})})[\"catch\"](t)}),g.prototype.destroy=q.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){return e?t(e):(r._destroyed=!0,r.emit(\"destroyed\"),void t(null,n||{ok:!0}))})}\"function\"==typeof e&&(t=e,e={});var r=this,o=\"use_prefix\"in r?r.use_prefix:!0;return\"http\"===r.type()?n():void r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var a=i.dependentDbs,s=r.constructor,u=Object.keys(a).map(function(e){var t=o?e.replace(new RegExp(\"^\"+s.prefix),\"\"):e;return new s(t,r.__opts).destroy()});D.all(u).then(n,t)})}),b.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},b.prototype.fail=function(e){this.failed=e,this.execute()},b.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},b.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},I(E,g),E.debug=A,E.adapters={},E.preferredAdapters=[],E.prefix=\"_pouch_\";var B=new C.EventEmitter;S(E),E.parseAdapter=function(e,t){var n,r,o=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(o){if(e=/http(s?)/.test(o[1])?o[1]+\"://\"+o[2]:o[2],n=o[1],!E.adapters[n].valid())throw\"Invalid adapter\";return{name:e,adapter:o[1]}}var i=\"idb\"in E.adapters&&\"websql\"in E.adapters&&q.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+E.prefix+e];if(t.adapter)r=t.adapter;else if(\"undefined\"!=typeof t&&t.db)r=\"leveldb\";else for(var a=0;a<E.preferredAdapters.length;++a)if(r=E.preferredAdapters[a],r in E.adapters){if(i&&\"idb\"===r){q.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.');continue}break}n=E.adapters[r];var s=n&&\"use_prefix\"in n?n.use_prefix:!0;return{name:s?E.prefix+e:e,adapter:r}},E.adapter=function(e,t,n){t.valid()&&(E.adapters[e]=t,n&&E.preferredAdapters.push(e))},E.plugin=function(e){return\"function\"==typeof e?e(E):Object.keys(e).forEach(function(t){E.prototype[t]=e[t]}),E},E.defaults=function(e){function t(n,r,o){return this instanceof t?(\"function\"!=typeof r&&\"undefined\"!=typeof r||(o=r,r={}),n&&\"object\"==typeof n&&(r=n,n=void 0),r=O.extend({},e,r),void E.call(this,n,r,o)):new t(n,r,o)}return I(t,E),t.preferredAdapters=E.preferredAdapters.slice(),Object.keys(E).forEach(function(e){e in t||(t[e]=E[e])}),t};var N=\"5.4.4\";E.version=N,t.exports=E}).call(this,e(36),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{10:10,12:12,13:13,24:24,26:26,32:32,33:33,35:35,36:36,37:37,7:7,8:8}],26:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){Error.call(this,e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}function i(e,t,n){function r(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return r.prototype=o.prototype,new r(t)}function a(e){var t,n,r,o,a;return n=e.error===!0&&\"string\"==typeof e.name?e.name:e.error,a=e.reason,r=R(\"name\",n,a),e.missing||\"missing\"===a||\"deleted\"===a||\"not_found\"===n?r=f:\"doc_validation\"===n?(r=b,o=a):\"bad_request\"===n&&r.message!==a&&(r=w),r||(r=R(\"status\",e.status,a)||y),t=i(r,a,n),o&&(t.message=o),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.missing&&(t.missing=e.missing),t}Object.defineProperty(n,\"__esModule\",{value:!0});var s=r(e(12));s(o,Error),o.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var u=new o({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),c=new o({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),f=new o({status:404,error:\"not_found\",reason:\"missing\"}),l=new o({status:409,error:\"conflict\",reason:\"Document update conflict\"}),d=new o({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),h=new o({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),p=new o({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),v=new o({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),y=new o({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),_=new o({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),m=new o({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),g=new o({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),b=new o({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),w=new o({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),k=new o({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),E=new o({status:404,error:\"not_found\",reason:\"Database not found\"}),S=new o({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),O=new o({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),A=new o({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),I=new o({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),D=new o({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),j=new o({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),x=new o({status:412,error:\"missing_stub\"}),C=new o({status:413,error:\"invalid_url\",reason:\"Provided URL is invalid\"}),q=[u,c,f,l,d,h,p,v,y,_,m,g,b,w,k,E,O,A,I,D,j,x,S,C],R=function(e,t,n){var r=q.filter(function(n){return n[e]===t});return n&&r.filter(function(e){return e.message===n})[0]||r[0]};n.UNAUTHORIZED=u,n.MISSING_BULK_DOCS=c,n.MISSING_DOC=f,n.REV_CONFLICT=l,n.INVALID_ID=d,n.MISSING_ID=h,n.RESERVED_ID=p,n.NOT_OPEN=v,n.UNKNOWN_ERROR=y,n.BAD_ARG=_,n.INVALID_REQUEST=m,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=b,n.BAD_REQUEST=w,n.NOT_AN_OBJECT=k,n.DB_MISSING=E,n.WSQ_ERROR=O,n.LDB_ERROR=A,n.FORBIDDEN=I,n.INVALID_REV=D,n.FILE_EXISTS=j,n.MISSING_STUB=x,n.IDB_ERROR=S,n.INVALID_URL=C,n.getErrorTypeByProp=R,n.createError=i,n.generateErrorFromResponse=a},{12:12}],27:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){return Object.keys(e).sort(u.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function i(e,t,n){var r=n.doc_ids?n.doc_ids.sort(u.collate):\"\",i=n.filter?n.filter.toString():\"\",c=\"\",f=\"\";return n.filter&&n.query_params&&(c=JSON.stringify(o(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),a.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+i+f+c+r;return new a(function(e){s.binaryMd5(t,e)})}).then(function(e){return e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"),\"_local/\"+e})}var a=r(e(33)),s=e(31),u=e(22);t.exports=i},{22:22,31:31,33:33}],28:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){try{return JSON.parse(e)}catch(t){return s.parse(e)}}function i(e){return e.length<5e4?JSON.parse(e):o(e)}function a(e){try{return JSON.stringify(e)}catch(t){return s.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var s=r(e(39));n.safeJsonParse=i,n.safeJsonStringify=a},{39:39}],29:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}Object.defineProperty(n,\"__esModule\",{value:!0});var o=r(e(7)),i=function(e,n){return n&&e.then(function(e){t.nextTick(function(){n(null,e)})},function(e){t.nextTick(function(){n(e)})}),e},a=function(e){return o(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&i(r,n),r})},s=function(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})},u=function(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}},c=function(e){for(var t={},n=0,r=e.length;r>n;n++)t[\"$\"+e[n]]=!0;var o=Object.keys(t),i=new Array(o.length);for(n=0,r=o.length;r>n;n++)i[n]=o[n].substring(1);return i};n.uniq=c,n.sequentialize=u,n.fin=s,n.callbackify=a,n.promisedCallback=i}).call(this,e(36))},{36:36,7:7}],30:[function(e,t,n){(function(n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(){this.promise=new K(function(e){e()})}function i(e){var t=e.db,n=e.viewName,r=e.map,o=e.reduce,i=e.temporary,a=r.toString()+(o&&o.toString())+\"undefined\";if(!i&&t._cachedViews){var s=t._cachedViews[a];if(s)return K.resolve(s)}return t.info().then(function(e){function s(e){e.views=e.views||{};var t=n;-1===t.indexOf(\"/\")&&(t=n+\"/\"+n);var r=e.views[t]=e.views[t]||{};if(!r[u])return r[u]=!0,e}var u=e.db_name+\"-mrview-\"+(i?\"temp\":J.stringMd5(a));return U.upsert(t,\"_local/mrviews\",s).then(function(){return t.registerDependentDatabase(u).then(function(e){var n=e.db;n.auto_compaction=!0;var s={name:u,db:n,sourceDB:t,adapter:t.adapter,mapFun:r,reduceFun:o};return s.db.get(\"_local/lastSeq\")[\"catch\"](function(e){if(404!==e.status)throw e}).then(function(e){return s.seq=e?e.seq:0,i||(t._cachedViews=t._cachedViews||{},t._cachedViews[a]=s,s.db.once(\"destroyed\",function(){delete t._cachedViews[a]})),s})})})})}function a(e,t,n,r,o,i){return z(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:n,log:r,isArray:o,toJSON:i})}function s(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function u(e){return 1===e.length&&/^1-/.test(e[0].rev)}function c(e,t){try{e.emit(\"error\",t)}catch(n){U.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),U.guardedConsole(\"error\",t)}}function f(e,t,n){try{return{output:t.apply(null,n)}}catch(r){return c(e,r),{error:r}}}function l(e,t){var n=V.collate(e.key,t.key);return 0!==n?n:V.collate(e.value,t.value)}function d(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function h(e){var t=e.value,n=t&&\"object\"==typeof t&&t._id||e.id;return n}function p(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=G.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function v(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&p(t),t}}function y(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new P(t)}function _(e){for(var t=0,n=0,r=e.length;r>n;n++){var o=e[n];if(\"number\"!=typeof o){if(!Array.isArray(o))throw y(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var i=0,a=o.length;a>i;i++){var s=o[i];if(\"number\"!=typeof s)throw y(\"_sum\");\"undefined\"==typeof t[i]?t.push(s):t[i]+=s}}else\"number\"==typeof t?t+=o:t[0]+=o}return t}function m(e,t,n,r){var o=t[e];\"undefined\"!=typeof o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function g(e){if(\"undefined\"!=typeof e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function b(e){return e.group_level=g(e.group_level),e.limit=g(e.limit),e.skip=g(e.skip),e}function w(e){if(e){if(\"number\"!=typeof e)return new M('Invalid value for integer: \"'+e+'\"');if(0>e)return new M('Invalid value for positive integer: \"'+e+'\"')}}function k(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(\"undefined\"!=typeof e[n]&&\"undefined\"!=typeof e[r]&&V.collate(e[n],e[r])>0)throw new M(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&e.reduce!==!1){if(e.include_docs)throw new M(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new M(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=w(e[t]);if(n)throw n})}function E(e,t,n){var r,o=[],i=\"GET\";if(m(\"reduce\",n,o),m(\"include_docs\",n,o),m(\"attachments\",n,o),m(\"limit\",n,o),m(\"descending\",n,o),m(\"group\",n,o),m(\"group_level\",n,o),m(\"skip\",n,o),m(\"stale\",n,o),m(\"conflicts\",n,o),m(\"startkey\",n,o,!0),m(\"start_key\",n,o,!0),m(\"endkey\",n,o,!0),m(\"end_key\",n,o,!0),m(\"inclusive_end\",n,o),m(\"key\",n,o,!0),o=o.join(\"&\"),o=\"\"===o?\"\":\"?\"+o,\"undefined\"!=typeof n.keys){var a=2e3,u=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));u.length+o.length+1<=a?o+=(\"?\"===o[0]?\"&\":\"?\")+u:(i=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var c=s(t);return e.request({method:i,url:\"_design/\"+c[0]+\"/_view/\"+c[1]+o,body:r}).then(v(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.request({method:\"POST\",url:\"_temp_view\"+o,body:r}).then(v(n))}function S(e,t,n){return new K(function(r,o){e._query(t,n,function(e,t){return e?o(e):void r(t)})})}function O(e){return new K(function(t,n){e._viewCleanup(function(e,r){return e?n(e):void t(r)})})}function A(e){return function(t){if(404===t.status)return e;throw t}}function I(e,t,n){function r(){return u(l)?K.resolve(s):t.db.get(a)[\"catch\"](A(s))}function o(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):K.resolve({rows:[]})}function i(e,t){for(var n=[],r={},o=0,i=t.rows.length;i>o;o++){var a=t.rows[o],s=a.doc;if(s&&(n.push(s),r[s._id]=!0,s._deleted=!f[s._id],!s._deleted)){var u=f[s._id];\"value\"in u&&(s.value=u.value)}}var c=Object.keys(f);return c.forEach(function(e){if(!r[e]){var t={_id:e},o=f[e];\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=Q.uniq(c.concat(e.keys)),n.push(e),n}var a=\"_local/doc_\"+e,s={_id:a,keys:[]},c=n[e],f=c.indexableKeysToKeyValues,l=c.changes;return r().then(function(e){return o(e).then(function(t){return i(e,t)})})}function D(e,t,n){var r=\"_local/lastSeq\";return e.db.get(r)[\"catch\"](A({_id:r,seq:0})).then(function(r){var o=Object.keys(t);return K.all(o.map(function(n){return I(n,e,t)})).then(function(t){var o=U.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function j(e){var t=\"string\"==typeof e?e:e.name,n=W[t];return n||(n=W[t]=new o),n}function x(e){return Q.sequentialize(j(e),function(){return C(e)})()}function C(e){function t(e,t){var n={id:i._id,key:V.normalizeKey(e)};\"undefined\"!=typeof t&&null!==t&&(n.value=V.normalizeKey(t)),r.push(n)}function n(t,n){return function(){return D(e,t,n)}}var r,i,s;if(\"function\"==typeof e.mapFun&&2===e.mapFun.length){var u=e.mapFun;s=function(e){return u(e,t)}}else s=a(e.mapFun.toString(),t,_,X,Array.isArray,JSON.parse);var c=e.seq||0,d=new o;return new K(function(t,o){function a(){d.finish().then(function(){e.seq=c,t()})}function u(){function t(e){o(e)}e.sourceDB.changes({conflicts:!0,include_docs:!0,\nstyle:\"all_docs\",since:c,limit:Y}).on(\"complete\",function(t){var o=t.results;if(!o.length)return a();for(var h={},p=0,v=o.length;v>p;p++){var y=o[p];if(\"_\"!==y.doc._id[0]){r=[],i=y.doc,i._deleted||f(e.sourceDB,s,[i]),r.sort(l);for(var _,m={},g=0,b=r.length;b>g;g++){var w=r[g],k=[w.key,w.id];0===V.collate(w.key,_)&&k.push(g);var E=V.toIndexableString(k);m[E]=w,_=w.key}h[y.doc._id]={indexableKeysToKeyValues:m,changes:y.changes}}c=y.seq}return d.add(n(h,c)),o.length<Y?a():u()}).on(\"error\",t)}u()})}function q(e,t,n){0===n.group_level&&delete n.group_level;var r,o=n.group||n.group_level;r=Z[e.reduceFun]?Z[e.reduceFun]:a(e.reduceFun.toString(),null,_,X,Array.isArray,JSON.parse);var i=[],s=isNaN(n.group_level)?Number.POSITIVE_INFINITY:n.group_level;t.forEach(function(e){var t=i[i.length-1],n=o?e.key:null;return o&&Array.isArray(n)&&(n=n.slice(0,s)),t&&0===V.collate(t.groupKey,n)?(t.keys.push([e.key,e.id]),void t.values.push(e.value)):void i.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var u=0,c=i.length;c>u;u++){var l=i[u],h=f(e.sourceDB,r,[l.keys,l.values,!1]);if(h.error&&h.error instanceof P)throw h.error;t.push({value:h.error?null:h.output,key:l.groupKey})}return{rows:d(t,n.limit,n.skip)}}function R(e,t){return Q.sequentialize(j(e),function(){return L(e,t)})()}function L(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(n>t||t>n))return e.doc.value}var r=V.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?q(e,n,t):{total_rows:o,offset:a,rows:n},t.include_docs){var s=Q.uniq(n.map(h));return e.sourceDB.allDocs({keys:s,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t={};return e.rows.forEach(function(e){e.doc&&(t[\"$\"+e.id]=e.doc)}),n.forEach(function(e){var n=h(e),r=t[\"$\"+n];r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&t.reduce!==!1,a=t.skip||0;if(\"undefined\"==typeof t.keys||t.keys.length||(t.limit=0,delete t.keys),\"undefined\"!=typeof t.keys){var s=t.keys,u=s.map(function(e){var t={startkey:V.toIndexableString([e]),endkey:V.toIndexableString([e,{}])};return n(t)});return K.all(u).then(U.flatten).then(r)}var c={descending:t.descending};if(t.start_key&&(t.startkey=t.start_key),t.end_key&&(t.endkey=t.end_key),\"undefined\"!=typeof t.startkey&&(c.startkey=t.descending?V.toIndexableString([t.startkey,{}]):V.toIndexableString([t.startkey])),\"undefined\"!=typeof t.endkey){var f=t.inclusive_end!==!1;t.descending&&(f=!f),c.endkey=V.toIndexableString(f?[t.endkey,{}]:[t.endkey])}if(\"undefined\"!=typeof t.key){var l=V.toIndexableString([t.key]),d=V.toIndexableString([t.key,{}]);c.descending?(c.endkey=l,c.startkey=d):(c.startkey=l,c.endkey=d)}return i||(\"number\"==typeof t.limit&&(c.limit=t.limit),c.skip=a),n(c).then(r)}function T(e){return e.request({method:\"POST\",url:\"_view_cleanup\"})}function B(e){return e.get(\"_local/mrviews\").then(function(t){var n={};Object.keys(t.views).forEach(function(e){var t=s(e),r=\"_design/\"+t[0],o=t[1];n[r]=n[r]||{},n[r][o]=!0});var r={keys:Object.keys(n),include_docs:!0};return e.allDocs(r).then(function(r){var o={};r.rows.forEach(function(e){var r=e.key.substring(8);Object.keys(n[e.key]).forEach(function(n){var i=r+\"/\"+n;t.views[i]||(i=n);var a=Object.keys(t.views[i]),s=e.doc&&e.doc.views&&e.doc.views[n];a.forEach(function(e){o[e]=o[e]||s})})});var i=Object.keys(o).filter(function(e){return!o[e]}),a=i.map(function(t){return Q.sequentialize(j(t),function(){return new e.constructor(t,e.__opts).destroy()})()});return K.all(a).then(function(){return{ok:!0}})})},A({ok:!0}))}function N(e,t,r){if(\"http\"===e.type())return E(e,t,r);if(\"function\"==typeof e._query)return S(e,t,r);if(\"string\"!=typeof t){k(r,t);var o={db:e,viewName:\"temp_view/temp_view\",map:t.map,reduce:t.reduce,temporary:!0};return H.add(function(){return i(o).then(function(e){function t(){return e.db.destroy()}return Q.fin(x(e).then(function(){return R(e,r)}),t)})}),H.finish()}var a=t,u=s(a),c=u[0],f=u[1];return e.get(\"_design/\"+c).then(function(t){var o=t.views&&t.views[f];if(!o||\"string\"!=typeof o.map)throw new F(\"ddoc \"+c+\" has no view named \"+f);k(r,o);var s={db:e,viewName:a,map:o.map,reduce:o.reduce};return i(s).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&n.nextTick(function(){x(e)}),R(e,r)):x(e).then(function(){return R(e,r)})})})}function M(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,M)}catch(t){}}function F(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,F)}catch(t){}}function P(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,P)}catch(t){}}var U=e(35),G=e(20),V=e(22),K=r(e(33)),J=e(31),z=r(e(37)),Q=e(29),$=r(e(12));o.prototype.add=function(e){return this.promise=this.promise[\"catch\"](function(){}).then(function(){return e()}),this.promise},o.prototype.finish=function(){return this.promise};var W={},H=new o,Y=50,X=U.guardedConsole.bind(null,\"log\"),Z={_sum:function(e,t){return _(t)},_count:function(e,t){return t.length},_stats:function(e,t){function n(e){for(var t=0,n=0,r=e.length;r>n;n++){var o=e[n];t+=o*o}return t}return{sum:_(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:n(t)}}},ee=Q.callbackify(function(){var e=this;return\"http\"===e.type()?T(e):\"function\"==typeof e._viewCleanup?O(e):B(e)}),te=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),t=t?b(t):{},\"function\"==typeof e&&(e={map:e});var r=this,o=K.resolve().then(function(){return N(r,e,t)});return Q.promisedCallback(o,n),o};$(M,Error),$(F,Error),$(P,Error);var ne={query:te,viewCleanup:ee};t.exports=ne}).call(this,e(36))},{12:12,20:20,22:22,29:29,31:31,33:33,35:35,36:36,37:37}],31:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){return c.btoa(e)}function i(e,t,n,r){(n>0||r<t.byteLength)&&(t=new Uint8Array(t,n,Math.min(r,t.byteLength)-n)),e.append(t)}function a(e,t,n,r){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t)}function s(e,t){function n(){var r=h*u,i=r+u;if(h++,c>h)v(p,e,r,i),l(n);else{v(p,e,r,i);var a=p.end(!0),s=o(a);t(s),p.destroy()}}var r=\"string\"==typeof e,s=r?e.length:e.byteLength,u=Math.min(d,s),c=Math.ceil(s/u),h=0,p=r?new f:new f.ArrayBuffer,v=r?a:i;n()}function u(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var c=e(20),f=r(e(38)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=s,n.stringMd5=u}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{20:20,38:38}],32:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var a=o.ids,s=a[2],u=o.pos;if(s.length)for(var c=0,f=s.length;f>c;c++)i.push({pos:u+1,ids:s[c]});else{var l=!!a[1].deleted,d=a[0];t&&!(r!==l?r:n!==u?u>n:d>t)||(t=d,n=u,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,a=i[2],s=t(0===a.length,o,i[0],n.ctx,i[1]),u=0,c=a.length;c>u;u++)r.push({pos:o+1,ids:a[u],ctx:s})}function i(e,t){return e.pos-t.pos}function a(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;r>n;n++)delete t[n].pos;return t}function s(e){for(var t=r(e),n=a(e.rev_tree),o=[],i=0,s=n.length;s>i;i++){var u=n[i];u.rev===t||u.opts.deleted||o.push(u.rev)}return o}function u(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function c(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,a=i[0],s=i[1],u=i[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:a,opts:s}),c&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=u.length;d>l;l++)r.push({pos:o+1,ids:u[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;i>o;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function h(e,t){for(var n,r,o=t,i=e.length;i>o;o++){var a=e[o],s=[a.id,a.opts,[]];r?(r[2].push(s),r=s):n=r=s}return n}function p(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,a=o.tree2;(i[1].status||a[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===a[1].status?\"available\":\"missing\");for(var s=0;s<a[2].length;s++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===a[2][s][0]&&(n.push({tree1:i[2][c],tree2:a[2][s]}),u=!0);u||(r=\"new_branch\",d(i[2],a[2][s],p))}else r=\"new_leaf\",i[2][0]=a[2][s]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,a=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var s=0,u=e.length;u>s;s++){var c=e[s];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=v(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,a=!0;else if(n!==!0){var l=c.pos<t.pos?c:t,d=c.pos<t.pos?t:c,h=d.pos-l.pos,p=[],y=[];for(y.push({ids:l.ids,diff:h,parent:null,parentIdx:null});y.length>0;){var _=y.pop();if(0!==_.diff)for(var m=_.ids[2],g=0,b=m.length;b>g;g++)y.push({ids:m[g],diff:_.diff-1,parent:_.ids,parentIdx:g});else _.ids[0]===d.ids[0]&&p.push(_)}var w=p[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,a=!0):o.push(c)}else o.push(c)}return a||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function _(e,t){for(var n,r=c(e),i={},a=0,s=r.length;s>a;a++){for(var u=r[a],f=u.ids,l=Math.max(0,f.length-t),d={pos:u.pos+l,ids:h(f,l)},p=0;l>p;p++){var v=u.pos+p+\"-\"+f[p].id;i[v]=!0}n=n?y(n,d,!0).tree:[d]}return o(n,function(e,t,n){delete i[t+\"-\"+n]}),{tree:n,revs:Object.keys(i)}}function m(e,t,n){var r=y(e,t),o=_(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function g(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),a=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===a)return!0;for(var s=n.ids[2],u=0,c=s.length;c>u;u++)r.push({pos:n.pos+1,ids:s[u]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=s,n.collectLeaves=a,n.compactTree=u,n.isDeleted=w,n.isLocalId=k,n.merge=m,n.revExists=g,n.rootToLeaf=c,n.traverseRevTree=o,n.winningRev=r},{}],33:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}var o=r(e(14)),i=\"function\"==typeof Promise?Promise:o;t.exports=i},{14:14}],34:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function a(e,t){var n=Object.keys(t._attachments);return g.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function s(e,t,n){var r=\"http\"===t.type()&&\"http\"!==e.type(),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return g.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))})[\"catch\"](function(e){if(404!==e.status)throw e;return a(t,n)}):a(t,n)}function u(e){var t=[];return Object.keys(e).forEach(function(n){var r=e[n].missing;r.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0}}function c(e,t,n,r){function i(){var o=u(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return g.all(n.results.map(function(n){return g.all(n.docs.map(function(n){var r=n.ok;return n.error&&(h=!1),r&&r._attachments?s(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){d=d.concat(m.flatten(e).filter(Boolean))})})}function a(e){return e._attachments&&Object.keys(e._attachments).length>0}function c(t){return e.allDocs({keys:t,include_docs:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){!e.deleted&&e.doc&&o(e.value.rev)&&!a(e.doc)&&(d.push(e.doc),delete n[e.id])})})}function f(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});return e.length>0?c(e):void 0}function l(){return{ok:h,docs:d}}n=m.clone(n);var d=[],h=!0;return g.resolve().then(f).then(i).then(l)}function f(e,t,n,r){return e.retry===!1?(t.emit(\"error\",n),void t.removeAllListeners()):(\"function\"!=typeof e.back_off_function&&(e.back_off_function=m.defaultBackOff),t.emit(\"requestError\",n),\"active\"!==t.state&&\"pending\"!==t.state||(t.emit(\"paused\",n),t.state=\"stopped\",t.once(\"active\",function(){e.current_back_off=A})),e.current_back_off=e.current_back_off||A,e.current_back_off=e.back_off_function(e.current_back_off),void setTimeout(r,e.current_back_off))}function l(e,t,n,r,o){function i(){return j?g.resolve():w(e,t,n).then(function(n){D=n,j=new b(e,t,D,r)})}function a(){if(G=[],0!==I.docs.length){var e=I.docs;return t.bulkDocs({docs:e,new_edits:!1}).then(function(t){if(r.cancelled)throw y(),new Error(\"cancelled\");var n=[],i={};t.forEach(function(e){e.error&&(o.doc_write_failures++,n.push(e),i[e.id]=e)}),U=U.concat(n),o.docs_written+=I.docs.length-n.length;var a=n.filter(function(e){return\"unauthorized\"!==e.name&&\"forbidden\"!==e.name});if(e.forEach(function(e){var t=i[e._id];t?r.emit(\"denied\",m.clone(t)):G.push(e)}),a.length>0){var s=new Error(\"bulkDocs error\");throw s.other_errors=n,v(\"target.bulkDocs failed to write docs\",s),new Error(\"bulkWrite partial failure\")}},function(t){throw o.doc_write_failures+=e.length,t})}}function s(){if(I.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=T=I.seq;var e=m.clone(o);return G.length&&(e.docs=G,r.emit(\"change\",e)),q=!0,j.writeCheckpoint(I.seq,V).then(function(){if(q=!1,r.cancelled)throw y(),new Error(\"cancelled\");I=void 0,S()})[\"catch\"](A)}function u(){var e={};return I.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw y(),new Error(\"cancelled\");I.diffs=e})}function d(){return c(e,t,I.diffs,r).then(function(e){I.error=!e.ok,e.docs.forEach(function(e){delete I.diffs[e._id],o.docs_read++,I.docs.push(e)})})}function h(){if(!r.cancelled&&!I){if(0===x.length)return void p(!0);I=x.shift(),u().then(d).then(a).then(s).then(h)[\"catch\"](function(e){v(\"batch processing terminated with error\",e)})}}function p(e){return 0===C.changes.length?void(0!==x.length||I||((B&&K.live||R)&&(r.state=\"pending\",r.emit(\"paused\")),R&&y())):void((e||R||C.changes.length>=N)&&(x.push(C),C={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),h()))}function v(e,t){L||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",o.errors.push(t),U=U.concat(t),x=[],C={seq:0,changes:[],docs:[]},y())}function y(){if(!(L||r.cancelled&&(o.status=\"cancelled\",q))){o.status=o.status||\"complete\",o.end_time=new Date,o.last_seq=T,L=!0;var i=U.filter(function(e){return\"unauthorized\"!==e.name&&\"forbidden\"!==e.name});if(i.length>0){var a=U.pop();U.length>0&&(a.other_errors=U),a.result=o,f(n,r,a,function(){l(e,t,n,r)})}else o.errors=U,r.emit(\"complete\",o),r.removeAllListeners()}}function _(e){if(r.cancelled)return y();var t=m.filterChange(n)(e);t&&(C.seq=e.seq,C.changes.push(e),p(0===x.length&&K.live))}function k(e){if(F=!1,r.cancelled)return y();if(e.results.length>0)K.since=e.last_seq,S(),p(!0);else{var t=function(){B?(K.live=!0,S()):R=!0,p(!0)};I||0!==e.results.length?t():(q=!0,j.writeCheckpoint(e.last_seq,V).then(function(){q=!1,o.last_seq=T=e.last_seq,t()})[\"catch\"](A))}}function E(e){return F=!1,r.cancelled?y():void v(\"changes rejected\",e)}function S(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!F&&!R&&x.length<M){F=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(K).on(\"change\",_);i.then(o,o),i.then(k)[\"catch\"](E),n.retry&&(r._changes=i,r._abortChanges=t)}}function O(){i().then(function(){return r.cancelled?void y():j.getCheckpoint().then(function(e){T=e,K={since:T,limit:N,batch_size:N,style:\"all_docs\",doc_ids:P,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?K.include_docs=!0:K.filter=n.filter),\"heartbeat\"in n&&(K.heartbeat=n.heartbeat),\"timeout\"in n&&(K.timeout=n.timeout),n.query_params&&(K.query_params=n.query_params),n.view&&(K.view=n.view),S()})})[\"catch\"](function(e){v(\"getCheckpoint rejected with \",e)})}function A(e){throw q=!1,v(\"writeCheckpoint completed with error\",e),e}var I,D,j,x=[],C={seq:0,changes:[],docs:[]},q=!1,R=!1,L=!1,T=0,B=n.continuous||n.live||!1,N=n.batch_size||100,M=n.batches_limit||10,F=!1,P=n.doc_ids,U=[],G=[],V=m.uuid();o=o||{ok:!0,start_time:new Date,docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var K={};return r.ready(e,t),r.cancelled?void y():(r._addedListeners||(r.once(\"cancel\",y),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void(\"undefined\"==typeof n.since?O():i().then(function(){return q=!0,j.writeCheckpoint(n.since,V)}).then(function(){return q=!1,r.cancelled?void y():(T=n.since,void O())})[\"catch\"](A)))}function d(){k.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new g(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e[\"catch\"]=function(e){return t[\"catch\"](e)},e[\"catch\"](function(){})}function h(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function p(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),\"undefined\"==typeof n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw S.createError(S.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=m.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n?n.retry:!1,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n),i=h(e,n),a=h(t,n);return l(i,a,n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),\"undefined\"==typeof n&&(n={}),n=m.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=h(e,n),t=h(t,n),new y(e,t,n,r)}function y(e,t,n,r){function o(e){h.emit(\"change\",{direction:\"pull\",change:e})}function i(e){h.emit(\"change\",{direction:\"push\",change:e})}function a(e){h.emit(\"denied\",{direction:\"push\",doc:e})}function s(e){h.emit(\"denied\",{direction:\"pull\",doc:e})}function u(){h.pushPaused=!0,h.pullPaused&&h.emit(\"paused\")}function c(){h.pullPaused=!0,h.pushPaused&&h.emit(\"paused\")}function f(){h.pushPaused=!1,h.pullPaused&&h.emit(\"active\",{direction:\"push\"})}function l(){h.pullPaused=!1,h.pushPaused&&h.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===s||n===a),p=\"paused\"===t&&(n===c||n===u),v=\"active\"===t&&(n===l||n===f);(r||d||p||v)&&(t in _||(_[t]={}),_[t][e]=!0,2===Object.keys(_[t]).length&&h.removeAllListeners(t))}}var h=this;this.canceled=!1;var v=n.push?O.extend({},n,n.push):n,y=n.pull?O.extend({},n,n.pull):n;this.push=p(e,t,v),this.pull=p(t,e,y),this.pushPaused=!0,this.pullPaused=!0;var _={};n.live&&(this.push.on(\"complete\",h.pull.cancel.bind(h.pull)),this.pull.on(\"complete\",h.push.cancel.bind(h.push))),this.on(\"newListener\",function(e){\"change\"===e?(h.pull.on(\"change\",o),h.push.on(\"change\",i)):\"denied\"===e?(h.pull.on(\"denied\",s),h.push.on(\"denied\",a)):\"active\"===e?(h.pull.on(\"active\",l),h.push.on(\"active\",f)):\"paused\"===e&&(h.pull.on(\"paused\",c),h.push.on(\"paused\",u))}),this.on(\"removeListener\",function(e){\"change\"===e?(h.pull.removeListener(\"change\",o),h.push.removeListener(\"change\",i)):\"denied\"===e?(h.pull.removeListener(\"denied\",s),h.push.removeListener(\"denied\",a)):\"active\"===e?(h.pull.removeListener(\"active\",l),h.push.removeListener(\"active\",f)):\"paused\"===e&&(h.pull.removeListener(\"paused\",c),h.push.removeListener(\"paused\",u))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var m=g.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return h.emit(\"complete\",t),r&&r(null,t),h.removeAllListeners(),t},function(e){if(h.cancel(),r?r(e):h.emit(\"error\",e),h.removeAllListeners(),r)throw e});this.then=function(e,t){return m.then(e,t)},this[\"catch\"]=function(e){return m[\"catch\"](e)}}function _(e){e.replicate=p,e.sync=v}var m=e(35),g=r(e(33)),b=r(e(21)),w=r(e(27)),k=e(10),E=r(e(12)),S=e(26),O=e(13),A=0;E(d,k.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},E(y,k.EventEmitter),y.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=_},{10:10,12:12,13:13,21:21,26:26,27:27,33:33,35:35}],35:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){return e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function a(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function s(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&Q.call(n)==$}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;r>n;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return a(e);if(!s(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);\"undefined\"!=typeof i&&(t[n]=i)}return t}function c(e){var t=!1;return G(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return G(function(n){n=u(n);var r,o=this,i=\"function\"==typeof n[n.length-1]?n.pop():!1;i&&(r=function(e,n){t.nextTick(function(){i(e,n)})});var a=new U(function(t,r){var i;try{var a=c(function(e,n){e?r(e):t(n)});n.push(a),i=e.apply(o,n),i&&\"function\"==typeof i.then&&t(i)}catch(s){r(s)}});return r&&a.then(function(e){r(null,e)},r),a})}function l(e,t){function n(e,t,n){if(W.enabled){for(var r=[e._db_name,t],o=0;o<n.length-1;o++)r.push(n[o]);W.apply(null,r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[e._db_name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),W.apply(null,o),i(n,r)}}}return f(G(function(r){if(this._closed)return U.reject(new Error(\"database is closed\"));if(this._destroyed)return U.reject(new Error(\"database is destroyed\"));var o=this;return n(o,e,r),this.taskqueue.isReady?t.apply(this,r):new U(function(t,n){o.taskqueue.addTask(function(i){i?n(i):t(o[e].apply(o,r))})})}))}function d(e,t){for(var n={},r=0,o=t.length;o>r;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function h(e){return e}function p(e){return[{ok:e}]}function v(e,t,n){function r(){var e=[];v.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){v[e]={id:t,docs:n},o()}function a(){if(!(_>=y.length)){var e=Math.min(_+H,y.length),t=y.slice(_,e);s(t,_),_+=t.length}}function s(n,r){n.forEach(function(n,o){var s=r+o,u=c[n],f=d(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(h);var l=h;0===f.open_revs.length&&(delete f.open_revs,l=p),[\"revs\",\"attachments\",\"binary\",\"ajax\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(s,n,r),a()})})}var u=t.docs,c={};u.forEach(function(e){e.id in c?c[e.id].push(e):c[e.id]=[e]});var f=Object.keys(c).length,l=0,v=new Array(f),y=Object.keys(c),_=0;a()}function y(){return\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage&&\"undefined\"!=typeof chrome.storage.local}function _(){return P}function m(e){y()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):_()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function g(){K.EventEmitter.call(this),this._listeners={},m(this)}function b(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){var n=6e5;e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||e>=t?t=(e||1)<<1:t+=1,t>n&&(e=n>>1,t=n);var r=Math.random(),o=t-e;return~~(o*r+e)}function k(e){var t=0;return e||(t=2e3),w(e,t)}function E(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function S(e,t){for(var n in t)if(t.hasOwnProperty(n)){var r=u(t[n]);\"undefined\"!=typeof r&&(e[n]=r)}}function O(e,t,n){return S(e,t),n&&S(e,n),e}function A(e,t,n){try{return!e(t,n)}catch(r){var o=\"Filter function threw: \"+r.toString();return z.createError(z.BAD_REQUEST,o)}}function I(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&A(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function D(e){for(var t=[],n=0,r=e.length;r>n;n++)t=t.concat(e[n]);return t}function j(){}function x(e){var t;if(e?\"string\"!=typeof e?t=z.createError(z.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=z.createError(z.RESERVED_ID)):t=z.createError(z.MISSING_ID),t)throw t}function C(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function q(e,t){return\"listenerCount\"in e?e.listenerCount(t):K.EventEmitter.listenerCount(e,t)}function R(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function L(e){var t=R(e);return t?t.join(\"/\"):null}function T(e){for(var t=oe.exec(e),n={},r=14;r--;){var o=te[r],i=t[r]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);n[o]=a?decodeURIComponent(i):i}return n[ne]={},n[te[12]].replace(re,function(e,t,r){t&&(n[ne][t]=r)}),n}function B(e,t,n){return new U(function(r,o){e.get(t,function(i,a){if(i){if(404!==i.status)return o(i);a={}}var s=a._rev,u=n(a);return u?(u._id=t,u._rev=s,void r(N(e,u,n))):r({updated:!1,rev:s})})})}function N(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return B(e,t._id,n)})}function M(e){return 0|Math.random()*e}function F(e,t){t=t||ie.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=ie[M(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=ie[3&M(16)|8];break;default:n+=ie[M(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var P,U=r(e(33)),G=r(e(7)),V=r(e(8)),K=e(10),J=r(e(12)),z=e(26),Q=Function.prototype.toString,$=Q.call(Object),W=V(\"pouchdb:api\"),H=6;if(y())P=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),P=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(Y){P=!1}J(g,K.EventEmitter),g.prototype.addListener=function(e,t,n,r){function o(){function e(){a=!1}if(i._listeners[t]){if(a)return void(a=\"waiting\");a=!0;var s=d(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(s).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===a&&setTimeout(function(){o()},0),a=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,a=!1;this._listeners[t]=o,this.on(e,o)}},g.prototype.removeListener=function(e,t){t in this._listeners&&K.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t])},g.prototype.notifyLocalWindows=function(e){y()?chrome.storage.local.set({dbName:e}):_()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},g.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var X,Z=j.name;X=Z?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ee=X,te=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],ne=\"queryKey\",re=/(?:^|&)([^&=]*)=?([^&]*)/g,oe=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ie=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=l,n.bulkGetShim=v,n.changesHandler=g,n.clone=u,n.defaultBackOff=k,n.explainError=E,n.extend=O,n.filterChange=I,n.flatten=D,n.functionName=ee,n.guardedConsole=b,n.hasLocalStorage=_,n.invalidIdError=x,n.isChromeApp=y,n.isCordova=C,n.listenerCount=q,n.normalizeDdocFunctionName=L,n.once=c,n.parseDdocFunctionName=R,n.parseUri=T,n.pick=d,n.toPromise=f,n.upsert=B,n.uuid=F}).call(this,e(36))},{10:10,12:12,26:26,33:33,36:36,7:7,8:8}],36:[function(e,t,n){function r(){if(!s){s=!0;for(var e,t=a.length;t;){e=a,a=[];for(var n=-1;++n<t;)e[n]();t=a.length}s=!1}}function o(){}var i=t.exports={},a=[],s=!1;i.nextTick=function(e){a.push(e),s||setTimeout(r,0)},i.title=\"browser\",i.browser=!0,i.env={},i.argv=[],i.version=\"\",i.versions={},i.on=o,i.addListener=o,i.once=o,i.off=o,i.removeListener=o,i.removeAllListeners=o,i.emit=o,i.binding=function(e){throw new Error(\"process.binding is not supported\")},i.cwd=function(){return\"/\"},i.chdir=function(e){throw new Error(\"process.chdir is not supported\")},i.umask=function(){return 0}},{}],37:[function(e,t,n){(function(){var e={}.hasOwnProperty,n=[].slice;t.exports=function(t,r){var o,i,a,s;i=[],s=[];for(o in r)e.call(r,o)&&(a=r[o],\"this\"!==o&&(i.push(o),s.push(a)));return Function.apply(null,n.call(i).concat([t])).apply(r[\"this\"],s)}}).call(this)},{}],38:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(o){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t,n,r,o,i){return t=g(g(t,e),g(r,i)),g(t<<o|t>>>32-o,n)}function n(e,n,r,o,i,a,s){return t(n&r|~n&o,e,n,i,a,s)}function r(e,n,r,o,i,a,s){return t(n&o|r&~o,e,n,i,a,s)}function o(e,n,r,o,i,a,s){return t(n^r^o,e,n,i,a,s)}function i(e,n,r,o,i,a,s){return t(r^(n|~o),e,n,i,a,s)}function a(e,t){var a=e[0],s=e[1],u=e[2],c=e[3];a=n(a,s,u,c,t[0],7,-680876936),c=n(c,a,s,u,t[1],12,-389564586),u=n(u,c,a,s,t[2],17,606105819),s=n(s,u,c,a,t[3],22,-1044525330),a=n(a,s,u,c,t[4],7,-176418897),c=n(c,a,s,u,t[5],12,1200080426),u=n(u,c,a,s,t[6],17,-1473231341),s=n(s,u,c,a,t[7],22,-45705983),a=n(a,s,u,c,t[8],7,1770035416),c=n(c,a,s,u,t[9],12,-1958414417),u=n(u,c,a,s,t[10],17,-42063),s=n(s,u,c,a,t[11],22,-1990404162),a=n(a,s,u,c,t[12],7,1804603682),c=n(c,a,s,u,t[13],12,-40341101),u=n(u,c,a,s,t[14],17,-1502002290),s=n(s,u,c,a,t[15],22,1236535329),a=r(a,s,u,c,t[1],5,-165796510),c=r(c,a,s,u,t[6],9,-1069501632),u=r(u,c,a,s,t[11],14,643717713),s=r(s,u,c,a,t[0],20,-373897302),a=r(a,s,u,c,t[5],5,-701558691),c=r(c,a,s,u,t[10],9,38016083),u=r(u,c,a,s,t[15],14,-660478335),s=r(s,u,c,a,t[4],20,-405537848),a=r(a,s,u,c,t[9],5,568446438),c=r(c,a,s,u,t[14],9,-1019803690),u=r(u,c,a,s,t[3],14,-187363961),s=r(s,u,c,a,t[8],20,1163531501),a=r(a,s,u,c,t[13],5,-1444681467),c=r(c,a,s,u,t[2],9,-51403784),u=r(u,c,a,s,t[7],14,1735328473),s=r(s,u,c,a,t[12],20,-1926607734),a=o(a,s,u,c,t[5],4,-378558),\nc=o(c,a,s,u,t[8],11,-2022574463),u=o(u,c,a,s,t[11],16,1839030562),s=o(s,u,c,a,t[14],23,-35309556),a=o(a,s,u,c,t[1],4,-1530992060),c=o(c,a,s,u,t[4],11,1272893353),u=o(u,c,a,s,t[7],16,-155497632),s=o(s,u,c,a,t[10],23,-1094730640),a=o(a,s,u,c,t[13],4,681279174),c=o(c,a,s,u,t[0],11,-358537222),u=o(u,c,a,s,t[3],16,-722521979),s=o(s,u,c,a,t[6],23,76029189),a=o(a,s,u,c,t[9],4,-640364487),c=o(c,a,s,u,t[12],11,-421815835),u=o(u,c,a,s,t[15],16,530742520),s=o(s,u,c,a,t[2],23,-995338651),a=i(a,s,u,c,t[0],6,-198630844),c=i(c,a,s,u,t[7],10,1126891415),u=i(u,c,a,s,t[14],15,-1416354905),s=i(s,u,c,a,t[5],21,-57434055),a=i(a,s,u,c,t[12],6,1700485571),c=i(c,a,s,u,t[3],10,-1894986606),u=i(u,c,a,s,t[10],15,-1051523),s=i(s,u,c,a,t[1],21,-2054922799),a=i(a,s,u,c,t[8],6,1873313359),c=i(c,a,s,u,t[15],10,-30611744),u=i(u,c,a,s,t[6],15,-1560198380),s=i(s,u,c,a,t[13],21,1309151649),a=i(a,s,u,c,t[4],6,-145523070),c=i(c,a,s,u,t[11],10,-1120210379),u=i(u,c,a,s,t[2],15,718787259),s=i(s,u,c,a,t[9],21,-343485551),e[0]=g(a,e[0]),e[1]=g(s,e[1]),e[2]=g(u,e[2]),e[3]=g(c,e[3])}function s(e){var t,n=[];for(t=0;64>t;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function u(e){var t,n=[];for(t=0;64>t;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function c(e){var t,n,r,o,i,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;c>=t;t+=64)a(f,s(e.substring(t-64,t)));for(e=e.substring(t-64),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;n>t;t+=1)r[t>>2]|=e.charCodeAt(t)<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(a(f,r),t=0;16>t;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),u=parseInt(o[1],16)||0,r[14]=i,r[15]=u,a(f,r),f}function f(e){var t,n,r,o,i,s,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;c>=t;t+=64)a(f,u(e.subarray(t-64,t)));for(e=c>t-64?e.subarray(t-64):new Uint8Array(0),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;n>t;t+=1)r[t>>2]|=e[t]<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(a(f,r),t=0;16>t;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),s=parseInt(o[1],16)||0,r[14]=i,r[15]=s,a(f,r),f}function l(e){var t,n=\"\";for(t=0;4>t;t+=1)n+=b[e>>8*t+4&15]+b[e>>8*t&15];return n}function d(e){var t;for(t=0;t<e.length;t+=1)e[t]=l(e[t]);return e.join(\"\")}function h(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function p(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;r>n;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function v(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function y(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function _(e){var t,n=[],r=e.length;for(t=0;r-1>t;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function m(){this.reset()}var g=function(e,t){return e+t&4294967295},b=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==d(c(\"hello\"))&&(g=function(e,t){var n=(65535&e)+(65535&t),r=(e>>16)+(t>>16)+(n>>16);return r<<16|65535&n}),\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||!function(){function t(e,t){return e=0|e||0,0>e?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,a,s,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),a=new Uint8Array(i),s=new Uint8Array(this,c,o),a.set(s),i)}}(),m.prototype.append=function(e){return this.appendBinary(h(e)),this},m.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var t,n=this._buff.length;for(t=64;n>=t;t+=64)a(this._hash,s(this._buff.substring(t-64,t)));return this._buff=this._buff.substring(t-64),this},m.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;o>t;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=_(n)),this.reset(),n},m.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},m.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},m.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},m.prototype._finish=function(e,t){var n,r,o,i=t;if(e[i>>2]|=128<<(i%4<<3),i>55)for(a(this._hash,e),i=0;16>i;i+=1)e[i]=0;n=8*this._length,n=n.toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(n[2],16),o=parseInt(n[1],16)||0,e[14]=r,e[15]=o,a(this._hash,e)},m.hash=function(e,t){return m.hashBinary(h(e),t)},m.hashBinary=function(e,t){var n=c(e),r=d(n);return t?_(r):r},m.ArrayBuffer=function(){this.reset()},m.ArrayBuffer.prototype.append=function(e){var t,n=y(this._buff.buffer,e,!0),r=n.length;for(this._length+=e.byteLength,t=64;r>=t;t+=64)a(this._hash,u(n.subarray(t-64,t)));return this._buff=r>t-64?new Uint8Array(n.buffer.slice(t-64)):new Uint8Array(0),this},m.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;o>t;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=_(n)),this.reset(),n},m.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.ArrayBuffer.prototype.getState=function(){var e=m.prototype.getState.call(this);return e.buff=v(e.buff),e},m.ArrayBuffer.prototype.setState=function(e){return e.buff=p(e.buff,!0),m.prototype.setState.call(this,e)},m.ArrayBuffer.prototype.destroy=m.prototype.destroy,m.ArrayBuffer.prototype._finish=m.prototype._finish,m.ArrayBuffer.hash=function(e,t){var n=f(new Uint8Array(e)),r=d(n);return t?_(r):r},m})},{}],39:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var a=t.pop();o[a]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,a,s,u,c,f,l,d,h=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",h+=o,i)h+=i;else if(\"object\"!=typeof r)h+=\"undefined\"==typeof r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),a=r.length-1;a>=0;a--)s=0===a?\"\":\",\",t.push({obj:r[a],prefix:s});t.push({val:\"[\"})}else{u=[];for(c in r)r.hasOwnProperty(c)&&u.push(c);for(t.push({val:\"}\"}),a=u.length-1;a>=0;a--)f=u[a],l=r[f],d=a>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,o,i,a,s,u,c,f,l=[],d=[],h=0;;)if(t=e[h++],\"}\"!==t&&\"]\"!==t&&\"undefined\"!=typeof t)switch(t){case\" \":case\"\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,r(null,l,d);break;case\"t\":h+=3,r(!0,l,d);break;case\"f\":h+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(o=e[h++],!/[\\d\\.\\-e\\+]/.test(o)){h--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",a=void 0,s=0;;){if(u=e[h++],'\"'===u&&(\"\\\\\"!==a||s%2!==1))break;i+=u,a=u,\"\\\\\"===a?s++:s=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":c={element:[],index:l.length},l.push(c.element),d.push(c);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[1]);";
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