import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getContainedVideoRect,
  mapVideoSelectionToFrame,
} from './video-selection-overlay.mjs';

test('portrait monitor is centred with horizontal letterboxing in a landscape frame', () => {
  const frame = { left: 0, top: 0, width: 1920, height: 1080 };
  const video = getContainedVideoRect(frame, 1080, 1920);
  assert.deepEqual(video, {
    left: 656.25,
    top: 0,
    width: 607.5,
    height: 1080,
  });

  const mapped = mapVideoSelectionToFrame(video, frame, {
    x: 0.2, y: 0.1, width: 0.5, height: 0.25,
  });
  assert.deepEqual(mapped, {
    left: 40.5078125,
    top: 10,
    width: 15.8203125,
    height: 25,
  });
});

test('landscape video fills the frame without adding an overlay offset', () => {
  const frame = { left: 120, top: 80, width: 1600, height: 900 };
  const video = getContainedVideoRect(frame, 1920, 1080);
  assert.deepEqual(video, frame);
  assert.deepEqual(mapVideoSelectionToFrame(video, frame, {
    x: 0.1, y: 0.2, width: 0.3, height: 0.4,
  }), {
    left: 10,
    top: 20,
    width: 30,
    height: 40,
  });
});

test('portrait frame creates vertical letterboxing for a landscape monitor', () => {
  const frame = { left: 10, top: 20, width: 800, height: 1200 };
  const video = getContainedVideoRect(frame, 1920, 1080);
  assert.equal(video.width, 800);
  assert.equal(video.height, 450);
  assert.equal(video.left, 10);
  assert.equal(video.top, 395);
  assert.deepEqual(mapVideoSelectionToFrame(video, frame, {
    x: 0, y: 0, width: 1, height: 1,
  }), {
    left: 0,
    top: 31.25,
    width: 100,
    height: 37.5,
  });
});

test('invalid video, frame and normalized selection geometry fail closed', () => {
  assert.equal(getContainedVideoRect({ left: 0, top: 0, width: 0, height: 1080 }, 1920, 1080), null);
  assert.equal(getContainedVideoRect({ left: 0, top: 0, width: 1920, height: 1080 }, NaN, 1080), null);
  const frame = { left: 0, top: 0, width: 1920, height: 1080 };
  assert.equal(mapVideoSelectionToFrame(frame, { ...frame, width: 0 }, {
    x: 0, y: 0, width: 0.5, height: 0.5,
  }), null);
  assert.equal(mapVideoSelectionToFrame(frame, frame, {
    x: -0.01, y: 0, width: 0.5, height: 0.5,
  }), null);
  assert.equal(mapVideoSelectionToFrame(frame, frame, {
    x: 0.8, y: 0, width: 0.3, height: 0.5,
  }), null);
  assert.equal(mapVideoSelectionToFrame(frame, frame, {
    x: 0, y: 0, width: 0, height: 0.5,
  }), null);
});
