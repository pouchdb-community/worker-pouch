'use strict';

var log = require('debug')('pouchdb:worker');

module.exports = function safeEval(str) {
  log('safeEvaling', str);
  var target = {};
  /* jshint evil: true */
  eval('target.target = (' + str + ');');
  log('returning', target.target);
  return target.target;
};