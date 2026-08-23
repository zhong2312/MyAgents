use crate::manifest::VerifiedResources;
use crate::ocr::OcrEngine;
use crate::protocol::{Warning, WorkerMetrics};
use anydoc::{Format, model::Asset};
use image::{DynamicImage, GenericImageView, ImageReader, Limits};
use pdfium_render::prelude::{PdfRenderConfig, Pdfium, PdfiumError, PdfiumInternalError};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 100_000_000;
pub const MAX_PDF_PAGES: usize = 500;
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_OCR_CHARACTERS: usize = 5_000_000;
const PDF_RENDER_WIDTH: i32 = 2400;
const PDF_RENDER_MAX_HEIGHT: i32 = 3500;

pub struct ConversionOutput {
    pub warnings: Vec<Warning>,
    pub detected_format: String,
    pub metrics: WorkerMetrics,
}

pub fn convert(
    input: &Path,
    source_name: &str,
    staging: &Path,
    password: Option<&str>,
    resources: &VerifiedResources,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(&str, u8),
) -> Result<ConversionOutput, String> {
    let started = Instant::now();
    validate_private_paths(input, staging)?;
    progress("inspecting", 5);
    let mut source = File::open(input).map_err(|_| "DOCUMENT_INPUT_UNAVAILABLE".to_string())?;
    let metadata = source
        .metadata()
        .map_err(|_| "DOCUMENT_INPUT_UNAVAILABLE".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(16 * 1024 * 1024) as usize);
    std::io::Read::by_ref(&mut source)
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "DOCUMENT_INPUT_READ_FAILED".to_string())?;
    if bytes.len() as u64 != metadata.len() {
        return Err("DOCUMENT_SOURCE_CHANGED".into());
    }
    check_cancelled(cancelled)?;

    let extension = Path::new(source_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let detected_document = Format::from_bytes(&bytes);
    let detected_image = image::guess_format(&bytes).ok().filter(|format| {
        matches!(
            format,
            image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
        )
    });
    let extension_is_image = matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp");
    let use_pdf = detected_document == Some(Format::Pdf)
        || (detected_document.is_none() && detected_image.is_none() && extension == "pdf");
    let use_image = detected_image.is_some() || (detected_document.is_none() && extension_is_image);
    let mut warnings = Vec::new();
    let (mut markdown, pages, ocr_pages, detected_format) = if use_pdf {
        if extension != "pdf" {
            warnings.push(format_mismatch_warning("PDF"));
        }
        progress("extracting", 15);
        let (markdown, pages, ocr_pages) = convert_pdf(
            &bytes,
            password,
            resources,
            cancelled,
            progress,
            &mut warnings,
        )?;
        (markdown, pages, ocr_pages, "pdf")
    } else if use_image {
        progress("ocr", 15);
        let image = decode_image(&bytes, &extension, &mut warnings)?;
        let mut engine = OcrEngine::load(
            &resources.onnx_runtime,
            &resources.detector_model,
            &resources.recognizer_model,
            &resources.dictionary,
        )?;
        let markdown = ocr_markdown(&mut engine, &image, "image", &mut warnings)?;
        let detected_format = match detected_image {
            Some(image::ImageFormat::Png) => "png",
            Some(image::ImageFormat::Jpeg) => "jpeg",
            Some(image::ImageFormat::WebP) => "webp",
            _ => extension.as_str(),
        };
        (markdown, 1, 1, detected_format)
    } else {
        progress("extracting", 20);
        let (document_bytes, format) = prepare_office_bytes(
            &bytes,
            &extension,
            detected_document,
            password,
            &mut warnings,
        )?;
        let (markdown, pages, ocr_pages) =
            convert_anydoc(&document_bytes, format, staging, &mut warnings)?;
        (markdown, pages, ocr_pages, format_name(format))
    };
    check_cancelled(cancelled)?;
    if markdown.trim().is_empty() {
        return Err("DOCUMENT_NO_USABLE_CONTENT".into());
    }
    if !warnings.is_empty() {
        markdown = warning_summary(&warnings) + &markdown;
    }
    if markdown.len() > MAX_OUTPUT_BYTES || markdown.chars().count() > MAX_OCR_CHARACTERS {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    let assets_written = validate_markdown_assets(&markdown, staging)?;
    progress("writing", 92);
    write_new_file(&staging.join("document.md"), markdown.as_bytes())?;
    let output_bytes = directory_size(staging)?;
    if output_bytes > MAX_OUTPUT_BYTES as u64 {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    progress("validating", 98);
    Ok(ConversionOutput {
        warnings,
        detected_format: detected_format.to_string(),
        metrics: WorkerMetrics {
            source_bytes: metadata.len(),
            output_bytes,
            pages_total: pages,
            pages_ocr: ocr_pages,
            assets_written,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    })
}

fn format_name(format: Format) -> &'static str {
    match format {
        Format::Doc => "doc",
        Format::Docx => "docx",
        Format::Odt => "odt",
        Format::Pdf => "pdf",
        Format::Ppt => "ppt",
        Format::Pptx => "pptx",
        Format::Rtf => "rtf",
        Format::Epub => "epub",
        Format::Excel => "excel",
        Format::Ods => "ods",
        Format::Odp => "odp",
        Format::Csv => "csv",
    }
}

fn map_anydoc_error(error: anydoc::ConvertError) -> String {
    match error {
        anydoc::ConvertError::Encrypted => "DOCUMENT_PASSWORD_REQUIRED",
        anydoc::ConvertError::ResourceLimit { .. } => "DOCUMENT_RESOURCE_LIMIT",
        anydoc::ConvertError::Unsupported(_) => "DOCUMENT_UNSUPPORTED_FORMAT",
        anydoc::ConvertError::Malformed { .. }
        | anydoc::ConvertError::MissingPart { .. }
        | anydoc::ConvertError::Io(_) => "DOCUMENT_MALFORMED",
        _ => "DOCUMENT_MALFORMED",
    }
    .to_string()
}

fn convert_anydoc(
    bytes: &[u8],
    format: Format,
    staging: &Path,
    warnings: &mut Vec<Warning>,
) -> Result<(String, u32, u32), String> {
    let assets_dir = staging.join("assets");
    let mut paths = HashMap::<usize, String>::new();
    let bundle = anydoc::to_markdown_bundle(bytes, format, |asset| {
        safe_asset_extension(asset).map(|extension| {
            let path = format!("assets/asset-{:04}.{extension}", asset.id.0 + 1);
            paths.insert(asset.id.0, path.clone());
            path
        })
    })
    .map_err(map_anydoc_error)?;
    warnings.extend(bundle.diagnostics.iter().map(|diagnostic| Warning {
        code: diagnostic.code.to_string(),
        location: diagnostic.location.clone(),
        message: diagnostic.message.clone(),
    }));
    let referenced_paths = paths
        .values()
        .filter(|path| bundle.markdown.contains(&format!("]({path})")))
        .cloned()
        .collect::<HashSet<_>>();
    let projected_bytes = bundle
        .assets
        .iter()
        .try_fold(bundle.markdown.len(), |total, asset| {
            let Some(relative) = paths.get(&asset.id.0) else {
                return Some(total);
            };
            if referenced_paths.contains(relative) {
                total.checked_add(asset.bytes.len())
            } else {
                Some(total)
            }
        });
    if projected_bytes.is_none_or(|bytes| bytes > MAX_OUTPUT_BYTES) {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    if !referenced_paths.is_empty() {
        fs::create_dir(&assets_dir).map_err(|_| "DOCUMENT_STAGING_WRITE_FAILED".to_string())?;
    }
    for asset in &bundle.assets {
        let Some(relative) = paths.get(&asset.id.0) else {
            warnings.push(Warning {
                code: "DOCUMENT_ASSET_SKIPPED".into(),
                location: Some(asset.origin_part.clone()),
                message: "An embedded asset used an unsupported or unsafe format and was omitted."
                    .into(),
            });
            continue;
        };
        if !referenced_paths.contains(relative) {
            warnings.push(Warning {
                code: "DOCUMENT_ASSET_UNUSED".into(),
                location: Some(asset.origin_part.clone()),
                message:
                    "An embedded asset was not referenced by the rendered document and was omitted."
                        .into(),
            });
            continue;
        }
        write_new_file(&staging.join(relative), &asset.bytes)?;
    }
    Ok((bundle.markdown, 0, 0))
}

fn prepare_office_bytes(
    bytes: &[u8],
    extension: &str,
    detected: Option<Format>,
    password: Option<&str>,
    warnings: &mut Vec<Warning>,
) -> Result<(Vec<u8>, Format), String> {
    let requested = Format::from_extension(extension);
    let selected = detected
        .or(requested)
        .ok_or_else(|| "DOCUMENT_UNSUPPORTED_FORMAT".to_string())?;
    match anydoc::to_document(bytes, selected) {
        Ok(_) => {
            if requested != Some(selected) {
                warnings.push(format_mismatch_warning(&format!("{selected:?}")));
            }
            return Ok((bytes.to_vec(), selected));
        }
        Err(anydoc::ConvertError::Encrypted) => {}
        Err(error) => return Err(map_anydoc_error(error)),
    }
    if encryption_scheme_is_unsupported(extension) {
        return Err("DOCUMENT_ENCRYPTION_SCHEME_UNSUPPORTED".into());
    }
    let Some(password) = password else {
        return Err("DOCUMENT_PASSWORD_REQUIRED".into());
    };
    match office_crypto::decrypt_from_bytes(bytes.to_vec(), password) {
        Ok(decrypted) => {
            if !decrypted_payload_matches_format(&decrypted, selected) {
                return Err("DOCUMENT_PASSWORD_INVALID".into());
            }
            let decrypted_format = Format::from_bytes(&decrypted)
                .or(requested)
                .ok_or_else(|| "DOCUMENT_MALFORMED".to_string())?;
            if let Err(error) = anydoc::to_document(&decrypted, decrypted_format) {
                return Err(match error {
                    anydoc::ConvertError::ResourceLimit { .. } => "DOCUMENT_RESOURCE_LIMIT",
                    _ => "DOCUMENT_MALFORMED",
                }
                .into());
            }
            if requested != Some(decrypted_format) {
                warnings.push(format_mismatch_warning(&format!("{decrypted_format:?}")));
            }
            Ok((decrypted, decrypted_format))
        }
        Err(office_crypto::DecryptError::Unimplemented(_)) => {
            Err("DOCUMENT_ENCRYPTION_SCHEME_UNSUPPORTED".into())
        }
        // The pinned office-crypto adapter exposes the legacy DOC verifier's
        // password failure separately. Structural crypto failures remain
        // malformed instead of being guessed to be a bad password.
        Err(office_crypto::DecryptError::InvalidPassword) => {
            Err("DOCUMENT_PASSWORD_INVALID".into())
        }
        Err(office_crypto::DecryptError::InvalidStructure)
        | Err(office_crypto::DecryptError::Unknown) => Err("DOCUMENT_MALFORMED".into()),
        Err(office_crypto::DecryptError::InvalidHeader)
        | Err(office_crypto::DecryptError::NotEncrypted)
        | Err(office_crypto::DecryptError::IoError(_)) => Err("DOCUMENT_MALFORMED".into()),
    }
}

fn decrypted_payload_matches_format(bytes: &[u8], format: Format) -> bool {
    const OLE_MAGIC: &[u8] = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1";
    const ZIP_PREFIXES: [&[u8]; 3] = [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"];
    match format {
        Format::Doc | Format::Ppt => bytes.starts_with(OLE_MAGIC),
        Format::Docx
        | Format::Pptx
        | Format::Excel
        | Format::Odt
        | Format::Ods
        | Format::Odp
        | Format::Epub => ZIP_PREFIXES.iter().any(|prefix| bytes.starts_with(prefix)),
        Format::Pdf => bytes.starts_with(b"%PDF-"),
        Format::Rtf => bytes.starts_with(b"{\\rtf"),
        Format::Csv => true,
    }
}

fn encryption_scheme_is_unsupported(extension: &str) -> bool {
    matches!(
        extension,
        "xls" | "ppt" | "pps" | "pot" | "odt" | "ods" | "odp" | "rtf" | "epub" | "csv"
    )
}

fn convert_pdf(
    bytes: &[u8],
    password: Option<&str>,
    resources: &VerifiedResources,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(&str, u8),
    warnings: &mut Vec<Warning>,
) -> Result<(String, u32, u32), String> {
    let (page_extraction, encrypted) = match pdf_inspector::extract_pages_markdown_mem(bytes, None)
    {
        Ok(extraction) => (Some(extraction), false),
        Err(pdf_inspector::PdfError::Encrypted) => (None, true),
        Err(_) => return Err("DOCUMENT_MALFORMED".into()),
    };
    if encrypted && password.is_none() {
        return Err("DOCUMENT_PASSWORD_REQUIRED".into());
    }
    let bindings = Pdfium::bind_to_library(&resources.pdfium)
        .map_err(|_| "DOCUMENT_PDFIUM_LOAD_FAILED".to_string())?;
    let pdfium = Pdfium::new(bindings);
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, encrypted.then_some(password).flatten())
        .map_err(|error| match error {
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)
                if encrypted =>
            {
                "DOCUMENT_PASSWORD_INVALID".to_string()
            }
            _ => "DOCUMENT_MALFORMED".to_string(),
        })?;
    let count = document.pages().len() as usize;
    if count == 0 || count > MAX_PDF_PAGES {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    if let Some(extraction) = page_extraction.as_ref()
        && extraction.pages.len() != count
    {
        return Err("DOCUMENT_PDF_PAGE_COVERAGE_INVALID".into());
    }
    let mut engine: Option<OcrEngine> = None;
    let mut output = String::new();
    let mut ocr_pages = 0_u32;
    for page_index in 0..count {
        check_cancelled(cancelled)?;
        let page_number = page_index + 1;
        let extracted = page_extraction
            .as_ref()
            .and_then(|result| result.pages.get(page_index));
        if let Some(page) = extracted
            && !pdf_page_index_matches(page.page, page_index)
        {
            return Err("DOCUMENT_PDF_PAGE_COVERAGE_INVALID".into());
        }
        let needs_ocr = encrypted || extracted.is_none_or(|page| page.needs_ocr);
        let page_markdown = if needs_ocr {
            ocr_pages += 1;
            progress("ocr", 20 + ((page_index * 70 / count) as u8));
            let page = document
                .pages()
                .get(page_index as i32)
                .map_err(|_| "DOCUMENT_PAGE_RENDER_FAILED".to_string())?;
            let image = page
                .render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(PDF_RENDER_WIDTH)
                        .set_maximum_height(PDF_RENDER_MAX_HEIGHT)
                        .render_annotations(true)
                        .render_form_data(true),
                )
                .and_then(|bitmap| bitmap.as_image())
                .map_err(|_| "DOCUMENT_PAGE_RENDER_FAILED".to_string())?;
            let engine = match engine.as_mut() {
                Some(engine) => engine,
                None => {
                    engine = Some(OcrEngine::load(
                        &resources.onnx_runtime,
                        &resources.detector_model,
                        &resources.recognizer_model,
                        &resources.dictionary,
                    )?);
                    engine.as_mut().expect("OCR engine inserted")
                }
            };
            ocr_markdown(engine, &image, &format!("page {page_number}"), warnings)?
        } else {
            extracted.expect("non OCR page exists").markdown.clone()
        };
        output.push_str(&format!("## Page {page_number}\n\n"));
        if page_markdown.trim().is_empty() {
            warnings.push(Warning {
                code: "DOCUMENT_PAGE_EMPTY".into(),
                location: Some(format!("page {page_number}")),
                message: "No usable text was recovered from this page.".into(),
            });
            output.push_str("> [!WARNING]\n> No usable text was recovered from this page.\n\n");
        } else {
            output.push_str(page_markdown.trim());
            output.push_str("\n\n");
        }
    }
    Ok((output, count as u32, ocr_pages))
}

fn pdf_page_index_matches(reported_zero_based: u32, expected_zero_based: usize) -> bool {
    usize::try_from(reported_zero_based).is_ok_and(|reported| reported == expected_zero_based)
}

fn decode_image(
    bytes: &[u8],
    extension: &str,
    warnings: &mut Vec<Warning>,
) -> Result<DynamicImage, String> {
    let guessed = image::guess_format(bytes).map_err(|_| "DOCUMENT_MALFORMED".to_string())?;
    let expected = match extension {
        "png" => Some(image::ImageFormat::Png),
        "jpg" | "jpeg" => Some(image::ImageFormat::Jpeg),
        "webp" => Some(image::ImageFormat::WebP),
        _ => None,
    };
    if expected != Some(guessed) {
        warnings.push(format_mismatch_warning(&format!("{guessed:?}")));
    }
    // Inspect dimensions before allocating the decoded pixel buffer. This
    // turns compressed image bombs into the stable pixel-limit error instead
    // of relying on an allocation failure after decode has already begun.
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), guessed)
        .into_dimensions()
        .map_err(|_| "DOCUMENT_MALFORMED".to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(512 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), guessed);
    reader.limits(limits);
    let mut image = reader
        .decode()
        .map_err(|_| "DOCUMENT_MALFORMED".to_string())?;
    image = apply_exif_orientation(image, exif_orientation(bytes));
    Ok(image)
}

