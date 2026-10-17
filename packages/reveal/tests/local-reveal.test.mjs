import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalRevealSession } from '../src/local-reveal.ts';

function harness() {
  let time = 0;
  const timers = new Set();
  const canceled = [];
  const session = createLocalRevealSession({
    budgetMs: 10_000, now: () => time,
    schedule(callback, delay) {
      const timer = { callback, at: time + delay };
      timers.add(timer);
      return () => { timers.delete(timer); canceled.push(callback); };
    },
  });
  return {
    session, timers, canceled,
    setTime: value => { time = value; },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        time = next.at;
        timers.delete(next);
        next.callback();
      }
      time = end;
    },
  };
}

test('starts hidden, requires a foreground viewer, and merely enabling does not spend', () => {
  const { session, advance } = harness();
  assert.equal(session.start(), false);
  session.setEnabled(true);
  advance(20_000);
  assert.deepEqual(session.getSnapshot(), { status: 'hidden', remainingMs: 10_000 });
});

test('two holds share one budget and idle time does not consume it', () => {
  const { session, advance } = harness();
  session.setEnabled(true);
  session.start(); advance(2_125); session.stop();
  assert.equal(session.getSnapshot().remainingMs, 7_875);
  advance(5_000);
  session.start(); advance(875); session.stop();
  assert.deepEqual(session.getSnapshot(), { status: 'hidden', remainingMs: 7_000 });
});

test('duplicate starts and repeated releases cannot refill or create overlapping timers', () => {
  const { session, advance, timers } = harness();
  session.setEnabled(true);
  assert.equal(session.start(), true);
  advance(2_000);
  assert.equal(session.start(), false);
  assert.equal(timers.size, 1);
  advance(1_000); session.stop(); session.stop();
  assert.equal(session.getSnapshot().remainingMs, 7_000);
  assert.equal(timers.size, 0);
});

test('exhausts exactly at the deadline; further holds cannot reveal', () => {
  const { session, advance, timers } = harness();
  session.setEnabled(true); session.start(); advance(10_000);
  assert.deepEqual(session.getSnapshot(), { status: 'exhausted', remainingMs: 0 });
  assert.equal(session.start(), false);
  assert.equal(timers.size, 0);
});

test('background/navigation interruption hides and requires a new hold after returning', () => {
  const { session, advance } = harness();
  session.setEnabled(true); session.start(); advance(1_250);
  session.setEnabled(false); advance(30_000);
  assert.equal(session.start(), false);
  session.setEnabled(true);
  assert.deepEqual(session.getSnapshot(), { status: 'hidden', remainingMs: 8_750 });
});

test('a canceled queued callback cannot hide or debit a newer hold', () => {
  const { session, advance, canceled } = harness();
  session.setEnabled(true); session.start(); advance(25); session.stop();
  const stale = canceled[0];
  session.start(); advance(10); stale();
  assert.equal(session.getSnapshot().status, 'revealing');
  session.stop();
  assert.equal(session.getSnapshot().remainingMs, 9_965);
});

test('accessible timed reveal uses the same budget and stops by itself', () => {
  const { session, advance } = harness();
  session.setEnabled(true); session.start(1_000); advance(1_000);
  assert.deepEqual(session.getSnapshot(), { status: 'hidden', remainingMs: 9_000 });
  session.start(); advance(500); session.stop();
  assert.equal(session.getSnapshot().remainingMs, 8_500);
});

test('delayed callbacks account actual elapsed time and cannot extend the budget', () => {
  const { session, timers, setTime } = harness();
  session.setEnabled(true); session.start();
  setTime(15_000);
  [...timers][0].callback();
  assert.deepEqual(session.getSnapshot(), { status: 'exhausted', remainingMs: 0 });
});

test('backwards and invalid clock values cannot add time', () => {
  const { session, advance, setTime } = harness();
  session.setEnabled(true); session.start(); advance(1_000);
  setTime(500); session.stop();
  assert.equal(session.getSnapshot().remainingMs, 9_000);
  session.start(); setTime(NaN); session.stop();
  assert.deepEqual(session.getSnapshot(), { status: 'exhausted', remainingMs: 0 });
});

test('unsubscribing stops notifications; snapshots are stable and immutable', () => {
  const { session } = harness();
  let changes = 0;
  const initial = session.getSnapshot();
  assert.equal(session.getSnapshot(), initial);
  const unsubscribe = session.subscribe(() => { changes++; });
  session.setEnabled(true); session.start();
  assert.equal(changes, 1);
  assert.ok(Object.isFrozen(session.getSnapshot()));
  unsubscribe(); session.stop();
  assert.equal(changes, 1);
});

test('a listener can synchronously cancel revelation without leaving a timer', () => {
  const { session, timers } = harness();
  session.subscribe(() => { if (session.getSnapshot().status === 'revealing') session.setEnabled(false); });
  session.setEnabled(true); session.start();
  assert.equal(session.getSnapshot().status, 'hidden');
  assert.equal(timers.size, 0);
});

test('a synchronous subscriber restart replaces the old timer instead of duplicating it', () => {
  const { session, advance, timers } = harness();
  let restarted = false;
  session.subscribe(() => {
    if (!restarted && session.getSnapshot().status === 'revealing' && session.getSnapshot().remainingMs < 10_000) {
      restarted = true;
      session.stop(); session.start();
    }
  });
  session.setEnabled(true); session.start(); advance(50);
  assert.equal(timers.size, 1);
  session.stop();
  assert.equal(timers.size, 0);
});
