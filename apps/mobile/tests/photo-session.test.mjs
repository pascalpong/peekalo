import assert from "node:assert/strict";
import test from "node:test";
import { createPhotoSession } from "../src/lib/photo-session.ts";

const photo = Object.freeze({ uri: "file:///camera/draft.jpg", width: 1200, height: 1600 });
const nextPhoto = Object.freeze({ ...photo, uri: "file:///camera/next.jpg" });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("locks synchronously against duplicate shutter presses and requires discard before a new capture", async () => {
  const pending = deferred();
  const session = createPhotoSession(() => {});
  let calls = 0;
  const take = () => { calls++; return pending.promise; };
  const first = session.capture(take);
  await session.capture(take);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().status, "capturing");
  pending.resolve(photo);
  await first;
  await session.capture(take);
  assert.equal(calls, 1);
  assert.deepEqual(session.getSnapshot(), { status: "review", photo, error: null });
});

test("an interrupted capture deletes a late result and cannot replace a newer review", async () => {
  const deleted = [];
  const pending = deferred();
  const session = createPhotoSession((value) => { deleted.push(value.uri); });
  const first = session.capture(() => pending.promise);
  session.interrupt();
  assert.equal(session.getSnapshot().status, "idle");
  await session.capture(async () => nextPhoto);
  const current = session.getSnapshot();
  pending.resolve(photo);
  await first;
  assert.equal(session.getSnapshot(), current);
  assert.deepEqual(deleted, [photo.uri]);
});

test("discard during capture also invalidates the native result", async () => {
  const deleted = [];
  const pending = deferred();
  const session = createPhotoSession((value) => { deleted.push(value.uri); });
  const capture = session.capture(() => pending.promise);
  session.discard();
  pending.resolve(photo);
  await capture;
  assert.deepEqual(session.getSnapshot(), { status: "idle", photo: null, error: null });
  assert.deepEqual(deleted, [photo.uri]);
});

test("review discard and background interruption each clear the local draft once", async () => {
  const deleted = [];
  const session = createPhotoSession((value) => { deleted.push(value.uri); });
  await session.capture(async () => photo);
  session.discard();
  session.discard();
  await session.capture(async () => nextPhoto);
  session.interrupt();
  assert.deepEqual(deleted, [photo.uri, nextPhoto.uri]);
  assert.equal(session.getSnapshot().photo, null);
});

test("native capture failure is generic and allows recovery", async () => {
  const session = createPhotoSession(() => {});
  await session.capture(async () => { throw new Error(`private native details ${photo.uri}`); });
  assert.equal(session.getSnapshot().status, "idle");
  assert.ok(session.getSnapshot().error);
  assert.ok(!session.getSnapshot().error.includes(photo.uri));
  await session.capture(async () => photo);
  assert.deepEqual(session.getSnapshot(), { status: "review", photo, error: null });
});

test("a stale native rejection does not change newer state", async () => {
  const pending = deferred();
  const session = createPhotoSession(() => {});
  const oldCapture = session.capture(() => pending.promise);
  session.interrupt();
  await session.capture(async () => nextPhoto);
  const current = session.getSnapshot();
  pending.reject(new Error("old native failure"));
  await oldCapture;
  assert.equal(session.getSnapshot(), current);
});

test("missing and invalid native results never enter review; malformed local files are cleaned", async () => {
  const deleted = [];
  const session = createPhotoSession((value) => { deleted.push(value.uri); });
  for (const result of [undefined, null, { ...photo, width: 0 }, { ...photo, height: Infinity }, { ...photo, width: 1.5 }, { ...photo, uri: "https://example.com/photo.jpg" }, { ...photo, uri: "" }]) {
    await session.capture(async () => result);
    assert.equal(session.getSnapshot().status, "idle");
    assert.equal(session.getSnapshot().photo, null);
    assert.ok(session.getSnapshot().error);
  }
  assert.deepEqual(deleted, [photo.uri, photo.uri, photo.uri]);
});

test("cleanup failure is generic and cannot prevent the next capture", async () => {
  const session = createPhotoSession(() => { throw new Error(`unable to delete ${photo.uri}`); });
  await session.capture(async () => photo);
  session.discard();
  assert.ok(session.getSnapshot().error);
  assert.ok(!session.getSnapshot().error.includes(photo.uri));
  await session.capture(async () => nextPhoto);
  assert.equal(session.getSnapshot().status, "review");
  assert.equal(session.getSnapshot().error, null);
});

test("a slow failing cleanup cannot replace a newer capture", async () => {
  const pendingDelete = deferred();
  const session = createPhotoSession(() => pendingDelete.promise);
  await session.capture(async () => photo);
  session.discard();
  await session.capture(async () => nextPhoto);
  const current = session.getSnapshot();
  pendingDelete.reject(new Error("delete failed"));
  await Promise.resolve();
  assert.equal(session.getSnapshot(), current);
});

test("snapshots stay stable between changes, are immutable, and unsubscribe works", async () => {
  const session = createPhotoSession(() => {});
  let changes = 0;
  const unsubscribe = session.subscribe(() => { changes++; });
  const idle = session.getSnapshot();
  session.discard();
  assert.equal(session.getSnapshot(), idle);
  await session.capture(async () => photo);
  const review = session.getSnapshot();
  assert.equal(changes, 2);
  assert.equal(session.getSnapshot(), review);
  assert.ok(Object.isFrozen(review));
  assert.ok(Object.isFrozen(review.photo));
  unsubscribe();
  session.discard();
  assert.equal(changes, 2);
});
