//! Desktop (Windows, macOS, Linux).

use super::{Decoding, Features};
use std::path::PathBuf;
use tauri::{AppHandle, Builder, Runtime};

pub fn features() -> Features {
    // A Flatpak (Flathub) copy is updated by Flathub, not by the app, and its
    // sandbox has no clipboard helper (wl-copy / xclip) for copying files.
    let flatpak = in_flatpak();
    Features {
        form: "desktop",
        window_controls: true,
        window_fullscreen: true,
        open_files: true,
        choose_folder: true,
        keyboard: true,
        background_alerts: true,
        self_update: !flatpak,
        share_sheet: cfg!(any(target_os = "macos", target_os = "windows")),
        copy_files: !flatpak,
        tv: super::tv_env(),
    }
}

/// Running inside a Flatpak sandbox (flatpak sets FLATPAK_ID and /.flatpak-info).
fn in_flatpak() -> bool {
    cfg!(target_os = "linux") && (std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists())
}

/// Before the window exists.
pub fn init() {
    // Windows: notifications (and the taskbar) show this app's name and icon.
    #[cfg(windows)]
    windows::register(crate::about::IDENTIFIER, crate::about::NAME);
}

pub fn plugins<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.plugin(tauri_plugin_updater::Builder::new().build())
}

// ── self-update ──
// Releases are built by .github/workflows/release.yml, which also publishes a
// signed `latest.json`; the endpoint and public key are in tauri.conf.json.
// Development builds (dev.yml) publish theirs on the rolling `dev` pre-release;
// with "Get development builds" on, both are checked and the newer one wins
// (so a dev copy still moves on to the next real release).
// The update is checked here and only installed when the user says so.

const DEV_MANIFEST: &str = "https://github.com/DanielGarc/chismoso/releases/download/dev/latest.json";

static PENDING: std::sync::Mutex<Option<tauri_plugin_updater::Update>> = std::sync::Mutex::new(None);

pub async fn check_update(app: &AppHandle, dev: bool) -> Result<Option<super::UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let stable = updater.check();
    let update = if dev {
        let url = DEV_MANIFEST.parse().map_err(|e| format!("{e}"))?;
        let dev = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
        let s = stable.await.map_err(|e| e.to_string())?;
        // A missing dev manifest (no dev build yet) isn't an error worth showing.
        newest(s, dev.check().await.ok().flatten())
    } else {
        stable.await.map_err(|e| e.to_string())?
    };
    let info = update.as_ref().map(|u| super::UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
        needs_password: matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Deb | tauri::utils::config::BundleType::Rpm)
        ),
    });
    *PENDING.lock().unwrap() = update;
    Ok(info)
}

fn newest(a: Option<tauri_plugin_updater::Update>, b: Option<tauri_plugin_updater::Update>) -> Option<tauri_plugin_updater::Update> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if newer(&b.version, &a.version) { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// Semantic-version order: 0.6.3 > 0.6.3-12 > 0.6.3-5 > 0.6.2.
fn newer(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

/// Downloads and installs the update found by `check_update`, reporting
/// progress (0..=1) through `progress`, then restarts the app.
pub async fn install_update(app: &AppHandle, progress: impl Fn(f64) + Send + 'static) -> Result<(), String> {
    let update = PENDING.lock().unwrap().take().ok_or("Check for updates first.")?;
    let mut done: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    progress(done as f64 / t as f64);
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("update-failed: {e}"))?;
    app.restart()
}

/// Once the window exists.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            // WebKitGTK ships with WebRTC switched off.
            let _ = w.with_webview(|wv| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                let view = wv.inner();
                if let Some(s) = view.settings()
                    && !s.enables_webrtc() {
                        s.set_enable_webrtc(true);
                        s.set_enable_media_stream(true);
                        s.set_media_playback_requires_user_gesture(false);
                        // The page was already created without WebRTC; reload so it gets RTCPeerConnection.
                        view.reload();
                    }
            });
        }
    }
    let _ = app;
    Ok(())
}

