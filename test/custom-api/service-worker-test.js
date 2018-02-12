'use strict';

var chai = require('chai');
require('chai-as-promised');
var should = chai.should();

var PouchDB = require('pouchdb-browser');
PouchDB.adapter('worker', require('../../client'));

describe('Service Worker custom api test suite', function () {

  var db;
  before(function () {
    return navigator.serviceWorker.register('sw.js', {
      scope: './'
    }).then(function () {
      if (navigator.serviceWorker.controller) {
        // already active and controlling this page
        return navigator.serviceWorker;
      }
      // wait for a new service worker to control this page
      return new Promise(function (resolve) {
        function onControllerChange() {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          resolve(navigator.serviceWorker);
        }
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      });
    }).then(function (serviceWorker) { // the worker is ready
      db = new PouchDB('testdb', {
        adapter: 'worker',
        worker: function() {
          return serviceWorker;
        }
      });
      return db;
    }).catch(console.log.bind(console));
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
