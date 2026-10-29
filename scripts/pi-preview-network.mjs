// Defense in depth for the isolated Next child only. Never preload in a real server.
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { const error = new Error('Collaudo isolato: rete in uscita vietata.'); error.code = 'PREVIEW_NETWORK_DENIED'; throw error; };
net.Socket.prototype.connect = deny;
tls.connect = deny;
globalThis.fetch = async () => deny();
syncBuiltinESMExports();
