# AceBase IPC Server

If you want to run a *pm2* or cloud-based cluster of *AceBase* or *AceBaseServer* instances using the same database files, you'll need an IPC server for the processes to be able to communicate with each other. 

**IMPORTANT: The AceBase IPC Server is NEW and currently in beta, please report any issues. Also make sure to frequently BACKUP your database files!**

Note that you don't need an IPC Server if you are running a standard Node.js cluster *without pm2* (by forking your process), [read here](#standard-nodejs-clusters) for more info.

## What is IPC?
IPC stands for "interprocess communication" and is used by *AceBase* to coordinate data locking and allocation, to exchange information about event subscriptions, and sending realtime data change notifications between multiple processes. Accessing database files from multiple processes without IPC will cause them to become corrupted.

An *AceBase IPC server* uses websockets to communicate with all connected *AceBase* instances, and is able to run on your localhost (pm2 clusters) or a publicly accessible host (cloud-based clusters). It supports SSL, can be protected using an access token, and can be used by multiple databases at the same time.

## How does it work?
Once an *AceBase* database is opened, it will open a websocket connection to the configured IPC server. From that moment on, *AceBase* is able to send and receive messages to and from other connected peers using the same database. The IPC server simply serves as a post office, routing messages to the right recipients.

### Master versus Worker
An *AceBase* process can work in 2 possible IPC modes: as a `master`, or a `worker`. The `worker` processes can read and write from/to the database files themselves, but they need to ask permission from the `master` process first, which is in charge of data locking and allocation.

## Setup
To use an external IPC server with *AceBase* or *AceBaseServer*, you will have to:
* Setup and run an IPC Server instance
* Configure AceBase to use the external IPC server. Note: this requires `acebase-server` version 1.7.0+ (or `acebase` version 1.12.0+)

### IPC Server setup

All you have to do to start an IPC server is:

1. Install the `acebase-ipc-server` dependency to your project:
```sh
npm install acebase-ipc-server
```
2. Start the IPC Server (*start-ipc-server.js*):
```js
const { AceBaseIPCServer } = require('acebase-ipc-server');
const server = new AceBaseIPCServer({ port: 9163 });
server.start();
```

That's it!

### AceBase IPC client setup

You will have to tell *AceBase* to use your IPC server and which role each instance should take on (`master` or `worker`). In each IPC configuration there must be 1 instance with the `master` role, all others must have the `worker` role.

In a *pm2 cluster* that means you have to:
* Configure *pm2* to start 1 `master` process, and multiple `worker` processes in a cluster
* OR, check the instance number of your process to decide between roles `master` or `worker` at runtime

In a *cloud-based cluster* you will always have to run 1 dedicated `master` process, all `worker` processes can run in a cluster.

Configuring an *AceBase* or *AceBaseServer* instance to use an IPC server is very easy, all you have to do add an `ipc` configuration property to AceBaseServer's settings, (or AceBase's `storage` settings):
```js
const ipcConfig = {
    port: 9163,
    role: 'master' // Or 'worker'

    // Optional: 
    // host: 'my.acebase.ipc', // 'localhost' is default
    // ssl: true, 
    // token: 'my_secret_access_token'
};
const server = new AceBaseServer('mydb', { ipc: ipcConfig });
```

## pm2 cluster example 1

This is the recommended setup for starting an *AceBaseServer* in a *pm2 cluster*, using an IPC server running on localhost, 1 dedicated `master` instance and multiple `worker` instances:

*Install dependencies*:
```sh
# IPC Server:
npm install acebase-ipc-server
# AceBaseServer instances:
npm install acebase-server
npm install ws
```

The `ws` dependency is required by AceBase for websocket communication

*ecosystem.config.js*:
```js
module.exports = {
    apps: [{
        name: "AceBase IPC Server",
        script: "./start-ipc-server.js"
    }, {
        name: "AceBase database master",
        script: "./start-db-master.js"
    }, {
        name: "AceBase database server",
        script: "./start-db-server.js",
        instances: "-2",        // Uses all CPUs minus 2
        exec_mode: "cluster"    // Enables PM2 load balancing
    }]
}
```

*start-ipc-server.js*:
```js
// Start IPC Server
const { AceBaseIPCServer } = require('acebase-ipc-server');
const server = new AceBaseIPCServer({ port: 9163 });
server.start();
```

