//! Fail-closed Windows UI Automation targeting for Backroom draft insertion.
//! A dragged rectangle is only a visual hint. The native host resolves its centre
//! to a real Edit/Document control and fingerprints that control before any write.
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditableTargetIdentity {
    pub process_id: i32,
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
        validate_target_metadata, validate_target_properties, EditableTargetIdentity,
    };
    use enigo::{Enigo, Keyboard, Settings};
    use uiautomation::{
        actions::{Text, Value},
        controls::{ControlType, DocumentControl, EditControl},
        types::{Point, TextAttribute},
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

        if process_id <= 0 || runtime_id.is_empty()
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
            bounds: [rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom()],
        }, value))
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
                let mut enigo = Enigo::new(&Settings::default())
                    .map_err(|_| "The native keyboard input driver is unavailable".to_string())?;
                enigo.text(text)
                    .map_err(|_| "Multi-line text input could not be delivered; inspect the editor before retrying".to_string())?;
                thread::sleep(Duration::from_millis(150));
            }
            _ => return Err("The selected editor uses an unsupported accessibility write mode".into()),
        }

        let (after_identity, after_value) = inspect_element(&element, false)?;
        if &after_identity != expected || after_value != text {
            return Err("Text insertion could not be verified by reading back the exact value. Inspect the field; do not retry automatically.".into());
        }
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
