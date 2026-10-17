import assert from "node:assert/strict";
import test from "node:test";
import { createVideoSession } from "../src/lib/video-session.ts";

const video = Object.freeze({ uri: "file:///camera/draft.mp4" });
const nextVideo = Object.freeze({ uri: "file:///camera/next.mp4" });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(overrides = {}) {
  const calls = { prepare: 0, record: 0, stop: 0, restore: 0, deleted: [] };
  const session = createVideoSession({
    prepare: async () => { calls.prepare++; return true; },
    record: async () => { calls.record++; return video; },
    stop: () => { calls.stop++; },
    onRestore: () => { calls.restore++; },
    deleteVideo: (uri) => { calls.deleted.push(uri); },
    ...overrides,
  });
  return { session, calls };
}

test("release during microphone or camera preparation never starts a recording", async () => {
  const pending = deferred();
  const { session, calls } = setup({ prepare: () => pending.promise });
  const start = session.start();
  session.release();
  assert.equal(session.getSnapshot().status, "stopping");
  pending.resolve(true);
  await start;
  assert.equal(calls.record, 0);
  assert.equal(calls.stop, 0);
  assert.equal(calls.restore, 1);
  assert.deepEqual(session.getSnapshot(), { status: "idle", video: null, error: null });
});

test("duplicate holds lock synchronously and release stops once before reviewing", async () => {
  const pending = deferred();
  let records = 0;
  const { session, calls } = setup({ record: () => { records++; return pending.promise; } });
  const start = session.start();
  await session.start();
  await Promise.resolve();
  assert.equal(records, 1);
  assert.equal(calls.prepare, 1);
  assert.equal(session.getSnapshot().status, "recording");
  session.release();
  session.release();
  assert.equal(calls.stop, 1);
  await session.start();
  assert.equal(records, 1);
  pending.resolve(video);
  await start;
  assert.deepEqual(session.getSnapshot(), { status: "review", video, error: null });
  await session.start();
  assert.equal(records, 1);
  assert.equal(calls.restore, 1);
});

test("a native duration limit can finish while held and later release preserves review", async () => {
  const { session, calls } = setup();
  await session.start();
  const review = session.getSnapshot();
  session.release();
  assert.equal(session.getSnapshot(), review);
  assert.equal(calls.stop, 0);
});

test("the ten-second fallback stops a held recording and does not repeat on release", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const { session, calls } = setup({ record: () => pending.promise });
  const start = session.start();
  await Promise.resolve();
  context.mock.timers.tick(9_999);
  assert.equal(calls.stop, 0);
  context.mock.timers.tick(1);
  assert.equal(calls.stop, 1);
  assert.equal(session.getSnapshot().status, "stopping");
  session.release();
  assert.equal(calls.stop, 1);
  pending.resolve(video);
  await start;
  assert.equal(session.getSnapshot().status, "review");
});

test("interruption stops native capture, locks until completion and deletes its late file", async () => {
  const pending = deferred();
  const { session, calls } = setup({ record: () => pending.promise });
  const start = session.start();
  await Promise.resolve();
  session.interrupt();
  assert.equal(calls.stop, 1);
  assert.deepEqual(session.getSnapshot(), { status: "idle", video: null, error: null });
  await session.start();
  assert.equal(calls.prepare, 1);
  pending.resolve(video);
  await start;
  assert.deepEqual(calls.deleted, [video.uri]);
  assert.equal(session.getSnapshot().status, "idle");
  assert.equal(calls.restore, 1);
  const retry = session.start();
  await retry;
  assert.equal(session.getSnapshot().status, "review");
});

test("interruption during preparation invalidates success and a rejection stays silent", async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    const { session, calls } = setup({ prepare: () => pending.promise });
    const start = session.start();
    session.interrupt();
    if (reject) pending.reject(new Error("private native details"));
    else pending.resolve(true);
    await start;
    assert.equal(calls.record, 0);
    assert.equal(calls.restore, 1);
    assert.deepEqual(session.getSnapshot(), { status: "idle", video: null, error: null });
  }
});

