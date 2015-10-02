'use strict';
/* jshint ignore: start */
// yes this is really how this works
module.exports = new Worker(workerify('./../worker/index.js'))
/* jshint ignore: end */