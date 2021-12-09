import uWS from 'uWebSockets.js';

export interface AceBaseIPCServerConfig {
    host?: string, 
    port: number,
    /** Used to check if connections made to this server are using the right database */
    // dbname: string, 
    /** Provide SSL certificate details. Use either `certPath` and `keyPath`, or `pfxPath` and `passphrase` */
    ssl?: { 
        certPath?: string, 
        keyPath?: string 
        pfxPath?: string, 
        passphrase?: string 
    },
    /** 
     * Maximum amount of bytes allowed to be sent over the websocket connection. The websocket connection is closed
     * immediately if the payload exceeds this number. Default is 16KB (16384).
     * Clients should send messages with larger content over http(s) with POST `/[dbname]/send?id=[clientId]`;
     * to receive large messages the server will send `get:[msgId]` to the client over the websocket 
     * connection, the message can then be downloaded by calling GET `/[dbname]/receive?id=[clientId]&msgId=[id]` */
    maxPayload?: number
    /** secret token to (help) prevent unauthorized clients to use the IPC channel */
    token?: string
}

interface AceBaseIPCClient { 
    id: string, 
    dbname: string,
    connected: Date,
    ws: uWS.WebSocket,
    sendMessage(message: any): Promise<void>
}

/**
 * This flow is used for remote IPC communications
 * Handshake:
 * - Remote client connects to the websocket on url `/[dbname]/connect?id=[clientId]&v=[clientVersion]&t=[token]`
 * - IPC Server adds it to the `clients` list for that dbname, if another client with the same id exists already, it's previous connection will be closed
 * - IPC Server sends `"welcome:{ maxPayload: [maxPayload] }"` to the client to notify the maxPayload size to use
 * - IPC Server broadcasts `"connect:clientid"`
 * 
 * Connection checks:
 * - To check the connection, client can send a `"ping"` message, which will immediately be replied to with `"pong"`
 * 
 * Message sending:
 * - If a client wants to send a message to 1 specific peer, it should prefix the message with `"to:[peerId];"`
 * - Messages without prefix are broadcast to all other peers
 * - If a message is prefixed `"to:all;"` the message will be sent to all other peers individually, this is provided for testing only - use unprefixed instead
 * - If the message to send exceeds the configured payload size, it must be http(s) POSTed to "/send?id=[clientId]&t=[token]" instead
 * 
 * Message receiving:
 * - Clients receive small messages through the websocket connection. 
 * - Messages sent from other peers will be prefixed with `"msg:"`
 * - Messages too large to be sent over the websocket connection, will send `"get:[msgId]"` instead, client must http(s) GET `"/[dbname]/receive?id=[clientId]&msg=[msgId]&t=[token]"` to download the message
 * 
 * Disconnect:
 * - Upon disconnection of a remote peer, server broadcasts `"disconnect:clientid"` to all still connected
 *
 */
export class AceBaseIPCServer {

    private clients: {
        [dbname: string]: AceBaseIPCClient[]
     } = {};

    constructor(private config: AceBaseIPCServerConfig) {}

    getClients(dbname: string) {
        if (!(dbname in this.clients)) { this.clients[dbname] = []; }
        return this.clients[dbname];
    }

