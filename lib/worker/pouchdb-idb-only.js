'use strict';

// no need for WebSQL when running in a worker
module.exports = require('pouchdb-core')
  .plugin('pouchdb-adapter-idb')
  .plugin('pouchdb-adapter-http')
  .plugin('pouchdb-mapreduce')
  .plugin('pouchdb-replication');