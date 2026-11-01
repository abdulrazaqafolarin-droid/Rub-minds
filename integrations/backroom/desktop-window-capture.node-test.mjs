import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');
const [native, companion, frame, acceptance] = await Promise.all([
  read('../../desktop-companion/src-tauri/src/lib.rs'),
  read('../../desktop-companion/src/main.js'),
  read('../../src/BackroomDesktopControl.tsx'),
  read('../../docs/BACKROOM_DESKTOP_UIA_ACCEPTANCE_MATRIX.md'),
]);

const capture = native.slice(native.indexOf('fn set_capture_geometry('), native.indexOf('fn window_binding_matches('));
test('single-window streams fail closed because browser capture does not identify an HWND', () => {
  assert.match(capture, /if display_surface == "window"\s*\{\s*return Err\(/);
  assert.match(capture, /Single-window capture is view-only/);
  assert.doesNotMatch(capture, /window_binding: Some\(WindowCaptureBinding/);
});
test('unknown screen source does not silently become a window', () => {
  assert.match(companion, /displaySurface:settings\.displaySurface\|\|'unknown'/);
  assert.match(capture, /if display_surface != "monitor"/);
});
test('monitor input still requires verified dimensions', () => {
  assert.match(capture, /frame_width\.abs_diff\(screen_width\) > tolerance_x/);
  assert.match(capture, /frame_height\.abs_diff\(screen_height\) > tolerance_y/);
  assert.match(capture, /window_binding: None/);
});
test('native launch identity remains tracked and cannot be forged through display capture', () => {
  assert.match(native, /launched_app_ids: Mutex<HashMap<String, u32>>/);
  assert.match(companion, /appId/);
  assert.doesNotMatch(capture, /window_binding: Some\(WindowCaptureBinding/);
});
test('control UX and documentation explicitly distinguish window view from monitor control', () => {
  assert.match(companion, /A single-app window is view-only/);
  assert.match(frame, /Single-window capture is view-only/);
  assert.match(acceptance, /Capture source identity safety correction/);
});
test('desktop input grants are required independently of screen view', () => {
  assert.match(native, /control_granted\(&state, &session_id\)\?/);
  assert.match(native, /draft_granted\(&state, &session_id\)\?/);
  assert.match(native, /fn emergency_stop\(/);
});
