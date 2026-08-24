use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const PIPELINE_VERSION: &str = "anydoc-0.1.9_ppocrv6-small_v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceManifest {
    pub schema_version: u32,
    pub pipeline_version: String,
    pub platform: String,
    pub architecture: String,
    pub files: ResourceFiles,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFiles {
    pub onnx_runtime: ResourceFile,
    pub pdfium: ResourceFile,
    pub detector_model: ResourceFile,
    pub recognizer_model: ResourceFile,
    pub dictionary: ResourceFile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub license: String,
    pub upstream_revision: String,
    pub artifact_source: String,
    pub signing: ResourceSigning,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSigning {
    pub kind: String,
    pub identity: String,
}

#[derive(Debug)]
pub struct VerifiedResources {
    pub onnx_runtime: PathBuf,
    pub pdfium: PathBuf,
    pub detector_model: PathBuf,
    pub recognizer_model: PathBuf,
    pub dictionary: PathBuf,
}

pub fn verify(path: &Path) -> Result<VerifiedResources, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "DOCUMENT_RESOURCE_MISSING".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("DOCUMENT_RESOURCE_MANIFEST_INVALID".into());
    }
    let bytes = fs::read(path).map_err(|_| "DOCUMENT_RESOURCE_MANIFEST_INVALID".to_string())?;
    let manifest: ResourceManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "DOCUMENT_RESOURCE_MANIFEST_INVALID".to_string())?;
    if manifest.schema_version != 1 || manifest.pipeline_version != PIPELINE_VERSION {
        return Err("DOCUMENT_RESOURCE_MANIFEST_INVALID".into());
    }
    validate_target(&manifest)?;
    let root = path
        .parent()
        .ok_or_else(|| "DOCUMENT_RESOURCE_MANIFEST_INVALID".to_string())?;
    Ok(VerifiedResources {
        onnx_runtime: verify_file(root, &manifest.files.onnx_runtime)?,
        pdfium: verify_file(root, &manifest.files.pdfium)?,
        detector_model: verify_file(root, &manifest.files.detector_model)?,
        recognizer_model: verify_file(root, &manifest.files.recognizer_model)?,
        dictionary: verify_file(root, &manifest.files.dictionary)?,
    })
}

fn validate_target(manifest: &ResourceManifest) -> Result<(), String> {
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => return Err("DOCUMENT_RUNTIME_UNSUPPORTED_PLATFORM".into()),
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("DOCUMENT_RUNTIME_UNSUPPORTED_PLATFORM".into()),
    };
    if manifest.platform != platform || manifest.architecture != architecture {
        return Err("DOCUMENT_RESOURCE_TARGET_MISMATCH".into());
    }
    Ok(())
}

fn verify_file(root: &Path, file: &ResourceFile) -> Result<PathBuf, String> {
    if file.sha256.len() != 64
        || file.size == 0
        || file.license.trim().is_empty()
        || file.upstream_revision.trim().is_empty()
        || file.artifact_source.trim().is_empty()
        || file.signing.kind.trim().is_empty()
        || file.signing.identity.trim().is_empty()
    {
        return Err("DOCUMENT_RESOURCE_MANIFEST_INVALID".into());
    }
    let relative = Path::new(&file.path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("DOCUMENT_RESOURCE_MANIFEST_INVALID".into());
    }
    let path = root.join(relative);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "DOCUMENT_RESOURCE_MISSING".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != file.size {
        return Err("DOCUMENT_RESOURCE_INVALID".into());
    }
    let actual = sha256_file(&path).map_err(|_| "DOCUMENT_RESOURCE_INVALID".to_string())?;
    if actual != file.sha256.to_ascii_lowercase() {
        return Err("DOCUMENT_RESOURCE_INVALID".into());
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
