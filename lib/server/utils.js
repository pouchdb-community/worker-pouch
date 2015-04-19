'use strict';

// mostly borrowed from express-pouchb's utils.sendError()
exports.createError = function (err) {
  var status = err.status || 500;

  // last argument is optional
  if (err.name && err.message) {
    if (err.name === 'Error' || err.name === 'TypeError') {
      if (err.message.indexOf("Bad special document member") !== -1) {
        err.name = 'doc_validation';
        // add more clauses here if the error name is too general
      } else {
        err.name = 'bad_request';
      }
    }
    err = {
      error: err.name,
      name: err.name,
      reason: err.message,
      status: status
    };
  }
  return err;
};