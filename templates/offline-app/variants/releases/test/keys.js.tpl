// Test publisher keys, generated per run (never stored).
import { generateKeyPairSync } from 'node:crypto';

export const newPublisherPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
