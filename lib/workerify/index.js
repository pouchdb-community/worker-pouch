"use strict";

var through = require('through2');
var browserify = require('browserify');
var UglifyJS = require("uglify-js");
var processedFiles = {};

function browserifyIt(entry, done) {
  var data = '';
  var b = browserify();

  b.add(entry);
  var bundle = b.bundle();
  bundle.on('data', function (buf) {
    data += buf;
  });
  bundle.on('end', function() {
    if (process.env.UGLIFY) {
      data = UglifyJS.minify(data, {
        fromString: true,
        mangle: true,
        compress: true
      }).code;
    }
    done(data);
  });
}

function workerify(filename) {

  if (!/\/worker\/index\.js$/.test(filename)) {
    return through();
  }
  if (processedFiles['$' + filename]) {
    return through();
  }

  processedFiles['$' + filename] = true;

  return through(
    function (chunk, enc, next) {
      next();
    },
    function (next) { // flush function
      /* jshint validthis:true */
      var self = this;

      browserifyIt(filename, function (contents) {
        self.push("module.exports = '" +
          new Buffer(contents, 'utf8').toString('base64') + "';");
        next();
      });
    }
  );
}

module.exports = workerify;