    start(): Promise<void> {
        let resolve:()=>void, reject:(err:Error)=>void, promise = new Promise<void>((rs, rj) => { resolve = rs; reject = rj; });
        const config = this.config;
        if (typeof config.maxPayload !== 'number') {
            config.maxPayload = 16 * 1024;
        }

        const textDecoder = new TextDecoder();
        const app = config.ssl
            ? uWS.SSLApp({
                cert_file_name: config.ssl.certPath,
                key_file_name: config.ssl.keyPath,
                dh_params_file_name: config.ssl.pfxPath,
                passphrase: config.ssl.passphrase
            })
            : uWS.App();

        app.ws(`/:dbname/connect`, {
            idleTimeout: 0, // No timeout
            maxBackpressure: 1024 * 1024,           // default
            maxPayloadLength: config.maxPayload,    // default (16 * 1024), connection is closed when payload exceeds this
            compression: uWS.DISABLED,              // default            
            upgrade: (res, req, context) => {
                // Execute the upgrade manually to add url and query
                const dbname = req.getParameter(0);
                const url = req.getUrl(), query = req.getQuery();
                // console.log(`Websocket request for db "${dbname}"`);

                // Parse query, should be in the form 'id=clientid&v=1'
                const env = parseQuery(query as string);
                
                // Check client environment
                let err;
                if (typeof env.v !== 'string' || env.v.split('.')[0] !== '1') {
                    // Using semantic versioning, major version update means and update is needed, minor version bump indicates backward compatible features were added, build nr bump means bugfix.
                    // This server version allows version 1.x.x
                    err = `409 Unsupported client IPC version "${env.v}". Update acebase-ipc-server package`;
                }
                else if (typeof env.id !== 'string' || env.id.length < 5) {
                    err = `500 Invalid IPC client id ${env.id}`;
                }
                else if (typeof config.token === 'string' && env.t !== config.token) {
                    err = `403 Unauthorized`;
                }
                if (err) {
                    console.error(err);
                    res.writeStatus(err);
                    return res.end(err);
                }

                const clients = this.getClients(dbname);
                const existingClient = clients.find(client => client.id === env.id);
                if (existingClient) {
                    // New client is connecting with an already known id.  Did we not get notified about a previous disconnect? 
                    // Close it now, it'll be replaced by the new connection
                    console.warn(`Client ${env.id} is connecting, but a previous connection appears to be open. Closing previous connection now.`)
                    existingClient.ws.close();
                }

                res.upgrade({
                        url,
                        query,
                        env,
                        dbname
                    },
                    /* Spell these correctly */
                    req.getHeader('sec-websocket-key'),
                    req.getHeader('sec-websocket-protocol'),
                    req.getHeader('sec-websocket-extensions'),
                    context
                );
            },
            open: (ws) => {
                // Add new client
                const client:AceBaseIPCClient = {
                    connected: new Date(),
                    id: ws.env.id,
                    dbname: ws.dbname,
                    ws,
                    async sendMessage(msg: any) {
                        const data = typeof msg === 'string' ? msg : `msg:${JSON.stringify(msg)}`;
                        const success = this.ws.send(data, false, false);
                        if (!success) {
                            console.warn(`Back pressure on client ${this.id} is building up`);
                        }
                    }
                };
                
                // Subscribe clients to each others broadcast channels called "from[id]"
                const clients = this.getClients(ws.dbname);
                clients.forEach(client => {
                    // Subscribe this client to broadcast messages from other clients
                    ws.subscribe(`from-${ws.dbname}-${client.id}`);

                    // Subscribe others to receive broadcast messages from this client
                    client.ws.subscribe(`from-${ws.dbname}-${ws.env.id}`);
                });

                // Add new client
                clients.push(client);
                
                // Send welcome message with configuration
                ws.send(`welcome:` + JSON.stringify({ maxPayload: config.maxPayload }));

                // Publish connect event to other clients
                app.publish('all', `connect:${client.id}`, false, false);

                // subscribe websocket to broadcasted events meant for all (connect & disconnect)
                ws.subscribe('all');
            },
            close: (ws, code, message) => {
                // Remove client 
                const clients = this.getClients(ws.dbname);
                const index = clients.findIndex(client => client.ws === ws);
                if (index >= 0) {
                    const client = clients[index];
                    index >= 0 && clients.splice(index, 1);
                    app.publish('all', `disconnect:${client.id}`, false, false);
                }
            },
            message: (ws, buffer, isBinary) => {
                if (isBinary) { return; } // Ignore
                const client = this.getClients(ws.dbname).find(client => client.ws === ws);
                try {
                    const str = textDecoder.decode(buffer);
                    console.log(`Received websocket message from ${client?.id} on db "${ws.dbname}": "${str}"`);
                    this.handleIncomingMessage(str, ws);
                }
                catch(err) {
                    console.error(`Error parsing received websocket message:`, err);
                }
            },
        });

        app.get(`/:dbname/clients`, (res, req) => {
            const dbname = req.getParameter(0);
            const clients = this.getClients(dbname);
            const txt = JSON.stringify(clients.map(client => ({ id: client.id, connected: client.connected.getTime() })));
            res.end(txt);
        });

        app.post(`/:dbname/send`, (res, req) => {
            // Client sending large message
            // example POST /mydb/receive?id=client1&token=secret (with message in data)

            const query = parseQuery(req.getQuery());
            const dbname = req.getParameter(0);
            const clients = this.getClients(dbname);
            const client = clients.find(client => client.id === query.id);

            if (!client || (typeof config.token === 'string' && query.t !== config.token)) {
                res.writeStatus('401 Unauthorized');
                return res.end('Unauthorized');
            }

            let data = '';
            res.onData((chunk, isLast) => {
                data += textDecoder.decode(chunk);
                if (isLast) {
                    res.end('ok');
                    this.handleIncomingMessage(data, client.ws);
                }
            });
        });

        /**
         * FOR TESTING PURPOSES ONLY, DISABLED IN PRODUCTION ENVIRONMENT
         * GET /mydb/send?id=client1&token=secret&msg=to:client1;Hallo
         */
        app.get(`/:dbname/send`, (res, req) => {
            if (process.env?.NODE_ENV !== 'development') {
                res.writeStatus('405 Method Not Allowed');
                return res.end('405 Method Not Allowed');
            }
            const query = parseQuery(req.getQuery());
            const dbname = req.getParameter(0);
            const clients = this.getClients(dbname);
            const client = clients.find(client => client.id === query.id);

            if (!client || (typeof config.token === 'string' && query.t !== config.token)) {
                res.writeStatus('401 Unauthorized');
                return res.end('Unauthorized');
            }

            this.handleIncomingMessage(query.msg, client.ws);
        });

        app.get(`/:dbname/receive`, (res, req) => {
            // Client wants to download a large message
            // example GET /mydb/receive?id=client1&msg=12345&token=secret

            const query = parseQuery(req.getQuery());
            const dbname = req.getParameter(0);
            const clients = this.getClients(dbname);
            const client = clients.find(client => client.id === query.id);

            if (!client || (typeof config.token === 'string' && query.t !== config.token)) {
                res.writeStatus('401 Unauthorized');
                return res.end('Unauthorized');
            }
            const msg = this.largeMessages[query.msg];
            if (typeof msg !== 'string') {
                res.writeStatus('404 Not Found');
                res.end('Not Found');
            }
            else {
                delete this.largeMessages[query.msg];
                res.end(msg);
            }
        })

        app.listen(config.port, listenSocket => {
            if (listenSocket) {
                console.log(`AceBase IPC server running on port ${config.port}`);
                resolve();
            }
            else {
                const message = `AceBase IPC server failed to start`;
                console.error(message);
                reject(new Error(message));
            }
        });

        return promise;
    }

