/**
 * Firestore security rules, exercised against the real rules engine.
 *
 * These are not assertions about the text of firestore.rules - they are
 * actual reads and writes, allowed or denied by the same evaluator that runs
 * in production, inside the Firebase emulator. That distinction is the point:
 * a rule can read correctly and still be wrong, and the only way to know is
 * to try the attack.
 *
 * Run it with:
 *
 *     npm install
 *     npm run test:rules
 *
 * It needs Node and a JDK (the Firestore emulator is a Java program) and
 * touches no real Firebase project - the emulator is local and throwaway.
 */
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection,
  getDocs, query, where, serverTimestamp,
} from 'firebase/firestore';

let pass = 0;
const failures = [];

async function it(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(error).split('\n')[0].slice(0, 160)}`);
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: 'contex-rules-test',
  firestore: {
    rules: fs.readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8571,
  },
});

const alice = testEnv.authenticatedContext('alice').firestore();
const mallory = testEnv.authenticatedContext('mallory').firestore();
const guest = testEnv.unauthenticatedContext().firestore();

// Seed two history rows and two profiles with rules bypassed, so the tests
// below are about reading and writing them, not about creating them.
await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, 'users/alice'), {
    uid: 'alice', email: 'alice@example.com', displayName: 'Alice',
  });
  await setDoc(doc(db, 'users/mallory'), {
    uid: 'mallory', email: 'mallory@example.com', displayName: 'Mallory',
  });
  await setDoc(doc(db, 'ocr_history/alice-doc'), {
    uid: 'alice', fileName: 'notes.png', ocrType: 'convert',
    result: '\\documentclass{article}', truncated: false,
    timestamp: new Date(),
  });
  await setDoc(doc(db, 'ocr_history/mallory-doc'), {
    uid: 'mallory', fileName: 'other.png', ocrType: 'convert',
    result: 'x', truncated: false, timestamp: new Date(),
  });
});

console.log('=== a guest can reach nothing ===');
await it('a guest cannot read a profile', async () => {
  await assertFails(getDoc(doc(guest, 'users/alice')));
});
await it('a guest cannot read history', async () => {
  await assertFails(getDoc(doc(guest, 'ocr_history/alice-doc')));
});
await it('a guest cannot list history', async () => {
  await assertFails(getDocs(query(collection(guest, 'ocr_history'),
    where('uid', '==', 'alice'))));
});
await it('a guest cannot write history', async () => {
  await assertFails(addDoc(collection(guest, 'ocr_history'), {
    uid: 'alice', fileName: 'x', ocrType: 'convert', result: 'x',
    truncated: false, timestamp: serverTimestamp(),
  }));
});

console.log('\n=== a user reaches their own data and no one else\'s ===');
await it('reads their own profile', async () => {
  await assertSucceeds(getDoc(doc(alice, 'users/alice')));
});
await it('cannot read another profile', async () => {
  await assertFails(getDoc(doc(mallory, 'users/alice')));
});
await it('reads their own history item', async () => {
  await assertSucceeds(getDoc(doc(alice, 'ocr_history/alice-doc')));
});
await it('cannot read another user\'s history item', async () => {
  await assertFails(getDoc(doc(mallory, 'ocr_history/alice-doc')));
});
await it('cannot list another user\'s history', async () => {
  await assertFails(getDocs(query(collection(mallory, 'ocr_history'),
    where('uid', '==', 'alice'))));
});
await it('cannot list the whole collection', async () => {
  await assertFails(getDocs(collection(alice, 'ocr_history')));
});

console.log('\n=== ownership cannot be forged or moved ===');
await it('cannot write history into another account', async () => {
  await assertFails(addDoc(collection(mallory, 'ocr_history'), {
    uid: 'alice', fileName: 'planted.png', ocrType: 'convert',
    result: 'planted', truncated: false, timestamp: serverTimestamp(),
  }));
});
await it('cannot edit another user\'s history', async () => {
  await assertFails(updateDoc(doc(mallory, 'ocr_history/alice-doc'),
    { result: 'tampered' }));
});
await it('cannot delete another user\'s history', async () => {
  await assertFails(deleteDoc(doc(mallory, 'ocr_history/alice-doc')));
});
await it('cannot hand their own record to someone else', async () => {
  await assertFails(updateDoc(doc(alice, 'ocr_history/alice-doc'),
    { uid: 'mallory' }));
});
await it('cannot claim a profile that is not theirs', async () => {
  await assertFails(setDoc(doc(mallory, 'users/alice'),
    { uid: 'alice', email: 'attacker@example.com' }, { merge: true }));
});
await it('cannot disagree with their own document id', async () => {
  await assertFails(setDoc(doc(alice, 'users/alice'),
    { uid: 'mallory' }, { merge: true }));
});

console.log('\n=== server-controlled fields cannot be chosen by the client ===');
await it('cannot backdate a new record', async () => {
  await assertFails(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'old.png', ocrType: 'convert', result: 'x',
    truncated: false, timestamp: new Date('2000-01-01'),
  }));
});
await it('cannot post-date a new record to sort itself to the top', async () => {
  await assertFails(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'future.png', ocrType: 'convert', result: 'x',
    truncated: false, timestamp: new Date('2099-01-01'),
  }));
});
await it('cannot move an existing record in time', async () => {
  await assertFails(updateDoc(doc(alice, 'ocr_history/alice-doc'),
    { timestamp: serverTimestamp() }));
});
await it('cannot smuggle in an extra field', async () => {
  await assertFails(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'x.png', ocrType: 'convert', result: 'x',
    truncated: false, timestamp: serverTimestamp(),
    isAdmin: true,
  }));
});
await it('cannot smuggle an extra field onto a profile', async () => {
  await assertFails(setDoc(doc(alice, 'users/alice'),
    { role: 'admin' }, { merge: true }));
});
await it('cannot store a document larger than the app allows', async () => {
  await assertFails(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'huge.png', ocrType: 'convert',
    result: 'x'.repeat(60101),
    truncated: false, timestamp: serverTimestamp(),
  }));
});

console.log('\n=== what a legitimate client would still be allowed to do ===');
await it('writes a well-formed record for itself', async () => {
  await assertSucceeds(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'good.png', ocrType: 'convert',
    result: '\\documentclass{article}', truncated: false,
    timestamp: serverTimestamp(),
  }));
});
await it('updates its own profile with expected fields', async () => {
  await assertSucceeds(setDoc(doc(alice, 'users/alice'),
    { displayName: 'Alice A.', termsAcceptedVersion: '1.0-2026-08-24' },
    { merge: true }));
});
await it('deletes its own history item', async () => {
  await assertSucceeds(deleteDoc(doc(alice, 'ocr_history/alice-doc')));
});

console.log('\n=== nothing else in the database is reachable ===');
await it('an unrelated collection is closed to a user', async () => {
  await assertFails(getDoc(doc(alice, 'anything/else')));
});
await it('an unrelated collection is closed to writes', async () => {
  await assertFails(setDoc(doc(alice, 'anything/else'), { x: 1 }));
});
await it('a profile cannot be deleted from the client', async () => {
  await assertFails(deleteDoc(doc(alice, 'users/alice')));
});

await testEnv.cleanup();

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
for (const name of failures) console.log('  FAILED:', name);
process.exit(failures.length ? 1 : 0);
