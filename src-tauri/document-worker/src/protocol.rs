use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerRequest {
    Start(StartRequest),
    Cancel {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub protocol_version: u32,
    pub job_id: String,
    pub worker_generation: u64,
    pub input_path: String,
    pub source_name: String,
    pub staging_path: String,
    pub resource_manifest_path: String,
    pub password: Option<SecretString>,
}

pub struct SecretString(String);

impl SecretString {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerMetrics {
    pub source_bytes: u64,
    pub output_bytes: u64,
    pub pages_total: u32,
    pub pages_ocr: u32,
    pub assets_written: u32,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedResult<'a> {
    pub warnings: &'a [Warning],
    pub detected_format: &'a str,
    pub metrics: &'a WorkerMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedResult<'a> {
    pub code: &'a str,
    pub message: &'a str,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerResponse<'a> {
    Ready {
        protocol_version: u32,
        job_id: &'a str,
        worker_generation: u64,
    },
    Progress {
        protocol_version: u32,
        job_id: &'a str,
        worker_generation: u64,
        stage: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unit: Option<&'a str>,
    },
    Completed {
        protocol_version: u32,
        job_id: &'a str,
        worker_generation: u64,
        result: CompletedResult<'a>,
    },
    Failed {
        protocol_version: u32,
        job_id: &'a str,
        worker_generation: u64,
        error: FailedResult<'a>,
    },
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0_u8; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => unreachable!("one-byte read returned more than one byte"),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut prefix[1..])?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_CONTROL_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid control frame length",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub fn write_frame(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    use zeroize::Zeroize;

    let mut payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_CONTROL_FRAME_BYTES {
        payload.zeroize();
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response frame is too large",
        ));
    }
    let result = writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush());
    payload.zeroize();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_frame_before_allocating_payload() {
        let prefix = ((MAX_CONTROL_FRAME_BYTES as u32) + 1).to_be_bytes();
        let mut bytes = prefix.as_slice();
        let error = read_frame(&mut bytes).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn distinguishes_clean_eof_from_a_truncated_prefix() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        let error = read_frame(&mut [0_u8, 0].as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn secret_debug_is_redacted() {
        let secret = SecretString("marker-password".into());
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
    }
}
