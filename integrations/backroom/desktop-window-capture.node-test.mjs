import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');
const [native, targeting, companion, frame, acceptance] = await Promise.all([
  read('../../desktop-companion/src-tauri/src/lib.rs'),
  read('../../desktop-companion/src-tauri/src/input_targeting.rs'),
  read('../../desktop-companion/src/main.js'),
  read('../../src/BackroomDesktopControl.tsx'),
  read('../../docs/BACKROOM_DESKTOP_UIA_ACCEPTANCE_MATRIX.md'),
]);

test('foreground window identity is a fully comparable native value', () => {
  assert.match(targeting, /#\[derive\(Clone, Debug, Eq, PartialEq\)\]\s*pub struct ForegroundWindowSnapshot/);
  assert.match(targeting, /#\[derive\(Clone, Debug, Eq, PartialEq\)\]\s*pub struct EditableTargetIdentity/);
  assert.match(targeting, /get_native_window_handle\(\)/);
  assert.match(targeting, /foreground_window_snapshot_for_process\(expected_process_id\)/);
  assert.match(targeting, /matches\.len\(\) != 1/);
  assert.match(targeting, /get_process_id\(\)/);
  assert.match(targeting, /get_classname\(\)/);
  assert.match(targeting, /get_bounding_rectangle\(\)/);
});

test('unknown browser capture surfaces fail closed instead of being guessed as windows', () => {
  assert.match(companion, /displaySurface:settings\.displaySurface\s*\|\|\s*'unknown'/);
  assert.doesNotMatch(companion, /displaySurface:settings\.displaySurface\s*\|\|\s*'window'/);
  assert.match(native, /if display_surface == "window"/);
  assert.match(native, /if display_surface != "monitor"/);
});

test('window capture requires native identity and matching geometry', () => {
  assert.match(native, /struct WindowCaptureBinding/);
  assert.match(native, /window_binding: Option<WindowCaptureBinding>/);
  assert.match(native, /validate_window_capture_dimensions\(frame_width, frame_height, target\.bounds\)/);
  assert.match(native, /window_binding_matches\(binding, &current\)/);
  assert.match(native, /capture_bounds\(&state, &geometry\)\?/);
});

test('window capture never controls the companion window or a different app process', () => {
  assert.match(native, /expected_process_id: Option<u32>/);
  assert.match(native, /app_id: Option<String>/);
  assert.match(native, /launched_app_ids: Mutex<HashMap<String, u32>>/);
  assert.match(native, /registered_pid/);
  assert.match(native, /current_pid != Some\(binding\.process_id\)/);
  assert.match(native, /child\.try_wait\(\)/);
  assert.match(native, /app_id: selected_app_id/);
  assert.match(companion, /expectedProcessId:Number\.isSafeInteger\(expectedProcessId\)\?expectedProcessId:null,\s*appId/);
  assert.match(native, /target\.process_id != expected_pid/);
  assert.match(native, /identity\.process_id != binding\.process_id/);
  assert.match(native, /current\.process_id == binding\.process_id/);
  assert.match(native, /current\.handle == binding\.handle/);
  assert.match(native, /current\.class_name == binding\.class_name/);
});

test('window input is mapped from the captured window origin and revalidated per action', () => {
  assert.match(native, /fn map_normalized_point\(/);
  assert.match(native, /width\.saturating_sub\(1\)/);
  assert.match(native, /height\.saturating_sub\(1\)/);
  assert.match(native, /let bounds = capture_bounds\(&state, &geometry\)\?/);
  assert.match(native, /map_normalized_point\(bounds, x, y\)\?/);
});

test('the frame describes window or monitor geometry and fails closed until verified', () => {
  assert.match(frame, /selected window\/monitor geometry verified/);
  assert.match(frame, /view-only until capture geometry is verified/);
  assert.match(acceptance, /Single-application window capture/);
  assert.match(acceptance, /Capture surface type is missing or unknown/);
});
