/*jshint expr:true */
'use strict';

var PouchDB = require('pouchdb');

//
// your plugin goes here
//
var thePlugin = require('../lib/client');
PouchDB.adapter('socket', thePlugin);

var chai = require('chai');
chai.use(require("chai-as-promised"));

//
// more variables you might want
//
chai.should(); // var should = chai.should();
require('bluebird'); // var Promise = require('bluebird');

function tests() {
  var db;

  beforeEach(function () {
    db = new PouchDB({
      url: 'ws://localhost:8080',
      name: 'testdb_ws',
      adapter: 'socket'
    });
    return db;
  });
  afterEach(function () {
    return db.destroy();
  });
  describe('basic test suite', function () {
    it('should have info', function () {
      return db.info().then(function (info) {
        info.db_name.should.equal('testdb_ws');
      });
    });
  });
}

tests();
