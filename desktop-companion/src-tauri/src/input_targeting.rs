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
        validate_post_write_value, validate_target_metadata, validate_target_properties, EditableTargetIdentity,
    };
    use uiautomation::{
        actions::{Text, Value},
        controls::{DocumentControl, EditControl},
        types::{ControlType, Point, TextAttribute},
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
}
