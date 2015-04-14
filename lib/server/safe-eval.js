'use strict';
// TODO: evil
module.exports = function safeEval(str) {
  console.log('safeEvaling', str);
  /* jshint evil: true */
  eval('process.foobar = (' + str + ');');
  console.log('returning', process.foobar);
  return process.foobar;
};