    largeMessages: { [id:string]: string } = {};

    handleIncomingMessage(msg: string, ws: uWS.WebSocket) {
        const clients = this.getClients(ws.dbname);
        let to:string = '';
        if (msg === 'ping') {
            return ws.send('pong');
        }
        if (msg.startsWith('to:')) {
            // Message as an explicit recipient, format is "to:client1;message"
            let i = msg.indexOf(';');
            to = msg.slice(3, i);
            msg = msg.slice(i+1);
        }
        if (msg.length > (this.config.maxPayload as number)) {
            // Message too large to send over websocket connection
            const id = generateID();
            this.largeMessages[id] = msg;

            // Remove message if not downloaded within 60s
            setTimeout(() => {
                delete this.largeMessages[id];
            }, 60e3); 

            // Adjust message to download instruction for client
            msg = `get:${id}`;
        }
        if (to.length > 0) {
            // Forward message to recipient or all others
            const forwardTo = to === 'all'
                ? clients.filter(client => client.ws !== ws)
                : clients.filter(client => client.id === to);
            
            forwardTo.forEach(client => {
                client.sendMessage(msg);
            });
        }
        else {
            // Broadcast entire message to all others
            const client = clients.find(client => client.ws === ws);
            if (client) {
                ws.publish(`from-${client.dbname}-${client.id}`, msg, false, false);
            }
            else {
                console.warn(`Received message from unknown client`);
            }
        }
    }
}

function parseQuery(q: string) {
    return q.split('&').reduce((init, kvp) => { let pair = kvp.split('='); init[pair[0]] = pair[1]; return init; }, {} as { [key:string]: any });
}


let _idSequence = 0;
const _maxNr = Math.pow(36, 8);
function generateID() {
    if (++_idSequence === _maxNr) { _idSequence = 0; }
    const time = Date.now().toString(36).padStart(8, '0');
    const seq = _idSequence.toString(36).padStart(8, '0');
    const random = Math.floor(Math.random() * _maxNr).toString(36).padStart(8, '0');
    return `${time}${seq}${random}`;
}