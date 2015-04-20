'use strict';

var log = require('debug')('pouchdb:socket:server');

// TODO: this is evil and insecure
module.exports = function safeEval(str) {
  log('safeEvaling', str);
  /* jshint evil: true */
  eval('process.foobar = (' + str + ');');
  log('returning', process.foobar);
  return process.foobar;
};