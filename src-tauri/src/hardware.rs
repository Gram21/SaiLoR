//! `local:probe` (electron/hardware.ts): a best-effort hardware probe for choosing a
//! llama.cpp backend. Every probe may fail (tool missing, sandbox, timeout); that
//! means "unknown", never an error.

use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tauri::Manager;

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    vendor: &'static str,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    vram_bytes: Option<u64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub(crate) platform: &'static str,
    pub(crate) arch: &'static str,
    total_ram_bytes: u64,
    free_ram_bytes: u64,
    gpus: Vec<Gpu>,
    pub(crate) disk_free_bytes: i64,
    pub(crate) recommended_backend: &'static str,
}

/// `\bword\b` on a lowercased name.
fn has_word(lower: &str, word: &str) -> bool {
    let is_word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    lower.match_indices(word).any(|(i, _)| {
        !is_word(lower[..i].chars().next_back()) && !is_word(lower[i + word.len()..].chars().next())
    })
}

pub fn vendor_of(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let any = |ws: &[&str]| ws.iter().any(|w| n.contains(w));
    if any(&["nvidia", "geforce", "quadro", "tesla", "rtx", "gtx"]) {
        "nvidia"
    } else if has_word(&n, "amd") || any(&["radeon", "advanced micro"]) {
        "amd"
    } else if has_word(&n, "arc") || any(&["intel", "iris", "uhd"]) {
        "intel"
    } else if n.contains("apple") {
        "apple"
    } else {
        "other"
    }
}

fn gpu(name: &str) -> Gpu {
    Gpu {
        vendor: vendor_of(name),
        name: name.to_string(),
        vram_bytes: None,
    }
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (memory in MiB).
pub fn parse_nvidia_smi(out: &str) -> Vec<Gpu> {
    out.lines()
        .filter_map(|line| {
            let (name, mib) = line.rsplit_once(',')?;
            let mib = mib.trim();
            if !mib.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let mib: u64 = mib.parse().ok()?;
            (!name.is_empty()).then(|| Gpu {
                vendor: "nvidia",
                name: name.trim().into(),
                vram_bytes: Some(mib * 1024 * 1024),
            })
        })
        .collect()
}

/// `system_profiler SPDisplaysDataType -json`. Apple GPUs share system RAM, so no VRAM figure.
pub fn parse_system_profiler(json: &str) -> Vec<Gpu> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return vec![];
    };
    v["SPDisplaysDataType"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|i| i["sppci_model"].as_str().filter(|s| !s.is_empty()).map(gpu))
        .collect()
}

/// One adapter name per line (`Get-CimInstance Win32_VideoController`). Skips software adapters.
pub fn parse_windows_video(out: &str) -> Vec<Gpu> {
    const SOFTWARE: [&str; 4] = ["basic render", "basic display", "remote display", "virtual"];
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !SOFTWARE.iter().any(|s| l.to_lowercase().contains(s)))
        .map(gpu)
        .collect()
}

/// `lspci` lines for display controllers.
pub fn parse_lspci(out: &str) -> Vec<Gpu> {
    const KINDS: [&str; 3] = [
        "vga compatible controller",
        "3d controller",
        "display controller",
    ];
    out.lines()
        .filter_map(|l| {
            let lower = l.to_ascii_lowercase();
            let (_, at) = KINDS
                .iter()
                .filter_map(|k| lower.find(k).map(|i| (i, i + k.len())))
                .min()?;
            let rest = l[at..].strip_prefix(':').map_or(&l[at..], |r| r);
            Some(gpu(rest.trim()))
        })
        .collect()
}

pub fn recommend_backend(platform: &str, arch: &str, gpus: &[Gpu]) -> &'static str {
    let has = |v: &str| gpus.iter().any(|g| g.vendor == v);
    if platform == "darwin" {
        return if arch == "arm64" { "metal" } else { "cpu" };
    }
    if has("nvidia") {
        return if platform == "win32" || platform == "linux" {
            "vulkan"
        } else {
            "cpu"
        };
    }
    if has("amd") || has("intel") {
        return "vulkan";
    }
    "cpu"
}

/// stdout of a tool, or "" when it is missing, fails, or outlives `limit`.
async fn run(cmd: &str, args: &[&str], limit: Duration) -> String {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    match tokio::time::timeout(limit, c.output()).await {
        Ok(Ok(o)) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => String::new(),
    }
}

