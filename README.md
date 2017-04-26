worker-pouch [![Build Status](https://travis-ci.org/nolanlawson/worker-pouch.svg)](https://travis-ci.org/nolanlawson/worker-pouch)
=====

```js
// This pouch is powered by Workers!
var db = new PouchDB('mydb', {adapter: 'worker'});
```

Adapter plugin to use PouchDB over [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Worker) and [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API). Transparently proxies all PouchDB API requests to the worker, so that the most expensive database operations are run in a separate thread.

Basically, worker-pouch allows you use the PouchDB API like you normally would, but your UI will suffer fewer hiccups, because any blocking operations (such as IndexedDB or checksumming) are run inside of the worker.

The worker-pouch adapter passes [the full PouchDB test suite](https://travis-ci.org/nolanlawson/worker-pouch). It requires PouchDB 5.0.0+.

**Topics**

* [Install](#install)
* [Usage](#usage)
  * [Easy Mode](#easy-mode)
  * [Custom Mode](#custom-mode)
* [Performance benefits of worker-pouch](#performance-benefits-of-worker-pouch)
* [Fallback for unsupported browsers](#fallback-for-unsupported-browsers)
* [Debugging](#debugging)
* [FAQs](#faqs)
* [Changelog](#changelog)


Install
---

    $ npm install worker-pouch

Usage
---

This plugin has two modes:
* [Easy Mode](#easy-mode), for Web Workers, supporting Chrome and Firefox, with a fallback for other browsers, and
* [Custom Mode](#custom-mode), potentially supporting more browsers, for Service Workers and allowing you to use your own Web Worker.

In Easy Mode, you don't need to set up the worker yourself, because the script is loaded in a [Blob URL](https://developer.mozilla.org/en-US/docs/Web/API/Blob). Whereas in Custom Mode, you must manage the Web Worker or Service Worker yourself.

### Easy Mode

You can do Easy Mode either with prebuilt JavaScript or via Browserify/Webpack.

#### Setup via prebuilt JavaScript

The client JS file is available at `node_modules/worker-pouch/dist/pouchdb.worker-pouch.js`. Or you can just download it from Github above (in which case, it will be available as `window.workerPouch`).

Then include it in your HTML, after PouchDB:

```html
<script src="pouchdb.js"></script>
<script src="pouchdb.worker-pouch.js"></script>
```

Then you can create a worker-powered PouchDB using:

```js
var db = new PouchDB('mydb', {adapter: 'worker'});
```

#### Setup via Browserify/Webpack/etc.

The same rules apply, but you have to notify PouchDB of the new adapter:

```js
var PouchDB = require('pouchdb');
PouchDB.adapter('worker', require('worker-pouch'));
```

#### Detecting browser support

Unfortunately, creating workers via Blob URLs is not supported in all browsers. In particular, IE, Edge, Safari, and iOS are not supported. Luckily, Firefox and Chrome are the browsers that [benefit the most from web workers](http://nolanlawson.com/2015/09/29/indexeddb-websql-localstorage-what-blocks-the-dom/). There is also an API to [detect browser support](#fallback-for-unsupported-browsers), which you must use if you would like to support browsers other than Firefox and Chrome.

### Custom Mode

In this mode, you manage the Web Worker yourself, and you register the two endpoints so that worker-pouch can communicate with the "backend" and "frontend."

Since this doesn't require Blob URLs, and because you can use custom PouchDB objects, you can potentially support more browsers this way. It's much more flexible.

This mode only supports bundling via Browserify/Webpack/etc. There is no prebuilt option.

To use, you'll need this code on the client side:

```js
// client-side code
var PouchDB = require('pouchdb');
PouchDB.adapter('worker', require('worker-pouch/client'));

var worker = new Worker('worker.js');

var db = new PouchDB('mydb', {
  adapter: 'worker',
  worker: worker
});
```

Note that you create the `PouchDB` object passing in both `adapter: 'worker'`
and `worker`, which points to your `Worker` object.

Then you include this code on the worker side:

```js
// worker-side code
var registerWorkerPouch = require('worker-pouch/worker');
var PouchDB = require('pouchdb');

// attach to global `self` object
registerWorkerPouch(self, PouchDB);
```

If you would like to customize how `PouchDB` is created inside of the worker, then you can also pass in a custom PouchDB factory function, which is a function that takes an options object (e.g. `{name: 'mydb', auto_compaction: true}`)
and returns a `PouchDB` object.

This is useful in cases where PouchDB's IndexedDB adapter doesn't work inside of a worker ([such as Safari](https://bugs.webkit.org/show_bug.cgi?id=149953)), so for instance you can have the `pouchCreator` function
return an in-memory `PouchDB` object.

Here's an example:

```js
var PouchDB = require('pouchdb');
require('pouchdb/extras/memory');
function pouchCreator(opts) {
  opts.adapter = 'memory'; // force in-memory mode
  return new PouchDB(opts);
}

var registerWorkerPouch = require('worker-pouch/worker');
registerWorkerPouch(self, pouchCreator);

```

The PouchDB worker code will listen for messages from the client side, but should ignore any non-worker-pouch messages, so you are free to still use `worker.postMessage()` as desired.

#### Service Workers

Communicating with a Service Worker is the same as with a Web Worker.
However, you have to wait for the Service Worker to install and start controlling the page. Here's an example:

```js
navigator.serviceWorker.register('sw.js', {
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
```

Then inside your Service Worker:

```js
// worker-side code
var registerWorkerPouch = require('worker-pouch/worker');
var PouchDB = require('pouchdb');

// attach to global `self` object
registerWorkerPouch(self, PouchDB);

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim()); // activate right now
});
```

Performance benefits of worker-pouch
----

These numbers were recorded using [this site](http://nolanlawson.github.io/database-comparison-worker-pouch/). The test involved inserting 10000 PouchDB documents, and was run on a 2013 MacBook Air. Browser data was deleted between each test.

| | Time (ms) | Blocked the DOM? |
| ----- | ------ | ------ |
| *Chrome 48* | | |
| &nbsp;&nbsp;&nbsp;`put()` - normal | 50070 | No |
| &nbsp;&nbsp;&nbsp;`put()` - worker | 56993 | No |
| &nbsp;&nbsp;&nbsp;`bulkDocs()` - normal | 2740 | Yes |
| &nbsp;&nbsp;&nbsp;`bulkDocs()` - worker| 3454 | No |
| *Firefox 43* |  | |
| &nbsp;&nbsp;&nbsp;`put()` - normal | 39595 | No |
| &nbsp;&nbsp;&nbsp;`put()` - worker | 41425 | No |
| &nbsp;&nbsp;&nbsp;`bulkDocs()` - normal | 1027 | Yes |
| &nbsp;&nbsp;&nbsp;`bulkDocs()` - worker| 1130 | No |

Basic takeaway: `put()`s avoid DOM-blocking (due to using many smaller transactions), but are much slower than `bulkDocs()`. With worker-pouch, though, you can get nearly all the speed benefit of `bulkDocs()` without blocking the DOM.

(Note that by "blocked the DOM," I mean froze the animated GIF for a significant amount of time - at least a half-second. A single dropped frame was not penalized. Try the test yourself, and you'll see the difference is pretty stark.)

Fallback for unsupported browsers
----

In Easy Mode, this plugin doesn't support all browsers. So it provides a special API to dianogose whether or not the current browser supports worker-pouch. Here's how you can use it:

```js
var workerPouch = require('worker-pouch');

workerPouch.isSupportedBrowser().then(function (supported) {
  var db;
  if (supported) {
    db = new PouchDB('mydb', {adapter: 'worker'});
  } else { // fall back to a normal PouchDB
  db = new PouchDB('mydb');
  }
}).catch(console.log.bind(console)); // shouldn't throw an error
```

The `isSupportedBrowser()` API returns a Promise for a boolean, which will be `true` if the browser is supported and `false` otherwise.

If you are using this method to return the PouchDB object *itself* from a Promise, be sure to wrap it in an object, to avoid "circular promise" errors:

```js
var workerPouch = require('worker-pouch');

workerPouch.isSupportedBrowser().then(function (supported) {
  if (supported) {
    return {db: new PouchDB('mydb', {adapter: 'worker'})};
  } else { // fall back to a normal PouchDB
  return {db: new PouchDB('mydb')};
  }
}).then(function (dbWrapper) {
  var db = dbWrapper.db; // now I have a PouchDB
}).catch(console.log.bind(console)); // shouldn't throw an error
```

Debugging
-----

worker-pouch uses [debug](https://github.com/visionmedia/debug) for logging. So in the browser, you can enable debugging by using PouchDB's logger:

```js
PouchDB.debug.enable('pouchdb:worker:*');
```

FAQs
---

#### Wait, doesn't PouchDB already work in a Web Worker or Service Worker?

Yes, you can use pure PouchDB inside of a Web Worker or Service Worker. But the point of this plugin is to let you use PouchDB from *outside a Web Worker or Service Worker*, and then have it transparently proxy to another PouchDB that is isolated in a Web Worker or Service Worker.

#### What browsers are supported?

Only those browsers that 1) Allow service workers or 2) Allow blob URLs for Web Worker scripts and allow IndexedDB inside of a Web Worker. Today, that means Chrome and Firefox.

#### Can I use it with other plugins?

Not right now, although map/reduce is supported.

#### Don't I pay a heavy cost of structured cloning due to worker messages?

Yes, but apparently this cost is less than that of IndexedDB, because the DOM is significanty less blocked when using worker-pouch. Another thing to keep in mind is that PouchDB's internal document representation in IndexedDB is more complex than the PouchDB documents you insert. So you clone a small PouchDB object to send it to the worker, and then inside the worker it's exploded into a more complex IndexedDB object. IndexedDB itself has to clone as well, but the more complex cloning is done inside the worker.

#### Does replication occur inside the worker?

It's a bit subtle. The answer is **yes**, if you do this:

```js
var local = new PouchDB('local', {adapter: 'worker'});
local.replicate.to('http://example.com/db');
```

However,  the answer is **no** if you do:

```js
var local = new PouchDB('local', {adapter: 'worker'});
var remote = new PouchDB('http://example.com/db');
local.replicate.to(remote);
```

The reason is that when you create a remote PouchDB using `new PouchDB('http://example.com/db')`, then that runs inside the UI thread. However, when you `.replicate.to('http://example.com/db')`, then that string is passed ver-batim to the worker thread, where `worker-pouch` becomes responsible for creating the remote PouchDB. Hence replication will occur inside of the worker thread.

In general, if you are very concerned about performance implications of what runs inside of the woker vs what runs outside of the worker, you are encouraged to _not_ use `worker-pouch` and to instead just run PouchDB inside a worker and handle message-passing yourself (might I recommend [promise-worker](https://github.com/nolanlawson/promise-worker)?). This is the only way to really ensure that _all_ PouchDB operations are isolated to the worker.

Changelog
-----

- 1.1.0
  - Adds the Custom Mode API
- 1.0.0
  - Initial release

Building
----

    npm install
    npm run build

Your plugin is now located at `dist/pouchdb.worker-pouch.js` and `dist/pouchdb.worker-pouch.min.js` and is ready for distribution.

Testing
----

### In the browser

Run `npm run dev` and then point your favorite browser to [http://127.0.0.1:8000/test/index.html](http://127.0.0.1:8000/test/index.html).

The query param `?grep=mysearch` will search for tests matching `mysearch`.

### Automated browser tests

You can run e.g.

    CLIENT=selenium:firefox npm test
    CLIENT=selenium:phantomjs npm test

This will run the tests automatically and the process will exit with a 0 or a 1 when it's done. Firefox uses IndexedDB, and PhantomJS uses WebSQL.

### Running the custom-api tests

Run:

    npm run test-custom

Or to debug:

    npm run test-custom-local
