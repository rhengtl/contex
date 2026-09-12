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

console.log('\n=== a signed-in user cannot reach their OWN data from the client ===');
// This is the block that changed. Every operation here is well-formed and
// owner-scoped -- what the previous rules permitted -- and every one must be
// refused, because the only legitimate route to these documents is the Worker.
await it('cannot read their own profile', async () => {
  await assertFails(getDoc(doc(alice, 'users/alice')));
});
await it('cannot read their own history item', async () => {
  await assertFails(getDoc(doc(alice, 'ocr_history/alice-doc')));
});
await it('cannot list their own history', async () => {
  await assertFails(getDocs(query(collection(alice, 'ocr_history'),
    where('uid', '==', 'alice'))));
});
await it('cannot write a well-formed record for themselves', async () => {
  await assertFails(addDoc(collection(alice, 'ocr_history'), {
    uid: 'alice', fileName: 'good.png', ocrType: 'convert',
    result: '\documentclass{article}', truncated: false,
    timestamp: serverTimestamp(),
  }));
});
await it('cannot write a record at a chosen id', async () => {
  await assertFails(setDoc(doc(alice, 'ocr_history/chosen'), {
    uid: 'alice', fileName: 'good.png', ocrType: 'convert',
    result: 'x', truncated: false, timestamp: serverTimestamp(),
  }));
});
await it('cannot update their own profile', async () => {
  await assertFails(setDoc(doc(alice, 'users/alice'),
    { displayName: 'Alice A.', termsAcceptedVersion: '1.0-2026-08-24' },
    { merge: true }));
});
await it('cannot mark their own terms as accepted', async () => {
  await assertFails(updateDoc(doc(alice, 'users/alice'),
    { termsAcceptedVersion: '9.9-2099-01-01' }));
});
await it('cannot delete their own history item', async () => {
  await assertFails(deleteDoc(doc(alice, 'ocr_history/alice-doc')));
});
await it('cannot delete their own profile', async () => {
  await assertFails(deleteDoc(doc(alice, 'users/alice')));
});

console.log('\n=== and certainly not anyone else\'s ===');
await it('cannot read another profile', async () => {
  await assertFails(getDoc(doc(mallory, 'users/alice')));
});
await it('cannot read another user\'s history item', async () => {
  await assertFails(getDoc(doc(mallory, 'ocr_history/alice-doc')));
});
await it('cannot list another user\'s history', async () => {
  await assertFails(getDocs(query(collection(mallory, 'ocr_history'),
    where('uid', '==', 'alice'))));
});
await it('cannot list the whole collection', async () => {
  await assertFails(getDocs(collection(mallory, 'ocr_history')));
});
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
await it('cannot claim a profile that is not theirs', async () => {
  await assertFails(setDoc(doc(mallory, 'users/alice'),
    { uid: 'alice', email: 'attacker@example.com' }, { merge: true }));
});

console.log('\n=== nothing else in the database is reachable ===');
await it('an unrelated collection is closed to reads', async () => {
  await assertFails(getDoc(doc(alice, 'anything/else')));
});
await it('an unrelated collection is closed to writes', async () => {
  await assertFails(setDoc(doc(alice, 'anything/else'), { x: 1 }));
});
await it('a collection group query finds nothing', async () => {
  await assertFails(getDocs(collection(alice, 'users/alice/private')));
});

await testEnv.cleanup();

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
for (const name of failures) console.log('  FAILED:', name);
process.exit(failures.length ? 1 : 0);
