//! Unsaved-changes guard for closing the window or quitting the app.
//! Port of the `close` handler, `promptUnsavedChanges` and the `app:setDirty` /
//! `app:saveComplete` channels in electron/main.ts.

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const SAVE: &str = "Save";
const DISCARD: &str = "Don't Save";
const CANCEL: &str = "Cancel";

#[derive(Default)]
pub struct Guard {
    dirty: AtomicBool,
    /// The dialog is on screen.
    asking: AtomicBool,
    /// The renderer was asked to save and has not reported back.
    saving: AtomicBool,
    /// The close was confirmed; let every further close and exit pass.
    allow: AtomicBool,
}

#[derive(Debug, PartialEq)]
enum Choice {
    Save,
    Discard,
    Cancel,
}

fn choice(result: &MessageDialogResult) -> Choice {
    match result {
        MessageDialogResult::Yes => Choice::Save,
        MessageDialogResult::No => Choice::Discard,
        MessageDialogResult::Custom(s) if s == SAVE => Choice::Save,
        MessageDialogResult::Custom(s) if s == DISCARD => Choice::Discard,
        _ => Choice::Cancel,
    }
}

impl Guard {
    /// Some(true): show the dialog. Some(false): a dialog is already open.
    /// None: let the close pass.
    fn on_close(&self) -> Option<bool> {
        if self.allow.load(SeqCst) || !self.dirty.load(SeqCst) {
            return None;
        }
        Some(!self.asking.swap(true, SeqCst))
    }

    /// Records the answer. True when the app may close now.
    fn answered(&self, choice: &Choice) -> bool {
        self.asking.store(false, SeqCst);
        match choice {
            Choice::Save => self.saving.store(true, SeqCst),
            Choice::Discard => self.allow.store(true, SeqCst),
            Choice::Cancel => {}
        }
        *choice == Choice::Discard
    }

    /// True when a save that the dialog asked for succeeded.
    fn saved(&self, ok: bool) -> bool {
        let close = self.saving.swap(false, SeqCst) && ok;
        if close {
            self.allow.store(true, SeqCst);
        }
        close
    }
}

/// True when the close or exit must be prevented. Shows the dialog if needed.
pub fn intercept(app: &AppHandle) -> bool {
    let guard = app.state::<Guard>();
    let Some(ask) = guard.on_close() else {
        return false;
    };
    if ask {
        let mut dialog = app
            .dialog()
            .message("Your changes will be lost if you don't save them.")
            .title("Do you want to save the changes to your project?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                SAVE.into(),
                DISCARD.into(),
                CANCEL.into(),
            ));
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.parent(&window);
        }
        let app = app.clone();
        dialog.show_with_result(move |result| {
            let choice = choice(&result);
            if app.state::<Guard>().answered(&choice) {
                app.exit(0);
            } else if choice == Choice::Save {
                let _ = app.emit("app:requestSave", ());
            }
        });
    }
    true
}

#[tauri::command]
pub fn app_set_dirty(guard: tauri::State<'_, Guard>, dirty: bool) {
    guard.dirty.store(dirty, SeqCst);
}

/// Only closes after a save this guard asked for, not on any `true`.
#[tauri::command]
pub fn app_save_complete(app: AppHandle, ok: bool) {
    if app.state::<Guard>().saved(ok) {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirty() -> Guard {
        let g = Guard::default();
        g.dirty.store(true, SeqCst);
        g
    }

    #[test]
    fn maps_dialog_buttons() {
        assert_eq!(
            choice(&MessageDialogResult::Custom(SAVE.into())),
            Choice::Save
        );
        assert_eq!(choice(&MessageDialogResult::Yes), Choice::Save);
        assert_eq!(
            choice(&MessageDialogResult::Custom(DISCARD.into())),
            Choice::Discard
        );
        assert_eq!(choice(&MessageDialogResult::No), Choice::Discard);
        assert_eq!(
            choice(&MessageDialogResult::Custom(CANCEL.into())),
            Choice::Cancel
        );
        assert_eq!(choice(&MessageDialogResult::Cancel), Choice::Cancel);
    }

    #[test]
    fn clean_project_closes_without_a_dialog() {
        assert_eq!(Guard::default().on_close(), None);
    }

    #[test]
    fn dirty_project_asks_once_and_cancel_keeps_it_open() {
        let g = dirty();
        assert_eq!(g.on_close(), Some(true));
        assert_eq!(g.on_close(), Some(false));
        assert!(!g.answered(&Choice::Cancel));
        assert_eq!(g.on_close(), Some(true));
    }

    #[test]
    fn discard_lets_every_later_close_pass() {
        let g = dirty();
        g.on_close();
        assert!(g.answered(&Choice::Discard));
        assert_eq!(g.on_close(), None);
    }

    #[test]
    fn closes_only_after_a_requested_save_succeeds() {
        let g = dirty();
        assert!(!g.saved(true), "no save was requested");
        g.on_close();
        assert!(!g.answered(&Choice::Save));
        assert!(!g.saved(false), "failed save keeps the window open");
        assert_eq!(g.on_close(), Some(true));
        g.answered(&Choice::Save);
        assert!(g.saved(true));
        assert_eq!(g.on_close(), None);
    }
}