*start-db-master.js*:
```js
// Start a database instance with master role
const { AceBase } = require('acebase');
const db = new AceBase('mydb', { storage: { ipc: { port: 9163, role: 'master' } } });
db.ready(() => {
    process.send('ready'); // Signal pm2 it's running
});
```

*start-db-server.js*:
```js
// Start a database server with worker role
const { AceBaseServer } = require('acebase-server');
const server = new AceBaseServer('mydb', { host: 'localhost', port: 5757, ipc: { port: 9163, role: 'worker' } });
```

## pm2 cluster example 2
Instead of starting a dedicated db `master` process shown above, you can also start 1 *AceBaseServer* with the `master` role manually, using an environment variable to decide which process should become the `master` at runtime. Note that the db `master` will also handle http requests for clients in this case, which might not be desirable because it also has to handle IPC master tasks for other clients. See the following example:

*Install dependencies*:
```sh
# IPC Server:
npm install acebase-ipc-server
# AceBaseServer instances:
npm install acebase-server
npm install ws
```

*ecosystem.config.js*:
```js
module.exports = {
    apps: [{
        name: "AceBase IPC Server",
        script: "./start-ipc-server.js"
    }, {
        name: "AceBase database server",
        script: "./start-db-server.js",
        instances: "-1",        // Uses all CPUs minus 1
        exec_mode: "cluster"    // Enables PM2 load balancing
    }]
}
```

*start-ipc-server.js*:
```js
const { AceBaseIPCServer } = require('acebase-ipc-server');
const server = new AceBaseIPCServer({ port: 9163 });
server.start();
```

*start-db-server.js*:
```js
const { AceBaseServer } = require('acebase-server');
const role = process.env.NODE_INSTANCE_ID === '0' ? 'master' : 'worker';
const server = new AceBaseServer('mydb', { host: 'localhost', port: 5757, ipc: { port: 9163, role } });
```

## Cloud-based clusters
To create an AceBaseServer cluster in the cloud, use the same approach as shown in the [first pm2 cluster example](#pm2-cluster-example-1), but create separate projects for each process to deploy.

Kindly note that all database instances described in this type of cluster will need access to the same database files, so you will have to mount and use the same storage bucket for all *AceBase* and *AceBaseServer* instances. This document does NOT describe how to replicate or synchronise multiple database servers using their own local copy of the database. More info about how to do that will follow soon, keep your eye on the [acebase-server documentation](https://github.com/appy-one/acebase-server/blob/master/README.md)!

* Start the IPC server. IMPORTANT: because the server will be publicly accessible in the cloud, make sure you configure it to use `ssl` and a `token` to prevent unauthorized access!
* Start 1 dedicated *AceBase* process with the `master` IPC role.
* Start any desired amount of *AceBaseServer* processes with the `worker` IPC role.

If any of the processes crash, are restarted or lose their connection, the connections between the IPC server and other processes should recover quickly without causing damage to the database. Kindly note that you should try to keep these processes running as long as possible, there should be no need for scheduled restarts! 

If you do have to restart your AceBaseServer processes (eg if you've updated the `acebase-server` package to a new version), restart them 1 at a time so your database server won't go offline entirely. If the `master` process or the IPC Server has to be restarted, it is best to take the entire cluster offline in this order: 
1. `worker` processes 
2. `master` process
3. IPC Server

The startup sequence of the processes does not matter.

## Standard Node.js clusters
If you do not use *pm2* and are running (or want to run) a standard Node.js cluster, *AceBase* will already be able to communicate between the processes because it can use Node.js's built-in IPC channels between master and worker processes. Processes in a *pm2* cluster can't use this IPC channel because *pm2* itself is the master.

A typical example of a Node.js cluster:
```js
const cluster = require('cluster'); // Node.js built-in cluster support
const { cpus } = require('os');
const { AceBase } = require('acebase');
const { AceBaseServer } = require('acebase');

const SERVER_PORT = 1352;

if (cluster.isMaster) {
    // Open local database, not running a server
    // This instance automatically becomes the IPC master because of cluster.isMaster
    const db = new AceBase('mydb');

    // OR, if you want the master process to also accept remote http connections:
    // const server = new AceBaseServer('mydb', { port: SERVER_PORT /*, ...*/ });

    // Start a worker for each available CPU (minus 1)
    const workers = cpus.length - 1;
    for(let n = 0; n < workers; n++) {
        cluster.fork();
    }
}
else {
    // Start AceBase server in this worker process
    const server = new AceBaseServer('mydb', { port: SERVER_PORT /*, ...*/ });
}

```