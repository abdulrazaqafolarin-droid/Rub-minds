//! Fail-closed Windows UI Automation targeting for Backroom draft insertion.
//! A dragged rectangle is only a visual hint. The native host resolves its centre
//! to a real Edit/Document control and fingerprints that control before any write.
use std::thread;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForegroundWindowSnapshot {
    pub process_id: u32,
    pub handle: String,
    pub class_name: String,
    pub bounds: [i32; 4],
}

pub fn validate_window_capture_dimensions(
    frame_width: u32,
    frame_height: u32,
    bounds: [i32; 4],
) -> Result<(), &'static str> {
    if !(320..=16_384).contains(&frame_width) || !(200..=16_384).contains(&frame_height) {
        return Err("invalid_capture_dimensions");
    }
    let width = bounds[2].saturating_sub(bounds[0]);
    let height = bounds[3].saturating_sub(bounds[1]);
    if width < 320 || height < 200 {
        return Err("invalid_window_bounds");
    }
    // Strict tolerance: a title-bar/client-area mismatch remains view-only.
    let tolerance_x = (width as f64 * 0.01).ceil().max(4.0) as i32;
    let tolerance_y = (height as f64 * 0.01).ceil().max(4.0) as i32;
    if frame_width.abs_diff(width as u32) > tolerance_x as u32
        || frame_height.abs_diff(height as u32) > tolerance_y as u32
    {
        return Err("captured_window_geometry_mismatch");
    }
    Ok(())
}

