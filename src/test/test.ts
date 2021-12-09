import { AceBaseIPCServer } from "../server";
import http from 'http';
import { IObserver, SimpleObservable } from "./simple-observable";
import WebSocket from 'ws';

(async function start() {
    // TODO: finish this...

    const dbname = 'mydb', port = 9163, token = 'ewout', maxPayload = 50;
    const server = new AceBaseIPCServer({ port, token, maxPayload }); // dbname, 
    await server.start();

    // Create test clients
    const n = 3;
    const clients = new Array(n).fill(0).map((n, i) => {
        const id = `client${i}`;
        console.log(`Creating client ${id}`);

        const ws = new WebSocket(`ws://localhost:${port}/${dbname}/connect?id=${id}&v=1.0.0&t=${token}`); 
        ws.addEventListener('open', e => console.log(`[${id}] open`));
        ws.addEventListener('error', e => {
            console.error(e);
        });
        ws.addEventListener('message', e => {
            const msg = e.data.toString();
            console.log(`[${id}] message received:`, msg);
            if (msg.startsWith('welcome:')) {
                // Parse & use config
                const config = JSON.parse(msg.slice(8));
                console.assert(config.maxPayload === maxPayload, 'we should get the configured payload back');
            }
            else if (msg.startsWith('connect:')) {
                // Other peer connected
                console.log(`[${id}] peer connected: ${msg.slice(8)}`);
            }
            else if (msg.startsWith('disconnect:')) {
                // Other peer disconnected
                console.log(`[${id}] peer disconnected: ${msg.slice(11)}`);
            }
        });

        const $events = new SimpleObservable<{ event: string, data?: any }>(observer => {
            const onMessage = async (ev: WebSocket.MessageEvent) => {
                let msg = ev.data as string;
                observer.next({ event: 'message', data: msg });
            };
            const onEvent = (ev: WebSocket.Event) => {
                observer.next({ event: ev.type });
            };
            const onError = (ev: WebSocket.ErrorEvent) => {
                observer.next({ event: 'error', data: ev.error });
            };
            ws.addEventListener('message', onMessage);
            ws.addEventListener('open', onEvent);
            ws.addEventListener('close', onEvent);
            ws.addEventListener('error', onError);

            return function cleanup() { 
                ws.removeEventListener('message', onMessage); 
                ws.removeEventListener('open', onEvent);
                ws.removeEventListener('close', onEvent);
                ws.removeEventListener('error', onError);
            };
        });

        /**
         * Observable for messages received from other peers. Does not include service messages
         */
        const $messages = new SimpleObservable<string>(observer => {
            const onMessage = async (ev: WebSocket.MessageEvent) => {
                let msg = ev.data as string;
                if (msg.startsWith('get:')) {
                    // Large message, download
                    const msgId = msg.slice(4);
                    msg = await fetch('GET', `/${dbname}/receive?id=${id}&msg=${msgId}&t=${token}`);
                }
                else if (/^[a-z]+:$/.test(msg)) {
                    // Ignore other service messages
                    return;
                }
                observer.next(msg);
            };
            ws.addEventListener('message', onMessage);

            return () => {
                ws.removeEventListener('message', onMessage);
            };
        });

        return {
            get id() { return id; },
            // ws: ws as WebSocket,
            async send(msg: string) {
                if (msg.length > maxPayload) {
                    await fetch('POST', `/${dbname}/send?id=${id}&t=${token}`, msg);
                }
                else {
                    ws.send(msg);
                }
            },
            onMessage: (callback: (msg: string) => void) => {
                return $messages.subscribe(callback);
            },
            onEvent: (callback: (event: string, data: any) => void) => {
                return $events.subscribe(ev => {
                    callback(ev.event, ev.data);
                });
            },
            close() {
                ws.close();
            }
        };
    });

    // wait for all to connect
    await Promise.all(clients.map(client => {
        return new Promise<void>(resolve => {
            let sub = client.onEvent(event => {
                if (event === 'open') { sub.unsubscribe(); resolve(); }
            });
        })
    }))

    // Let them all broadcast a hello message
    clients.forEach(async client => {
        client.send(`Hello my name is ${client.id}`);
    });

    // Simple fetch implementation for http GET and POST requests
    async function fetch(method: 'GET'|'POST', path: string, postData?: string) {
        const options = {
            hostname: 'localhost',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData || '')
            }
        };
        
        return await new Promise<string>((resolve, reject) => {
            const req = http.request(options, (res) => {
                // console.log(`STATUS: ${res.statusCode}`);
                // console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
                res.setEncoding('utf8');

                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve(data);
                });
            });
            
            req.on('error', (e) => {
                reject(`problem with request: ${e.message}`);
            });
            
            // Write data to request body
            req.write(postData);
            req.end();   
        });
    }
    

})();