fn format_mismatch_warning(actual: &str) -> Warning {
    Warning {
        code: "FORMAT_EXTENSION_MISMATCH".into(),
        location: None,
        message: format!(
            "The file extension did not match the safely detected {actual} content; detected content was used."
        ),
    }
}

fn exif_orientation(bytes: &[u8]) -> Option<u16> {
    let marker = bytes.windows(6).position(|window| window == b"Exif\0\0")?;
    let tiff = bytes.get(marker + 6..)?;
    let little_endian = match tiff.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read_u16 = |offset: usize| -> Option<u16> {
        let bytes: [u8; 2] = tiff.get(offset..offset + 2)?.try_into().ok()?;
        Some(if little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let bytes: [u8; 4] = tiff.get(offset..offset + 4)?.try_into().ok()?;
        Some(if little_endian {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    if read_u16(2)? != 42 {
        return None;
    }
    let ifd = usize::try_from(read_u32(4)?).ok()?;
    let count = usize::from(read_u16(ifd)?).min(256);
    for index in 0..count {
        let entry = ifd.checked_add(2)?.checked_add(index.checked_mul(12)?)?;
        if read_u16(entry)? == 0x0112 && read_u16(entry + 2)? == 3 && read_u32(entry + 4)? == 1 {
            return read_u16(entry + 8).filter(|value| (1..=8).contains(value));
        }
    }
    None
}

fn apply_exif_orientation(image: DynamicImage, orientation: Option<u16>) -> DynamicImage {
    match orientation.unwrap_or(1) {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.fliph().rotate270(),
        6 => image.rotate90(),
        7 => image.fliph().rotate90(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn ocr_markdown(
    engine: &mut OcrEngine,
    image: &DynamicImage,
    location: &str,
    warnings: &mut Vec<Warning>,
) -> Result<String, String> {
    let (width, height) = image.dimensions();
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("DOCUMENT_RESOURCE_LIMIT".into());
    }
    let lines = engine.recognize(image)?;
    if lines.is_empty() {
        warnings.push(Warning {
            code: "DOCUMENT_OCR_NO_TEXT".into(),
            location: Some(location.to_owned()),
            message: "OCR found no reliable text.".into(),
        });
        return Ok(String::new());
    }
    let mut markdown = String::new();
    for line in lines {
        if line.confidence < 0.45 {
            warnings.push(Warning {
                code: "DOCUMENT_OCR_LOW_CONFIDENCE".into(),
                location: Some(location.to_owned()),
                message: "Some OCR text has low recognition confidence.".into(),
            });
        }
        markdown.push_str(&line.text);
        markdown.push('\n');
    }
    Ok(markdown)
}

fn safe_asset_extension(asset: &Asset) -> Option<&'static str> {
    match asset.media_type.to_ascii_lowercase().as_str() {
        "image/png" if asset.bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("png"),
        "image/jpeg" if asset.bytes.starts_with(b"\xff\xd8\xff") => Some("jpg"),
        "image/webp"
            if asset.bytes.starts_with(b"RIFF") && asset.bytes.get(8..12) == Some(b"WEBP") =>
        {
            Some("webp")
        }
        _ => None,
    }
}

fn warning_summary(warnings: &[Warning]) -> String {
    let mut summary =
        String::from("> [!WARNING]\n> This conversion completed with recoverable omissions:\n");
    for warning in warnings.iter().take(20) {
        summary.push_str("> - ");
        if let Some(location) = &warning.location {
            summary.push_str(location);
            summary.push_str(": ");
        }
        summary.push_str(&warning.message.replace(['\r', '\n'], " "));
        summary.push('\n');
    }
    summary.push('\n');
    summary
}

fn validate_private_paths(input: &Path, staging: &Path) -> Result<(), String> {
    for (path, directory) in [(input, false), (staging, true)] {
        let metadata =
            fs::symlink_metadata(path).map_err(|_| "DOCUMENT_PRIVATE_PATH_INVALID".to_string())?;
        if metadata.file_type().is_symlink()
            || (directory && !metadata.is_dir())
            || (!directory && !metadata.is_file())
        {
            return Err("DOCUMENT_PRIVATE_PATH_INVALID".into());
        }
    }
    let mut entries =
        fs::read_dir(staging).map_err(|_| "DOCUMENT_PRIVATE_PATH_INVALID".to_string())?;
    if let Some(entry) = entries.next() {
        let entry = entry.map_err(|_| "DOCUMENT_PRIVATE_PATH_INVALID".to_string())?;
        let metadata = entry
            .metadata()
            .map_err(|_| "DOCUMENT_PRIVATE_PATH_INVALID".to_string())?;
        if entry.file_name() != ".myagents-owner"
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != 32
            || entries.next().is_some()
        {
            return Err("DOCUMENT_STAGING_NOT_EMPTY".into());
        }
    }
    Ok(())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let metadata = fs::symlink_metadata(parent)
            .map_err(|_| "DOCUMENT_STAGING_WRITE_FAILED".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("DOCUMENT_STAGING_WRITE_FAILED".into());
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "DOCUMENT_STAGING_WRITE_FAILED".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "DOCUMENT_STAGING_WRITE_FAILED".to_string())
}

fn validate_markdown_assets(markdown: &str, staging: &Path) -> Result<u32, String> {
    let mut referenced = HashSet::new();
    for segment in markdown.split("](").skip(1) {
        let Some(target) = segment.split(')').next() else {
            continue;
        };
        if !target.starts_with("assets/") {
            continue;
        }
        let path = Path::new(target);
        if path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("DOCUMENT_ARTIFACT_INVALID".into());
        }
        let full = staging.join(path);
        let metadata =
            fs::symlink_metadata(&full).map_err(|_| "DOCUMENT_ARTIFACT_INVALID".to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("DOCUMENT_ARTIFACT_INVALID".into());
        }
        referenced.insert(full);
    }
    let assets = staging.join("assets");
    if assets.is_dir() {
        for entry in fs::read_dir(&assets).map_err(|_| "DOCUMENT_ARTIFACT_INVALID".to_string())? {
            let path = entry
                .map_err(|_| "DOCUMENT_ARTIFACT_INVALID".to_string())?
                .path();
            if !referenced.contains(&path) {
                return Err("DOCUMENT_ARTIFACT_INVALID".into());
            }
        }
    }
    u32::try_from(referenced.len()).map_err(|_| "DOCUMENT_ARTIFACT_INVALID".to_string())
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut pending = vec![PathBuf::from(path)];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(directory).map_err(|_| "DOCUMENT_STAGING_READ_FAILED".to_string())?
        {
            let entry = entry.map_err(|_| "DOCUMENT_STAGING_READ_FAILED".to_string())?;
            if entry.path() == path.join(".myagents-owner") {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|_| "DOCUMENT_STAGING_READ_FAILED".to_string())?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("DOCUMENT_CANCELLED".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_format_matrix_rejects_unsupported_schemes_before_password_guessing() {
        for extension in [
            "xls", "ppt", "pps", "pot", "odt", "ods", "odp", "rtf", "epub",
        ] {
            assert!(encryption_scheme_is_unsupported(extension));
        }
        for extension in [
            "doc", "docx", "docm", "xlsx", "xlsm", "xlsb", "pptx", "pptm",
        ] {
            assert!(!encryption_scheme_is_unsupported(extension));
        }
    }

    #[test]
    fn decrypted_payload_signature_separates_wrong_password_from_inner_corruption() {
        assert!(decrypted_payload_matches_format(
            b"PK\x03\x04fixture",
            Format::Docx
        ));
        assert!(decrypted_payload_matches_format(
            b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1fixture",
            Format::Doc,
        ));
        assert!(!decrypted_payload_matches_format(
            b"random plaintext",
            Format::Docx
        ));
    }

    #[test]
    fn legacy_doc_password_and_structure_errors_have_distinct_public_codes() {
        fn map(error: office_crypto::DecryptError) -> &'static str {
            match error {
                office_crypto::DecryptError::InvalidPassword => "DOCUMENT_PASSWORD_INVALID",
                office_crypto::DecryptError::InvalidStructure => "DOCUMENT_MALFORMED",
                _ => "fixture-unrelated",
            }
        }

        assert_eq!(
            map(office_crypto::DecryptError::InvalidPassword),
            "DOCUMENT_PASSWORD_INVALID"
        );
        assert_eq!(
            map(office_crypto::DecryptError::InvalidStructure),
            "DOCUMENT_MALFORMED"
        );
    }

    #[test]
    fn anydoc_error_variants_map_to_stable_public_codes() {
        assert_eq!(
            map_anydoc_error(anydoc::ConvertError::Encrypted),
            "DOCUMENT_PASSWORD_REQUIRED"
        );
        assert_eq!(
            map_anydoc_error(anydoc::ConvertError::ResourceLimit {
                limit: "fixture",
                detail: "fixture".into(),
            }),
            "DOCUMENT_RESOURCE_LIMIT"
        );
        assert_eq!(
            map_anydoc_error(anydoc::ConvertError::Malformed {
                part: None,
                detail: "fixture".into(),
            }),
            "DOCUMENT_MALFORMED"
        );
        assert_eq!(
            map_anydoc_error(anydoc::ConvertError::Unsupported("fixture".into())),
            "DOCUMENT_UNSUPPORTED_FORMAT"
        );
    }

    #[test]
    fn pdf_inspector_page_adapter_is_explicitly_zero_based() {
        assert!(pdf_page_index_matches(0, 0));
        assert!(pdf_page_index_matches(1, 1));
        assert!(!pdf_page_index_matches(1, 0));
        assert!(!pdf_page_index_matches(0, 1));
    }

    #[test]
    fn unsafe_assets_are_not_published() {
        let svg = Asset {
            id: anydoc::model::AssetId(0),
            media_type: "image/svg+xml".into(),
            origin_part: "x".into(),
            bytes: b"<svg/>".to_vec(),
        };
        assert_eq!(safe_asset_extension(&svg), None);
    }

    #[test]
    fn structured_csv_uses_the_anydoc_fast_path_without_ocr_resources() {
        let staging = tempfile::tempdir().unwrap();
        let mut warnings = Vec::new();
        let (markdown, pages, ocr_pages) = convert_anydoc(
            b"name,value\nalpha,42\n",
            Format::Csv,
            staging.path(),
            &mut warnings,
        )
        .unwrap();
        assert!(markdown.contains("alpha"));
        assert!(markdown.contains("42"));
        assert_eq!((pages, ocr_pages), (0, 0));
        assert!(warnings.is_empty());
    }

    #[test]
    fn artifact_validation_counts_only_referenced_asset_files() {
        let staging = tempfile::tempdir().unwrap();
        let assets = staging.path().join("assets");
        fs::create_dir(&assets).unwrap();
        fs::write(assets.join("figure.png"), b"png").unwrap();

        assert_eq!(
            validate_markdown_assets("![figure](assets/figure.png)", staging.path()).unwrap(),
            1,
        );
        fs::write(assets.join("orphan.png"), b"png").unwrap();
        assert_eq!(
            validate_markdown_assets("![figure](assets/figure.png)", staging.path()).unwrap_err(),
            "DOCUMENT_ARTIFACT_INVALID",
        );
    }
}