pub fn foreground_window_snapshot_for_process(expected_process_id: u32) -> Result<ForegroundWindowSnapshot, String> {
    if expected_process_id == 0 {
        return Err("A Backroom-launched application process is required for interactive window capture".into());
    }
    #[cfg(target_os = "windows")]
    {
        return thread::spawn(move || windows_impl::foreground_window_snapshot_for_process(expected_process_id))
            .join()
            .map_err(|_| "Windows foreground-window inspection worker stopped unexpectedly".to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = expected_process_id;
        Err("Window-bound desktop control is currently supported by the Windows accessibility driver only".into())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditableTargetIdentity {
    pub process_id: u32,
    pub runtime_id: Vec<i32>,
    pub class_name: String,
    pub control_type: String,
    /// "value" uses UIA ValuePattern; "text" uses TextPattern readback and a
    /// keyboard write after the exact control has been focused and re-identified.
    pub access_mode: String,
    pub bounds: [i32; 4],
}

/// Exact local UI Automation identity of a possible Send control.
/// Accessible name and automation ID remain in the native process only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendControlIdentity {
    pub process_id: u32,
    pub runtime_id: Vec<i32>,
    pub class_name: String,
    pub accessible_name: String,
    pub automation_id: String,
    pub bounds: [i32; 4],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SendControlInspection {
    pub candidate: Option<SendControlIdentity>,
    pub reason: &'static str,
}

fn rect_is_valid(rect: [i32; 4]) -> bool {
    rect[2] > rect[0] && rect[3] > rect[1]
}

fn rect_inside(inner: [i32; 4], outer: [i32; 4]) -> bool {
    rect_is_valid(inner) && rect_is_valid(outer)
        && inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3]
}

fn axis_gap(a_start: i32, a_end: i32, b_start: i32, b_end: i32) -> i64 {
    if a_end < b_start { i64::from(b_start) - i64::from(a_end) }
    else if b_end < a_start { i64::from(a_start) - i64::from(b_end) }
    else { 0 }
}

/// Button names must be exact. Resource IDs are used only when the accessible
/// name is empty, and only when "send" is its own identifier token.
pub fn is_recognized_send_label(name: &str, automation_id: &str) -> bool {
    let normalized = name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    if matches!(normalized.as_str(), "send" | "send message" | "send prompt") {
        return true;
    }
    if !name.trim().is_empty() || automation_id.trim().is_empty() {
        return false;
    }

    // Reject misleading action identities even when a camel-case prefix
    // would otherwise split them into a standalone "send" token.
    let normalized_id = automation_id.to_lowercase();
    if ["resend", "email", "feedback", "share", "forward", "reply"]
        .iter()
        .any(|forbidden| normalized_id.contains(forbidden))
    {
        return false;
    }

    let chars: Vec<char> = automation_id.chars().collect();
    let mut token = String::new();
    let mut tokens = Vec::<String>::new();
    for (index, ch) in chars.iter().copied().enumerate() {
        if !ch.is_ascii_alphanumeric() {
            if !token.is_empty() { tokens.push(std::mem::take(&mut token)); }
            continue;
        }
        if ch.is_ascii_uppercase() && !token.is_empty()
            && chars.get(index.wrapping_sub(1)).is_some_and(|previous| previous.is_ascii_lowercase() || previous.is_ascii_digit())
        {
            tokens.push(std::mem::take(&mut token));
        }
        token.push(ch.to_ascii_lowercase());
    }
    if !token.is_empty() { tokens.push(token); }
    tokens.iter().any(|item| item == "send")
}

pub fn validate_send_control_candidate(
    control_type: &str,
    enabled: bool,
    offscreen: bool,
    same_process: bool,
    name: &str,
    automation_id: &str,
    window_bounds: [i32; 4],
    composer_bounds: [i32; 4],
    candidate_bounds: [i32; 4],
) -> Result<(), &'static str> {
    if control_type != "Button" { return Err("not_button_control"); }
    if !enabled { return Err("disabled_control"); }
    if offscreen { return Err("offscreen_control"); }
    if !same_process { return Err("different_process"); }
    if !rect_is_valid(window_bounds) || !rect_is_valid(composer_bounds) || !rect_is_valid(candidate_bounds) {
        return Err("invalid_control_bounds");
    }
    if !rect_inside(candidate_bounds, window_bounds) { return Err("outside_selected_app_window"); }
    if !is_recognized_send_label(name, automation_id) { return Err("unrecognized_send_control"); }

    let composer_width = i64::from(composer_bounds[2]) - i64::from(composer_bounds[0]);
    let composer_height = i64::from(composer_bounds[3]) - i64::from(composer_bounds[1]);
    let window_width = i64::from(window_bounds[2]) - i64::from(window_bounds[0]);
    let window_height = i64::from(window_bounds[3]) - i64::from(window_bounds[1]);
    let max_horizontal_gap = 96_i64.max(composer_width / 2).max(window_width / 10);
    let max_vertical_gap = 96_i64.max(composer_height * 3).max(window_height / 10);
    let horizontal_gap = axis_gap(
        composer_bounds[0], composer_bounds[2], candidate_bounds[0], candidate_bounds[2],
    );
    let vertical_gap = axis_gap(
        composer_bounds[1], composer_bounds[3], candidate_bounds[1], candidate_bounds[3],
    );
    if horizontal_gap > max_horizontal_gap || vertical_gap > max_vertical_gap {
        return Err("send_control_not_near_composer");
    }
    Ok(())
}

pub fn choose_send_control(candidates: Vec<SendControlIdentity>) -> SendControlInspection {
    match candidates.len() {
        0 => SendControlInspection { candidate: None, reason: "unique_nearby_send_control_not_found" },
        1 => SendControlInspection { candidate: candidates.into_iter().next(), reason: "unique_send_control_verified" },
        _ => SendControlInspection { candidate: None, reason: "multiple_send_controls_ambiguous" },
    }
}

pub fn inspect_send_control(composer: &EditableTargetIdentity) -> SendControlInspection {
    #[cfg(target_os = "windows")]
    {
        let composer = composer.clone();
        return thread::spawn(move || windows_impl::inspect_send_control(&composer))
            .join()
            .unwrap_or(SendControlInspection { candidate: None, reason: "uia_inspection_worker_failed" });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = composer;
        SendControlInspection { candidate: None, reason: "windows_accessibility_driver_unavailable" }
    }
}

pub fn revalidate_send_control(
    composer: &EditableTargetIdentity,
    expected_send: &SendControlIdentity,
) -> SendControlInspection {
    let current = inspect_send_control(composer);
    if current.candidate.as_ref() == Some(expected_send) {
        return current;
    }
    if current.candidate.is_some() {
        return SendControlInspection { candidate: None, reason: "send_control_identity_changed" };
    }
    current
}

pub fn inspect_at(x: i32, y: i32) -> Result<(EditableTargetIdentity, String), String> {
    #[cfg(target_os = "windows")]
    {
        return thread::spawn(move || windows_impl::inspect_at(x, y))
            .join()
            .map_err(|_| "Windows accessibility inspection worker stopped unexpectedly".to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Err("Verified editable-field targeting is currently supported by the Windows accessibility driver only".into())
    }
}

/// Pure safety gate for control metadata, independent of the current value.
pub fn validate_target_metadata(
    control_type: &str,
    enabled: bool,
    offscreen: bool,
    password: bool,
    read_only: bool,
    keyboard_focusable: bool,
) -> Result<(), &'static str> {
    if control_type != "Edit" && control_type != "Document" { return Err("not_editable_control"); }
    if !enabled { return Err("disabled_control"); }
    if offscreen { return Err("offscreen_control"); }
    if password { return Err("protected_control"); }
    if read_only { return Err("readonly_control"); }
    if !keyboard_focusable { return Err("not_keyboard_focusable"); }
    Ok(())
}

/// A new target is eligible only while its current value is empty.
pub fn validate_target_properties(
    control_type: &str,
    enabled: bool,
    offscreen: bool,
    password: bool,
    read_only: bool,
    keyboard_focusable: bool,
    value: &str,
) -> Result<(), &'static str> {
    validate_target_metadata(control_type, enabled, offscreen, password, read_only, keyboard_focusable)?;
    if !value.is_empty() { return Err("nonempty_control"); }
    Ok(())
}

