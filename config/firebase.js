
import admin from 'firebase-admin';
import { env } from './env.js';

if (!env.firebaseClientEmail || !env.firebasePrivateKey) {
  throw new Error(
    'Firebase Admin credentials missing. Configure FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in server/.env'
  );
}

if (!admin.apps.length) {
  const privateKey = env.firebasePrivateKey.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.firebaseProjectId,
      clientEmail: env.firebaseClientEmail,
      privateKey,
    }),
    databaseURL: env.firebaseDatabaseUrl,
  });
}

export const authAdmin = admin.auth();

const root = admin.database().ref('jupiter');

export const db = {
  ref(path = '') {
    return path ? root.child(path) : root;
  },

  async get(path) {
    const snapshot = await root.child(path).get();
    return snapshot.exists() ? snapshot.val() : null;
  },

  async set(path, value) {
    await root.child(path).set(value);
  },

  async update(values) {
    const clean = {};

    for (const [path, value] of Object.entries(values)) {
      clean[path.replace(/^\/+|\/+$/g, '')] = value;
    }

    await root.update(clean);
  },

  async remove(path) {
    await root.child(path).remove();
  },

  async transaction(path, fn) {
    return root.child(path).transaction(fn);
  },

  key() {
    return root.push().key;
  },
};
