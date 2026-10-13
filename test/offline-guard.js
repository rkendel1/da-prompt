// Tests in this repository must not need the network. blockNetwork() makes that a checked fact rather than a habit: any attempt
// to open a TCP connection to a host other than this machine fails loudly (http, https and fetch all go through
// net.Socket#connect). Loopback stays open because the mock servers listen there.
import net from 'node:net';

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1|\[::1\]|::ffff:127(\.\d+){3})$/i;
export const blocked = [];

export function blockNetwork() {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect() hands Socket#connect an array [options, callback]; a direct call passes options, a port or a path.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host;
    if (first && typeof first === 'object') host = first.path ? 'localhost' : first.host || 'localhost';
    else if (typeof first === 'string' && Number.isNaN(Number(first))) host = 'localhost'; // a unix socket path
    else host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!LOOPBACK.test(String(host))) {
      blocked.push(String(host));
      const err = Object.assign(new Error(`test network guard: a connection to ${host} was blocked (tests must stay on this machine)`), { code: 'ETESTNETBLOCKED' });
      queueMicrotask(() => this.destroy(err));
      return this;
    }
    return original.apply(this, args);
  };
  return () => {
    net.Socket.prototype.connect = original;
  };
}