test("permission refusal and native failures allow recovery without exposing details", async () => {
  let allowed = false;
  const { session, calls } = setup({ prepare: async () => allowed });
  await session.start();
  assert.equal(session.getSnapshot().status, "idle");
  assert.ok(session.getSnapshot().error);
  assert.equal(calls.record, 0);
  allowed = true;
  await session.start();
  assert.equal(session.getSnapshot().status, "review");
  for (const callback of ["prepare", "record"]) {
    const failing = setup({ [callback]: () => { throw new Error(`private ${video.uri}`); } });
    await failing.session.start();
    assert.equal(failing.session.getSnapshot().status, "idle");
    assert.ok(!failing.session.getSnapshot().error.includes(video.uri));
    assert.equal(failing.calls.restore, 1);
  }
});

test("missing or remote results cannot enter local video review", async () => {
  for (const result of [undefined, null, { uri: "" }, { uri: "https://example.com/movie.mp4" }]) {
    const { session } = setup({ record: async () => result });
    await session.start();
    assert.equal(session.getSnapshot().status, "idle");
    assert.equal(session.getSnapshot().video, null);
    assert.ok(session.getSnapshot().error);
  }
});

test("discard and background interruption delete reviewed files exactly once", async () => {
  const { session, calls } = setup();
  await session.start();
  session.discard();
  session.discard();
  await session.start();
  session.interrupt();
  assert.deepEqual(calls.deleted, [video.uri, video.uri]);
  assert.equal(session.getSnapshot().video, null);
});

test("slow failed cleanup cannot overwrite the next recording's review", async () => {
  const pendingDelete = deferred();
  let result = video;
  const { session } = setup({ record: async () => result, deleteVideo: () => pendingDelete.promise });
  await session.start();
  session.discard();
  result = nextVideo;
  await session.start();
  const current = session.getSnapshot();
  pendingDelete.reject(new Error(`cannot delete ${video.uri}`));
  await Promise.resolve();
  assert.equal(session.getSnapshot(), current);
});

test("cleanup failure is generic and retry remains possible", async () => {
  const { session } = setup({ deleteVideo: () => { throw new Error(`cannot delete ${video.uri}`); } });
  await session.start();
  session.discard();
  assert.equal(session.getSnapshot().status, "idle");
  assert.ok(session.getSnapshot().error);
  assert.ok(!session.getSnapshot().error.includes(video.uri));
  await session.start();
  assert.equal(session.getSnapshot().status, "review");
});

test("stop failure keeps the native lock until capture settles", async () => {
  const pending = deferred();
  const { session, calls } = setup({ record: () => pending.promise, stop: () => { throw new Error("private stop details"); } });
  const start = session.start();
  await Promise.resolve();
  session.release();
  assert.equal(session.getSnapshot().status, "stopping");
  assert.ok(session.getSnapshot().error);
  await session.start();
  assert.equal(calls.prepare, 1);
  pending.resolve(video);
  await start;
  assert.equal(session.getSnapshot().status, "review");
});

test("synchronous release on preparing/recording notifications prevents native recording", async () => {
  for (const status of ["preparing", "recording"]) {
    const { session, calls } = setup();
    session.subscribe(() => { if (session.getSnapshot().status === status) session.release(); });
    await session.start();
    assert.equal(calls.record, 0);
    assert.equal(session.getSnapshot().status, "idle");
  }
});

test("snapshots are stable and immutable, and unsubscribed listeners do not run", async () => {
  const { session } = setup();
  const initial = session.getSnapshot();
  session.release();
  session.discard();
  assert.equal(session.getSnapshot(), initial);
  let notifications = 0;
  const unsubscribe = session.subscribe(() => { notifications++; });
  await session.start();
  assert.equal(notifications, 3);
  const current = session.getSnapshot();
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(current.video));
  assert.equal(session.getSnapshot(), current);
  unsubscribe();
  session.discard();
  assert.equal(notifications, 3);
});
