#!/usr/bin/env node

'use strict';

var COUCH_HOST = process.env.COUCH_HOST || 'http://127.0.0.1:5984';
var HTTP_PORT = 8000;
var CORS_PORT = 2020;

var cors_proxy = require('corsproxy');
var watch = require('watch-glob');
var Promise = require('bluebird');
var http_proxy = require('pouchdb-http-proxy');
var http_server = require("http-server");
var debounce = require('lodash.debounce');
var fs = require('fs');
var browserify = require('browserify');
var filesWritten = false;
var serverStarted = false;
var readyCallback;

var rebuildPromise = Promise.resolve();

function browserifyPromise(src, dest) {
  return new Promise(function (resolve, reject) {
    browserify(src, {debug: true}).bundle().pipe(fs.createWriteStream(dest))
      .on('finish', resolve)
      .on('error', reject);
  });
}

function rebuildServiceWorker() {
  rebuildPromise = rebuildPromise.then(function () {
    return browserifyPromise('./test/custom-api/service-worker.js',
      './test/sw.js');
  }).then(function () {
    console.log('Rebuilt test/sw.js');
  }).catch(console.error);
  return rebuildPromise;
}

function rebuildServiceWorkerTest() {
  rebuildPromise = rebuildPromise.then(function () {
    return browserifyPromise('./test/custom-api/service-worker-test.js',
      './test/sw-test-bundle.js');
  }).then(function () {
    console.log('Rebuilt test/sw-test-bundle.js');
  }).catch(console.error);
  return rebuildPromise;
}

function rebuildTestBundle() {
  rebuildPromise = rebuildPromise.then(function () {
    return browserifyPromise('./test/test.js',
      './test/test-bundle.js');
  }).then(function () {
    console.log('Rebuilt test/test-bundle.js');
  }).catch(console.error);
  return rebuildPromise;
}

function watchAll() {
  watch(['./test/custom-api/service-worker.js'],
    debounce(rebuildServiceWorker, 700, {leading: true}));
  watch(['./test/custom-api/service-worker-test.js'],
    debounce(rebuildServiceWorkerTest, 700, {leading: true}));
  watch(['./test/test.js";'],
    debounce(rebuildTestBundle, 700, {leading: true}));
}

Promise.all([
  rebuildTestBundle(),
  rebuildServiceWorker(),
  rebuildServiceWorkerTest()
]).then(() => checkReady());

function startServers(callback) {
  readyCallback = callback;

  return new Promise(function (resolve, reject) {
    http_server.createServer().listen(HTTP_PORT, function (err) {
      if (err) {
        return reject(err);
      }
      cors_proxy.options = {target: COUCH_HOST};
      http_proxy.createServer(cors_proxy).listen(CORS_PORT, function (err) {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }).then(function () {
    console.log('Tests: http://127.0.0.1:' + HTTP_PORT + '/test/index.html');
    serverStarted = true;
    checkReady();
  }).catch(function (err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }
  });
}

function checkReady() {
  if (filesWritten && serverStarted && readyCallback) {
    readyCallback();
  }
}

if (require.main === module) {
  startServers();
  watchAll();
} else {
  module.exports.start = startServers;
}