/// Confirms the read-back value exactly matches the one-shot draft.
pub fn validate_post_write_value(expected: &str, actual: &str) -> Result<(), &'static str> {
    if expected.is_empty() { return Err("empty_expected_value"); }
    if actual != expected { return Err("readback_mismatch"); }
    Ok(())
}

/// Require the drag rectangle to lie predominantly inside one actual editable
/// control. A centre-point hit alone is not enough when the rectangle spans
/// multiple nearby controls or surrounding panels.
pub fn validate_drag_coverage(
    selection: [i32; 4],
    field: [i32; 4],
) -> Result<(), &'static str> {
    let [sl, st, sr, sb] = selection;
    let [fl, ft, fr, fb] = field;
    if sr <= sl || sb <= st || fr <= fl || fb <= ft {
        return Err("invalid_drag_or_field_bounds");
    }
    let selected_width = i64::from(sr) - i64::from(sl);
    let selected_height = i64::from(sb) - i64::from(st);
    if selected_width <= 0 || selected_height <= 0 {
        return Err("invalid_drag_or_field_bounds");
    }
    let overlap_width = (
        i64::from(sr.min(fr)) - i64::from(sl.max(fl))
    ).max(0) as f64;
    let overlap_height = (
        i64::from(sb.min(fb)) - i64::from(st.max(ft))
    ).max(0) as f64;
    let selected_area = selected_width as f64 * selected_height as f64;
    let coverage = overlap_width * overlap_height / selected_area;
    if coverage < 0.65 {
        return Err("drag_must_stay_inside_one_editable_field");
    }
    Ok(())
}

