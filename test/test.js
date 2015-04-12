/*jshint expr:true */
'use strict';

var PouchDB = require('pouchdb');

//
// your plugin goes here
//
var thePlugin = require('../');
PouchDB.plugin(thePlugin);

var chai = require('chai');
chai.use(require("chai-as-promised"));

//
// more variables you might want
//
chai.should(); // var should = chai.should();
require('bluebird'); // var Promise = require('bluebird');

var dbs;
if (process.browser) {
  dbs = 'testdb' + Math.random() +
    ',http://localhost:5984/testdb' + Math.round(Math.random() * 100000);
} else {
  dbs = process.env.TEST_DB;
}

dbs.split(',').forEach(function (db) {
  var dbType = /^http/.test(db) ? 'http' : 'local';
  tests(db, dbType);
});

function tests(dbName, dbType) {

  var db;

  beforeEach(function () {
    db = new PouchDB(dbName);
    return db;
  });
  afterEach(function () {
    return db.destroy();
  });
  describe(dbType + ': hello test suite', function () {
    it('should say hello', function () {
      return db.sayHello().then(function (response) {
        response.should.equal('hello');
      });
    });
  });
}
