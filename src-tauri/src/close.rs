//! Unsaved-changes guard for closing the window, quitting the app and reloading the page.
//! Port of the `close` handler, `promptUnsavedChanges` and the `app:setDirty` /
//! `app:saveComplete` channels in electron/main.ts. The reload path is `guardedReload`.

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
    /// The open dialog or pending save ends in a reload, not a close.
    reload: AtomicBool,
    /// The close was confirmed; let every further close and exit pass.
    allow: AtomicBool,
}

#[derive(Debug, PartialEq)]
enum Choice {
    Save,
    Discard,
    Cancel,
}

#[derive(Debug, PartialEq)]
enum Next {
    Stay,
    RequestSave,
    Quit,
    Reload,
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
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(SeqCst)
    }

    /// Some(true): show the dialog. Some(false): a dialog is already open.
    /// None: let the close pass.
    fn on_close(&self) -> Option<bool> {
        if self.allow.load(SeqCst) || !self.dirty.load(SeqCst) {
            return None;
        }
        Some(!self.asking.swap(true, SeqCst))
    }

    /// Some(true): show the dialog for a reload. Some(false): a dialog or save is pending.
    /// None: reload now.
    fn on_reload(&self) -> Option<bool> {
        if !self.dirty.load(SeqCst) {
            return None;
        }
        if self.asking.load(SeqCst) || self.saving.load(SeqCst) {
            return Some(false);
        }
        self.asking.store(true, SeqCst);
        self.reload.store(true, SeqCst);
        Some(true)
    }

    /// Records the answer.
    fn answered(&self, choice: &Choice) -> Next {
        self.asking.store(false, SeqCst);
        match choice {
            Choice::Save => {
                self.saving.store(true, SeqCst);
                Next::RequestSave
            }
            Choice::Discard => self.finish(),
            Choice::Cancel => {
                self.reload.store(false, SeqCst);
                Next::Stay
            }
        }
    }

    /// Acts on a save the dialog asked for. Only a successful save continues.
    fn saved(&self, ok: bool) -> Next {
        if !self.saving.swap(false, SeqCst) {
            return Next::Stay;
        }
        if ok {
            self.finish()
        } else {
            self.reload.store(false, SeqCst);
            Next::Stay
        }
    }

    /// A reload goes ahead. A close goes ahead and lets every later close pass.
    fn finish(&self) -> Next {
        if self.reload.swap(false, SeqCst) {
            Next::Reload
        } else {
            self.allow.store(true, SeqCst);
            Next::Quit
        }
    }
}

/// True when the close or exit must be prevented. Shows the dialog if needed.
pub fn intercept(app: &AppHandle) -> bool {
    let guard = app.state::<Guard>();
    let Some(ask) = guard.on_close() else {
        return false;
    };
    if ask {
        ask_user(app);
    }
    true
}

/// Reloads the page now when nothing is unsaved, otherwise asks first.
pub fn request_reload(app: &AppHandle) {
    match app.state::<Guard>().on_reload() {
        None => reload_main(app),
        Some(true) => ask_user(app),
        Some(false) => {}
    }
}

/// Quits through the same guard as a window close.
pub fn request_quit(app: &AppHandle) {
    if !intercept(app) {
        app.exit(0);
    }
}

fn ask_user(app: &AppHandle) {
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
        let next = app.state::<Guard>().answered(&choice(&result));
        perform(&app, next);
    });
}

fn perform(app: &AppHandle, next: Next) {
    match next {
        Next::Stay => {}
        Next::RequestSave => {
            let _ = app.emit("app:requestSave", ());
        }
        Next::Quit => app.exit(0),
        Next::Reload => reload_main(app),
    }
}

fn reload_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.reload();
    }
}

#[tauri::command]
pub fn app_set_dirty(guard: tauri::State<'_, Guard>, dirty: bool) {
    guard.dirty.store(dirty, SeqCst);
}

/// Only closes or reloads after a save this guard asked for, not on any `true`.
#[tauri::command]
pub fn app_save_complete(app: AppHandle, ok: bool) {
    let next = app.state::<Guard>().saved(ok);
    perform(&app, next);
}

#[tauri::command]
pub fn app_reload(app: AppHandle) {
    request_reload(&app);
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
        assert_eq!(g.answered(&Choice::Cancel), Next::Stay);
        assert_eq!(g.on_close(), Some(true));
    }

    #[test]
    fn discard_lets_every_later_close_pass() {
        let g = dirty();
        g.on_close();
        assert_eq!(g.answered(&Choice::Discard), Next::Quit);
        assert_eq!(g.on_close(), None);
    }

    #[test]
    fn closes_only_after_a_requested_save_succeeds() {
        let g = dirty();
        assert_eq!(g.saved(true), Next::Stay, "no save was requested");
        g.on_close();
        assert_eq!(g.answered(&Choice::Save), Next::RequestSave);
        assert_eq!(
            g.saved(false),
            Next::Stay,
            "failed save keeps the window open"
        );
        assert_eq!(g.on_close(), Some(true));
        g.answered(&Choice::Save);
        assert_eq!(g.saved(true), Next::Quit);
        assert_eq!(g.on_close(), None);
    }

    #[test]
    fn clean_project_reloads_at_once() {
        assert_eq!(Guard::default().on_reload(), None);
    }

    #[test]
    fn dirty_reload_asks_once_and_cancel_keeps_the_page() {
        let g = dirty();
        assert_eq!(g.on_reload(), Some(true));
        assert_eq!(g.on_reload(), Some(false));
        assert_eq!(g.answered(&Choice::Cancel), Next::Stay);
        assert_eq!(g.on_reload(), Some(true));
    }

    #[test]
    fn discard_reloads_without_allowing_a_later_close() {
        let g = dirty();
        assert_eq!(g.on_reload(), Some(true));
        assert_eq!(g.answered(&Choice::Discard), Next::Reload);
        assert_eq!(g.on_close(), Some(true));
    }

    #[test]
    fn reload_waits_for_a_requested_save_to_succeed() {
        let g = dirty();
        assert_eq!(g.on_reload(), Some(true));
        assert_eq!(g.answered(&Choice::Save), Next::RequestSave);
        assert_eq!(g.on_reload(), Some(false), "a save is pending");
        assert_eq!(g.saved(false), Next::Stay, "failed save keeps the page");
        assert_eq!(g.on_reload(), Some(true));
        g.answered(&Choice::Save);
        assert_eq!(g.saved(true), Next::Reload);
        assert_eq!(g.on_close(), Some(true), "reload does not allow a close");
    }

    #[test]
    fn close_dialog_answer_does_not_reload() {
        let g = dirty();
        g.on_close();
        assert_eq!(g.answered(&Choice::Save), Next::RequestSave);
        assert_eq!(g.saved(true), Next::Quit);
    }

    #[test]
    fn open_close_dialog_blocks_reload() {
        let g = dirty();
        assert_eq!(g.on_close(), Some(true));
        assert_eq!(g.on_reload(), Some(false));
        assert_eq!(g.answered(&Choice::Discard), Next::Quit);
    }
}