async fn probe_gpus(platform: &str, arch: &str) -> Vec<Gpu> {
    let short = Duration::from_secs(4);
    let long = Duration::from_secs(8);
    if platform == "darwin" {
        let found = parse_system_profiler(
            &run("system_profiler", &["SPDisplaysDataType", "-json"], long).await,
        );
        if !found.is_empty() || arch != "arm64" {
            return found;
        }
        return vec![Gpu {
            vendor: "apple",
            name: "Apple GPU".into(),
            vram_bytes: None,
        }];
    }
    let nvidia = parse_nvidia_smi(
        &run(
            "nvidia-smi",
            &[
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            short,
        )
        .await,
    );
    let others = if platform == "win32" {
        let ps = "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }";
        parse_windows_video(&run("powershell.exe", &["-NoProfile", "-Command", ps], long).await)
    } else {
        parse_lspci(&run("lspci", &[], short).await)
    };
    let keep = |g: &Gpu| g.vendor != "nvidia" || nvidia.is_empty();
    let others: Vec<Gpu> = others.into_iter().filter(keep).collect();
    nvidia.into_iter().chain(others).collect()
}

/// Node's `process.platform` / `process.arch` names, which the renderer and catalogs use.
fn node_names() -> (&'static str, &'static str) {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        a => a,
    };
    (platform, arch)
}

/// Free space on the volume holding `dir` (the longest matching mount point), or -1.
pub(crate) fn disk_free(dir: &Path) -> i64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map_or(-1, |d| d.available_space() as i64)
}

pub async fn probe(data_dir: &Path) -> HardwareInfo {
    let (platform, arch) = node_names();
    let gpus = probe_gpus(platform, arch).await;
    let dir = data_dir.to_path_buf();
    let (total, free, disk) = tokio::task::spawn_blocking(move || {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        (sys.total_memory(), sys.available_memory(), disk_free(&dir))
    })
    .await
    .unwrap_or((0, 0, -1));
    HardwareInfo {
        platform,
        arch,
        total_ram_bytes: total,
        free_ram_bytes: free,
        recommended_backend: recommend_backend(platform, arch, &gpus),
        gpus,
        disk_free_bytes: disk,
    }
}

#[tauri::command]
pub async fn local_probe(app: tauri::AppHandle) -> Result<HardwareInfo, String> {
    let dir = app
        .path()
        .config_dir()
        .map_err(crate::authz::err)?
        .join("SaiLoR");
    Ok(probe(&dir).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(v: &'static str, n: &str) -> Gpu {
        Gpu {
            vendor: v,
            name: n.into(),
            vram_bytes: None,
        }
    }

    #[test]
    fn parsers() {
        let smi = parse_nvidia_smi("NVIDIA GeForce RTX 4090, 24564\nNVIDIA T4, 15360\n");
        assert_eq!(
            smi[0],
            Gpu {
                vendor: "nvidia",
                name: "NVIDIA GeForce RTX 4090".into(),
                vram_bytes: Some(24564 * 1024 * 1024)
            }
        );
        assert_eq!(smi.len(), 2);
        assert!(
            parse_nvidia_smi("NVIDIA-SMI has failed because it could not communicate").is_empty()
        );
        assert!(parse_nvidia_smi("").is_empty());

        let j = r#"{"SPDisplaysDataType":[{"sppci_model":"Apple M3 Pro"},{"_name":"no model"}]}"#;
        assert_eq!(
            parse_system_profiler(j),
            vec![named("apple", "Apple M3 Pro")]
        );
        assert!(parse_system_profiler("not json").is_empty());

        let out = "NVIDIA GeForce GTX 1060\r\nMicrosoft Basic Render Driver\r\nIntel(R) UHD Graphics 630\r\n\r\n";
        let vendors: Vec<&str> = parse_windows_video(out).iter().map(|g| g.vendor).collect();
        assert_eq!(vendors, ["nvidia", "intel"]);

        let out = "00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620\n\
                   01:00.0 3D controller: NVIDIA Corporation GP108M [GeForce MX150]\n\
                   00:1f.3 Audio device: Intel Corporation Sunrise Point-LP HD Audio";
        assert_eq!(
            parse_lspci(out),
            vec![
                named("intel", "Intel Corporation UHD Graphics 620"),
                named("nvidia", "NVIDIA Corporation GP108M [GeForce MX150]"),
            ]
        );

        assert_eq!(vendor_of("AMD Radeon RX 7900"), "amd");
        assert_eq!(vendor_of("Intel Arc A770"), "intel");
        assert_eq!(vendor_of("Search Architect"), "other");
        assert_eq!(vendor_of("Mystery Board"), "other");
    }

    #[test]
    fn backends() {
        let nv = [named("nvidia", "x")];
        assert_eq!(recommend_backend("darwin", "arm64", &[]), "metal");
        assert_eq!(recommend_backend("darwin", "x64", &[]), "cpu");
        assert_eq!(recommend_backend("win32", "x64", &nv), "vulkan");
        assert_eq!(
            recommend_backend("linux", "x64", &[named("amd", "x")]),
            "vulkan"
        );
        assert_eq!(recommend_backend("linux", "x64", &[]), "cpu");
    }

    #[tokio::test]
    async fn probe_reports_this_machine() {
        let info = probe(&std::env::temp_dir()).await;
        assert!(
            info.total_ram_bytes > 0 && info.disk_free_bytes > 0,
            "{info:?}"
        );
        assert_eq!(
            info.recommended_backend,
            recommend_backend(info.platform, info.arch, &info.gpus)
        );
    }
}