/// One native notification, with an optional picture (a file path). Sent with
/// notify-rust directly (what Tauri's notification plugin uses underneath):
/// the plugin can't attach images, and on Windows falls back to PowerShell's
/// identity unless the app was installed.
pub fn notify(_app: &AppHandle, title: &str, body: &str, image: Option<&str>) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body).appname(crate::about::NAME);
    if let Some(path) = image {
        n.image_path(path);
    }
    #[cfg(windows)]
    n.app_id(crate::about::IDENTIFIER);
    #[cfg(target_os = "macos")]
    {
        // Notifications belong to the app bundle; a bare binary (cargo run)
        // borrows Terminal's, as the plugin did.
        static APP: std::sync::Once = std::sync::Once::new();
        APP.call_once(|| {
            let bundled = std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS"));
            let _ = notify_rust::set_application(if bundled { crate::about::IDENTIFIER } else { "com.apple.Terminal" });
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    n.auto_icon(); // the binary's name, which is the icon name the .deb/.rpm installs
    n.show().map(|_| ()).map_err(|e| e.to_string())
}

/// Scratch space (notification pictures).
pub fn cache_dir(_app: &AppHandle) -> PathBuf {
    std::env::temp_dir()
}

pub fn default_output_dir(_app: &AppHandle) -> String {
    dirs::video_dir()
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Chismoso Exports")
        .display()
        .to_string()
}

/// Opens a folder, an .mp4 file, or the connected Frigate's web page
/// (`connected`) with the OS default app. Nothing else, so the UI can't be
/// used to launch programs.
pub fn open_path(path: &str, reveal: bool, connected: Option<&str>) -> Result<(), String> {
    let target: std::ffi::OsString = if path.starts_with("http://") || path.starts_with("https://") {
        let ours = path == crate::about::DOWNLOAD_PAGE;
        if !ours && connected != Some(path.trim_end_matches('/')) {
            return Err("Only the connected Frigate server can be opened.".into());
        }
        path.into()
    } else {
        let mut p = PathBuf::from(path);
        if reveal {
            p = p.parent().map(|d| d.to_path_buf()).unwrap_or(p);
        } else if !p.exists() && p.extension().is_none() {
            // the output folder may not exist yet
            let _ = std::fs::create_dir_all(&p);
        }
        let is_media = p.is_file()
            && p.extension().and_then(|e| e.to_str()).is_some_and(|e| ["mp4", "jpg", "jpeg", "png"].iter().any(|x| e.eq_ignore_ascii_case(x)));
        if !p.is_dir() && !is_media {
            return Err(format!("Can't open {}.", p.display()));
        }
        p.into_os_string()
    };
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&target).spawn();
    r.map(|_| ()).map_err(|e| format!("Couldn't open it: {e}"))
}

// ── sharing ─────────────────────────────────────────────────────────────

/// Opens the system share menu for files (macOS share picker, Windows Share),
/// pointing at `anchor`. Linux desktops have no common share menu; the UI
/// hides the button there (`Features::share_sheet`).
#[cfg(target_os = "macos")]
pub fn share_files(window: &tauri::WebviewWindow, paths: &[PathBuf], anchor: super::Anchor) -> Result<(), String> {
    mac_share::share(window, paths, anchor)
}
#[cfg(windows)]
pub fn share_files(window: &tauri::WebviewWindow, paths: &[PathBuf], _anchor: super::Anchor) -> Result<(), String> {
    win_share::share(window, paths)
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn share_files(_window: &tauri::WebviewWindow, _paths: &[PathBuf], _anchor: super::Anchor) -> Result<(), String> {
    Err("This desktop has no share menu. Use Copy, or Show in folder.".into())
}

/// Puts files on the clipboard as files, so pasting into a chat or an email
/// attaches them.
#[cfg(target_os = "macos")]
pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
    mac_share::copy(paths)
}
#[cfg(windows)]
pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
    win_share::copy(paths)
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
    linux_copy(paths)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn linux_copy(paths: &[PathBuf]) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    // file:// URIs, one per line: what file managers and chat apps accept.
    let uri = |p: &PathBuf| {
        let mut out = String::from("file://");
        for b in p.to_string_lossy().bytes() {
            if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
        }
        out
    };
    let list: String = paths.iter().map(|p| uri(p) + "\r\n").collect();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let tools: &[(&str, &[&str])] = if wayland {
        &[("wl-copy", &["--type", "text/uri-list"]), ("xclip", &["-selection", "clipboard", "-t", "text/uri-list"])]
    } else {
        &[("xclip", &["-selection", "clipboard", "-t", "text/uri-list"]), ("wl-copy", &["--type", "text/uri-list"])]
    };
    for (cmd, args) in tools {
        let Ok(mut child) = Command::new(cmd).args(*args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { continue };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(list.as_bytes());
        }
        // both tools keep serving the clipboard in the background; don't wait on that
        std::thread::spawn(move || { let _ = child.wait(); });
        return Ok(());
    }
    Err(if wayland {
        "Copying files needs wl-clipboard (sudo apt install wl-clipboard). Use Show in folder instead.".into()
    } else {
        "Copying files needs xclip (sudo apt install xclip). Use Show in folder instead.".into()
    })
}

