use std::io::{Read, Write};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

use roxmltree::Document;
use serde::{Deserialize, Serialize};
use url::Url;

const PREVIEW_LIMIT: u64 = 2 * 1024 * 1024;
const EDIT_LIMIT: u64 = 8 * 1024 * 1024;
const HISTORY_LIMIT: u32 = 200;
const HISTORY_DIFF_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct Session {
    root_url: String,
    workdir: String,
    credentials: Credentials,
}

#[derive(Clone, Default)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct StoredCredentials {
    username: String,
    password: String,
}

#[derive(Clone, Serialize)]
struct SavedCredentialSummary {
    username: String,
    has_password: bool,
}
#[derive(Clone, Serialize)]
struct RepoInfo {
    root_url: String,
    workdir: String,
    revision: u64,
}

#[derive(Clone, Serialize)]
struct SvnEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    revision: Option<u64>,
    author: Option<String>,
    date: Option<String>,
    checked_out: bool,
}

#[derive(Clone, Serialize)]
struct FileContent {
    path: String,
    content: String,
    size: u64,
    is_binary: bool,
}

#[derive(Clone, Serialize)]
struct SavedFile {
    changed: bool,
    diff: String,
}

#[derive(Clone, Serialize)]
struct UploadedEntry {
    path: String,
    commit_path: String,
    kind: String,
    source_path: String,
}

#[derive(Clone, Serialize)]
struct LocalChange {
    path: String,
    commit_path: String,
    status: String,
    kind: String,
}

#[derive(Clone, Serialize)]
struct HistoryChangedPath {
    path: String,
    action: String,
    kind: Option<String>,
}

#[derive(Clone, Serialize)]
struct HistoryEntry {
    revision: u64,
    author: Option<String>,
    date: Option<String>,
    message: Option<String>,
    changed_paths: Vec<HistoryChangedPath>,
}

#[derive(Clone, Serialize)]
struct HistoryDiff {
    output: String,
    truncated: bool,
    byte_size: usize,
}

#[tauri::command]
async fn connect_repository(
    root_url: String,
    workdir: String,
    username: Option<String>,
    password: Option<String>,
    remember_credentials: Option<bool>,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<RepoInfo, String> {
    let root_url = root_url.trim().trim_end_matches('/').to_string();
    let workdir = expand_home(workdir.trim())?;
    let remember_password = remember_credentials.unwrap_or(false);
    let saved_credentials = if remember_password {
        read_saved_credentials(&root_url)?
    } else {
        None
    };
    let mut credentials = Credentials {
        username: username.unwrap_or_default().trim().to_string(),
        password: password.unwrap_or_default(),
    };

    // The password is intentionally not sent back through the webview after a
    // restart; refill it from the system credential store for the same account.
    if let Some(saved) = &saved_credentials {
        if credentials.username.is_empty() {
            credentials.username = saved.username.clone();
        }
        if credentials.password.is_empty() && credentials.username == saved.username {
            credentials.password = saved.password.clone();
        }
    }

    if Url::parse(&root_url).is_err() {
        return Err("Repository URL is not valid".to_string());
    }

    let target = PathBuf::from(&workdir);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create parent folder: {err}"))?;
    }

    if target.exists() {
        if !target.join(".svn").exists() {
            let is_empty = fs::read_dir(&target)
                .map_err(|err| format!("Could not read working folder: {err}"))?
                .next()
                .is_none();
            if !is_empty {
                return Err(
                    "Selected working folder is not empty and is not an SVN working copy"
                        .to_string(),
                );
            }
        }
    } else {
        run_svn_auth(
            &credentials,
            &[
                "checkout",
                "--non-interactive",
                "--depth",
                "empty",
                &root_url,
                &workdir,
            ],
        )?;
    }

    let existing_url = working_copy_url(&target, &credentials)?;
    if existing_url.trim_end_matches('/') != root_url {
        return Err(format!("Working copy already belongs to {}", existing_url));
    }

    let revision = working_copy_revision(&target, &credentials)?;
    let session = Session {
        root_url: root_url.clone(),
        workdir,
        credentials,
    };
    let info = RepoInfo {
        root_url: session.root_url.clone(),
        workdir: session.workdir.clone(),
        revision,
    };
    if remember_password {
        save_credentials(&root_url, &session.credentials, saved_credentials.as_ref())?;
    } else {
        delete_saved_credentials(&root_url)?;
    }
    *state.lock().map_err(unlock_failed)? = Some(session);
    Ok(info)
}

#[tauri::command]
async fn load_saved_credentials(
    root_url: String,
) -> Result<Option<SavedCredentialSummary>, String> {
    let root_url = root_url.trim().trim_end_matches('/').to_string();
    Ok(
        read_saved_credentials(&root_url)?.map(|credentials| SavedCredentialSummary {
            username: credentials.username,
            has_password: !credentials.password.is_empty(),
        }),
    )
}

