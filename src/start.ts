import { AceBaseIPCServer } from "./server";

// Usage: node start.js DBNAME=mydb HOST=localhost PORT=8585
// 


function getVariable(name: string, defaultValue?: string): string {
    // Checks if an argument with the name was passed, or if an environment variable was set with that name
    // If not found, the default value will be used if one if provided. An error is raised otherwise.
    name = name.toUpperCase();
    const arg = process.argv.find(arg => arg.toUpperCase().startsWith(`${name}=`));
    if (arg) { return arg.split('=')[1]; }
    if (typeof process.env[name] === 'string') { return process.env[name] as string; }
    if (typeof defaultValue === 'undefined') { throw new Error(`No value for variable "${name}" found in environment or startup args`); }
    return defaultValue;
}

// const dbname = getVariable('DBNAME');
const host = getVariable('HOST', 'localhost');
const port = +getVariable('PORT', '9163'); // 9,16,3: IPC
const useSSL = getVariable('SSL', '0') === '1';
const keyPath = useSSL && getVariable('KEY_PATH', '') || undefined;
const certPath = useSSL && getVariable('CERT_PATH', '') || undefined;
const pfxPath = useSSL && getVariable('PFX_PATH', '') || undefined;
const passphrase = useSSL && getVariable('PASSPHRASE', '') || undefined;
const ssl = useSSL ? { keyPath, certPath, pfxPath, passphrase } : undefined;
const token = getVariable('TOKEN', '') || undefined;
const maxPayload = +getVariable('MAX_PAYLOAD', '0') || undefined;

(async function start() {
    try {
        const server = new AceBaseIPCServer({ host, port, ssl, token, maxPayload }); //dbname, 
        await server.start();
        if (process.env?.NODE_APP_INSTANCE || process.env?.pm_id) {
            // Process was started by PM2, signal it's ready
            process.send && process.send('ready'); 
        }
    }
    catch (err) {
        console.error(err);
    }
})();
