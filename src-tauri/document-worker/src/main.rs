mod manifest;
mod ocr;
mod pipeline;
mod protocol;

use protocol::{
    CompletedResult, FailedResult, PROTOCOL_VERSION, WorkerRequest, WorkerResponse, read_frame,
    write_frame,
};
use std::io;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use zeroize::Zeroize;

fn main() {
    if let Err(error) = run() {
        eprintln!("myagents-document-worker protocol failure: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut stdin = io::stdin().lock();
    let mut first = read_frame(&mut stdin)
        .map_err(|_| "failed to read start frame".to_string())?
        .ok_or_else(|| "missing start frame".to_string())?;
    let parsed = serde_json::from_slice(&first);
    first.zeroize();
    let request: WorkerRequest = parsed.map_err(|_| "invalid start frame".to_string())?;
    let WorkerRequest::Start(start) = request else {
        return Err("first frame must be start".into());
    };
    if start.protocol_version != PROTOCOL_VERSION
        || start.job_id.is_empty()
        || start.worker_generation == 0
    {
        return Err("invalid start identity".into());
    }
    let job_id = start.job_id.clone();
    let generation = start.worker_generation;
    {
        let mut stdout = io::stdout().lock();
        write_frame(
            &mut stdout,
            &WorkerResponse::Ready {
                protocol_version: PROTOCOL_VERSION,
                job_id: &job_id,
                worker_generation: generation,
            },
        )
        .map_err(|_| "failed to write ready frame".to_string())?;
    }
    drop(stdin);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_flag = cancelled.clone();
    let cancel_job = job_id.clone();
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        while let Ok(Some(frame)) = read_frame(&mut stdin) {
            let Ok(WorkerRequest::Cancel {
                protocol_version,
                job_id,
                worker_generation,
            }) = serde_json::from_slice::<WorkerRequest>(&frame)
            else {
                continue;
            };
            if protocol_version == PROTOCOL_VERSION
                && job_id == cancel_job
                && worker_generation == generation
            {
                cancel_flag.store(true, Ordering::Relaxed);
                break;
            }
        }
    });

    let resources = match manifest::verify(Path::new(&start.resource_manifest_path)) {
        Ok(resources) => resources,
        Err(code) => return terminal_error(&job_id, generation, &code),
    };
    let mut stdout = io::stdout().lock();
    let mut progress = |stage: &str, _value: u8| {
        let _ = write_frame(
            &mut stdout,
            &WorkerResponse::Progress {
                protocol_version: PROTOCOL_VERSION,
                job_id: &job_id,
                worker_generation: generation,
                stage,
                current: None,
                total: None,
                unit: None,
            },
        );
    };
    let result = pipeline::convert(
        Path::new(&start.input_path),
        &start.source_name,
        Path::new(&start.staging_path),
        start.password.as_ref().map(|password| password.expose()),
        &resources,
        &cancelled,
        &mut progress,
    );
    match result {
        Ok(output) => write_frame(
            &mut stdout,
            &WorkerResponse::Completed {
                protocol_version: PROTOCOL_VERSION,
                job_id: &job_id,
                worker_generation: generation,
                result: CompletedResult {
                    warnings: &output.warnings,
                    detected_format: &output.detected_format,
                    metrics: &output.metrics,
                },
            },
        )
        .map_err(|_| "failed to write terminal frame".to_string()),
        Err(code) => {
            let code = public_error_code(&code);
            let message = public_error_message(code);
            write_frame(
                &mut stdout,
                &WorkerResponse::Failed {
                    protocol_version: PROTOCOL_VERSION,
                    job_id: &job_id,
                    worker_generation: generation,
                    error: FailedResult { code, message },
                },
            )
            .map_err(|_| "failed to write terminal frame".to_string())
        }
    }
}

fn terminal_error(job_id: &str, generation: u64, code: &str) -> Result<(), String> {
    let code = public_error_code(code);
    let mut stdout = io::stdout().lock();
    write_frame(
        &mut stdout,
        &WorkerResponse::Failed {
            protocol_version: PROTOCOL_VERSION,
            job_id,
            worker_generation: generation,
            error: FailedResult {
                code,
                message: public_error_message(code),
            },
        },
    )
    .map_err(|_| "failed to write terminal frame".to_string())
}

fn public_error_code(code: &str) -> &str {
    match code {
        "DOCUMENT_INPUT_UNAVAILABLE" => "DOCUMENT_INPUT_READ_FAILED",
        "DOCUMENT_ARTIFACT_INVALID"
        | "DOCUMENT_STAGING_READ_FAILED"
        | "DOCUMENT_STAGING_WRITE_FAILED" => "DOCUMENT_PUBLISH_FAILED",
        "DOCUMENT_PRIVATE_PATH_INVALID"
        | "DOCUMENT_STAGING_NOT_EMPTY"
        | "DOCUMENT_PDF_PAGE_COVERAGE_INVALID" => "DOCUMENT_WORKER_PROTOCOL_ERROR",
        "DOCUMENT_OCR_INFERENCE_FAILED" | "DOCUMENT_OCR_OUTPUT_INVALID" => {
            "DOCUMENT_OCR_RUNTIME_UNAVAILABLE"
        }
        "DOCUMENT_RUNTIME_UNSUPPORTED_PLATFORM" => "DOCUMENT_RESOURCE_TARGET_MISMATCH",
        _ => code,
    }
}

fn public_error_message(code: &str) -> &'static str {
    match code {
        "DOCUMENT_CANCELLED" => "The conversion was cancelled.",
        "DOCUMENT_PASSWORD_REQUIRED" => "This document is encrypted and requires --password.",
        "DOCUMENT_PASSWORD_INVALID" => "The supplied document password is incorrect.",
        "DOCUMENT_ENCRYPTION_SCHEME_UNSUPPORTED" => {
            "This encrypted document format is not supported."
        }
        "DOCUMENT_UNSUPPORTED_FORMAT" => "This file format is not supported.",
        "DOCUMENT_RESOURCE_LIMIT" => "The document exceeds a fixed processing safety limit.",
        code if code.starts_with("DOCUMENT_RESOURCE") => {
            "The bundled document-processing resources are missing or corrupt. Reinstall MyAgents."
        }
        "DOCUMENT_OCR_RUNTIME_UNAVAILABLE" | "DOCUMENT_PDFIUM_LOAD_FAILED" => {
            "A bundled document-processing runtime could not be loaded. Reinstall MyAgents."
        }
        _ => "The document could not be converted safely.",
    }
}

#[cfg(test)]
mod tests {
    use super::public_error_code;

    #[test]
    fn internal_worker_failures_normalize_to_the_public_error_contract() {
        assert_eq!(
            public_error_code("DOCUMENT_INPUT_UNAVAILABLE"),
            "DOCUMENT_INPUT_READ_FAILED"
        );
        assert_eq!(
            public_error_code("DOCUMENT_OCR_OUTPUT_INVALID"),
            "DOCUMENT_OCR_RUNTIME_UNAVAILABLE"
        );
        assert_eq!(
            public_error_code("DOCUMENT_STAGING_WRITE_FAILED"),
            "DOCUMENT_PUBLISH_FAILED"
        );
        assert_eq!(
            public_error_code("DOCUMENT_PDF_PAGE_COVERAGE_INVALID"),
            "DOCUMENT_WORKER_PROTOCOL_ERROR"
        );
    }
}
