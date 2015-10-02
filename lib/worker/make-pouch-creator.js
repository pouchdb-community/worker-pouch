'use strict';

var PouchDB = require('pouchdb');
var Promise = require('pouchdb/extras/promise');

function createLocalPouch(args) {

  if (typeof args[0] === 'string') {
    args = [{name: args[0]}];
  }

  // TODO: there is probably a smarter way to be safe about filepaths
  args[0].name = args[0].name.replace('.', '').replace('/', '');
  return Promise.resolve({
    pouch: new PouchDB(args[0])
  });
}

function createHttpPouch(options) {
  var remoteUrl = options.remoteUrl;
  // chop off last '/'
  if (remoteUrl[remoteUrl.length - 1] === '/') {
    remoteUrl = remoteUrl.substring(0, remoteUrl.length -1);
  }
  return function (args) {
    if (typeof args[0] === 'string') {
      args = [{name: args[0]}];
    }
    return Promise.resolve({
      pouch: new PouchDB(remoteUrl + '/' + args[0].name)
    });
  };
}

function makePouchCreator(options) {
  if (options.remoteUrl) {
    return createHttpPouch(options);
  }
  if (!options.pouchCreator) {
    return createLocalPouch;
  }
  return function (args) {
    var name = typeof args[0] === 'string' ? args[0] : args[0].name;
    var res = options.pouchCreator(name);
    if (res instanceof PouchDB) {
      return {pouch: res};
    } else {
      return res;
    }
  };
}

module.exports = makePouchCreator;