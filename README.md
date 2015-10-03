WorkerPouch (Beta)
=====

[![Build Status](https://travis-ci.org/nolanlawson/worker-pouch.svg)](https://travis-ci.org/nolanlawson/worker-pouch)

Plugin to use PouchDB over web workers. Transparently proxies all PouchDB API requests to a web worker, so that all IndexedDB operations are run in a separate thread. Supports Firefox and Chrome.

Basically, you use the PouchDB API exactly as you're used to, but your UI will experience less interruptions, because most of PouchDB's expensive operations are run inside of the web worker.

```js
// this pouch is powered by web workers
var db = new PouchDB('mydb', {adapter: 'worker'});
```

Usage
---

    $ npm install worker-pouch
    
When you `npm install worker-pouch`, the client JS file is available at `node_modules/worker-pouch/dist/pouchdb.worker-pouch.js`. Or you can just download it from Github above.

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