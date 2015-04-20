SocketPouch (Beta)
=====

[![Build Status](https://travis-ci.org/nolanlawson/socket-pouch.svg)](https://travis-ci.org/nolanlawson/socket-pouch)

Plugin to allow PouchDB and CouchDB to sync over WebSockets, using [Engine.io](https://github.com/Automattic/engine.io).

Introduction
---

Normally PouchDB and CouchDB replicate using the [CouchDB replication protocol](http://www.replication.io/), which runs over HTTP/HTTPS. This protocol can be quite slow, because it's [very chatty](https://issues.apache.org/jira/browse/COUCHDB-2310).

To speed up replication, SocketPouch implements this protocol over [WebSockets](https://issues.apache.org/jira/browse/COUCHDB-2310), falling back to normal HTTP long-polling for browsers that don't support WebSockets. This is accomplished using [Engine.io](https://github.com/Automattic/engine.io), the famous core of [Socket.io](http://socket.io/).

SocketPouch has two parts:

* **A Node.js server**, which can create local PouchDBs or proxy to a remote CouchDB.
* **A JavaScript client**, which can run in Node.js or the browser.

Beta warning
---

This plugin is still pretty experimental (hence the `<1.0.0` version), but you are encouraged to play with it. Note that it currently requires [a special branch of PouchDB](https://github.com/pouchdb/pouchdb/tree/branch-for-socket-pouch) because I need some pull requests to get merged in order for it to work. Hopefully it should be ready in time for PouchDB 3.5.0.

The API may substantially change before 1.0.0. I'd really like to get authentication right, but I haven't figured out yet how best to model it. Suggestions are welcome. :)

Currently SocketPouch is passing [the full PouchDB test suite](https://travis-ci.org/nolanlawson/socket-pouch).

Usage
---

    $ npm install socket-pouch

#### Server

```js
var socketPouchServer = require('socket-pouch/server');

socketPouchServer.listen(80);
```

#### Client

##### In the browser
    
When you `npm install socket-pouch`, the client JS file is available at `node_modules/socket-pouch/dist/socket-pouch.client.js`. Or you can just download it from Github above.

Then include it in your HTML, after PouchDB:

```html
<script src="pouchdb.js"></script>
<script src="socket-pouch.client.js"></script>
```

Then you can create a socket-powered PouchDB using:

```js
var db = new PouchDB({
  adapter: 'socket',
  name: 'mydb',
  url: 'ws://localhost:80'
});
```

##### In Node.js/Browserify

The same rules apply, but you have to notify PouchDB of the new adapter:

```js
var PouchDB = require('pouchdb');
PouchDB.adapter('socket', require('socket-pouch/client'));
```

API
----

### Server

```js
var socketPouchServer = require('socket-pouch/server');

socketPouchServer.listen(80, {}, function () {
  // server started
});
```

#### socketPouchServer.listen(port [, options] [, callback])

##### Arguments

* **port**: the port to listen on. You should probably use 80 or 443 if you plan on running this in production; most browsers are finicky about other ports. 8080 may work in Chrome during debugging.
* **options**: (optional) options object
  * **remoteUrl**: tells SocketPouch to act as a proxy for a remote CouchDB at the given URL (rather than creating local PouchDB databases)
  * **pouchCreator**: alternatively, you can supply a custom function that takes a string and returns any PouchDB object however you like. (See examples below.) 
  * **socketOptions**: (optional) options passed passed verbatim to Engine.io. See [their documentation](https://github.com/Automattic/engine.io/#methods) for details.
* **callback**: (optional) called when the server has started

Create a server which creates local PouchDBs, named by the user and placed in the current directory:

```js
socketPouchServer.listen(80, {}, function () {
  console.log('server started!');
});
```

Create a server which acts as a proxy to a remote CouchDB (or CouchDB-compliant database):

```js
socketPouchServer.listen(80, {
  remoteUrl: 'http://localhost:5984'
});
```

So e.g. when the user requests a database called 'foo', it will use a remote database at `'http://localhost:5984/foo'`. Note that authentication is not handled, so you may want the `pouchCreator` option instead.

Create a MemDOWN-backed PouchDB server:

```js
socketPouchServer.listen(80, {
  pouchCreator: function (dbName) {
    return new PouchDB(dbName, {
      db: require('memdown')
    });
  }
});
```

Note that this `dbName` is supplied by the client ver batim, meaning **it could be dangerous**. In the example above, everything is fine because MemDOWN databases can have any string as a name.

Alternatively, your `pouchCreator` can return a `Promise` if you want to do something asynchronously, such as authenticating the user. In that case you must wrap the object in `{pouch: yourPouchDB}`:

```js
socketPouchServer.listen(80, {
  pouchCreator: function (dbName) {
    return doSomethingAsynchronously().then(function () {
      return {
        pouch: new PouchDB('dbname')
      };
    });
  }
});
```

### Client

```js
var db = new PouchDB({
  adapter: 'socket',
  name: 'mydb',
  url: 'ws://localhost:80',
  socketOptions: {}
});
```

The `name` and `url` are required and must point to a valid `socketPouchServer`. The `socketOptions`, if provided, are passed ver batim to Engine.io, so refer to [their documentation](https://github.com/Automattic/engine.io-client/#nodejs-with-certificates) for details.

### Replication

The `db` object acts like a PouchDB that communicates remotely with the `socketPouchServer` In other words, it's analogous to a PouchDB created like `new PouchDB('http://localhost:5984/mydb')`.

So you can replicate using the normal methods:

```js
var localDB = new PouchDB('local');
var remoteDB = new PouchDB({adapter: 'socket', name: 'remote', url: 'ws://localhost:80'});

// replicate from local to remote
localDB.replicate.to(remoteDB);

// replicate from remote to local
localDB.replicate.from(remoteDB);

// replicate bidirectionally
localDB.sync(remoteDB);
```

For details, see the official [`replicate()`](http://pouchdb.com/api.html#replication) or [`sync()`](http://pouchdb.com/api.html#sync) docs.

### Remote API

```js
var remoteDB = new PouchDB({adapter: 'socket', name: 'remote', url: 'ws://localhost:80'});
```

You can also talk to this `remoteDB` as if it were a normal PouchDB. All the standard methods like `info()`, `get()`, `put()`, and `putAttachment()` will work. The [Travis tests](https://travis-ci.org/nolanlawson/socket-pouch) run the full PouchDB test suite.

### Debugging

SocketPouch uses [debug](https://github.com/visionmedia/debug) for logging. So in Node.js, you can enable debugging by setting a flag:

```
DEBUG=pouchdb:socket:*
```

In the browser, you can enable debugging by using PouchDB's logger:

```js
PouchDB.debug.enable('pouchdb:socket:*');
```

Q & A
---

#### How does it communicate?

SocketPouch communicates using the normal Engine.io APIs like `send()` and `on('message')`.

Normally it sends JSON text data, but in the case of attachments, binary data is sent. This means that SocketPouch is actually more efficient than regular PouchDB replication, which (as of this writing) uses base64-string encoding to send attachments between the client and server.

#### Does it work in a web worker or service worker?

Unfortuantely, not at the moment.

#### How does it work?

This is a custom PouchDB adapter. Currently the only known PouchDB adapters were the IndexedDB, WebSQL, LevelDB, and HTTP (Couch) adapters, as well as a quasi-adapter written for [pouchdb-replication-stream](https://github.com/nolanlawson/pouchdb-replication-stream). But I'm trying to make it easier to write arbitrary adapters, and SocketPouch is part of that effort.

So who knows - maybe WebRTC or BLE or p2p Wifi could be up next.

Building
----
    npm install
    npm run build

Your plugin is now located at `dist/pouchdb.mypluginname.js` and `dist/pouchdb.mypluginname.min.js` and is ready for distribution.

Testing
----

### In Node

This will run the tests in Node using LevelDB:

    npm test
    
You can also check for 100% code coverage using:

    npm run coverage

Run certain tests:
```
GREP=foo npm test
```

### In the browser

Run `npm run dev` and then point your favorite browser to [http://127.0.0.1:8000/test/index.html](http://127.0.0.1:8000/test/index.html).

The query param `?grep=mysearch` will search for tests matching `mysearch`.

### Automated browser tests

You can run e.g.

    CLIENT=selenium:firefox npm test
    CLIENT=selenium:phantomjs npm test

This will run the tests automatically and the process will exit with a 0 or a 1 when it's done. Firefox uses IndexedDB, and PhantomJS uses WebSQL.