#[tauri::command]
async fn refresh_repository(
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<RepoInfo, String> {
    let session = current_session(&state)?;
    let revision = working_copy_revision(Path::new(&session.workdir), &session.credentials)?;
    Ok(RepoInfo {
        root_url: session.root_url,
        workdir: session.workdir,
        revision,
    })
}

#[tauri::command]
async fn disconnect_repository(
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    *state.lock().map_err(unlock_failed)? = None;
    Ok(())
}

#[tauri::command]
async fn list_path(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<Vec<SvnEntry>, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let remote = remote_url(&session.root_url, &path)?;
    let xml = run_svn_session_string(&session, &["list", "--xml", "--non-interactive", &remote])?;
    let mut entries = parse_listing(&xml, &path)?;
    for entry in &mut entries {
        entry.checked_out = local_path(&session.workdir, &entry.path)?.exists();
    }
    Ok(entries)
}

#[tauri::command]
async fn preview_file(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<FileContent, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let remote = remote_url(&session.root_url, &path)?;
    let size = remote_file_size(&remote, &session.credentials)?;
    if size > PREVIEW_LIMIT {
        return Err(format!(
            "File is {} bytes; preview is limited to {} bytes",
            size, PREVIEW_LIMIT
        ));
    }

    let bytes = run_svn_session(&session, &["cat", "--non-interactive", &remote])?;
    Ok(file_content(path, bytes))
}

#[tauri::command]
async fn open_for_edit(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<FileContent, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let remote = remote_url(&session.root_url, &path)?;
    let size = remote_file_size(&remote, &session.credentials)?;
    if size > EDIT_LIMIT {
        return Err(format!(
            "File is {} bytes; editing is limited to {} bytes in this MVP",
            size, EDIT_LIMIT
        ));
    }

    ensure_sparse_file(&session, &path)?;
    let local = local_path(&session.workdir, &path)?;
    let bytes = fs::read(&local).map_err(|err| format!("Could not read fetched file: {err}"))?;
    // Binary files are still fetched; the UI then offers to open them in the
    // default application instead of the built-in text editor.
    Ok(file_content(path, bytes))
}

#[tauri::command]
async fn save_file(
    path: String,
    content: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<SavedFile, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.exists() {
        return Err("File is not present in the sparse working copy".to_string());
    }
    if looks_binary(&local)? {
        return Err("Binary files cannot be saved from the built-in text editor".to_string());
    }

    working_copy_url(&local, &session.credentials)?;
    fs::write(&local, content).map_err(|err| format!("Could not save file: {err}"))?;
    let diff = run_svn_session_string(
        &session,
        &[
            "diff",
            "--git",
            "--non-interactive",
            &local.to_string_lossy(),
        ],
    )?;
    Ok(SavedFile {
        changed: !diff.trim().is_empty(),
        diff,
    })
}

#[tauri::command]
async fn file_diff(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<String, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.exists() {
        // A file that was never fetched cannot have local changes yet.
        return Ok(String::new());
    }
    run_svn_session_string(
        &session,
        &[
            "diff",
            "--git",
            "--non-interactive",
            &local.to_string_lossy(),
        ],
    )
}

#[tauri::command]
async fn update_file(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<FileContent, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    ensure_sparse_file(&session, &path)?;
    let local = local_path(&session.workdir, &path)?;
    let bytes = fs::read(&local).map_err(|err| format!("Could not read file: {err}"))?;
    Ok(file_content(path, bytes))
}

#[tauri::command]
async fn discard_changes(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<FileContent, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    run_svn_session_string(
        &session,
        &[
            "revert",
            "--non-interactive",
            "--recursive",
            &local.to_string_lossy(),
        ],
    )?;
    let bytes = fs::read(&local).map_err(|err| format!("Could not read file: {err}"))?;
    Ok(file_content(path, bytes))
}

#[tauri::command]
async fn open_local_path(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.is_file() {
        return Err("This file is not in the local working copy yet; fetch it first".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&local)
            .spawn()
            .map_err(|err| format!("Could not open the file: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = local;
        Err("Opening files in the default application is only supported on macOS".to_string())
    }
}

#[tauri::command]
async fn commit_file(
    path: String,
    message: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<String, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    let local = local_path(&session.workdir, &path)?;
    working_copy_url(&local, &session.credentials)?;
    run_svn_session_string(
        &session,
        &[
            "commit",
            "--non-interactive",
            "-m",
            &message,
            &local.to_string_lossy(),
        ],
    )
}

#[tauri::command]
async fn upload_to_working_copy(
    destination_dir: String,
    source_path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<UploadedEntry, String> {
    let session = current_session(&state)?;
    let destination_dir = destination_dir.trim().trim_matches('/').to_string();
    validate_relative_path(&destination_dir)?;

    let source = expand_home(source_path.trim())?;
    let source_path = fs::canonicalize(&source)
        .map_err(|err| format!("Could not resolve upload source: {err}"))?;
    if !source_path.exists() {
        return Err("Upload source does not exist".to_string());
    }

    let working_root = fs::canonicalize(&session.workdir)
        .map_err(|err| format!("Could not resolve sparse working copy: {err}"))?;
    if source_path == working_root || source_path.starts_with(&working_root) {
        return Err("Cannot upload from inside the sparse working copy".to_string());
    }

    let Some(source_name) = source_path.file_name().and_then(|name| name.to_str()) else {
        return Err("Upload source has an unsupported name".to_string());
    };
    validate_relative_path(source_name)?;
    let target_path = if destination_dir.is_empty() {
        source_name.to_string()
    } else {
        format!("{destination_dir}/{source_name}")
    };
    validate_relative_path(&target_path)?;

    let target_remote = remote_url(&session.root_url, &target_path)?;
    if remote_path_exists(&target_remote, &session.credentials)? {
        return Err(format!("{} already exists in the repository", target_path));
    }

    if !destination_dir.is_empty() {
        let destination_remote = remote_url(&session.root_url, &destination_dir)?;
        if remote_path_exists(&destination_remote, &session.credentials)? {
            let destination_local = local_path(&session.workdir, &destination_dir)?;
            run_svn_session(
                &session,
                &[
                    "update",
                    "--non-interactive",
                    "--parents",
                    "--depth",
                    "empty",
                    &destination_local.to_string_lossy(),
                ],
            )?;
        }
    }

    let target_local = local_path(&session.workdir, &target_path)?;
    if target_local.exists() {
        let existing_status = local_status_item(&target_local)?;
        match existing_status.as_deref() {
            Some("added") => {
                let commit_path = nearest_added_commit_path(&session.workdir, &target_path)?;
                return Ok(UploadedEntry {
                    kind: if target_local.is_dir() {
                        "dir".to_string()
                    } else {
                        "file".to_string()
                    },
                    path: target_path,
                    commit_path,
                    source_path: source_path.to_string_lossy().into_owned(),
                });
            }
            Some("unversioned") => {
                run_svn_session_string(
                    &session,
                    &[
                        "add",
                        "--non-interactive",
                        "--parents",
                        &target_local.to_string_lossy(),
                    ],
                )?;
            }
            _ => {
                return Err(format!(
                    "{} already exists locally and is not an unfinished upload",
                    target_path
                ));
            }
        }
    } else {
        copy_upload_source(&source_path, &target_local)?;
        if let Err(err) = run_svn_session_string(
            &session,
            &[
                "add",
                "--non-interactive",
                "--parents",
                &target_local.to_string_lossy(),
            ],
        ) {
            remove_upload_target(&target_local);
            return Err(err);
        }
    }

    let commit_path = nearest_added_commit_path(&session.workdir, &target_path)?;
    Ok(UploadedEntry {
        kind: if source_path.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        },
        path: target_path,
        commit_path,
        source_path: source_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn commit_paths(
    paths: Vec<String>,
    message: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<String, String> {
    let session = current_session(&state)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    let mut unique_paths = paths
        .into_iter()
        .map(|path| path.trim().trim_matches('/').to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    unique_paths.sort();
    unique_paths.dedup();
    if unique_paths.is_empty() {
        return Err("Select at least one uploaded item".to_string());
    }

    let mut commit_paths = Vec::new();
    for path in unique_paths {
        validate_relative_path(&path)?;
        if commit_paths
            .iter()
            .any(|ancestor: &String| path != *ancestor && Path::new(&path).starts_with(ancestor))
        {
            continue;
        }
        let local = local_path(&session.workdir, &path)?;
        if !local.exists() {
            return Err(format!("{} is not in the local sparse working copy", path));
        }
        commit_paths.push(path);
    }

    if commit_paths.is_empty() {
        return Err("No commit targets remain".to_string());
    }

    let mut arguments = vec![
        "commit".to_string(),
        "--non-interactive".to_string(),
        "-m".to_string(),
        message,
    ];
    for path in &commit_paths {
        arguments.push(
            local_path(&session.workdir, path)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    let argument_refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    run_svn_session_string(&session, &argument_refs)
}

#[tauri::command]
async fn list_local_changes(
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<Vec<LocalChange>, String> {
    let session = current_session(&state)?;
    let xml = run_svn_auth(
        &session.credentials,
        &["status", "--xml", "--non-interactive", &session.workdir],
    )?;
    parse_local_changes(&String::from_utf8_lossy(&xml), &session.workdir)
}

#[tauri::command]
async fn list_local_entries(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<Vec<SvnEntry>, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.is_dir() {
        return Ok(Vec::new());
    }

    read_local_directory(&local, &path)
}

// Lists only the immediate children of a directory so the locally checked-out
// view mirrors the repository hierarchy instead of flattening the whole tree.
fn read_local_directory(directory: &Path, relative_prefix: &str) -> Result<Vec<SvnEntry>, String> {
    let read_dir =
        fs::read_dir(directory).map_err(|err| format!("Could not read local directory: {err}"))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|err| format!("Could not read local directory: {err}"))?;
        let file_name = entry.file_name();
        if file_name == ".svn" || file_name == ".DS_Store" {
            continue;
        }

        let child = entry.path();
        let metadata = fs::symlink_metadata(&child)
            .map_err(|err| format!("Could not inspect local entry: {err}"))?;
        let is_dir = metadata.is_dir();
        let name = file_name.to_string_lossy().into_owned();
        let child_path = if relative_prefix.is_empty() {
            name.clone()
        } else {
            format!("{relative_prefix}/{name}")
        };

        entries.push(SvnEntry {
            revision: None,
            author: None,
            date: None,
            size: if is_dir { None } else { metadata.len().into() },
            name,
            path: child_path,
            kind: if is_dir { "dir" } else { "file" }.to_string(),
            checked_out: true,
        });
    }

    entries.sort_by(|left, right| {
        right
            .kind
            .eq("dir")
            .cmp(&left.kind.eq("dir"))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
async fn checkout_directory(
    path: String,
    mode: String,
    levels: Option<u8>,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;

    match mode.as_str() {
        "files" => update_svn_depth(&session, &local, "files")?,
        "subfolders" => update_svn_depth(&session, &local, "immediates")?,
        "all" => update_svn_depth(&session, &local, "infinity")?,
        "custom" => {
            let levels = levels.unwrap_or(1).clamp(1, 8);
            checkout_custom_depth(&session, &local, levels)?;
        }
        _ => return Err("Unsupported checkout depth".to_string()),
    }

    Ok(())
}

fn update_svn_depth(session: &Session, local: &Path, depth: &str) -> Result<(), String> {
    run_svn_session(
        session,
        &[
            "update",
            "--non-interactive",
            "--parents",
            "--set-depth",
            depth,
            &local.to_string_lossy(),
        ],
    )?;
    Ok(())
}

#[tauri::command]
async fn exclude_checkout(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.exists() {
        return Err("This folder is not checked out locally".to_string());
    }

    // `--set-depth exclude` is SVN's own way of dropping a checked-out subtree
    // from the working copy. The repository is not touched, so the folder can be
    // checked out again later and the space it took up is released now.
    run_svn_session(
        &session,
        &[
            "update",
            "--non-interactive",
            "--set-depth",
            "exclude",
            &local.to_string_lossy(),
        ],
    )?;
    Ok(())
}

// Refreshes an already checked-out folder in place. A plain update keeps the
// sparse depth exactly as it is and only pulls the newest content for the items
// that are already present, so refreshing never grows the working copy.
#[tauri::command]
async fn update_directory(
    path: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;
    if !local.exists() {
        return Err("This folder is not checked out locally yet".to_string());
    }

    run_svn_session(
        &session,
        &["update", "--non-interactive", &local.to_string_lossy()],
    )?;
    Ok(())
}

fn checkout_custom_depth(session: &Session, local: &Path, levels: u8) -> Result<(), String> {
    if levels <= 1 {
        return update_svn_depth(session, local, "files");
    }

    update_svn_depth(session, local, "immediates")?;
    let children =
        fs::read_dir(local).map_err(|err| format!("Could not read checkout folder: {err}"))?;
    for child in children {
        let child = child.map_err(|err| format!("Could not read checkout folder: {err}"))?;
        if child.file_name() == ".svn" {
            continue;
        }
        let is_dir = fs::symlink_metadata(child.path())
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        if is_dir {
            checkout_custom_depth(session, &child.path(), levels - 1)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_history(
    path: String,
    limit: Option<u32>,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<Vec<HistoryEntry>, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let limit = limit.unwrap_or(HISTORY_LIMIT).clamp(1, 500);
    let remote = remote_url(&session.root_url, &path)?;
    let limit_text = limit.to_string();
    let xml = run_svn_auth(
        &session.credentials,
        &[
            "log",
            "--xml",
            "--verbose",
            "--non-interactive",
            "--limit",
            &limit_text,
            &remote,
        ],
    )?;
    parse_history(&String::from_utf8_lossy(&xml))
}

#[tauri::command]
async fn diff_history_with_latest(
    path: String,
    revision: u64,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<HistoryDiff, String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    if revision == 0 {
        return Err("Revision must be greater than zero".to_string());
    }

    let remote = remote_url(&session.root_url, &path)?;
    let revision_range = format!("{revision}:HEAD");
    let bytes = run_svn_auth(
        &session.credentials,
        &[
            "diff",
            "--git",
            "--non-interactive",
            "--internal-diff",
            "-r",
            &revision_range,
            &remote,
        ],
    )?;
    let byte_size = bytes.len();
    let truncated = byte_size > HISTORY_DIFF_LIMIT;
    let output = if truncated {
        String::from_utf8_lossy(&bytes[..HISTORY_DIFF_LIMIT]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(HistoryDiff {
        output: if output.trim().is_empty() {
            "No differences between this revision and HEAD.".to_string()
        } else {
            output
        },
        truncated,
        byte_size,
    })
}

#[tauri::command]
async fn discard_local_change(
    path: String,
    status: String,
    state: tauri::State<'_, Mutex<Option<Session>>>,
) -> Result<(), String> {
    let session = current_session(&state)?;
    validate_relative_path(&path)?;
    let local = local_path(&session.workdir, &path)?;

    if local.exists() {
        let working_root = fs::canonicalize(&session.workdir)
            .map_err(|err| format!("Could not resolve sparse working copy: {err}"))?;
        let resolved_path = fs::canonicalize(&local)
            .map_err(|err| format!("Could not resolve local change: {err}"))?;
        if resolved_path == working_root || !resolved_path.starts_with(&working_root) {
            return Err("Invalid local change path".to_string());
        }
    }

    if status == "unversioned" {
        remove_upload_target(&local);
        return Ok(());
    }

    run_svn_auth(
        &session.credentials,
        &[
            "revert",
            "--non-interactive",
            "--depth",
            "infinity",
            &local.to_string_lossy(),
        ],
    )?;

    if status == "added" {
        // SVN revert unschedules added items but leaves their local content on
        // disk. Since these are uploads, discard that staged content too.
        remove_upload_target(&local);
    }

    Ok(())
}

fn current_session(state: &tauri::State<'_, Mutex<Option<Session>>>) -> Result<Session, String> {
    state
        .lock()
        .map_err(unlock_failed)?
        .clone()
        .ok_or_else(|| "No repository is connected".to_string())
}

fn run_svn_session(session: &Session, args: &[&str]) -> Result<Vec<u8>, String> {
    run_svn_auth(&session.credentials, args)
}

fn run_svn_session_string(session: &Session, args: &[&str]) -> Result<String, String> {
    run_svn_session(session, args).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

// A Finder-launched app inherits launchd's bare PATH, which contains no Homebrew
// directory, so resolve the Subversion client from the usual install locations
// instead of trusting PATH alone.
fn svn_binary() -> PathBuf {
    const CANDIDATES: [&str; 5] = [
        "/opt/homebrew/bin/svn",
        "/usr/local/bin/svn",
        "/opt/local/bin/svn",
        "/usr/bin/svn",
        "/bin/svn",
    ];
    CANDIDATES
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map_or_else(|| PathBuf::from("svn"), Path::to_path_buf)
}

fn run_svn_auth(credentials: &Credentials, args: &[&str]) -> Result<Vec<u8>, String> {
    let (command_args, password) = authenticated_args(credentials, args);
    let stdin_required = password.is_some();

    let mut child = Command::new(svn_binary())
        .args(&command_args)
        .stdin(if stdin_required {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                "The svn command line client was not found. Install it first, for example with \
                 `brew install subversion`."
                    .to_string()
            } else {
                format!("Could not run svn: {err}")
            }
        })?;

    if stdin_required && let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{}\n", password.unwrap_or_default()).as_bytes())
            .map_err(|err| format!("Could not provide SVN password: {err}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("Could not run svn: {err}"))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("svn command failed with status {}", output.status)
        } else {
            stderr
        })
    }
}

fn authenticated_args(credentials: &Credentials, args: &[&str]) -> (Vec<String>, Option<String>) {
    let mut command_args = vec![args[0].to_string()];
    let password = if credentials.password.is_empty() {
        None
    } else {
        Some(credentials.password.clone())
    };

    if !credentials.username.is_empty() {
        command_args.push("--username".to_string());
        command_args.push(credentials.username.clone());
    }
    if password.is_some() {
        command_args.push("--password-from-stdin".to_string());
    }
    if !credentials.username.is_empty() || password.is_some() {
        command_args.push("--no-auth-cache".to_string());
    }
    command_args.extend(args[1..].iter().map(|argument| (*argument).to_string()));
    (command_args, password)
}

fn remote_url(base: &str, relative_path: &str) -> Result<String, String> {
    let mut url = Url::parse(base).map_err(|err| format!("Invalid repository URL: {err}"))?;
    url.set_fragment(None);
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Repository URL cannot contain path segments".to_string())?;
        for segment in relative_path.split('/') {
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
    }
    Ok(url.into())
}

fn expand_home(path: &str) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home =
            dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
        return Ok(home.join(rest).to_string_lossy().into_owned());
    }
    Ok(path.to_string())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.contains('\\') || path.contains('\0') {
        return Err("Invalid repository path".to_string());
    }
    if path.starts_with('/') {
        return Err("Repository paths must be relative to the connected URL".to_string());
    }

    for component in Path::new(path).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("Repository paths cannot use traversal components".to_string());
        }
    }
    Ok(())
}

fn local_path(workdir: &str, relative_path: &str) -> Result<PathBuf, String> {
    Ok(Path::new(workdir).join(relative_path))
}

fn ensure_sparse_file(session: &Session, path: &str) -> Result<(), String> {
    let local = local_path(&session.workdir, path)?;
    if !local.exists() {
        run_svn_session(
            session,
            &[
                "update",
                "--non-interactive",
                "--parents",
                &local.to_string_lossy(),
            ],
        )?;
    }
    working_copy_url(&local, &session.credentials)?;
    Ok(())
}

fn working_copy_url(path: &Path, credentials: &Credentials) -> Result<String, String> {
    let xml = String::from_utf8_lossy(&run_svn_auth(
        credentials,
        &[
            "info",
            "--xml",
            "--non-interactive",
            &path.to_string_lossy(),
        ],
    )?)
    .into_owned();
    xml_url(&xml).ok_or_else(|| "SVN did not return a URL".to_string())
}

fn working_copy_revision(path: &Path, credentials: &Credentials) -> Result<u64, String> {
    let xml = String::from_utf8_lossy(&run_svn_auth(
        credentials,
        &[
            "info",
            "--xml",
            "--non-interactive",
            &path.to_string_lossy(),
        ],
    )?)
    .into_owned();
    xml_revision(&xml)
}

fn remote_file_size(remote: &str, credentials: &Credentials) -> Result<u64, String> {
    let xml = String::from_utf8_lossy(&run_svn_auth(
        credentials,
        &["info", "--xml", "--non-interactive", remote],
    )?)
    .into_owned();
    parse_remote_file_size(&xml)
}

fn parse_remote_file_size(xml: &str) -> Result<u64, String> {
    let document =
        Document::parse(xml).map_err(|err| format!("Could not parse svn info: {err}"))?;
    let size = document
        .descendants()
        .find(|node| node.has_tag_name("entry") && node.attribute("kind") == Some("file"))
        .and_then(|node| node.attribute("size"))
        .map(str::to_string)
        .or_else(|| {
            document
                .descendants()
                .find(|node| node.has_tag_name("size"))
                .and_then(|node| node.text())
                .map(str::to_string)
        });

    size.and_then(|value| value.trim().parse::<u64>().ok())
        .ok_or_else(|| "SVN did not report a file size".to_string())
}

fn remote_path_exists(remote: &str, credentials: &Credentials) -> Result<bool, String> {
    match run_svn_auth(credentials, &["info", "--xml", "--non-interactive", remote]) {
        Ok(_) => Ok(true),
        Err(err)
            if err.contains("W170000")
                || err.contains("non-existent")
                || err.contains("E200009") =>
        {
            Ok(false)
        }
        Err(err) => Err(err),
    }
}

// Saved passwords live in a per-user JSON file instead of the login keychain.
// The bundle is ad-hoc signed, so its code signature changes on every rebuild;
// macOS then treats each new build as a different application and asks for the
// login password before every keychain read. A 0600 file removes that prompt
// while keeping the password out of the repository and out of process argv.
fn credentials_file_path() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .ok_or_else(|| "Could not locate the application data directory".to_string())?;
    Ok(base.join("CatSVN").join("credentials.json"))
}

fn read_credentials_store() -> Result<HashMap<String, StoredCredentials>, String> {
    read_credentials_store_from(&credentials_file_path()?)
}

fn read_credentials_store_from(path: &Path) -> Result<HashMap<String, StoredCredentials>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("Saved credential data is invalid: {err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(err) => Err(format!("Could not read saved credentials: {err}")),
    }
}

fn write_credentials_store(store: &HashMap<String, StoredCredentials>) -> Result<(), String> {
    write_credentials_store_to(&credentials_file_path()?, store)
}

fn write_credentials_store_to(
    path: &Path,
    store: &HashMap<String, StoredCredentials>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create the credential folder: {err}"))?;
    }
    let data = serde_json::to_vec_pretty(store).map_err(|err| err.to_string())?;
    fs::write(path, data).map_err(|err| format!("Could not save credentials: {err}"))?;
    restrict_credentials_permissions(path);
    Ok(())
}

#[cfg(unix)]
fn restrict_credentials_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_credentials_permissions(_path: &Path) {}

fn read_saved_credentials(root_url: &str) -> Result<Option<StoredCredentials>, String> {
    Ok(read_credentials_store()?.get(root_url).cloned())
}

fn save_credentials(
    root_url: &str,
    credentials: &Credentials,
    previous: Option<&StoredCredentials>,
) -> Result<(), String> {
    if credentials.password.is_empty() {
        let Some(previous) = previous else {
            return Ok(());
        };
        if credentials.username != previous.username || previous.password.is_empty() {
            return Ok(());
        }
    }

    let mut store = read_credentials_store()?;
    store.insert(
        root_url.to_string(),
        StoredCredentials {
            username: credentials.username.clone(),
            password: credentials.password.clone(),
        },
    );
    write_credentials_store(&store)
}

fn delete_saved_credentials(root_url: &str) -> Result<(), String> {
    let mut store = read_credentials_store()?;
    if store.remove(root_url).is_some() {
        write_credentials_store(&store)?;
    }
    Ok(())
}

fn local_status_item(path: &Path) -> Result<Option<String>, String> {
    let xml = run_svn_auth(
        &Credentials::default(),
        &[
            "status",
            "--xml",
            "--non-interactive",
            &path.to_string_lossy(),
        ],
    )?;
    let xml_text = String::from_utf8_lossy(&xml).into_owned();
    let document = Document::parse(&xml_text).map_err(|err| err.to_string())?;
    let exact_path = path.to_string_lossy();
    Ok(document
        .descendants()
        .find(|node| {
            node.has_tag_name("entry") && node.attribute("path") == Some(exact_path.as_ref())
        })
        .and_then(|entry| {
            entry
                .descendants()
                .find(|node| node.has_tag_name("wc-status"))
        })
        .and_then(|status| status.attribute("item"))
        .map(str::to_string))
}

fn parse_local_changes(xml: &str, workdir: &str) -> Result<Vec<LocalChange>, String> {
    let document =
        Document::parse(xml).map_err(|err| format!("Could not parse svn status: {err}"))?;
    let working_root = Path::new(workdir);
    let added_relative_paths = document
        .descendants()
        .filter_map(|node| {
            if !node.has_tag_name("entry") {
                return None;
            }
            let is_added = node.descendants().any(|status| {
                status.has_tag_name("wc-status") && status.attribute("item") == Some("added")
            });
            if !is_added {
                return None;
            }
            node.attribute("path")
                .and_then(|path| Path::new(path).strip_prefix(working_root).ok())
                .map(|path| path.to_string_lossy().replace('\\', "/"))
        })
        .collect::<HashSet<_>>();
    // Mirrors `nearest_added_commit_path`: an added node is committed through the
    // top-most directory that was itself scheduled for addition, so a freshly
    // uploaded tree yields a single commit target instead of one per file.
    let nearest_added_relative = |relative_path: &str| -> String {
        let parts: Vec<&str> = relative_path.split('/').collect();
        for length in 1..=parts.len() {
            let candidate = parts[..length].join("/");
            if added_relative_paths.contains(&candidate) {
                return candidate;
            }
        }
        relative_path.to_string()
    };
    let mut changes = Vec::new();

    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(path_attribute) = entry.attribute("path") else {
            continue;
        };
        let absolute_path = PathBuf::from(path_attribute);
        let Ok(relative_path) = absolute_path.strip_prefix(working_root) else {
            continue;
        };
        let Some(status_node) = entry
            .descendants()
            .find(|node| node.has_tag_name("wc-status"))
        else {
            continue;
        };
        let Some(status) = status_node.attribute("item") else {
            continue;
        };
        // `incomplete` is what SVN reports for a directory whose depth was
        // limited by a sparse checkout, so it is a shape of the working copy
        // rather than a local edit and must not show up as pending work.
        if matches!(
            status,
            "normal" | "none" | "external" | "ignored" | "incomplete"
        ) {
            continue;
        }

        let relative_path = relative_path.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            continue;
        }
        let commit_path = if status == "added" {
            nearest_added_relative(&relative_path)
        } else {
            relative_path.clone()
        };
        let metadata = fs::symlink_metadata(&absolute_path).ok();
        changes.push(LocalChange {
            kind: if metadata.is_some_and(|metadata| metadata.is_dir()) {
                "dir".to_string()
            } else {
                "file".to_string()
            },
            path: relative_path,
            commit_path,
            status: status.to_string(),
        });
    }

    changes.sort_by_key(|change| change.path.to_lowercase());
    Ok(changes)
}

fn parse_history(xml: &str) -> Result<Vec<HistoryEntry>, String> {
    let document = Document::parse(xml).map_err(|err| format!("Could not parse svn log: {err}"))?;
    let mut entries = Vec::new();

    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
    {
        let Some(revision) = entry
            .attribute("revision")
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };

        let author = entry
            .descendants()
            .find(|node| node.has_tag_name("author"))
            .and_then(|node| node.text())
            .map(str::to_string);
        let date = entry
            .descendants()
            .find(|node| node.has_tag_name("date"))
            .and_then(|node| node.text())
            .map(str::to_string);
        let message = entry
            .descendants()
            .find(|node| node.has_tag_name("msg"))
            .and_then(|node| node.text())
            .map(str::to_string);

        let changed_paths = entry
            .descendants()
            .filter(|node| node.has_tag_name("path"))
            .filter_map(|node| {
                let path = node.text()?.to_string();
                Some(HistoryChangedPath {
                    path,
                    action: node.attribute("action")?.to_string(),
                    kind: node.attribute("kind").map(str::to_string),
                })
            })
            .collect();

        entries.push(HistoryEntry {
            revision,
            author,
            date,
            message,
            changed_paths,
        });
    }

    Ok(entries)
}

fn nearest_added_commit_path(workdir: &str, target_path: &str) -> Result<String, String> {
    let working_root = fs::canonicalize(workdir)
        .map_err(|err| format!("Could not resolve sparse working copy: {err}"))?;
    let target = working_root.join(target_path);
    let xml = String::from_utf8_lossy(&run_svn_auth(
        &Credentials::default(),
        &[
            "status",
            "--xml",
            "--non-interactive",
            &target.to_string_lossy(),
        ],
    )?)
    .into_owned();
    let added_paths = xml_added_paths(&xml);

    let mut candidate = target.clone();
    let mut nearest = None;
    while candidate != working_root {
        if added_paths.contains(&candidate.to_string_lossy().into_owned()) {
            nearest = Some(candidate.clone());
        }
        let Some(parent) = candidate.parent() else {
            break;
        };
        candidate = parent.to_path_buf();
    }

    let nearest =
        nearest.ok_or_else(|| "SVN did not schedule the upload for addition".to_string())?;
    let relative = nearest
        .strip_prefix(&working_root)
        .map_err(|err| format!("Could not resolve upload commit path: {err}"))?;
    Ok(relative.to_string_lossy().into_owned())
}

fn xml_added_paths(xml: &str) -> HashSet<String> {
    Document::parse(xml)
        .map(|document| {
            document
                .descendants()
                .filter(|node| {
                    node.has_tag_name("entry")
                        && node.descendants().any(|status| {
                            status.has_tag_name("wc-status")
                                && status.attribute("item") == Some("added")
                        })
                })
                .filter_map(|node| node.attribute("path"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn copy_upload_source(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("Could not inspect upload source: {err}"))?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() {
        return Err("Symbolic links are not supported for upload".to_string());
    }
    if file_type.is_dir() {
        fs::create_dir_all(target)
            .map_err(|err| format!("Could not create upload folder: {err}"))?;
        for entry in
            fs::read_dir(source).map_err(|err| format!("Could not read upload folder: {err}"))?
        {
            let entry = entry.map_err(|err| format!("Could not read upload folder: {err}"))?;
            // Never push SVN metadata or Finder's per-folder bookkeeping into the
            // repository when the user uploads a folder.
            if entry.file_name() == ".svn" || entry.file_name() == ".DS_Store" {
                continue;
            }
            copy_upload_source(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if file_type.is_file() {
        fs::copy(source, target).map_err(|err| format!("Could not copy upload file: {err}"))?;
        return Ok(());
    }

    Err("Unsupported upload source type".to_string())
}

fn remove_upload_target(target: &Path) {
    let Ok(metadata) = fs::symlink_metadata(target) else {
        return;
    };
    if metadata.is_dir() {
        let _ = fs::remove_dir_all(target);
    } else {
        let _ = fs::remove_file(target);
    }
}

fn xml_url(xml: &str) -> Option<String> {
    let document = Document::parse(xml).ok()?;
    document
        .descendants()
        .find(|node| node.has_tag_name("url"))
        .and_then(|node| node.text())
        .map(str::to_string)
}

fn xml_revision(xml: &str) -> Result<u64, String> {
    let document =
        Document::parse(xml).map_err(|err| format!("Could not parse svn info: {err}"))?;
    document
        .descendants()
        .find(|node| node.has_tag_name("commit"))
        .and_then(|node| node.attribute("revision"))
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "SVN did not return a revision".to_string())
}

fn parse_listing(xml: &str, parent: &str) -> Result<Vec<SvnEntry>, String> {
    let document =
        Document::parse(xml).map_err(|err| format!("Could not parse svn list: {err}"))?;
    let mut entries = Vec::new();

    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(name_node) = entry.descendants().find(|node| node.has_tag_name("name")) else {
            continue;
        };
        let Some(name) = name_node.text().map(str::to_string) else {
            continue;
        };
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        let commit = entry.descendants().find(|node| node.has_tag_name("commit"));
        entries.push(SvnEntry {
            revision: commit
                .as_ref()
                .and_then(|node| node.attribute("revision"))
                .and_then(|value| value.parse::<u64>().ok()),
            author: commit
                .as_ref()
                .and_then(|node| node.descendants().find(|item| item.has_tag_name("author")))
                .and_then(|node| node.text())
                .map(str::to_string),
            date: commit
                .as_ref()
                .and_then(|node| node.descendants().find(|item| item.has_tag_name("date")))
                .and_then(|node| node.text())
                .map(str::to_string),
            size: entry
                .descendants()
                .find(|node| node.has_tag_name("size"))
                .and_then(|node| node.text())
                .and_then(|value| value.trim().parse::<u64>().ok()),
            name,
            path,
            kind: entry.attribute("kind").unwrap_or("unknown").to_string(),
            checked_out: false,
        });
    }

    entries.sort_by(|left, right| {
        right
            .kind
            .eq("dir")
            .cmp(&left.kind.eq("dir"))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

fn looks_binary(path: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(path).map_err(|err| format!("Could not read file: {err}"))?;
    let mut buffer = [0u8; 8192];
    let read = file
        .read(&mut buffer)
        .map_err(|err| format!("Could not read file: {err}"))?;
    Ok(buffer[..read].contains(&0))
}

fn file_content(path: String, bytes: Vec<u8>) -> FileContent {
    let is_binary = bytes.contains(&0);
    FileContent {
        size: bytes.len() as u64,
        content: if is_binary {
            String::new()
        } else {
            decode_text(&bytes)
        },
        is_binary,
        path,
    }
}

fn decode_text(bytes: &[u8]) -> String {
    if let Some((encoding, _)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding.decode(bytes).0.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    encoding_rs::GBK.decode(bytes).0.into_owned()
}

fn unlock_failed<T>(_error: T) -> String {
    "Application state is unavailable".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(None::<Session>))
        .invoke_handler(tauri::generate_handler![
            connect_repository,
            disconnect_repository,
            load_saved_credentials,
            refresh_repository,
            list_path,
            preview_file,
            open_for_edit,
            open_local_path,
            save_file,
            file_diff,
            update_file,
            discard_changes,
            commit_file,
            upload_to_working_copy,
            commit_paths,
            list_local_changes,
            list_local_entries,
            checkout_directory,
            exclude_checkout,
            update_directory,
            discard_local_change,
            list_history,
            diff_history_with_latest
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_url_encodes_each_path_segment() {
        let actual = remote_url("https://svn.example.com/repo/trunk", "docs/my file.txt").unwrap();
        assert_eq!(
            actual,
            "https://svn.example.com/repo/trunk/docs/my%20file.txt"
        );
    }

    #[test]
    fn relative_paths_reject_traversal() {
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(validate_relative_path("docs/file.txt").is_ok());
    }

    #[test]
    fn local_directory_listing_is_not_recursive() {
        let base =
            std::env::temp_dir().join(format!("catsvn-local-listing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join(".svn")).unwrap();
        fs::create_dir_all(base.join("alpha").join("nested")).unwrap();
        fs::write(base.join("alpha").join("nested").join("deep.txt"), b"deep").unwrap();
        fs::write(base.join("alpha").join("inner.txt"), b"inner").unwrap();
        fs::write(base.join("readme.txt"), b"readme").unwrap();

        let entries = read_local_directory(&base, "").unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        // Only the immediate children are returned, and the hidden .svn metadata
        // directory plus nested content are skipped.
        assert_eq!(paths, vec!["alpha", "readme.txt"]);
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[1].kind, "file");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn credential_store_round_trips_and_locks_down_permissions() {
        let path =
            std::env::temp_dir().join(format!("catsvn-credentials-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);

        assert!(read_credentials_store_from(&path).unwrap().is_empty());

        let mut store = read_credentials_store_from(&path).unwrap();
        store.insert(
            "https://svn.example.com/repo".to_string(),
            StoredCredentials {
                username: "alice".to_string(),
                password: "s3cret".to_string(),
            },
        );
        write_credentials_store_to(&path, &store).unwrap();

        let saved = read_credentials_store_from(&path)
            .unwrap()
            .get("https://svn.example.com/repo")
            .cloned()
            .expect("saved credentials should be readable again");
        assert_eq!(saved.username, "alice");
        assert_eq!(saved.password, "s3cret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn detects_binary_files_by_prefix() {
        let base = std::env::temp_dir().join(format!("catsvn-binary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let text = base.join("text.txt");
        let binary = base.join("binary.bin");
        fs::write(&text, b"plain text\n").unwrap();
        fs::write(&binary, b"\x00\x01PK\x03\x04").unwrap();

        assert!(!looks_binary(&text).unwrap());
        assert!(looks_binary(&binary).unwrap());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_upload_skips_svn_and_finder_metadata() {
        let base = std::env::temp_dir().join(format!("catsvn-upload-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let source = base.join("source");
        let target = base.join("target");
        fs::create_dir_all(source.join(".svn")).unwrap();
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join(".DS_Store"), b"junk").unwrap();
        fs::write(source.join("keep.txt"), b"keep").unwrap();
        fs::write(source.join("sub").join(".DS_Store"), b"junk").unwrap();
        fs::write(source.join("sub").join("deep.txt"), b"deep").unwrap();
        fs::write(source.join(".svn").join("entries"), b"meta").unwrap();

        copy_upload_source(&source, &target).unwrap();

        assert!(target.join("keep.txt").is_file());
        assert!(target.join("sub").join("deep.txt").is_file());
        assert!(!target.join(".DS_Store").exists());
        assert!(!target.join("sub").join(".DS_Store").exists());
        assert!(!target.join(".svn").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn non_added_changes_commit_through_their_own_path() {
        let workdir = "/tmp/catsvn-status-fixture-2";
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="{workdir}">
<entry path="{workdir}/deleted.txt"><wc-status item="deleted" props="none"/></entry>
<entry path="{workdir}/missing.txt"><wc-status item="missing" props="none"/></entry>
<entry path="{workdir}/conflicted.txt"><wc-status item="conflicted" props="none"/></entry>
<entry path="{workdir}/untracked.txt"><wc-status item="unversioned" props="none"/></entry>
<entry path="{workdir}/ignored.log"><wc-status item="ignored" props="none"/></entry>
<entry path="{workdir}/normal.txt"><wc-status item="normal" props="none"/></entry>
</target>
</status>"#
        );

        let changes = parse_local_changes(&xml, workdir).unwrap();
        let statuses = changes
            .iter()
            .map(|change| change.status.as_str())
            .collect::<Vec<_>>();

        // Ignored and unmodified entries are dropped, and everything that is not
        // an "added" node commits through its own path.
        assert_eq!(
            statuses,
            vec!["conflicted", "deleted", "missing", "unversioned"]
        );
        assert!(
            changes
                .iter()
                .all(|change| change.commit_path == change.path)
        );
    }

    #[test]
    fn parses_history_entries_with_changed_paths() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="12">
<author>amy</author>
<date>2026-02-03T04:05:06.000000Z</date>
<paths>
<path kind="file" action="M">/RDDepartment/notes.md</path>
</paths>
<msg>update notes</msg>
</logentry>
<logentry revision="11">
<author>ben</author>
<date>2026-02-02T01:02:03.000000Z</date>
<paths>
<path kind="dir" action="A">/RDDepartment/notes</path>
</paths>
</logentry>
</log>"#;

        let entries = parse_history(xml).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].revision, 12);
        assert_eq!(entries[0].author.as_deref(), Some("amy"));
        assert_eq!(entries[0].message.as_deref(), Some("update notes"));
        assert_eq!(entries[0].changed_paths.len(), 1);
        assert_eq!(entries[0].changed_paths[0].action, "M");
        assert_eq!(entries[0].changed_paths[0].path, "/RDDepartment/notes.md");
        assert_eq!(entries[1].revision, 11);
        assert_eq!(entries[1].changed_paths[0].action, "A");
        assert_eq!(entries[1].changed_paths[0].kind.as_deref(), Some("dir"));
    }

    #[test]
    fn added_tree_commits_through_its_top_level_root() {
        let workdir = "/tmp/catsvn-status-fixture";
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="{workdir}">
<entry path="{workdir}/newdir"><wc-status item="added" props="none"/></entry>
<entry path="{workdir}/newdir/f1.txt"><wc-status item="added" props="none"/></entry>
<entry path="{workdir}/newdir/sub"><wc-status item="added" props="none"/></entry>
<entry path="{workdir}/newdir/sub/f2.txt"><wc-status item="added" props="none"/></entry>
<entry path="{workdir}/existing/a.txt"><wc-status item="modified" props="none"/></entry>
</target>
</status>"#
        );

        let changes = parse_local_changes(&xml, workdir).unwrap();
        let commit_path = |path: &str| {
            changes
                .iter()
                .find(|change| change.path == path)
                .map(|change| change.commit_path.clone())
                .unwrap_or_else(|| panic!("missing change for {path}"))
        };

        // Every node of a freshly added tree shares the top-level added root so
        // the pending-upload list shows one item instead of one per file.
        assert_eq!(commit_path("newdir"), "newdir");
        assert_eq!(commit_path("newdir/f1.txt"), "newdir");
        assert_eq!(commit_path("newdir/sub"), "newdir");
        assert_eq!(commit_path("newdir/sub/f2.txt"), "newdir");
        // A plain modification keeps its own path as the commit target.
        assert_eq!(commit_path("existing/a.txt"), "existing/a.txt");
    }

    #[test]
    fn parses_verbose_listing_entries() {
        let xml = r#"
      <list path="https://svn.example.com/repo/trunk">
        <entry kind="dir">
          <name>docs</name>
          <commit revision="7"><author>amy</author><date>2026-01-02T03:04:05.000000Z</date></commit>
        </entry>
        <entry kind="file">
          <name>readme.md</name>
          <size>42</size>
          <commit revision="9"><author>ben</author><date>2026-02-03T04:05:06.000000Z</date></commit>
        </entry>
      </list>
    "#;
        let entries = parse_listing(xml, "").unwrap();
        assert_eq!(entries[0].name, "docs");
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[1].name, "readme.md");
        assert_eq!(entries[1].size, Some(42));
        assert_eq!(entries[1].author.as_deref(), Some("ben"));
    }

    #[test]
    fn parses_remote_file_size_attribute() {
        let xml = r#"
      <info>
        <entry kind="file" size="356" revision="29483">
          <url>https://svn.example.com/file.txt</url>
        </entry>
      </info>
    "#;
        assert_eq!(parse_remote_file_size(xml).unwrap(), 356);
    }

    #[test]
    fn decodes_utf8_and_falls_back_to_gbk() {
        assert_eq!(decode_text("普通文本".as_bytes()), "普通文本");
        assert_eq!(decode_text(b"plain ascii"), "plain ascii");
        // B2 E2 CA D4 is "测试" in GBK and is not valid UTF-8, so the decoder has
        // to fall back the way it does for a real GBK-encoded working copy.
        assert_eq!(decode_text(&[0xB2, 0xE2, 0xCA, 0xD4]), "测试");
    }

    #[test]
    fn expands_tilde_only_for_home_relative_paths() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            expand_home("~/repos/demo").unwrap(),
            home.join("repos/demo").to_string_lossy().into_owned()
        );
        assert_eq!(expand_home("~").unwrap(), "~");
        assert_eq!(expand_home("/tmp/demo").unwrap(), "/tmp/demo");
    }

    #[test]
    fn rejects_absolute_null_and_backslash_paths() {
        assert!(validate_relative_path("/etc/passwd").is_err());
        assert!(validate_relative_path("a/b\0c").is_err());
        assert!(validate_relative_path("a\\b").is_err());
        assert!(validate_relative_path("a/b/c.txt").is_ok());
    }

    #[test]
    fn remote_url_encodes_non_ascii_and_drops_empty_segments() {
        assert_eq!(
            remote_url("https://svn.example.com/repo", "文档/说明.md").unwrap(),
            "https://svn.example.com/repo/%E6%96%87%E6%A1%A3/%E8%AF%B4%E6%98%8E.md"
        );
        assert_eq!(
            remote_url("https://svn.example.com/repo", "a//b/").unwrap(),
            "https://svn.example.com/repo/a/b"
        );
        assert_eq!(
            remote_url("https://svn.example.com/repo#fragment", "a").unwrap(),
            "https://svn.example.com/repo/a"
        );
    }

    #[test]
    fn local_changes_collapse_added_trees_to_their_root() {
        let base =
            std::env::temp_dir().join(format!("catsvn-local-changes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("newdir").join("nested")).unwrap();
        fs::write(base.join("newdir").join("nested").join("file.txt"), b"x").unwrap();
        let root = base.to_string_lossy().to_string();
        let xml = format!(
            r#"
      <status>
        <target path="{root}">
          <entry path="{root}/newdir">
            <wc-status item="added" props="none"/>
          </entry>
          <entry path="{root}/newdir/nested">
            <wc-status item="added" props="none"/>
          </entry>
          <entry path="{root}/newdir/nested/file.txt">
            <wc-status item="added" props="none"/>
          </entry>
          <entry path="{root}/readme.md">
            <wc-status item="modified" props="none"/>
          </entry>
          <entry path="{root}/untouched.md">
            <wc-status item="normal" props="none"/>
          </entry>
          <entry path="{root}/sparse">
            <wc-status item="incomplete" props="none"/>
          </entry>
        </target>
      </status>
    "#
        );

        let changes = parse_local_changes(&xml, &root).unwrap();
        let summarized = changes
            .iter()
            .map(|change| {
                (
                    change.path.as_str(),
                    change.commit_path.as_str(),
                    change.status.as_str(),
                    change.kind.as_str(),
                )
            })
            .collect::<Vec<_>>();

        // The whole added tree collapses onto `newdir`, `normal` and sparse
        // `incomplete` entries drop out, and the modified file keeps committing
        // through its own path.
        assert_eq!(
            summarized,
            vec![
                ("newdir", "newdir", "added", "dir"),
                ("newdir/nested", "newdir", "added", "dir"),
                ("newdir/nested/file.txt", "newdir", "added", "file"),
                ("readme.md", "readme.md", "modified", "file"),
            ]
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolves_the_svn_client_from_the_usual_install_locations() {
        let resolved = svn_binary();
        let name = resolved.to_string_lossy().into_owned();
        assert!(
            name == "svn" || name.ends_with("/svn"),
            "unexpected: {name}"
        );
        if name != "svn" {
            // A Finder-launched app has no Homebrew directory on PATH, so this
            // has to be a real binary rather than a bare command name.
            assert!(resolved.is_file(), "{name} should be a real file");
        }
    }
}
