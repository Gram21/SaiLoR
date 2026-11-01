#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod authz;
mod feedback;
mod git;
mod paths;
mod pdf;
mod project;
mod protocol;
// Phase 4 (AI): LLM targets, local servers, web fetch, hardware.
mod hardware;
mod llm;
mod net;
mod ollama;
mod webfetch;

use authz::Session;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// CI probe: open `$SPIKE_PROJECT` without a dialog.
#[tauri::command]
async fn spike_auto(session: State<'_, Mutex<Session>>) -> Result<Option<project::Opened>, String> {
    let Ok(path) = std::env::var("SPIKE_PROJECT") else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let opened = project::read_project(&session, &path).ok();
    if opened.is_some() {
        project::set_dir(&session, &path);
    }
    Ok(opened)
}

/// CI probe: append a line to `$SPIKE_REPORT`.
#[tauri::command]
fn spike_report(line: String) {
    if let Ok(out) = std::env::var("SPIKE_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(out)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(Session::default()))
        .register_asynchronous_uri_scheme_protocol("slr-file", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(protocol::serve(&app.state::<Mutex<Session>>(), &req))
            });
        })
        .invoke_handler(tauri::generate_handler![
            spike_auto,
            spike_report,
            project::project_open,
            project::project_open_path,
            project::project_save,
            project::project_set_dir,
            project::project_pick_save_path,
            project::project_peek,
            feedback::project_write_feedback,
            feedback::project_list_feedback,
            pdf::pdf_pick,
            pdf::pdf_pick_folder,
            pdf::pdf_read,
            pdf::pdf_check_path,
            pdf::pdf_allow_path,
            pdf::pdf_pick_export_path,
            pdf::text_pick_export_path,
            paths::paths_relative,
            paths::paths_rebase,
            paths::paths_absolute,
            paths::paths_sibling,
            webfetch::web_fetch,
            webfetch::web_abort,
            llm::llm_configs,
            llm::llm_save_config,
            llm::llm_delete_config,
            llm::llm_call,
            llm::llm_abort,
            ollama::ollama_version,
            ollama::ollama_list,
            ollama::ollama_show,
            ollama::ollama_ps,
            ollama::ollama_pull,
            ollama::ollama_cancel_pull,
            ollama::ollama_delete,
            ollama::ollama_manifest_size,
            ollama::localserver_discover,
            hardware::local_probe,
            git::git_probe,
            git::git_pick_clone_dir,
            git::git_clone,
            git::git_pick_project_in,
            git::git_info,
            git::git_status,
            git::git_commit,
            git::git_last_commit_message,
            git::git_push,
            git::git_pull_begin,
            git::git_pull_finish,
            git::git_pull_abort,
            git::git_merge_begin,
            git::git_log_begin,
            git::git_log_diff,
            git::git_annotation_authors,
            git::git_repo_setup_status,
            git::git_apply_repo_setup,
            git::git_background_fetch,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_restore,
            git::git_stash_drop,
            git::git_stash_branch,
            git::git_branches,
            git::git_branch_create,
            git::git_branch_delete,
            git::git_checkout,
            git::git_branch_switch_begin,
            git::git_branch_switch_finish,
            git::git_branch_switch_abort,
            git::git_head_content,
            git::git_working_content,
            git::git_commit_partial,
            git::git_write_working,
            git::git_discard_file,
        ])
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