#[cfg(target_os = "macos")]
mod mac_share {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting, NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use std::path::PathBuf;

    fn urls(paths: &[PathBuf]) -> Vec<Retained<NSURL>> {
        paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()))).collect()
    }

    pub fn share(window: &tauri::WebviewWindow, paths: &[PathBuf], a: super::super::Anchor) -> Result<(), String> {
        let paths = paths.to_vec();
        window
            .with_webview(move |wv| {
                let Some(_mtm) = MainThreadMarker::new() else { return };
                // The WKWebView: flipped coordinates, so the page's CSS pixels map straight over.
                let view = unsafe { &*(wv.inner() as *const NSView) };
                let items: Vec<Retained<AnyObject>> = urls(&paths).into_iter().map(|u| Retained::into_super(Retained::into_super(u))).collect();
                let items = NSArray::from_retained_slice(&items);
                // SAFETY: every item is an NSURL, which AppKit can share.
                let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
                let rect = NSRect::new(NSPoint::new(a.x, a.y), NSSize::new(a.w.max(1.0), a.h.max(1.0)));
                picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MaxY);
                // AppKit keeps showing it after we return; keep our reference alive too.
                std::mem::forget(picker);
            })
            .map_err(|e| e.to_string())
    }

    pub fn copy(paths: &[PathBuf]) -> Result<(), String> {
        let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = urls(paths).into_iter().map(ProtocolObject::from_retained).collect();
        let items = NSArray::from_retained_slice(&items);
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if pb.writeObjects(&items) { Ok(()) } else { Err("Couldn't put the files on the clipboard.".into()) }
    }
}

#[cfg(windows)]
mod win_share {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;
    use windows::core::{HSTRING, Interface, Ref, factory};

