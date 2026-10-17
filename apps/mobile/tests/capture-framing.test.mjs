import assert from "node:assert/strict";
import test from "node:test";
import { centerCrop916, frame916 } from "../src/lib/capture-framing.ts";

test("an existing 9:16 portrait retains its entire frame", () => {
  assert.deepEqual(centerCrop916(1080, 1920), { originX: 0, originY: 0, width: 1080, height: 1920 });
});

test("4:3 portrait capture crops the sides to the visible portrait frame", () => {
  assert.deepEqual(centerCrop916(3024, 4032), { originX: 378, originY: 0, width: 2268, height: 4032 });
});

test("landscape input produces an upright centered portrait crop", () => {
  assert.deepEqual(centerCrop916(4032, 3024), { originX: 1165, originY: 0, width: 1701, height: 3024 });
});

test("tall and odd-sized sources remain centered with exact integer 9:16 dimensions", () => {
  for (const [width, height] of [[1080, 2340], [3025, 4033], [1921, 1081], [9, 16], [17, 33]]) {
    const crop = centerCrop916(width, height);
    assert.equal(crop.width * 16, crop.height * 9);
    assert.ok(crop.width > 0 && crop.height > 0);
    assert.ok(Object.values(crop).every(Number.isSafeInteger));
    assert.ok(crop.originX >= 0 && crop.originX + crop.width <= width);
    assert.ok(crop.originY >= 0 && crop.originY + crop.height <= height);
    assert.ok(Math.abs(crop.originX - (width - crop.originX - crop.width)) <= 1);
    assert.ok(Math.abs(crop.originY - (height - crop.originY - crop.height)) <= 1);
    assert.ok(crop.width + 9 > width || crop.height + 16 > height);
  }
});

test("invalid or undersized capture dimensions fail before native manipulation", () => {
  for (const [width, height] of [[0, 16], [9, 0], [-9, 16], [8, 16], [9, 15], [9.5, 16], [9, 16.5], [NaN, 16], [9, Infinity], [Number.MAX_SAFE_INTEGER + 1, 16]]) {
    assert.throws(() => centerCrop916(width, height), /Invalid capture dimensions/);
  }
});

test("preview frame fits tall phones and landscape layouts without stretching", () => {
  assert.deepEqual(frame916(1080, 2340), { left: 0, top: 210, width: 1080, height: 1920 });
  assert.deepEqual(frame916(1920, 1080), { left: 656.25, top: 0, width: 607.5, height: 1080 });
  const frame = frame916(393.5, 850.25);
  assert.equal(frame.width, 393.5);
  assert.ok(Math.abs(frame.width / frame.height - 9 / 16) < 1e-12);
});

test("unmeasured or invalid preview layouts cannot produce a frame", () => {
  for (const [width, height] of [[0, 100], [100, 0], [-1, 100], [NaN, 100], [100, Infinity]]) {
    assert.throws(() => frame916(width, height), /Invalid camera frame dimensions/);
  }
});
