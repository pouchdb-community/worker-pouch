WorkerPouch (Beta) [![Build Status](https://travis-ci.org/nolanlawson/worker-pouch.svg)](https://travis-ci.org/nolanlawson/worker-pouch)
=====

```js
// This pouch is powered by web workers!
var db = new PouchDB('mydb', {adapter: 'worker'});
```

Plugin to use PouchDB over [web workers](https://developer.mozilla.org/en-US/docs/Web/API/Worker). Transparently proxies all PouchDB API requests to a web worker, so that the most expensive database operations are run in a separate thread. Supports Firefox and Chrome.

Basically, WorkerPouch allows you use the PouchDB API like you normally would, but your UI will suffer fewer hiccups, because any blocking operations (such as IndexedDB, object cloning, or checksumming) are run inside of the worker. You don't even need to set up the worker yourself, because the script is loaded in a [Blob URL](https://developer.mozilla.org/en-US/docs/Web/API/Blob).

WorkerPouch passes [the full PouchDB test suite](https://travis-ci.org/nolanlawson/socket-pouch). It requires PouchDB 5.0.0+.

IE, Edge, Safari, and iOS are not supported due to browser bugs. Luckily, Firefox and Chrome are the browsers that [benefit the most from web workers](http://nolanlawson.com/2015/09/29/indexeddb-websql-localstorage-what-blocks-the-dom/). There is also an API to [detect browser support](#detecting-browser-support).

Usage
---

    $ npm install worker-pouch
    
When you `npm install worker-pouch`, the client JS file is available at `node_modules/worker-pouch/dist/pouchdb.worker-pouch.js`. Or you can just download it from Github above (in which case, it will be available as `window.workerPouch`).

Then include it in your HTML, after PouchDB:

```html
<script src="pouchdb.js"></script>
<script src="pouchdb.worker-pouch.js"></script>
```

Then you can create a worker-powered PouchDB using:

```js
var db = new PouchDB('mydb', {adapter: 'worker'});
```

##### In Browserify

The same rules apply, but you have to notify PouchDB of the new adapter:

```js
var PouchDB = require('pouchdb');
PouchDB.adapter('worker', require('worker-pouch'));
```

Detecting browser support
----

WorkerPouch doesn't support all browsers. So it provides a special API to dianogose whether or not the current browser supports WorkerPouch. Here's how you can use it:

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

WorkerPouch uses [debug](https://github.com/visionmedia/debug) for logging. So in the browser, you can enable debugging by using PouchDB's logger:

```js
PouchDB.debug.enable('pouchdb:worker:*');
```

Q & A
---

#### Wait, doesn't PouchDB already work in a web worker?

Yes, you can use pure PouchDB inside of a web worker. But the point of this plugin is to let you use PouchDB from *outside a web worker*, and then have it transparently proxy to another PouchDB that is isolated in a web worker.

#### What browsers are supported?

Only those browsers that 1) allow blob URLs for web worker scripts, and 2) allow IndexedDB inside of a web worker. Today, that means Chrome and Firefox.

#### Can I use it with other plugins?

Not right now, although map/reduce is supported.

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
