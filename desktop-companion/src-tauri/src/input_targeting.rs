//! Fail-closed Windows UI Automation targeting for Backroom draft insertion.
//! A dragged rectangle is only a visual hint. This module resolves its centre to
//! a real editable UIA control, captures a stable identity, and reads the value
//! again immediately before and after typing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditableTargetIdentity {
    pub process_id: i32,
    pub runtime_id: Vec<i32>,
    pub class_name: String,
    pub bounds: [i32; 4],
}

pub fn inspect_at(x: i32, y: i32) -> Result<(EditableTargetIdentity, String), String> {
    #[cfg(target_os = "windows")]
    {
        return std::thread::spawn(move || windows_impl::inspect_at(x, y))
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
pub fn validate_target_metadata(control_type: &str, enabled: bool, offscreen: bool, password: bool, read_only: bool) -> Result<(), &'static str> {
    if control_type != "Edit" && control_type != "Document" { return Err("not_editable_control"); }
    if !enabled { return Err("disabled_control"); }
    if offscreen { return Err("offscreen_control"); }
    if password { return Err("protected_control"); }
    if read_only { return Err("readonly_control"); }
    Ok(())
}

/// A new target is eligible only while its current value is empty.
pub fn validate_target_properties(control_type: &str, enabled: bool, offscreen: bool, password: bool, read_only: bool, value: &str) -> Result<(), &'static str> {
    validate_target_metadata(control_type, enabled, offscreen, password, read_only)?;
    if !value.is_empty() { return Err("nonempty_control"); }
    Ok(())
}
pub fn set_value_exact(x: i32, y: i32, expected: &EditableTargetIdentity, text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let expected = expected.clone();
        let text = text.to_string();
        return std::thread::spawn(move || windows_impl::set_value_exact(x, y, &expected, &text))
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
    use super::EditableTargetIdentity;
    use uiautomation::{
        actions::Value,
        controls::{ControlType, DocumentControl, EditControl},
        types::Point,
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

    fn inspect_element(element: &UIElement, require_empty: bool) -> Result<(EditableTargetIdentity, String), String> {
        let control_type = element.get_control_type()
            .map_err(|_| "Could not identify the selected UI control".to_string())?;
        let control_type_label = match control_type {
            ControlType::Edit => "Edit",
            ControlType::Document => "Document",
            _ => return Err("Select an actual editable text field or document, not its surrounding panel".into()),
        };
        let enabled = element.is_enabled().map_err(|_| "Could not verify whether the text field is enabled".to_string())?;
        let offscreen = element.is_offscreen().map_err(|_| "Could not verify text-field visibility".to_string())?;
        let password = element.is_password().map_err(|_| "Could not verify whether this is a protected field".to_string())?;

        // Support native Edit fields and Document controls only when they expose
        // a writable ValuePattern. Rich/custom controls without readback fail closed.
        let (read_only, value) = match control_type {
            ControlType::Edit => {
                let edit = EditControl::try_from(element.clone())
                    .map_err(|_| "The selected control does not expose a supported editable value".to_string())?;
                let read_only = edit.is_readonly().map_err(|_| "Could not verify whether the field is read-only".to_string())?;
                let value = edit.get_value().map_err(|_| "The selected field does not support reliable accessibility readback".to_string())?;
                (read_only, value)
            }
            ControlType::Document => {
                let document = DocumentControl::try_from(element.clone())
                    .map_err(|_| "The selected document does not expose an editable value".to_string())?;
                let read_only = document.is_readonly().map_err(|_| "Could not verify whether the document is read-only".to_string())?;
                let value = document.get_value().map_err(|_| "The selected document does not support reliable accessibility readback".to_string())?;
                (read_only, value)
            }
            _ => unreachable!(),
        };
        if require_empty {
            validate_target_properties(control_type_label, enabled, offscreen, password, read_only, &value)
                .map_err(str::to_string)?;
        } else {
            validate_target_metadata(control_type_label, enabled, offscreen, password, read_only)
                .map_err(str::to_string)?;
        }

        let process_id = element.get_process_id()
            .map_err(|_| "Could not identify the application process".to_string())?;
        let runtime_id = element.get_runtime_id()
            .map_err(|_| "Could not create a stable accessibility identity".to_string())?;
        let class_name = element.get_classname()
            .map_err(|_| "Could not identify the selected control class".to_string())?;
        let rect = element.get_bounding_rectangle()
            .map_err(|_| "Could not verify the selected control bounds".to_string())?;

        if process_id <= 0 || runtime_id.is_empty() ||
           rect.get_right() <= rect.get_left() || rect.get_bottom() <= rect.get_top() {
            return Err("The selected control has incomplete accessibility identity".into());
        }

        Ok((EditableTargetIdentity {
            process_id,
            runtime_id,
            class_name,
            bounds: [rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom()],
        }, value))
    }

    pub fn inspect_at(x: i32, y: i32) -> Result<(EditableTargetIdentity, String), String> {
        let automation = UIAutomation::new()
            .map_err(|_| "Windows UI Automation could not be initialized".to_string())?;
        let hit = automation.element_from_point(Point::new(x, y))
            .map_err(|_| "Windows could not inspect the selected screen point".to_string())?;
        let edit = editable_ancestor(&automation, hit)?;
        let (identity, value) = inspect_element(&edit, true)?;
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

        match element.get_control_type()
            .map_err(|_| "Could not re-identify the selected editable control".to_string())? {
            ControlType::Edit => {
                let edit = EditControl::try_from(element.clone())
                    .map_err(|_| "The selected edit control is no longer writable".to_string())?;
                edit.set_value(text)
                    .map_err(|_| "The selected application rejected the exact text insertion".to_string())?;
            }
            ControlType::Document => {
                let document = DocumentControl::try_from(element.clone())
                    .map_err(|_| "The selected document is no longer writable".to_string())?;
                document.set_value(text)
                    .map_err(|_| "The selected application rejected the exact text insertion".to_string())?;
            }
            _ => return Err("The selected control is no longer an editable field".into()),
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
    }

    #[test]
    fn target_policy_fails_closed_for_non_editable_or_unsafe_fields() {
        use super::validate_target_properties as validate;
        assert!(validate("Edit", true, false, false, false, "").is_ok());
        assert!(validate("Document", true, false, false, false, "").is_ok());
        assert_eq!(validate("Pane", true, false, false, false, ""), Err("not_editable_control"));
        assert_eq!(validate("Edit", false, false, false, false, ""), Err("disabled_control"));
        assert_eq!(validate("Edit", true, true, false, false, ""), Err("offscreen_control"));
        assert_eq!(validate("Edit", true, false, true, false, ""), Err("protected_control"));
        assert_eq!(validate("Edit", true, false, false, true, ""), Err("readonly_control"));
        assert_eq!(validate("Edit", true, false, false, false, "already typed"), Err("nonempty_control"));
        assert!(super::validate_target_metadata("Edit", true, false, false, false).is_ok());
        assert!(super::validate_target_metadata("Document", true, false, false, false).is_ok());
    }
}
