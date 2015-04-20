#!/usr/bin/env node

'use strict';

var COUCH_HOST = process.env.COUCH_HOST || 'http://127.0.0.1:5984';
var HTTP_PORT = 8000;
var CORS_PORT = 2020;
var SOCKET_PORT = 8080;

var cors_proxy = require('corsproxy');
var Promise = require('bluebird');
var http_proxy = require('pouchdb-http-proxy');
var http_server = require("http-server");
var fs = require('fs');
var indexfile = "./test/test.js";
var dotfile = "./test/.test-bundle.js";
var outfile = "./test/test-bundle.js";
var watchify = require("watchify");
var browserify = require('browserify');
var socketPouch = require('../lib/server');
var w = watchify(browserify(indexfile, {
  cache: {},
  packageCache: {},
  fullPaths: true,
  debug: true
}));

w.on('update', bundle);
bundle();

var filesWritten = false;
var serverStarted = false;
var socketServerStarted = false;
var readyCallback;

function bundle() {
  var wb = w.bundle();
  wb.on('error', function (err) {
    console.error(String(err));
  });
  wb.on("end", end);
  wb.pipe(fs.createWriteStream(dotfile));

  function end() {
    fs.rename(dotfile, outfile, function (err) {
      if (err) { return console.error(err); }
      console.log('Updated:', outfile);
      filesWritten = true;
      checkReady();
    });
  }
}

function startSocketServer() {
  socketPouch.listen(SOCKET_PORT, {}, function () {
    console.log('Socket server started');
    socketServerStarted = true;
    checkReady();
  });
}

function startServers(callback) {
  readyCallback = callback;

  startSocketServer();

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
  if (filesWritten && serverStarted && socketServerStarted && readyCallback) {
    readyCallback();
  }
}

if (require.main === module) {
  startServers();
} else {
  module.exports.start = startServers;
}
