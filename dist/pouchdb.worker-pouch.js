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
      api.constructor.emit('destroyed', api._name);
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
module.exports = "!function e(t,n,r){function o(i,a){if(!n[i]){if(!t[i]){var c=\"function\"==typeof require&&require;if(!a&&c)return c(i,!0);if(s)return s(i,!0);var u=new Error(\"Cannot find module '\"+i+\"'\");throw u.code=\"MODULE_NOT_FOUND\",u}var f=n[i]={exports:{}};t[i][0].call(f.exports,function(e){var n=t[i][1][e];return o(n?n:e)},f,f.exports,e,t,n,r)}return n[i].exports}for(var s=\"function\"==typeof require&&require,i=0;i<r.length;i++)o(r[i]);return o}({1:[function(e,t,n){\"use strict\";var r=e(3),o=e(4);r(self,o)},{3:3,4:4}],2:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}var o=e(12);o(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,s=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),i=r&&s.filter(function(e){var t=o[e];return t.message===r})[0]||s[0];return i?o[i]:null},n.generateErrorFromResponse=function(e){var t,r,o,s,i,a=n;return r=e.error===!0&&\"string\"==typeof e.name?e.name:e.error,i=e.reason,o=a.getErrorTypeByProp(\"name\",r,i),e.missing||\"missing\"===i||\"deleted\"===i||\"not_found\"===r?o=a.MISSING_DOC:\"doc_validation\"===r?(o=a.DOC_VALIDATION,s=i):\"bad_request\"===r&&o.message!==i&&(0===i.indexOf(\"unknown stub attachment\")?(o=a.MISSING_STUB,s=i):o=a.BAD_REQUEST),o||(o=a.getErrorTypeByProp(\"status\",e.status,i)||a.UNKNOWN_ERROR),t=a.error(o,i,r),s&&(t.message=s),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],3:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){f(\" -> sendUncaughtError\",t,n),e.postMessage({type:\"uncaughtError\",id:t,content:i.createError(n)})}function r(t,n,r){f(\" -> sendError\",t,n,r),e.postMessage({type:\"error\",id:t,messageId:n,content:i.createError(r)})}function l(t,n,r){f(\" -> sendSuccess\",t,n),e.postMessage({type:\"success\",id:t,messageId:n,content:r})}function d(t,n,r){f(\" -> sendUpdate\",t,n),e.postMessage({type:\"update\",id:t,messageId:n,content:r})}function p(e,t,n,s){var i=c[\"$\"+e];return i?void o.resolve().then(function(){return i[t].apply(i,s)}).then(function(t){l(e,n,t)})[\"catch\"](function(t){r(e,n,t)}):r(e,n,{error:\"db not found\"})}function h(e,t,n){var r=n[0];r&&\"object\"==typeof r&&(r.returnDocs=!0,r.return_docs=!0),p(e,\"changes\",t,n)}function v(e,t,n){var i=c[\"$\"+e];return i?void o.resolve().then(function(){var r=n[0],o=n[1],a=n[2];return\"object\"!=typeof a&&(a={}),i.get(r,a).then(function(r){if(!r._attachments||!r._attachments[o])throw s.MISSING_DOC;return i.getAttachment.apply(i,n).then(function(n){l(e,t,n)})})})[\"catch\"](function(n){r(e,t,n)}):r(e,t,{error:\"db not found\"})}function m(e,t,n){var s=\"$\"+e,i=c[s];return i?(delete c[s],void o.resolve().then(function(){return i.destroy.apply(i,n)}).then(function(n){l(e,t,n)})[\"catch\"](function(n){r(e,t,n)})):r(e,t,{error:\"db not found\"})}function _(e,t,n){var s=c[\"$\"+e];return s?void o.resolve().then(function(){var o=s.changes(n[0]);u[t]=o,o.on(\"change\",function(n){d(e,t,n)}).on(\"complete\",function(n){o.removeAllListeners(),delete u[t],l(e,t,n)}).on(\"error\",function(n){o.removeAllListeners(),delete u[t],r(e,t,n)})}):r(e,t,{error:\"db not found\"})}function y(e){var t=u[e];t&&t.cancel()}function g(e,t){return o.resolve().then(function(){e.on(\"error\",function(e){n(t,e)})})}function b(e,n,o){var s=\"$\"+e,i=c[s];if(i)return g(i,e).then(function(){return l(e,n,{ok:!0,exists:!0})});var a=\"string\"==typeof o[0]?o[0]:o[0].name;return a?(i=c[s]=t(o[0]),void g(i,e).then(function(){l(e,n,{ok:!0})})[\"catch\"](function(t){r(e,n,t)})):r(e,n,{error:\"you must provide a database name\"})}function w(e,t,n,o){switch(f(\"onReceiveMessage\",t,e,n,o),t){case\"createDatabase\":return b(e,n,o);case\"id\":return void l(e,n,e);case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":return p(e,t,n,o);case\"changes\":return h(e,n,o);case\"getAttachment\":return v(e,n,o);case\"liveChanges\":return _(e,n,o);case\"cancelChanges\":return y(n);case\"destroy\":return m(e,n,o);default:return r(e,n,{error:\"unknown API method: \"+t})}}function E(e,t){var n=e.type,r=e.messageId,o=a(e.args);w(t,n,r,o)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete c[\"$\"+t]):E(e.data,t)}})}var o=e(20),s=e(2),i=e(6),a=i.decodeArgs,c={},u={},f=e(8)(\"pouchdb:worker\");t.exports=r},{2:2,20:20,6:6,8:8}],4:[function(e,t,n){\"use strict\";t.exports=e(17).plugin(\"pouchdb-adapter-idb\").plugin(\"pouchdb-adapter-http\").plugin(\"pouchdb-mapreduce\").plugin(\"pouchdb-replication\")},{17:17}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){function r(){return\"WebkitAppearance\"in document.documentElement.style||window.console&&(console.firebug||console.exception&&console.table)||navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31}function o(){var e=arguments,t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),!t)return e;var r=\"color: \"+this.color;e=[e[0],r,\"color: inherit\"].concat(Array.prototype.slice.call(e,1));var o=0,s=0;return e[0].replace(/%[a-z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(s=o))}),e.splice(s,0,r),e}function s(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function i(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(t){}}function a(){var e;try{e=n.storage.debug}catch(t){}return e}function c(){try{return window.localStorage}catch(e){}}n=t.exports=e(9),n.log=s,n.formatArgs=o,n.save=i,n.load=a,n.useColors=r,n.storage=\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage?chrome.storage.local:c(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){return JSON.stringify(e)},n.enable(a())},{9:9}],9:[function(e,t,n){function r(){return n.colors[f++%n.colors.length]}function o(e){function t(){}function o(){var e=o,t=+new Date,s=t-(u||t);e.diff=s,e.prev=u,e.curr=t,u=t,null==e.useColors&&(e.useColors=n.useColors()),null==e.color&&e.useColors&&(e.color=r());var i=Array.prototype.slice.call(arguments);i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&(i=[\"%o\"].concat(i));var a=0;i[0]=i[0].replace(/%([a-z%])/g,function(t,r){if(\"%%\"===t)return t;a++;var o=n.formatters[r];if(\"function\"==typeof o){var s=i[a];t=o.call(e,s),i.splice(a,1),a--}return t}),\"function\"==typeof n.formatArgs&&(i=n.formatArgs.apply(e,i));var c=o.log||n.log||console.log.bind(console);c.apply(e,i)}t.enabled=!1,o.enabled=!0;var s=n.enabled(e)?o:t;return s.namespace=e,s}function s(e){n.save(e);for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;r>o;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function i(){n.enable(\"\")}function a(e){var t,r;for(t=0,r=n.skips.length;r>t;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;r>t;t++)if(n.names[t].test(e))return!0;return!1}function c(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o,n.coerce=c,n.disable=i,n.enable=s,n.enabled=a,n.humanize=e(15),n.names=[],n.skips=[],n.formatters={};var u,f=0},{15:15}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function s(e){return\"number\"==typeof e}function i(e){return\"object\"==typeof e&&null!==e}function a(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!s(e)||0>e||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,s,c,u;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||i(this._events.error)&&!this._events.error.length)){if(t=arguments[1],t instanceof Error)throw t;throw TypeError('Uncaught, unspecified \"error\" event.')}if(n=this._events[e],a(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:for(r=arguments.length,s=new Array(r-1),c=1;r>c;c++)s[c-1]=arguments[c];n.apply(this,s)}else if(i(n)){for(r=arguments.length,s=new Array(r-1),c=1;r>c;c++)s[c-1]=arguments[c];for(u=n.slice(),r=u.length,c=0;r>c;c++)u[c].apply(this,s)}return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");if(this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?i(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,i(this._events[e])&&!this._events[e].warned){var n;n=a(this._maxListeners)?r.defaultMaxListeners:this._maxListeners,n&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace())}return this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,s,a;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],s=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(i(n)){for(a=s;a-- >0;)if(n[a]===t||n[a].listener&&n[a].listener===t){r=a;break}if(0>r)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){var t;return t=this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.listenerCount=function(e,t){var n;return n=e._events&&e._events[t]?o(e._events[t])?1:e._events[t].length:0}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,s=e.MutationObserver||e.WebKitMutationObserver;if(s){var i=0,a=new s(n),c=e.document.createTextNode(\"\");a.observe(c,{characterData:!0}),o=function(){c.data=i=++i%2}}else if(e.setImmediate||\"undefined\"==typeof e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var u=new e.MessageChannel;u.port1.onmessage=n,o=function(){u.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){(function(e){e(\"object\"==typeof n?n:this)}).call(this,function(e){var t=Array.prototype.slice,n=Array.prototype.forEach,r=function(e){if(\"object\"!=typeof e)throw e+\" is not an object\";var o=t.call(arguments,1);return n.call(o,function(t){if(t)for(var n in t)\"object\"==typeof t[n]&&e[n]?r.call(e,e[n],t[n]):e[n]=t[n]}),e};e.extend=r})},{}],14:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=y,this.queue=[],this.outcome=void 0,e!==r&&c(this,e)}function s(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function i(e,t,n){h(function(){var r;try{r=t(n)}catch(o){return v.reject(e,o)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function a(e){var t=e&&e.then;return e&&\"object\"==typeof e&&\"function\"==typeof t?function(){t.apply(e,arguments)}:void 0}function c(e,t){function n(t){s||(s=!0,v.reject(e,t))}function r(t){s||(s=!0,v.resolve(e,t))}function o(){t(r,n)}var s=!1,i=u(o);\"error\"===i.status&&n(i.value)}function u(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(r){n.status=\"error\",n.value=r}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){function t(e,t){function r(e){i[t]=e,++a!==o||s||(s=!0,v.resolve(u,i))}n.resolve(e).then(r,function(e){s||(s=!0,v.reject(u,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,s=!1;if(!o)return this.resolve([]);for(var i=new Array(o),a=0,c=-1,u=new this(r);++c<o;)t(e[c],c);return u}function p(e){function t(e){n.resolve(e).then(function(e){s||(s=!0,v.resolve(a,e))},function(e){s||(s=!0,v.reject(a,e))})}var n=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var o=e.length,s=!1;if(!o)return this.resolve([]);for(var i=-1,a=new this(r);++i<o;)t(e[i]);return a}var h=e(11),v={},m=[\"REJECTED\"],_=[\"FULFILLED\"],y=[\"PENDING\"];t.exports=o,o.prototype[\"catch\"]=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===_||\"function\"!=typeof t&&this.state===m)return this;var n=new this.constructor(r);if(this.state!==y){var o=this.state===_?e:t;i(n,o,this.outcome)}else this.queue.push(new s(n,e,t));return n},s.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},s.prototype.otherCallFulfilled=function(e){i(this.promise,this.onFulfilled,e)},s.prototype.callRejected=function(e){v.reject(this.promise,e)},s.prototype.otherCallRejected=function(e){i(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=u(a,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)c(e,r);else{e.state=_,e.outcome=t;for(var o=-1,s=e.queue.length;++o<s;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=m,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=p},{11:11}],15:[function(e,t,n){function r(e){if(e=\"\"+e,!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]),r=(t[2]||\"ms\").toLowerCase();switch(r){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*u;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*c;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*a;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=u?Math.round(e/u)+\"h\":e>=c?Math.round(e/c)+\"m\":e>=a?Math.round(e/a)+\"s\":e+\"ms\"}function s(e){return i(e,f,\"day\")||i(e,u,\"hour\")||i(e,c,\"minute\")||i(e,a,\"second\")||e+\" ms\"}function i(e,t,n){return t>e?void 0:1.5*t>e?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var a=1e3,c=60*a,u=60*c,f=24*u,l=365.25*f;t.exports=function(e,t){return t=t||{},\"string\"==typeof e?r(e):t[\"long\"]?s(e):o(e)}},{}],16:[function(e,t,n){\"use strict\";function r(){this.store={}}function o(e){if(this.store=new r,e&&Array.isArray(e))for(var t=0,n=e.length;n>t;t++)this.add(e[t])}n.Map=r,n.Set=o,r.prototype.mangle=function(e){if(\"string\"!=typeof e)throw new TypeError(\"key must be a string but Got \"+e);return\"$\"+e},r.prototype.unmangle=function(e){return e.substring(1)},r.prototype.get=function(e){var t=this.mangle(e);return t in this.store?this.store[t]:void 0},r.prototype.set=function(e,t){var n=this.mangle(e);return this.store[n]=t,!0},r.prototype.has=function(e){var t=this.mangle(e);return t in this.store},r.prototype[\"delete\"]=function(e){var t=this.mangle(e);return t in this.store?(delete this.store[t],!0):!1},r.prototype.forEach=function(e){for(var t=Object.keys(this.store),n=0,r=t.length;r>n;n++){var o=t[n],s=this.store[o];o=this.unmangle(o),e(s,o)}},o.prototype.add=function(e){return this.store.set(e,!0)},o.prototype.has=function(e){return this.store.has(e)},o.prototype[\"delete\"]=function(e){return this.store[\"delete\"](e)}},{}],17:[function(e,t,n){(function(n,r){\"use strict\";function o(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function s(e){return j(\"return \"+e+\";\",{})}function i(e){return new Function(\"doc\",[\"var emitted = false;\",\"var emit = function (a, b) {\",\"  emitted = true;\",\"};\",\"var view = \"+e+\";\",\"view(doc);\",\"if (emitted) {\",\"  return true;\",\"}\"].join(\"\\n\"))}function a(e,t){try{e.emit(\"change\",t)}catch(n){x.guardedConsole(\"error\",'Error in .on(\"change\", function):',n)}}function c(e,t,n){function r(){o.cancel()}N.EventEmitter.call(this);var o=this;this.db=e,t=t?x.clone(t):{};var s=t.complete=x.once(function(t,n){t?x.listenerCount(o,\"error\")>0&&o.emit(\"error\",t):o.emit(\"complete\",n),o.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(o.on(\"complete\",function(e){n(null,e)}),o.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){t.isCancelled||(a(o,e),o.startSeq&&o.startSeq<=e.seq&&(o.startSeq=!1))};var i=new R(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});o.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=i.then.bind(i),this[\"catch\"]=i[\"catch\"].bind(i),this.then(function(e){s(null,e)},s),e.taskqueue.isReady?o.doChanges(t):e.taskqueue.addTask(function(){o.isCancelled?o.emit(\"cancel\"):o.doChanges(t)})}function u(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=C.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return C.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=C.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function f(e,t){return t>e?-1:e>t?1:0}function l(e,t){for(var n=0;n<e.length;n++)if(t(e[n],n)===!0)return e[n]}function d(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function p(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var s=r[o];n._attachments[s]=x.pick(n._attachments[s],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function h(e,t){var n=f(e._id,t._id);if(0!==n)return n;var r=e._revisions?e._revisions.start:0,o=t._revisions?t._revisions.start:0;return f(r,o)}function v(e){var t={},n=[];return C.traverseRevTree(e,function(e,r,o,s){var i=r+\"-\"+o;return e&&(t[i]=0),void 0!==s&&n.push({from:s,to:i}),i}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function m(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return R.all(r.map(function(n){var r=I.extend({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new R(function(t,s){e._allDocs(r,function(e,r){return e?s(e):(o.total_rows=r.total_rows,void t(r.rows[0]||{key:n,error:\"not_found\"}))})})})).then(function(e){return o.rows=e,o})}function _(e){var t=e._compactionQueue[0],r=t.opts,o=t.callback;e.get(\"_local/compaction\")[\"catch\"](function(){return!1}).then(function(t){t&&t.last_seq&&(r.last_seq=t.last_seq),e._compact(r,function(t,r){t?o(t):o(null,r),n.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&_(e)})})})}function y(e){return\"_\"===e.charAt(0)?e+\"is not a valid attachment name, attachment names cannot start with '_'\":!1}function g(){N.EventEmitter.call(this)}function b(){this.isReady=!1,this.failed=!1,this.queue=[]}function w(e){e&&r.debug&&x.guardedConsole(\"error\",e)}function E(e,t){function n(){s.emit(\"destroyed\",o)}function r(){e.removeListener(\"destroyed\",n),e.emit(\"destroyed\",e)}var o=t.originalName,s=e.constructor,i=s._destructionListeners;e.once(\"destroyed\",n),i.has(o)||i.set(o,[]),i.get(o).push(r)}function k(e,t,n){if(!(this instanceof k))return new k(e,t,n);var r=this;if(\"function\"!=typeof t&&\"undefined\"!=typeof t||(n=t,t={}),e&&\"object\"==typeof e&&(t=e,e=void 0),\"undefined\"==typeof n)n=w;else{var o=n;n=function(){return x.guardedConsole(\"warn\",\"Using a callback for new PouchDB()is deprecated.\"),o.apply(null,arguments)}}e=e||t.name,t=x.clone(t),delete t.name,this.__opts=t;var s=n;r.auto_compaction=t.auto_compaction,r.prefix=k.prefix,g.call(r),r.taskqueue=new b;var i=new R(function(o,s){n=function(e,t){return e?s(e):(delete t.then,void o(t))},t=x.clone(t);var i,a;return function(){try{if(\"string\"!=typeof e)throw a=new Error(\"Missing/invalid DB name\"),a.code=400,a;var n=(t.prefix||\"\")+e;if(i=k.parseAdapter(n,t),t.originalName=e,t.name=i.name,t.adapter=t.adapter||i.adapter,r._adapter=t.adapter,O(\"pouchdb:adapter\")(\"Picked adapter: \"+t.adapter),r._db_name=e,!k.adapters[t.adapter])throw a=new Error(\"Adapter is missing\"),a.code=404,a;if(!k.adapters[t.adapter].valid())throw a=new Error(\"Invalid Adapter\"),a.code=404,a}catch(o){r.taskqueue.fail(o)}}(),a?s(a):(r.adapter=t.adapter,r.replicate={},r.replicate.from=function(e,t,n){return r.constructor.replicate(e,r,t,n)},r.replicate.to=function(e,t,n){return r.constructor.replicate(r,e,t,n)},r.sync=function(e,t,n){return r.constructor.sync(r,e,t,n)},r.replicate.sync=r.sync,void k.adapters[t.adapter].call(r,t,function(e){return e?(r.taskqueue.fail(e),void n(e)):(E(r,t),r.emit(\"created\",r),k.emit(\"created\",t.originalName),r.taskqueue.ready(r),void n(null,r))}))});i.then(function(e){s(null,e)},s),r.then=i.then.bind(i),r[\"catch\"]=i[\"catch\"].bind(i)}function D(e){Object.keys(N.EventEmitter.prototype).forEach(function(t){\"function\"==typeof N.EventEmitter.prototype[t]&&(e[t]=T[t].bind(T))});var t=e._destructionListeners=new S.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t[\"delete\"](e)})}var I=e(13),O=o(e(8)),A=o(e(12)),R=o(e(20)),S=e(16),L=o(e(7)),N=e(10),x=e(21),C=e(19),j=o(e(23)),q=e(18);A(c,N.EventEmitter),c.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},c.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=x.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=u,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){return t.isCancelled?void n(null,{status:\"cancelled\"}):(e.since=r.update_seq,void t.doChanges(e))},n);if(e.continuous&&\"now\"!==e.since&&this.db.info().then(function(e){t.startSeq=e.update_seq},function(e){if(\"idbNull\"!==e.id)throw e}),e.view&&!e.filter&&(e.filter=\"_view\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=x.normalizeDdocFunctionName(e.view):e.filter=x.normalizeDdocFunctionName(e.filter),\"http\"!==this.db.type()&&!e.doc_ids))return this.filterChanges(e);\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=L(function(e){r.cancel(),o.apply(this,e)})}},c.prototype.filterChanges=function(e){var t=this,n=e.complete;if(\"_view\"===e.filter){if(!e.view||\"string\"!=typeof e.view){var r=q.createError(q.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(r)}var o=x.parseDdocFunctionName(e.view);this.db.get(\"_design/\"+o[0],function(r,s){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(q.generateErrorFromResponse(r));var a=s&&s.views&&s.views[o[1]]&&s.views[o[1]].map;return a?(e.filter=i(a),void t.doChanges(e)):n(q.createError(q.MISSING_DOC,s.views?\"missing json key: \"+o[1]:\"missing json key: views\"))})}else{var a=x.parseDdocFunctionName(e.filter);if(!a)return t.doChanges(e);this.db.get(\"_design/\"+a[0],function(r,o){if(t.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(q.generateErrorFromResponse(r));var i=o&&o.filters&&o.filters[a[1]];return i?(e.filter=s(i),void t.doChanges(e)):n(q.createError(q.MISSING_DOC,o&&o.filters?\"missing json key: \"+a[1]:\"missing json key: filters\"))})}},A(g,N.EventEmitter),g.prototype.post=x.adapterFun(\"post\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(q.createError(q.NOT_AN_OBJECT)):void this.bulkDocs({docs:[e]},t,d(n))}),g.prototype.put=x.adapterFun(\"put\",L(function(e){function t(){i||(x.guardedConsole(\"warn\",\"db.put(doc, id, rev) has been deprecated and will be removed in a future release, please use db.put({_id: id, _rev: rev}) instead\"),i=!0)}var n,r,o,s,i=!1,a=e.shift(),c=\"_id\"in a;if(\"object\"!=typeof a||Array.isArray(a))return(s=e.pop())(q.createError(q.NOT_AN_OBJECT));for(;;)if(n=e.shift(),r=typeof n,\"string\"!==r||c?\"string\"!==r||!c||\"_rev\"in a?\"object\"===r?o=n:\"function\"===r&&(s=n):(t(),a._rev=n):(t(),a._id=n,c=!0),!e.length)break;return o=o||{},x.invalidIdError(a._id),C.isLocalId(a._id)&&\"function\"==typeof this._putLocal?a._deleted?this._removeLocal(a,s):this._putLocal(a,s):void this.bulkDocs({docs:[a]},o,d(s))})),g.prototype.putAttachment=x.adapterFun(\"putAttachment\",function(e,t,n,r,o){function s(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},i.put(e)}var i=this;return\"function\"==typeof o&&(o=r,r=n,n=null),\"undefined\"==typeof o&&(o=r,r=n,n=null),i.get(e).then(function(e){if(e._rev!==n)throw q.createError(q.REV_CONFLICT);return s(e)},function(t){if(t.reason===q.MISSING_DOC.message)return s({_id:e});throw t})}),g.prototype.removeAttachment=x.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,s){return e?void r(e):s._rev!==n?void r(q.createError(q.REV_CONFLICT)):s._attachments?(delete s._attachments[t],0===Object.keys(s._attachments).length&&delete s._attachments,void o.put(s,r)):r()})}),g.prototype.remove=x.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var s={_id:o._id,_rev:o._rev||n.rev};return s._deleted=!0,C.isLocalId(s._id)&&\"function\"==typeof this._removeLocal?this._removeLocal(o,r):void this.bulkDocs({docs:[s]},n,d(r))}),g.prototype.revsDiff=x.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){a.has(e)||a.set(e,{missing:[]}),a.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);C.traverseRevTree(n,function(e,n,s,i,a){var c=n+\"-\"+s,u=o.indexOf(c);-1!==u&&(o.splice(u,1),\"available\"!==a.status&&r(t,c))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var s=Object.keys(e);if(!s.length)return n(null,{});var i=0,a=new S.Map;s.map(function(t){this._getRevisionTree(t,function(r,c){if(r&&404===r.status&&\"missing\"===r.message)a.set(t,{missing:e[t]});else{if(r)return n(r);o(t,c)}if(++i===s.length){var u={};return a.forEach(function(e,t){u[t]=e}),n(null,u)}})},this)}),g.prototype.bulkGet=x.adapterFun(\"bulkGet\",function(e,t){x.bulkGetShim(this,e,t)}),g.prototype.compactDocument=x.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,s){if(o)return n(o);var i=v(s),a=[],c=[];Object.keys(i).forEach(function(e){i[e]>t&&a.push(e)}),C.traverseRevTree(s,function(e,t,n,r,o){var s=t+\"-\"+n;\"available\"===o.status&&-1!==a.indexOf(s)&&c.push(s)}),r._doCompaction(e,c,n)})}),g.prototype.compact=x.adapterFun(\"compact\",function(e,t){\n\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&_(n)}),g.prototype._compact=function(e,t){function n(e){i.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;R.all(i).then(function(){return x.upsert(o,\"_local/compaction\",function(e){return!e.last_seq||e.last_seq<n?(e.last_seq=n,e):!1})}).then(function(){t(null,{ok:!0})})[\"catch\"](t)}var o=this,s={return_docs:!1,last_seq:e.last_seq||0},i=[];o.changes(s).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},g.prototype.get=x.adapterFun(\"get\",function(e,t,n){function r(){var r=[],i=o.length;return i?void o.forEach(function(o){s.get(e,{rev:o,revs:t.revs,attachments:t.attachments},function(e,t){e?r.push({missing:o}):r.push({ok:t}),i--,i||n(null,r)})}):n(null,r)}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(q.createError(q.INVALID_ID));if(C.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],s=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,i=r.metadata,a=r.ctx;if(t.conflicts){var c=C.collectConflicts(i);c.length&&(o._conflicts=c)}if(C.isDeleted(i,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){var u=C.rootToLeaf(i.rev_tree),f=l(u,function(e){return-1!==e.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])}),d=f.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,p=f.ids.length-d;if(f.ids.splice(d,p),f.ids.reverse(),t.revs&&(o._revisions={start:f.pos+f.ids.length-1,ids:f.ids.map(function(e){return e.id})}),t.revs_info){var h=f.pos+f.ids.length;o._revs_info=f.ids.map(function(e){return h--,{rev:h+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var v=o._attachments,m=Object.keys(v).length;if(0===m)return n(null,o);Object.keys(v).forEach(function(e){this._getAttachment(o._id,e,v[e],{rev:o._rev,binary:t.binary,ctx:a},function(t,r){var s=o._attachments[e];s.data=r,delete s.stub,delete s.length,--m||n(null,o)})},s)}else{if(o._attachments)for(var _ in o._attachments)o._attachments.hasOwnProperty(_)&&(o._attachments[_].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){return e?n(e):(o=C.collectLeaves(t).map(function(e){return e.rev}),void r())});else{if(!Array.isArray(t.open_revs))return n(q.createError(q.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var i=0;i<o.length;i++){var a=o[i];if(\"string\"!=typeof a||!/^\\d+-/.test(a))return n(q.createError(q.INVALID_REV))}r()}}),g.prototype.getAttachment=x.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(s,i){return s?r(s):i.doc._attachments&&i.doc._attachments[t]?(n.ctx=i.ctx,n.binary=!0,o._getAttachment(e,t,i.doc._attachments[t],n,r),void 0):r(q.createError(q.MISSING_DOC))})}),g.prototype.allDocs=x.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=\"undefined\"!=typeof e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(q.createError(q.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(\"http\"!==this.type())return m(this,e,t)}return this._allDocs(e,t)}),g.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new c(this,e,t)},g.prototype.close=x.adapterFun(\"close\",function(e){return this._closed=!0,this._close(e)}),g.prototype.info=x.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){return n?e(n):(r.db_name=r.db_name||t._db_name,r.auto_compaction=!(!t.auto_compaction||\"http\"===t.type()),r.adapter=t.type(),void e(null,r))})}),g.prototype.id=x.adapterFun(\"id\",function(e){return this._id(e)}),g.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},g.prototype.bulkDocs=x.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(q.createError(q.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(q.createError(q.NOT_AN_OBJECT));var o;return e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(e){o=o||y(e)})}),o?n(q.createError(q.BAD_REQUEST,o)):(\"new_edits\"in t||(\"new_edits\"in e?t.new_edits=e.new_edits:t.new_edits=!0),t.new_edits||\"http\"===this.type()||e.docs.sort(h),p(e.docs),this._bulkDocs(e,t,function(e,r){return e?n(e):(t.new_edits||(r=r.filter(function(e){return e.error})),void n(null,r))}))}),g.prototype.registerDependentDatabase=x.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},t.dependentDbs[e]?!1:(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);x.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})})[\"catch\"](t)}),g.prototype.destroy=x.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){return e?t(e):(r._destroyed=!0,r.emit(\"destroyed\"),void t(null,n||{ok:!0}))})}\"function\"==typeof e&&(t=e,e={});var r=this,o=\"use_prefix\"in r?r.use_prefix:!0;return\"http\"===r.type()?n():void r.get(\"_local/_pouch_dependentDbs\",function(e,s){if(e)return 404!==e.status?t(e):n();var i=s.dependentDbs,a=r.constructor,c=Object.keys(i).map(function(e){var t=o?e.replace(new RegExp(\"^\"+a.prefix),\"\"):e;return new a(t,r.__opts).destroy()});R.all(c).then(n,t)})}),b.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},b.prototype.fail=function(e){this.failed=e,this.execute()},b.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},b.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},A(k,g),k.debug=O,k.adapters={},k.preferredAdapters=[],k.prefix=\"_pouch_\";var T=new N.EventEmitter;D(k),k.parseAdapter=function(e,t){var n,r,o=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(o){if(e=/http(s?)/.test(o[1])?o[1]+\"://\"+o[2]:o[2],n=o[1],!k.adapters[n].valid())throw\"Invalid adapter\";return{name:e,adapter:o[1]}}var s=\"idb\"in k.adapters&&\"websql\"in k.adapters&&x.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+k.prefix+e];if(t.adapter)r=t.adapter;else if(\"undefined\"!=typeof t&&t.db)r=\"leveldb\";else for(var i=0;i<k.preferredAdapters.length;++i)if(r=k.preferredAdapters[i],r in k.adapters){if(s&&\"idb\"===r){x.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.');continue}break}n=k.adapters[r];var a=n&&\"use_prefix\"in n?n.use_prefix:!0;return{name:a?k.prefix+e:e,adapter:r}},k.adapter=function(e,t,n){t.valid()&&(k.adapters[e]=t,n&&k.preferredAdapters.push(e))},k.plugin=function(e){return\"function\"==typeof e?e(k):Object.keys(e).forEach(function(t){k.prototype[t]=e[t]}),k},k.defaults=function(e){function t(n,r,o){return this instanceof t?(\"function\"!=typeof r&&\"undefined\"!=typeof r||(o=r,r={}),n&&\"object\"==typeof n&&(r=n,n=void 0),r=I.extend({},e,r),void k.call(this,n,r,o)):new t(n,r,o)}return A(t,k),t.preferredAdapters=k.preferredAdapters.slice(),Object.keys(k).forEach(function(e){e in t||(t[e]=k[e])}),t};var F=\"5.4.4\";k.version=F,t.exports=k}).call(this,e(22),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{10:10,12:12,13:13,16:16,18:18,19:19,20:20,21:21,22:22,23:23,7:7,8:8}],18:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){Error.call(this,e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}function s(e,t,n){function r(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return r.prototype=o.prototype,new r(t)}function i(e){var t,n,r,o,i;return n=e.error===!0&&\"string\"==typeof e.name?e.name:e.error,i=e.reason,r=C(\"name\",n,i),e.missing||\"missing\"===i||\"deleted\"===i||\"not_found\"===n?r=f:\"doc_validation\"===n?(r=b,o=i):\"bad_request\"===n&&r.message!==i&&(r=w),r||(r=C(\"status\",e.status,i)||m),t=s(r,i,n),o&&(t.message=o),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.missing&&(t.missing=e.missing),t}Object.defineProperty(n,\"__esModule\",{value:!0});var a=r(e(12));a(o,Error),o.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var c=new o({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),u=new o({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),f=new o({status:404,error:\"not_found\",reason:\"missing\"}),l=new o({status:409,error:\"conflict\",reason:\"Document update conflict\"}),d=new o({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),p=new o({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),h=new o({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),v=new o({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),m=new o({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),_=new o({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),y=new o({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),g=new o({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),b=new o({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),w=new o({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),E=new o({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),k=new o({status:404,error:\"not_found\",reason:\"Database not found\"}),D=new o({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),I=new o({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),O=new o({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),A=new o({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),R=new o({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),S=new o({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),L=new o({status:412,error:\"missing_stub\"}),N=new o({status:413,error:\"invalid_url\",reason:\"Provided URL is invalid\"}),x=[c,u,f,l,d,p,h,v,m,_,y,g,b,w,E,k,I,O,A,R,S,L,D,N],C=function(e,t,n){var r=x.filter(function(n){return n[e]===t});return n&&r.filter(function(e){return e.message===n})[0]||r[0]};n.UNAUTHORIZED=c,n.MISSING_BULK_DOCS=u,n.MISSING_DOC=f,n.REV_CONFLICT=l,n.INVALID_ID=d,n.MISSING_ID=p,n.RESERVED_ID=h,n.NOT_OPEN=v,n.UNKNOWN_ERROR=m,n.BAD_ARG=_,n.INVALID_REQUEST=y,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=b,n.BAD_REQUEST=w,n.NOT_AN_OBJECT=E,n.DB_MISSING=k,n.WSQ_ERROR=I,n.LDB_ERROR=O,n.FORBIDDEN=A,n.INVALID_REV=R,n.FILE_EXISTS=S,n.MISSING_STUB=L,n.IDB_ERROR=D,n.INVALID_URL=N,n.getErrorTypeByProp=C,n.createError=s,n.generateErrorFromResponse=i},{12:12}],19:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,s=e.rev_tree.slice();o=s.pop();){var i=o.ids,a=i[2],c=o.pos;if(a.length)for(var u=0,f=a.length;f>u;u++)s.push({pos:c+1,ids:a[u]});else{var l=!!i[1].deleted,d=i[0];t&&!(r!==l?r:n!==c?c>n:d>t)||(t=d,n=c,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,s=n.ids,i=s[2],a=t(0===i.length,o,s[0],n.ctx,s[1]),c=0,u=i.length;u>c;c++)r.push({pos:o+1,ids:i[c],ctx:a})}function s(e,t){return e.pos-t.pos}function i(e){var t=[];o(e,function(e,n,r,o,s){e&&t.push({rev:n+\"-\"+r,pos:n,opts:s})}),t.sort(s).reverse();for(var n=0,r=t.length;r>n;n++)delete t[n].pos;return t}function a(e){for(var t=r(e),n=i(e.rev_tree),o=[],s=0,a=n.length;a>s;s++){var c=n[s];c.rev===t||c.opts.deleted||o.push(c.rev)}return o}function c(e){var t=[];return o(e.rev_tree,function(e,n,r,o,s){\"available\"!==s.status||e||(t.push(n+\"-\"+r),s.status=\"missing\")}),t}function u(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,s=t.ids,i=s[0],a=s[1],c=s[2],u=0===c.length,f=t.history?t.history.slice():[];f.push({id:i,opts:a}),u&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=c.length;d>l;l++)r.push({pos:o+1,ids:c[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,s=e.length;s>o;)r=o+s>>>1,n(e[r],t)<0?o=r+1:s=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function p(e,t){for(var n,r,o=t,s=e.length;s>o;o++){var i=e[o],a=[i.id,i.opts,[]];r?(r[2].push(a),r=a):n=r=a}return n}function h(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),s=o.tree1,i=o.tree2;(s[1].status||i[1].status)&&(s[1].status=\"available\"===s[1].status||\"available\"===i[1].status?\"available\":\"missing\");for(var a=0;a<i[2].length;a++)if(s[2][0]){for(var c=!1,u=0;u<s[2].length;u++)s[2][u][0]===i[2][a][0]&&(n.push({tree1:s[2][u],tree2:i[2][a]}),c=!0);c||(r=\"new_branch\",d(s[2],i[2][a],h))}else r=\"new_leaf\",s[2][0]=i[2][a]}return{conflicts:r,tree:e}}function m(e,t,n){var r,o=[],s=!1,i=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var a=0,c=e.length;c>a;a++){var u=e[a];if(u.pos===t.pos&&u.ids[0]===t.ids[0])r=v(u.ids,t.ids),o.push({pos:u.pos,ids:r.tree}),s=s||r.conflicts,i=!0;else if(n!==!0){var l=u.pos<t.pos?u:t,d=u.pos<t.pos?t:u,p=d.pos-l.pos,h=[],m=[];for(m.push({ids:l.ids,diff:p,parent:null,parentIdx:null});m.length>0;){var _=m.pop();if(0!==_.diff)for(var y=_.ids[2],g=0,b=y.length;b>g;g++)m.push({ids:y[g],diff:_.diff-1,parent:_.ids,parentIdx:g});else _.ids[0]===d.ids[0]&&h.push(_)}var w=h[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),s=s||r.conflicts,i=!0):o.push(u)}else o.push(u)}return i||o.push(t),o.sort(f),{tree:o,conflicts:s||\"internal_node\"}}function _(e,t){for(var n,r=u(e),s={},i=0,a=r.length;a>i;i++){for(var c=r[i],f=c.ids,l=Math.max(0,f.length-t),d={pos:c.pos+l,ids:p(f,l)},h=0;l>h;h++){var v=c.pos+h+\"-\"+f[h].id;s[v]=!0}n=n?m(n,d,!0).tree:[d]}return o(n,function(e,t,n){delete s[t+\"-\"+n]}),{tree:n,revs:Object.keys(s)}}function y(e,t,n){var r=m(e,t),o=_(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function g(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),s=parseInt(o[0],10),i=o[1];n=r.pop();){if(n.pos===s&&n.ids[0]===i)return!0;for(var a=n.ids[2],c=0,u=a.length;u>c;c++)r.push({pos:n.pos+1,ids:a[c]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),s=e.rev_tree.map(b);n=s.pop();){if(n[0]===o)return!!n[1].deleted;s=s.concat(n[2])}}function E(e){return/^_local/.test(e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=a,n.collectLeaves=i,n.compactTree=c,n.isDeleted=w,n.isLocalId=E,n.merge=y,n.revExists=g,n.rootToLeaf=u,n.traverseRevTree=o,n.winningRev=r},{}],20:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}var o=r(e(14)),s=\"function\"==typeof Promise?Promise:o;t.exports=s},{14:14}],21:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e[\"default\"]:e}function o(e){return e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function s(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function i(e){if(e instanceof ArrayBuffer)return s(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function a(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&z.call(n)==$}function c(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;r>n;n++)t[n]=c(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return i(e);if(!a(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var s=c(e[n]);\"undefined\"!=typeof s&&(t[n]=s)}return t}function u(e){var t=!1;return P(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return P(function(n){n=c(n);var r,o=this,s=\"function\"==typeof n[n.length-1]?n.pop():!1;s&&(r=function(e,n){t.nextTick(function(){s(e,n)})});var i=new G(function(t,r){var s;try{var i=u(function(e,n){e?r(e):t(n)});n.push(i),s=e.apply(o,n),s&&\"function\"==typeof s.then&&t(s)}catch(a){r(a)}});return r&&i.then(function(e){r(null,e)},r),i})}function l(e,t){function n(e,t,n){if(K.enabled){for(var r=[e._db_name,t],o=0;o<n.length-1;o++)r.push(n[o]);K.apply(null,r);var s=n[n.length-1];n[n.length-1]=function(n,r){var o=[e._db_name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),K.apply(null,o),s(n,r)}}}return f(P(function(r){if(this._closed)return G.reject(new Error(\"database is closed\"));if(this._destroyed)return G.reject(new Error(\"database is destroyed\"));var o=this;return n(o,e,r),this.taskqueue.isReady?t.apply(this,r):new G(function(t,n){o.taskqueue.addTask(function(s){s?n(s):t(o[e].apply(o,r))})})}))}function d(e,t){for(var n={},r=0,o=t.length;o>r;r++){var s=t[r];s in e&&(n[s]=e[s])}return n}function p(e){return e}function h(e){return[{ok:e}]}function v(e,t,n){function r(){var e=[];v.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function s(e,t,n){v[e]={id:t,docs:n},o()}function i(){if(!(_>=m.length)){var e=Math.min(_+H,m.length),t=m.slice(_,e);a(t,_),_+=t.length}}function a(n,r){n.forEach(function(n,o){var a=r+o,c=u[n],f=d(c[0],[\"atts_since\",\"attachments\"]);f.open_revs=c.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=h),[\"revs\",\"attachments\",\"binary\",\"ajax\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),s(a,n,r),i()})})}var c=t.docs,u={};c.forEach(function(e){e.id in u?u[e.id].push(e):u[e.id]=[e]});var f=Object.keys(u).length,l=0,v=new Array(f),m=Object.keys(u),_=0;i()}function m(){return\"undefined\"!=typeof chrome&&\"undefined\"!=typeof chrome.storage&&\"undefined\"!=typeof chrome.storage.local}function _(){return U}function y(e){m()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):_()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function g(){Q.EventEmitter.call(this),this._listeners={},y(this)}function b(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){var n=6e5;e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||e>=t?t=(e||1)<<1:t+=1,t>n&&(e=n>>1,t=n);var r=Math.random(),o=t-e;return~~(o*r+e)}function E(e){var t=0;return e||(t=2e3),w(e,t)}function k(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function D(e,t){for(var n in t)if(t.hasOwnProperty(n)){var r=c(t[n]);\"undefined\"!=typeof r&&(e[n]=r)}}function I(e,t,n){return D(e,t),n&&D(e,n),e}function O(e,t,n){try{return!e(t,n)}catch(r){var o=\"Filter function threw: \"+r.toString();return W.createError(W.BAD_REQUEST,o)}}function A(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&O(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var s in r.doc._attachments)r.doc._attachments.hasOwnProperty(s)&&(r.doc._attachments[s].stub=!0)}else delete r.doc;return!0}}function R(e){for(var t=[],n=0,r=e.length;r>n;n++)t=t.concat(e[n]);return t}function S(){}function L(e){var t;if(e?\"string\"!=typeof e?t=W.createError(W.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=W.createError(W.RESERVED_ID)):t=W.createError(W.MISSING_ID),t)throw t}function N(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function x(e,t){return\"listenerCount\"in e?e.listenerCount(t):Q.EventEmitter.listenerCount(e,t)}function C(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function j(e){var t=C(e);return t?t.join(\"/\"):null}function q(e){for(var t=oe.exec(e),n={},r=14;r--;){var o=te[r],s=t[r]||\"\",i=-1!==[\"user\",\"password\"].indexOf(o);n[o]=i?decodeURIComponent(s):s}return n[ne]={},n[te[12]].replace(re,function(e,t,r){t&&(n[ne][t]=r)}),n}function T(e,t,n){return new G(function(r,o){e.get(t,function(s,i){if(s){if(404!==s.status)return o(s);i={}}var a=i._rev,c=n(i);return c?(c._id=t,c._rev=a,void r(F(e,c,n))):r({updated:!1,rev:a})})})}function F(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return T(e,t._id,n)})}function M(e){return 0|Math.random()*e}function B(e,t){t=t||se.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=se[M(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=se[3&M(16)|8];break;default:n+=se[M(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var U,G=r(e(20)),P=r(e(7)),V=r(e(8)),Q=e(10),J=r(e(12)),W=e(18),z=Function.prototype.toString,$=z.call(Object),K=V(\"pouchdb:api\"),H=6;if(m())U=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),U=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(Y){U=!1}J(g,Q.EventEmitter),g.prototype.addListener=function(e,t,n,r){function o(){function e(){i=!1}if(s._listeners[t]){if(i)return void(i=\"waiting\");i=!0;var a=d(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(a).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===i&&setTimeout(function(){o()},0),i=!1}).on(\"error\",e)}}if(!this._listeners[t]){var s=this,i=!1;this._listeners[t]=o,this.on(e,o)}},g.prototype.removeListener=function(e,t){t in this._listeners&&Q.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t])},g.prototype.notifyLocalWindows=function(e){m()?chrome.storage.local.set({dbName:e}):_()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},g.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var X,Z=S.name;X=Z?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ee=X,te=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],ne=\"queryKey\",re=/(?:^|&)([^&=]*)=?([^&]*)/g,oe=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,se=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=l,n.bulkGetShim=v,n.changesHandler=g,n.clone=c,n.defaultBackOff=E,n.explainError=k,n.extend=I,n.filterChange=A,n.flatten=R,n.functionName=ee,n.guardedConsole=b,n.hasLocalStorage=_,n.invalidIdError=L,n.isChromeApp=m,n.isCordova=N,n.listenerCount=x,n.normalizeDdocFunctionName=j,n.once=u,n.parseDdocFunctionName=C,n.parseUri=q,n.pick=d,n.toPromise=f,n.upsert=T,n.uuid=B}).call(this,e(22))},{10:10,12:12,18:18,20:20,22:22,7:7,8:8}],22:[function(e,t,n){function r(){if(!a){a=!0;for(var e,t=i.length;t;){e=i,i=[];for(var n=-1;++n<t;)e[n]();t=i.length}a=!1}}function o(){}var s=t.exports={},i=[],a=!1;s.nextTick=function(e){i.push(e),a||setTimeout(r,0)},s.title=\"browser\",s.browser=!0,s.env={},s.argv=[],s.version=\"\",s.versions={},s.on=o,s.addListener=o,s.once=o,s.off=o,s.removeListener=o,s.removeAllListeners=o,s.emit=o,s.binding=function(e){throw new Error(\"process.binding is not supported\")},s.cwd=function(){return\"/\"},s.chdir=function(e){throw new Error(\"process.chdir is not supported\")},s.umask=function(){return 0}},{}],23:[function(e,t,n){(function(){var e={}.hasOwnProperty,n=[].slice;t.exports=function(t,r){var o,s,i,a;s=[],a=[];for(o in r)e.call(r,o)&&(i=r[o],\"this\"!==o&&(s.push(o),a.push(i)));return Function.apply(null,n.call(s).concat([t])).apply(r[\"this\"],a)}}).call(this)},{}]},{},[1]);";
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