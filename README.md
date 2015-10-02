WorkerPouch (Beta)
=====

[![Build Status](https://travis-ci.org/nolanlawson/worker-pouch.svg)](https://travis-ci.org/nolanlawson/worker-pouch)

Plugin to use PouchDB over web workers. Works transparently in browsers that support workers via Blob URLs, i.e. Firefox and Chrome.

Basically, you use the PouchDB API exactly as you're used to using it, but everything is less janky because all database operations are proxied over to a web worker.

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

### Debugging

WorkerPOuch uses [debug](https://github.com/visionmedia/debug) for logging. So in the browser, you can enable debugging by using PouchDB's logger:

```js
PouchDB.debug.enable('pouchdb:worker:*');
```

Q & A
---

#### How does it communicate?

WorkerPouch proxies the normal PouchDB API over to a single global web worker, which is what runs the core PouchDB code. You can debug the worker by looking for a script starting with `blob:` in your dev tools.

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