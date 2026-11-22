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
  assert.match(capture, /app-window stream is view-only because the browser does not disclose its native HWND/);
  assert.doesNotMatch(capture.slice(capture.indexOf('if display_surface == "window"'), capture.indexOf('if display_surface != "monitor"')), /window_binding: Some/);
});
test('unknown screen source does not silently become a window', () => {
  assert.match(companion, /displaySurface:settings\.displaySurface\|\|'unknown'/);
  assert.match(capture, /if display_surface != "monitor"/);
});

test('native capture binds to the physical monitor origin, not taskbar-adjusted work-area origin', () => {
  assert.match(companion, /originXCss:screen\.left\|\|0/);
  assert.match(companion, /originYCss:screen\.top\|\|0/);
  assert.doesNotMatch(companion, /origin(?:X|Y)Css:screen\.avail(?:Left|Top)/);
});
test('monitor input requires a selected Backroom-launched app and an exact foreground HWND', () => {
  assert.match(capture, /frame_width\.abs_diff\(screen_width\) > tolerance_x/);
  assert.match(capture, /frame_height\.abs_diff\(screen_height\) > tolerance_y/);
  assert.match(capture, /app_id\.filter\(\|value\| Uuid::parse_str\(value\)\.is_ok\(\)\)/);
  assert.match(capture, /state\.launched_app_ids[\s\S]*?\.get\(&app_id\)/);
  assert.match(capture, /state\.desktop_processes[\s\S]*?get_mut\(&process_id\)/);
  assert.match(capture, /foreground_window_snapshot_for_process\(process_id\)/);
  assert.match(capture, /window_binding: Some\(window_binding\)/);
  assert.match(native, /fn validate_full_monitor_window_bounds/);
  assert.match(native, /current\.bounds == binding\.bounds/);
});
test('native launch identity is bound to the exact visible app window and cannot be caller-forged', () => {
  assert.match(native, /launched_app_ids: Mutex<HashMap<String, u32>>/);
  assert.match(companion, /appId/);
  assert.match(capture, /The selected application was not launched by this Backroom session/);
  assert.match(capture, /foreground_window_snapshot_for_process\(process_id\)/);
  assert.match(native, /fn capture_bounds[\s\S]*?window_binding/);
  assert.match(native, /fn capture_bounds[\s\S]*?This screen session has no verified native application window binding; desktop input is view-only/);
});
test('control UX and documentation explain native HWND-gated desktop control', () => {
  assert.match(companion, /foreground HWND, process identity and full-monitor window bounds match/);
  assert.match(frame, /foreground HWND \+ process \+ full-monitor bounds verified/);
  assert.match(frame, /browser-selected window alone does not prove native window identity/);
  assert.match(acceptance, /Capture source identity safety correction/);
});
test('desktop input grants are required independently of screen view', () => {
  assert.match(native, /control_granted\(&state, &session_id\)\?/);
  assert.match(native, /draft_granted\(&state, &session_id\)\?/);
  assert.match(native, /fn emergency_stop\(/);
});
