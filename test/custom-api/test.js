'use strict';

var chai = require('chai');
require('chai-as-promised');
var should = chai.should();

var PouchDB = require('pouchdb-browser');
PouchDB.adapter('worker', require('../../client'));

describe('custom api test suite', function () {

  this.timeout(180000);

  var db;

  before(function () {
    var worker = new Worker('/test/custom-api/worker-bundle.js');
    db = new PouchDB('testdb', {
      adapter: 'worker',
      worker: function () { return worker; }
    });
  });

  after(function () {
    return db.destroy();
  });

  it('should exist', function () {
    should.exist(db);
  });

  it('should be valid', function () {
    db.adapter.should.equal('worker');
  });

  it('should put() and get data', function () {
    return db.put({
      _id: 'foo'
    }).then(function () {
      return db.get('foo');
    }).then(function (doc) {
      doc._id.should.equal('foo');
      return db.info();
    }).then(function (info) {
      info.doc_count.should.equal(1);
    });
  });

});