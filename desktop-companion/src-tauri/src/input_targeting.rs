//! Fail-closed Windows UI Automation targeting for Backroom draft insertion.
//! A dragged rectangle is only a visual hint. This module resolves its centre to
//! a real editable UIA control, captures a stable identity, and reads the value
//! again immediately before and after typing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditableTargetIdentity {
    pub process_id: i32,
    pub window_handle: isize,
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

pub fn inspect_focused() -> Result<(EditableTargetIdentity, String), String> {
    #[cfg(target_os = "windows")]
    {
        return std::thread::spawn(windows_impl::inspect_focused)
            .join()
            .map_err(|_| "Windows accessibility inspection worker stopped unexpectedly".to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Verified editable-field readback is currently supported by the Windows accessibility driver only".into())
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
            if current.get_control_type().ok() == Some(ControlType::Edit) {
                return Ok(current);
            }
            current = walker.get_parent(&current)
                .map_err(|_| "The selected point is not inside an accessible editable field".to_string())?;
        }
        Err("No editable text control was found at the selected point".into())
    }

    fn inspect_element(element: &UIElement) -> Result<(EditableTargetIdentity, String), String> {
        let control_type = element.get_control_type()
            .map_err(|_| "Could not identify the selected UI control".to_string())?;
        if control_type != ControlType::Edit && control_type != ControlType::Document {
            return Err("Select an actual editable text field or document, not its surrounding panel".into());
        }
        if !element.is_enabled().map_err(|_| "Could not verify whether the text field is enabled".to_string())? {
            return Err("The selected text field is disabled".into());
        }
        if element.is_offscreen().map_err(|_| "Could not verify text-field visibility".to_string())? {
            return Err("The selected text field is no longer visible".into());
        }
        if element.is_password().map_err(|_| "Could not verify whether this is a protected field".to_string())? {
            return Err("Password and protected fields cannot be targeted".into());
        }

        // Support native Edit fields and Document controls only when they expose
        // a writable ValuePattern. Rich/custom controls without readback fail closed.
        let value = match control_type {
            ControlType::Edit => {
                let edit = EditControl::try_from(element.clone())
                    .map_err(|_| "The selected control does not expose a supported editable value".to_string())?;
                if edit.is_readonly().map_err(|_| "Could not verify whether the field is read-only".to_string())? {
                    return Err("The selected text field is read-only".into());
                }
                edit.get_value()
            }
            ControlType::Document => {
                let document = DocumentControl::try_from(element.clone())
                    .map_err(|_| "The selected document does not expose an editable value".to_string())?;
                if document.is_readonly().map_err(|_| "Could not verify whether the document is read-only".to_string())? {
                    return Err("The selected document is read-only".into());
                }
                document.get_value()
            }
            _ => unreachable!(),
        }.map_err(|_| "The selected field does not support reliable accessibility readback".to_string())?;

        let process_id = element.get_process_id()
            .map_err(|_| "Could not identify the application process".to_string())?;
        let handle: isize = element.get_native_window_handle()
            .map_err(|_| "Could not identify the owning application window".to_string())?
            .into();
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
            window_handle: handle,
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
        let (identity, value) = inspect_element(&edit)?;
        let [left, top, right, bottom] = identity.bounds;
        if x < left || x >= right || y < top || y >= bottom {
            return Err("The drag-selection centre is outside the editable field".into());
        }
        Ok((identity, value))
    }

    pub fn inspect_focused() -> Result<(EditableTargetIdentity, String), String> {
        let automation = UIAutomation::new()
            .map_err(|_| "Windows UI Automation could not be initialized".to_string())?;
        let focused = automation.get_focused_element()
            .map_err(|_| "Windows could not verify the focused text field".to_string())?;
        let edit = editable_ancestor(&automation, focused)?;
        inspect_element(&edit)
    }
}

#[cfg(test)]
mod tests {
    use super::EditableTargetIdentity;

    fn identity() -> EditableTargetIdentity {
        EditableTargetIdentity {
            process_id: 42,
            window_handle: 100,
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
}