pub fn set_value_exact(
    x: i32,
    y: i32,
    expected: &EditableTargetIdentity,
    text: &str,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let expected = expected.clone();
        let text = text.to_string();
        return thread::spawn(move || windows_impl::set_value_exact(x, y, &expected, &text))
            .join()
            .map_err(|_| "Windows accessibility insertion worker stopped unexpectedly".to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, expected, text);
        Err("Verified editable-field insertion is currently supported by the Windows accessibility driver only".into())
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        validate_post_write_value, validate_send_control_candidate, validate_target_metadata,
        validate_target_properties, EditableTargetIdentity, SendControlIdentity,
        SendControlInspection,
    };
    use uiautomation::{
        actions::{Text, Value},
        controls::{DocumentControl, EditControl},
        types::{ControlType, Point, TextAttribute, TreeScope, UIProperty},
        variants::Variant,
        UIAutomation, UIElement,
    };

    const MAX_PARENT_DEPTH: usize = 8;

    fn editable_ancestor(automation: &UIAutomation, element: UIElement) -> Result<UIElement, String> {
        let walker = automation.get_control_view_walker()
            .map_err(|_| "Windows accessibility tree is unavailable".to_string())?;
        let mut current = element;
        for _ in 0..MAX_PARENT_DEPTH {
            let control_type = current.get_control_type().ok();
            if control_type == Some(ControlType::Edit) || control_type == Some(ControlType::Document) {
                return Ok(current);
            }
            current = walker.get_parent(&current)
                .map_err(|_| "The selected point is not inside an accessible editable field".to_string())?;
        }
        Err("No editable text control was found at the selected point".into())
    }

    fn read_value_and_mode(element: &UIElement, control_type: ControlType) -> Result<(String, bool, &'static str), String> {
        match control_type {
            ControlType::Edit => {
                let edit = EditControl::try_from(element.clone())
                    .map_err(|_| "The selected control does not expose an editable text interface".to_string())?;
                // Single-line Edit controls commonly expose ValuePattern.
                // Multi-line Edit controls often expose TextPattern instead.
                if let Ok(value) = edit.get_value() {
                    let read_only = edit.is_readonly()
                        .map_err(|_| "Could not verify whether the field is read-only".to_string())?;
                    return Ok((value, read_only, "value"));
                }
                let range = edit.get_document_range()
                    .map_err(|_| "The editor exposes neither a readable Value nor Text pattern".to_string())?;
                let read_only: bool = range.get_attribute_value(TextAttribute::IsReadOnly)
                    .map_err(|_| "Could not verify whether the text range is read-only".to_string())?
                    .try_into()
                    .map_err(|_| "The editor did not provide a reliable read-only attribute".to_string())?;
                let value = range.get_text(-1)
                    .map_err(|_| "Could not read the selected editor text".to_string())?;
                Ok((value, read_only, "text"))
            }
            ControlType::Document => {
                let document = DocumentControl::try_from(element.clone())
                    .map_err(|_| "The selected document does not expose an editable text interface".to_string())?;
                if let Ok(value) = document.get_value() {
                    let read_only = document.is_readonly()
                        .map_err(|_| "Could not verify whether the document is read-only".to_string())?;
                    return Ok((value, read_only, "value"));
                }
                let range = document.get_document_range()
                    .map_err(|_| "The document exposes neither a readable Value nor Text pattern".to_string())?;
                let read_only: bool = range.get_attribute_value(TextAttribute::IsReadOnly)
                    .map_err(|_| "Could not verify whether the document range is read-only".to_string())?
                    .try_into()
                    .map_err(|_| "The document did not provide a reliable read-only attribute".to_string())?;
                let value = range.get_text(-1)
                    .map_err(|_| "Could not read the selected document text".to_string())?;
                Ok((value, read_only, "text"))
            }
            _ => Err("The selected control is not an editable text control".into()),
        }
    }

    fn inspect_element(
        element: &UIElement,
        require_empty: bool,
    ) -> Result<(EditableTargetIdentity, String), String> {
        let control_type = element.get_control_type()
            .map_err(|_| "Could not identify the selected UI control".to_string())?;
        let control_type_label = match control_type {
            ControlType::Edit => "Edit",
            ControlType::Document => "Document",
            _ => return Err("Select an actual editable text field or document, not its surrounding panel".into()),
        };
        let enabled = element.is_enabled()
            .map_err(|_| "Could not verify whether the text field is enabled".to_string())?;
        let offscreen = element.is_offscreen()
            .map_err(|_| "Could not verify text-field visibility".to_string())?;
        let password = element.is_password()
            .map_err(|_| "Could not verify whether this is a protected field".to_string())?;
        let focusable = element.is_keyboard_focusable()
            .map_err(|_| "Could not verify whether the editor accepts keyboard focus".to_string())?;
        let (value, read_only, access_mode) = read_value_and_mode(element, control_type)?;
        if require_empty {
            validate_target_properties(
                control_type_label, enabled, offscreen, password, read_only, focusable, &value,
            ).map_err(str::to_string)?;
        } else {
            validate_target_metadata(
                control_type_label, enabled, offscreen, password, read_only, focusable,
            ).map_err(str::to_string)?;
        }

        let process_id = element.get_process_id()
            .map_err(|_| "Could not identify the application process".to_string())?;
        let runtime_id = element.get_runtime_id()
            .map_err(|_| "Could not create a stable accessibility identity".to_string())?;
        let class_name = element.get_classname()
            .map_err(|_| "Could not identify the selected control class".to_string())?;
        let rect = element.get_bounding_rectangle()
            .map_err(|_| "Could not verify the selected control bounds".to_string())?;

        if process_id == 0 || runtime_id.is_empty()
            || rect.get_right() <= rect.get_left()
            || rect.get_bottom() <= rect.get_top()
        {
            return Err("The selected control has incomplete accessibility identity".into());
        }

        Ok((EditableTargetIdentity {
            process_id,
            runtime_id,
            class_name,
            control_type: control_type_label.into(),
            access_mode: access_mode.into(),
            // UIA rectangles expose inclusive right/bottom pixels. Store half-open bounds
            // so normalized drag rectangles and overlap calculations use one convention.
            bounds: [rect.get_left(), rect.get_top(), rect.get_right().saturating_add(1), rect.get_bottom().saturating_add(1)],
        }, value))
    }

    pub fn foreground_window_snapshot_for_process(expected_process_id: u32) -> Result<super::ForegroundWindowSnapshot, String> {
        let automation = UIAutomation::new()
            .map_err(|_| "Windows UI Automation could not be initialized".to_string())?;
        let walker = automation.get_control_view_walker()
            .map_err(|_| "Windows accessibility window tree is unavailable".to_string())?;
        let root = automation.get_root_element()
            .map_err(|_| "Windows desktop accessibility root is unavailable".to_string())?;

        // Only one visible top-level window for the exact launched process can
        // be bound to a window capture. Multiple windows are ambiguous.
        let mut matches = Vec::new();
        let mut cursor = walker.get_first_child(&root).ok();
        while let Some(element) = cursor {
            if element.get_control_type().ok() == Some(ControlType::Window)
                && element.get_process_id().ok() == Some(expected_process_id)
                && element.is_offscreen().ok() == Some(false)
            {
                let handle = element.get_native_window_handle()
                    .map_err(|_| "The selected app window has no native Windows handle".to_string())?;
                let handle_text = handle.to_string();
                let class_name = element.get_classname()
                    .map_err(|_| "Windows could not identify the selected app window class".to_string())?;
                let rect = element.get_bounding_rectangle()
                    .map_err(|_| "Windows could not read the selected app window bounds".to_string())?;
                let bounds = [rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom()];
                if handle_text.is_empty() || handle_text == "0" || class_name.trim().is_empty()
                    || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]
                {
                    return Err("The selected app window identity or bounds are incomplete".into());
                }
                matches.push(super::ForegroundWindowSnapshot {
                    process_id: expected_process_id, handle: handle_text, class_name, bounds,
                });
            }
            cursor = walker.get_next_sibling(&element).ok();
        }
        if matches.len() != 1 {
            return Err("Interactive app-window capture requires exactly one visible top-level window for the Backroom-launched app. Close extra windows or choose monitor view.".into());
        }
        let selected = matches.remove(0);

        let focused = automation.get_focused_element()
            .map_err(|_| "Windows could not identify the foreground app window".to_string())?;
        let mut focused_window = focused;
        let mut is_window = false;
        for _ in 0..16 {
            if focused_window.get_control_type().ok() == Some(ControlType::Window) {
                is_window = true;
                break;
            }
            focused_window = walker.get_parent(&focused_window)
                .map_err(|_| "The foreground control is not inside an accessible app window".to_string())?;
        }
        let focused_handle = focused_window.get_native_window_handle()
            .map(|handle| handle.to_string()).ok();
        if !is_window
            || focused_window.get_process_id().ok() != Some(expected_process_id)
            || focused_handle.as_deref() != Some(selected.handle.as_str())
        {
            return Err("The foreground window is not the unique Backroom-launched application window. Restore that app and retry.".into());
        }
        Ok(selected)
    }

    fn half_open_bounds(element: &UIElement) -> Result<[i32; 4], String> {
        let rect = element.get_bounding_rectangle()
            .map_err(|_| "Could not verify accessibility control bounds".to_string())?;
        let bounds = [
            rect.get_left(),
            rect.get_top(),
            rect.get_right().saturating_add(1),
            rect.get_bottom().saturating_add(1),
        ];
        if bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
            return Err("The accessibility control has invalid bounds".into());
        }
        Ok(bounds)
    }

    fn selected_composer_window(
        automation: &UIAutomation,
        expected: &EditableTargetIdentity,
    ) -> Result<(UIElement, [i32; 4]), String> {
        let walker = automation.get_control_view_walker()
            .map_err(|_| "Windows accessibility tree is unavailable".to_string())?;
        // Re-resolve the selected empty composer by its saved screen bounds.
        // Requiring it to be keyboard-focused would make a harmless status
        // recheck depend on focus being moved away from the companion UI.
        let x = expected.bounds[0] + (expected.bounds[2] - expected.bounds[0]) / 2;
        let y = expected.bounds[1] + (expected.bounds[3] - expected.bounds[1]) / 2;
        let hit = automation.element_from_point(Point::new(x, y))
            .map_err(|_| "Windows could not re-identify the selected composer".to_string())?;
        let composer = editable_ancestor(automation, hit)?;
        let (current, value) = inspect_element(&composer, true)?;
        if &current != expected || !value.is_empty() {
            return Err("The selected composer changed or is no longer empty".into());
        }

        let mut current = composer;
        let mut selected_window: Option<(UIElement, [i32; 4], String)> = None;
        for _ in 0..MAX_PARENT_DEPTH * 2 {
            if current.get_control_type().ok() == Some(ControlType::Window) {
                let bounds = half_open_bounds(&current)?;
                let handle = current.get_native_window_handle()
                    .map(|value| value.to_string())
                    .map_err(|_| "The selected app window has no native identity".to_string())?;
                if current.get_process_id().ok() != Some(expected.process_id) || handle == "0" {
                    return Err("The selected composer is no longer inside its selected application window".into());
                }
                selected_window = Some((current.clone(), bounds, handle));
                break;
            }
            current = walker.get_parent(&current)
                .map_err(|_| "Could not locate the selected composer's application window".to_string())?;
        }
        let (window, bounds, selected_handle) = selected_window
            .ok_or("The selected composer has no verifiable application window")?;

        // Recheck may be requested from another device, so the target app need
        // not have the keyboard focus within its composer. Its top-level window
        // must, however, still be the actual foreground window on this PC.
        let mut focused = automation.get_focused_element()
            .map_err(|_| "Windows could not identify the foreground application window".to_string())?;
        let mut foreground_match = false;
        for _ in 0..MAX_PARENT_DEPTH * 2 {
            if focused.get_control_type().ok() == Some(ControlType::Window) {
                let handle = focused.get_native_window_handle()
                    .map(|value| value.to_string()).ok();
                foreground_match = focused.get_process_id().ok() == Some(expected.process_id)
                    && handle.as_deref() == Some(selected_handle.as_str());
                break;
            }
            focused = walker.get_parent(&focused)
                .map_err(|_| "The foreground control has no verifiable application window".to_string())?;
        }
        if !foreground_match {
            return Err("The selected app is no longer the foreground application window".into());
        }
        Ok((window, bounds))
    }

    fn collect_send_candidates(
        automation: &UIAutomation,
        window: &UIElement,
        process_id: u32,
        window_bounds: [i32; 4],
        composer_bounds: [i32; 4],
    ) -> Result<Vec<SendControlIdentity>, String> {
        // Use the provider's descendant FindAll operation rather than a
        // best-effort child/sibling walk. A failed query is not a partial
        // "unique" result; it invalidates the whole read-only capability check.
        let button_condition = automation.create_property_condition(
            UIProperty::ControlType,
            Variant::from(ControlType::Button as i32),
            None,
        ).map_err(|_| "Could not create the UI Automation Button query".to_string())?;
        let buttons = window.find_all(TreeScope::Descendants, &button_condition)
            .map_err(|_| "The selected app accessibility tree could not be read completely".to_string())?;
        if buttons.len() > 4_096 {
            return Err("The selected app contains too many accessible buttons to verify safely".into());
        }

        let mut candidates = Vec::new();
        for element in buttons {
            let candidate_process = element.get_process_id()
                .map_err(|_| "Could not verify the Send candidate process".to_string())?;
            if candidate_process != process_id {
                continue;
            }

            // A failed property read must not be converted into an empty label
            // or a guessed default. That could let an unreadable button be
            // mistaken for a uniquely identified Send action.
            let enabled = element.is_enabled()
                .map_err(|_| "Could not verify whether a candidate button is enabled".to_string())?;
            let offscreen = element.is_offscreen()
                .map_err(|_| "Could not verify candidate button visibility".to_string())?;
            let name = element.get_name()
                .map_err(|_| "Could not read a candidate button's accessible name".to_string())?;
            let automation_id = element.get_automation_id()
                .map_err(|_| "Could not read a candidate button's AutomationId".to_string())?;
            let bounds = half_open_bounds(&element)?;

            if validate_send_control_candidate(
                "Button",
                enabled,
                offscreen,
                true,
                &name,
                &automation_id,
                window_bounds,
                composer_bounds,
                bounds,
            ).is_err() {
                continue;
            }

            let runtime_id = element.get_runtime_id()
                .map_err(|_| "Send control has no stable accessibility identity".to_string())?;
            let class_name = element.get_classname()
                .map_err(|_| "Could not identify the Send control class".to_string())?;
            if runtime_id.is_empty() || class_name.trim().is_empty() {
                return Err("The Send control has an incomplete accessibility identity".into());
            }
            candidates.push(SendControlIdentity {
                process_id,
                runtime_id,
                class_name,
                accessible_name: name,
                automation_id,
                bounds,
            });
        }
        Ok(candidates)
    }

    pub fn inspect_send_control(composer: &EditableTargetIdentity) -> SendControlInspection {
        let automation = match UIAutomation::new() {
            Ok(value) => value,
            Err(_) => return SendControlInspection { candidate: None, reason: "uia_unavailable" },
        };
        let (window, window_bounds) = match selected_composer_window(&automation, composer) {
            Ok(value) => value,
            Err(_) => return SendControlInspection { candidate: None, reason: "composer_or_foreground_window_changed" },
        };
        let candidates = match collect_send_candidates(
            &automation, &window, composer.process_id, window_bounds, composer.bounds,
        ) {
            Ok(candidates) => candidates,
            Err(_) => return SendControlInspection { candidate: None, reason: "accessibility_tree_incomplete" },
        };
        super::choose_send_control(candidates)
    }

    pub fn inspect_at(x: i32, y: i32) -> Result<(EditableTargetIdentity, String), String> {
        let automation = UIAutomation::new()
            .map_err(|_| "Windows UI Automation could not be initialized".to_string())?;
        let hit = automation.element_from_point(Point::new(x, y))
            .map_err(|_| "Windows could not inspect the selected screen point".to_string())?;
        let element = editable_ancestor(&automation, hit)?;
        let (identity, value) = inspect_element(&element, true)?;
        let [left, top, right, bottom] = identity.bounds;
        if x < left || x >= right || y < top || y >= bottom {
            return Err("The drag-selection centre is outside the editable field".into());
        }
        Ok((identity, value))
    }

    pub fn set_value_exact(
        x: i32,
        y: i32,
        expected: &EditableTargetIdentity,
        text: &str,
    ) -> Result<(), String> {
        if text.is_empty() || text.chars().count() > 4_000 || text.chars().any(char::is_control) {
            return Err("Draft must be non-empty, single-line plain text of at most 4000 characters".into());
        }
        let automation = UIAutomation::new()
            .map_err(|_| "Windows UI Automation could not be initialized".to_string())?;
        let hit = automation.element_from_point(Point::new(x, y))
            .map_err(|_| "Windows could not inspect the selected screen point".to_string())?;
        let element = editable_ancestor(&automation, hit)?;
        let (identity, current_value) = inspect_element(&element, true)?;
        if &identity != expected {
            return Err("The selected application field changed or moved. Drag-select it again.".into());
        }
        if !current_value.is_empty() {
            return Err("The selected field is no longer empty. Existing text will not be overwritten.".into());
        }

        match identity.access_mode.as_str() {
            "value" => match element.get_control_type()
                .map_err(|_| "Could not re-identify the selected editable control".to_string())? {
                ControlType::Edit => {
                    EditControl::try_from(element.clone())
                        .map_err(|_| "The selected edit control is no longer writable".to_string())?
                        .set_value(text)
                        .map_err(|_| "The selected application rejected the exact text insertion".to_string())?;
                }
                ControlType::Document => {
                    DocumentControl::try_from(element.clone())
                        .map_err(|_| "The selected document is no longer writable".to_string())?
                        .set_value(text)
                        .map_err(|_| "The selected application rejected the exact text insertion".to_string())?;
                }
                _ => return Err("The selected control is no longer an editable field".into()),
            },
            "text" => {
                // TextPattern is read-only for content retrieval. Multi-line editors
                // therefore need keyboard input, but only after focusing this exact
                // UIA element and confirming that the OS reports that same element
                // (same process/runtime ID) as the focused editable control.
                element.set_focus()
                    .map_err(|_| "Windows could not focus the selected editor".to_string())?;
                let focused = automation.get_focused_element()
                    .map_err(|_| "Windows could not verify the focused editor".to_string())?;
                let focused_edit = editable_ancestor(&automation, focused)?;
                let (focused_identity, focused_value) = inspect_element(&focused_edit, true)?;
                if focused_identity != identity || !focused_value.is_empty() {
                    return Err("The focused editor does not match the selected empty text area. No text was typed.".into());
                }
                // UIElement::send_text focuses this exact UIA element before
                // emitting literal characters. It does not interpret Enter or
                // other control keys; those are excluded by the input validator.
                // The crate documents that a too-low interval can drop
                // characters in long text. Use a small non-zero cadence, then
                // require an exact read-back before reporting success.
                element.send_text(text, 8)
                    .map_err(|_| "Multi-line text input could not be delivered; inspect the editor before retrying".to_string())?;
            }
            _ => return Err("The selected editor uses an unsupported accessibility write mode".into()),
        }

        let (after_identity, after_value) = inspect_element(&element, false)?;
        if &after_identity != expected {
            return Err("The editable control identity changed during insertion. Inspect the field; do not retry automatically.".into());
        }
        validate_post_write_value(text, &after_value)
            .map_err(|_| "Text insertion could not be verified by reading back the exact value. Inspect the field; do not retry automatically.".to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::EditableTargetIdentity;

    fn identity() -> EditableTargetIdentity {
        EditableTargetIdentity {
            process_id: 42,
            runtime_id: vec![1, 2, 3],
            class_name: "Edit".into(),
            control_type: "Edit".into(),
            access_mode: "value".into(),
            bounds: [10, 20, 300, 80],
        }
    }

    #[test]
    fn window_capture_dimensions_reject_mismatched_or_invalid_bounds() {
        use super::validate_window_capture_dimensions as validate;
        assert!(validate(1280, 720, [100, 50, 1380, 770]).is_ok());
        assert!(validate(1280, 720, [100, 50, 1383, 773]).is_ok());
        assert_eq!(validate(1280, 720, [100, 50, 1600, 770]), Err("captured_window_geometry_mismatch"));
        assert_eq!(validate(1280, 720, [100, 50, 1380, 900]), Err("captured_window_geometry_mismatch"));
        assert_eq!(validate(200, 720, [0, 0, 200, 720]), Err("invalid_capture_dimensions"));
        assert_eq!(validate(1280, 720, [10, 10, 10, 100]), Err("invalid_window_bounds"));
    }

    #[test]
    fn post_write_readback_requires_the_exact_nonempty_draft() {
        use super::validate_post_write_value as validate;
        assert!(validate("exact draft", "exact draft").is_ok());
        assert_eq!(validate("", ""), Err("empty_expected_value"));
        assert_eq!(validate("expected", "different"), Err("readback_mismatch"));
        assert_eq!(validate("expected", "expected extra"), Err("readback_mismatch"));
    }

    #[test]
    fn drag_rectangle_must_be_mostly_inside_one_editable_control() {
        use super::validate_drag_coverage as validate;
        assert!(validate([20, 20, 80, 40], [10, 10, 100, 60]).is_ok());
        assert!(validate([15, 15, 105, 55], [10, 10, 110, 60]).is_ok());
        assert!(validate([0, 0, 100, 100], [0, 0, 65, 100]).is_ok());
        assert_eq!(validate([0, 0, 100, 100], [0, 0, 64, 100]), Err("drag_must_stay_inside_one_editable_field"));
        assert_eq!(validate([10, 10, 190, 90], [10, 10, 100, 60]), Err("drag_must_stay_inside_one_editable_field"));
        assert_eq!(validate([10, 10, 30, 30], [40, 40, 80, 80]), Err("drag_must_stay_inside_one_editable_field"));
        assert_eq!(validate([10, 10, 10, 30], [0, 0, 40, 40]), Err("invalid_drag_or_field_bounds"));
    }

    #[test]
    fn target_identity_is_exact_and_detects_replaced_or_moved_controls() {
        let original = identity();
        assert_eq!(original, identity());
        let mut replaced = identity();
        replaced.runtime_id = vec![1, 2, 4];
        assert_ne!(original, replaced);
        let mut moved = identity();
        moved.bounds[0] += 1;
        assert_ne!(original, moved);
        let mut other_process = identity();
        other_process.process_id += 1;
        assert_ne!(original, other_process);
        let mut other_access_mode = identity();
        other_access_mode.access_mode = "text".into();
        assert_ne!(original, other_access_mode);
    }

    #[test]
    fn target_policy_fails_closed_for_non_editable_or_unsafe_fields() {
        use super::validate_target_properties as validate;
        assert!(validate("Edit", true, false, false, false, true, "").is_ok());
        assert!(validate("Document", true, false, false, false, true, "").is_ok());
        assert_eq!(validate("Pane", true, false, false, false, true, ""), Err("not_editable_control"));
        assert_eq!(validate("Edit", false, false, false, false, true, ""), Err("disabled_control"));
        assert_eq!(validate("Edit", true, true, false, false, true, ""), Err("offscreen_control"));
        assert_eq!(validate("Edit", true, false, true, false, true, ""), Err("protected_control"));
        assert_eq!(validate("Edit", true, false, false, true, true, ""), Err("readonly_control"));
        assert_eq!(validate("Edit", true, false, false, false, false, ""), Err("not_keyboard_focusable"));
        assert_eq!(validate("Edit", true, false, false, false, true, "already typed"), Err("nonempty_control"));
        assert!(super::validate_target_metadata("Edit", true, false, false, false, true).is_ok());
        assert!(super::validate_target_metadata("Document", true, false, false, false, true).is_ok());
    }

    #[test]
    fn send_labels_are_exact_and_resource_ids_require_a_send_token() {
        use super::is_recognized_send_label as recognized;
        for label in ["Send", " send message ", "SEND PROMPT"] {
            assert!(recognized(label, ""), "{label}");
        }
        for label in ["Submit", "Send feedback", "Share", "Send to email", "New message"] {
            assert!(!recognized(label, ""), "{label}");
        }
        assert!(recognized("", "composer_send_button"));
        assert!(recognized("", "sendButton"));
        assert!(recognized("", "button-SEND"));
        assert!(!recognized("Submit", "send_button"));
        assert!(!recognized("", "sendbutton"));
        assert!(!recognized("", "resend_button"));
        assert!(!recognized("", "reSendButton"));
        assert!(!recognized("", "sendToEmail"));
        assert!(!recognized("", "composerSendFeedback"));
        assert!(!recognized("", "sendToShare"));
    }

    #[test]
    fn send_control_requires_unique_button_in_same_visible_app_window_and_near_composer() {
        use super::validate_send_control_candidate as validate;
        let window = [0, 0, 1000, 1800];
        let composer = [100, 1450, 900, 1700];
        let send = [820, 1630, 960, 1700];
        assert!(validate("Button", true, false, true, "Send", "", window, composer, send).is_ok());
        assert_eq!(validate("Edit", true, false, true, "Send", "", window, composer, send), Err("not_button_control"));
        assert_eq!(validate("Button", false, false, true, "Send", "", window, composer, send), Err("disabled_control"));
        assert_eq!(validate("Button", true, true, true, "Send", "", window, composer, send), Err("offscreen_control"));
        assert_eq!(validate("Button", true, false, false, "Send", "", window, composer, send), Err("different_process"));
        assert_eq!(validate("Button", true, false, true, "Submit", "", window, composer, send), Err("unrecognized_send_control"));
        assert_eq!(validate("Button", true, false, true, "Send", "", window, composer, [1001, 1630, 1080, 1700]), Err("outside_selected_app_window"));
        assert_eq!(validate("Button", true, false, true, "Send", "", window, composer, [820, 100, 960, 160]), Err("send_control_not_near_composer"));
        let narrow_composer = [100, 1450, 400, 1700];
        assert_eq!(validate("Button", true, false, true, "Send", "", window, narrow_composer, [900, 1630, 990, 1700]), Err("send_control_not_near_composer"));
        assert_eq!(validate("Button", true, false, true, "Send", "", window, [10, 10, 10, 20], send), Err("invalid_control_bounds"));
    }

    #[test]
    fn ambiguous_send_candidates_are_never_selected() {
        use super::{choose_send_control, SendControlIdentity};
        let candidate = |runtime_id: i32| SendControlIdentity {
            process_id: 42,
            runtime_id: vec![runtime_id],
            class_name: "Button".into(),
            accessible_name: "Send".into(),
            automation_id: "send_button".into(),
            bounds: [820, 1630, 960, 1700],
        };
        let none = choose_send_control(Vec::new());
        assert_eq!(none.candidate, None);
        assert_eq!(none.reason, "unique_nearby_send_control_not_found");
        let unique = choose_send_control(vec![candidate(1)]);
        assert_eq!(unique.candidate.unwrap().runtime_id, vec![1]);
        assert_eq!(unique.reason, "unique_send_control_verified");
        let ambiguous = choose_send_control(vec![candidate(1), candidate(2)]);
        assert_eq!(ambiguous.candidate, None);
        assert_eq!(ambiguous.reason, "multiple_send_controls_ambiguous");
    }
}
