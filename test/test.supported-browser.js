'use strict';

/* global workerPouch */

describe('test.supported-browser.js', function () {

  it('should support the current browser', function () {
    return workerPouch.isSupportedBrowser().then(function (supported) {
      if (supported !== true) {
        throw new Error('this browser is not supported');
      }
    });
  });
});