    thread_local! {
        // The handler from the previous share, removed before adding the next.
        static PREV: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) };
    }

    pub fn share(window: &tauri::WebviewWindow, paths: &[PathBuf]) -> Result<(), String> {
        let raw = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let paths = paths.to_vec();
        window
            .run_on_main_thread(move || {
                if let Err(e) = show(HWND(raw as *mut _), &paths) {
                    eprintln!("share failed: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }

    fn show(hwnd: HWND, paths: &[PathBuf]) -> windows::core::Result<()> {
        let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
        let mgr: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
        let paths = paths.to_vec();
        let title = match paths.as_slice() {
            [one] => one.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            _ => format!("{} files", paths.len()),
        };
        PREV.with(|prev| {
            if let Some((m, token)) = prev.borrow_mut().take() {
                let _ = m.RemoveDataRequested(token);
            }
        });
        let token = mgr.DataRequested(&TypedEventHandler::new(move |_, args: Ref<DataRequestedEventArgs>| {
            let args = args.ok()?;
            let data = args.Request()?.Data()?;
            data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
            // WinRT file objects can't cross threads, so they're opened here, on the UI thread.
            let files: Vec<Option<IStorageItem>> = paths
                .iter()
                .map(|p| StorageFile::GetFileFromPathAsync(&HSTRING::from(p.as_os_str()))?.join()?.cast().map(Some))
                .collect::<windows::core::Result<_>>()?;
            let list: windows_collections::IIterable<IStorageItem> = files.into();
            data.SetStorageItemsReadOnly(&list)?;
            Ok(())
        }))?;
        PREV.with(|prev| *prev.borrow_mut() = Some((mgr, token)));
        unsafe { interop.ShowShareUIForWindow(hwnd) }
    }

    /// CF_HDROP: the clipboard format Explorer uses for copied files.
    pub fn copy(paths: &[PathBuf]) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{GlobalFree, POINT};
        use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
        use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
        use windows_sys::Win32::UI::Shell::DROPFILES;
        const CF_HDROP: u32 = 15;

        let mut names: Vec<u16> = Vec::new();
        for p in paths {
            names.extend(p.as_os_str().encode_wide());
            names.push(0);
        }
        names.push(0);
        let header = std::mem::size_of::<DROPFILES>();
        let bytes = header + names.len() * 2;
        unsafe {
            let mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if mem.is_null() {
                return Err("Couldn't put the files on the clipboard.".into());
            }
            let ptr = GlobalLock(mem) as *mut u8;
            let df = DROPFILES { pFiles: header as u32, pt: POINT { x: 0, y: 0 }, fNC: 0, fWide: 1 };
            std::ptr::write_unaligned(ptr as *mut DROPFILES, df);
            std::ptr::copy_nonoverlapping(names.as_ptr() as *const u8, ptr.add(header), names.len() * 2);
            GlobalUnlock(mem);
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                GlobalFree(mem);
                return Err("The clipboard is busy. Try again.".into());
            }
            EmptyClipboard();
            let ok = !SetClipboardData(CF_HDROP, mem).is_null();
            CloseClipboard();
            if ok { Ok(()) } else { GlobalFree(mem); Err("Couldn't put the files on the clipboard.".into()) }
        }
    }
}

pub fn decoding() -> Decoding {
    #[cfg(target_os = "linux")]
    {
        linux_decoding()
    }
    #[cfg(target_os = "windows")]
    {
        Decoding { hardware: Some(true), detail: "WebView2 (Edge) uses the graphics card when it can".into(), hint: None }
    }
    #[cfg(target_os = "macos")]
    {
        Decoding { hardware: Some(true), detail: "WebKit uses VideoToolbox (hardware)".into(), hint: None }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Decoding { hardware: None, detail: "Unknown on this system".into(), hint: None }
    }
}

/// WebKitGTK plays video through GStreamer, which decodes in software unless
/// a hardware plugin is installed and a GPU render node is available.
#[cfg(target_os = "linux")]
fn linux_decoding() -> Decoding {
    use std::path::Path;
    let mut dirs: Vec<String> = std::env::var("GST_PLUGIN_PATH").map(|v| v.split(':').map(String::from).collect()).unwrap_or_default();
    for d in [
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
    ] {
        dirs.push(d.into());
    }
    let plugins = [
        ("libgstva.so", "VA-API (gst-plugins-bad va)"),
        ("libgstvaapi.so", "VA-API (gstreamer-vaapi)"),
        ("libgstnvcodec.so", "NVIDIA NVDEC"),
        ("libgstv4l2codecs.so", "V4L2 stateless (ARM boards)"),
    ];
    let found: Vec<&str> = plugins.iter().filter(|(f, _)| dirs.iter().any(|d| Path::new(d).join(f).exists())).map(|(_, n)| *n).collect();
    let gpu = Path::new("/dev/dri/renderD128").exists();
    match (found.is_empty(), gpu) {
        (false, true) => Decoding { hardware: Some(true), detail: format!("GStreamer hardware decoding: {}", found.join(", ")), hint: None },
        (false, false) => Decoding {
            hardware: None,
            detail: format!("Hardware plugin installed ({}) but no GPU render device (/dev/dri) was found", found.join(", ")),
            hint: Some("Check your graphics driver, or that this user can open /dev/dri/renderD128 (the 'render' group).".into()),
        },
        (true, _) => Decoding {
            hardware: Some(false),
            detail: "Software decoding (no GStreamer hardware plugin found)".into(),
            hint: Some("Install hardware decoding to cut CPU use a lot: Intel/AMD → gstreamer1.0-plugins-bad (va) or gstreamer1.0-vaapi; NVIDIA → gstreamer1.0-plugins-bad (nvcodec). Then restart the app.".into()),
        },
    }
}

/// Gives the app its own identity for Windows notifications, however it was
/// installed (or not): registers our AppUserModelID for this user with a
/// display name and icon, and claims that ID for this process so toasts and
/// the taskbar agree. The installers' Start-menu shortcut uses the same ID.
#[cfg(windows)]
pub mod windows {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    const ICON: &[u8] = include_bytes!("../../icons/128x128@2x.png");

    pub fn register(app_id: &str, name: &str) {
        let wide: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
        // Must happen before the first window opens.
        unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
        if let Err(e) = write_registration(app_id, name) {
            eprintln!("couldn't register for notifications: {e}");
        }
    }

    fn write_registration(app_id: &str, name: &str) -> std::io::Result<()> {
        let dir = dirs::data_local_dir().ok_or_else(|| std::io::Error::other("no local app data folder"))?.join(app_id);
        std::fs::create_dir_all(&dir)?;
        let icon = dir.join("notification-icon.png");
        if std::fs::read(&icon).ok().as_deref() != Some(ICON) {
            std::fs::write(&icon, ICON)?;
        }
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"Software\Classes\AppUserModelId\{app_id}"))?;
        key.set_value("DisplayName", &name)?;
        key.set_value("IconUri", &icon.to_string_lossy().to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_order() {
        assert!(super::newer("0.6.3", "0.6.3-12"));
        assert!(super::newer("0.6.3-12", "0.6.3-5"));
        assert!(super::newer("0.6.3-1", "0.6.2"));
        assert!(!super::newer("0.6.2", "0.6.3-1"));
    }
}
