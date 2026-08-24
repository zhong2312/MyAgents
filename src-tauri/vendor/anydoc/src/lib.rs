//! anydoc converts documents to GitHub-Flavored Markdown.
//!
//! Recovery and skipped-content events from [`to_markdown_bundle`] are
//! returned as typed [`Diagnostic`] values. They may also be mirrored through
//! the [`log`] facade for debugging, but log text is never a product API.

#![warn(missing_docs)]

macro_rules! recovery_warn {
    ($code:expr, $location:expr, $($arg:tt)*) => {{
        let message = format!($($arg)*);
        log::warn!("{}", message);
        crate::diagnostics::emit($code, $location, message);
    }};
}

pub mod model;

mod diagnostics;
mod error;
mod formats;
mod package;
mod render;
mod shared;

pub use error::ConvertError;

use render::markdown::{document_to_markdown, document_to_markdown_with_asset_paths};

use std::collections::HashMap;
use std::path::Path;

/// A Markdown document plus the embedded assets referenced by that Markdown.
#[derive(Debug, Clone)]
pub struct MarkdownBundle {
    /// GitHub-Flavored Markdown with safe caller-provided relative asset paths.
    pub markdown: String,
    /// Embedded assets retained by the parsed document model.
    pub assets: Vec<model::Asset>,
    /// Typed recoveries and omissions observed while parsing the document.
    pub diagnostics: Vec<Diagnostic>,
}

/// One recoverable parser omission with a stable code and best available location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// Stable machine-readable recovery identity.
    pub code: String,
    /// Source part, page, slide, sheet, chapter, or other local position when known.
    pub location: Option<String>,
    /// Bounded human-readable explanation without source content.
    pub message: String,
}

/// Input format. Selects the parser; container variants that share a parser
/// (docm, xlsm, ...) map onto these via [`Format::from_bytes`] or
/// [`Format::from_extension`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// Binary Word 97-2003 (`.doc`).
    Doc,
    /// WordprocessingML (`.docx`, `.docm`), both Transitional and Strict.
    Docx,
    /// OpenDocument Text (`.odt`).
    Odt,
    /// Converted with [pdf-inspector], which emits Markdown directly:
    /// [`to_document`] is unsupported for PDFs. Scanned/image-only PDFs
    /// (needing OCR) error as unsupported.
    ///
    /// [pdf-inspector]: https://github.com/firecrawl/pdf-inspector
    Pdf,
    /// Binary PowerPoint 97-2003 (`.ppt`, `.pps`, `.pot`).
    Ppt,
    /// PresentationML (`.pptx`, `.pptm`, `.ppsx`, `.ppsm`).
    Pptx,
    /// Rich Text Format (`.rtf`).
    Rtf,
    /// EPUB 2 and 3 (`.epub`).
    Epub,
    /// Excel workbooks in every container calamine reads: `.xlsx`, `.xlsm`,
    /// `.xlsb`, and binary `.xls`.
    Excel,
    /// OpenDocument Spreadsheet (`.ods`).
    Ods,
    /// OpenDocument Presentation (`.odp`).
    Odp,
    /// Delimiter-separated text (`.csv`). Carries no signature, so it has to
    /// be named rather than detected.
    Csv,
}

impl Format {
    /// Detect the format from the content itself: the signature and identity
    /// each container specification designates (PDF header, RTF open group,
    /// OLE stream names, ZIP package mimetype/content types). Plain-text
    /// formats (CSV) carry no signature and return `None`; so does anything
    /// unrecognized.
    pub fn from_bytes(bytes: &[u8]) -> Option<Format> {
        formats::detect::from_bytes(bytes)
    }

    /// The format a bare extension names (no leading dot), matched
    /// case-insensitively. `None` for anything unrecognized.
    pub fn from_extension(ext: &str) -> Option<Format> {
        Some(match ext.to_ascii_lowercase().as_str() {
            "doc" => Format::Doc,
            "docx" | "docm" => Format::Docx,
            "odt" => Format::Odt,
            "pdf" => Format::Pdf,
            "pptx" | "pptm" | "ppsx" | "ppsm" => Format::Pptx,
            "ppt" | "pps" | "pot" => Format::Ppt,
            "rtf" => Format::Rtf,
            "epub" => Format::Epub,
            "xlsx" | "xlsm" | "xlsb" | "xls" => Format::Excel,
            "ods" => Format::Ods,
            "odp" => Format::Odp,
            "csv" => Format::Csv,
            _ => return None,
        })
    }

    /// The format a path's extension names. `None` when the path has no
    /// extension or names nothing recognized.
    pub fn from_path(path: &Path) -> Option<Format> {
        path.extension()
            .and_then(|e| e.to_str())
            .and_then(Format::from_extension)
    }
}

/// Convert a document file to Markdown. The format is detected from the
/// file content ([`Format::from_bytes`]); the extension is the fallback for
/// signature-less formats (CSV) and unrecognizable containers.
pub fn to_markdown(path: impl AsRef<Path>) -> Result<String, ConvertError> {
    let path = path.as_ref();
    let bytes = std::fs::read(path)?;
    let Some(format) = Format::from_bytes(&bytes).or_else(|| Format::from_path(path)) else {
        return Err(ConvertError::Unsupported(format!(
            "unrecognized file content and extension: {}",
            path.display()
        )));
    };
    to_markdown_bytes(&bytes, format)
}

/// Convert an in-memory document to Markdown. Pass a [`Format`] to select the
/// parser, or `None` to detect it from the content ([`Format::from_bytes`]),
/// which signature-less formats (CSV) have to name explicitly.
pub fn to_markdown_bytes(
    bytes: &[u8],
    format: impl Into<Option<Format>>,
) -> Result<String, ConvertError> {
    let format = resolve_format(bytes, format.into())?;
    // PDFs convert to Markdown directly (pdf-inspector) without passing
    // through the document model.
    if format == Format::Pdf {
        return formats::pdf::to_markdown(bytes);
    }
    Ok(document_to_markdown(&to_document(bytes, format)?))
}

/// Parse an in-memory document into the document model. Pass a [`Format`] to
/// select the parser, or `None` to detect it from the content.
///
/// Unsupported for [`Format::Pdf`]: PDF conversion produces Markdown
/// directly and has no document-model form; use [`to_markdown_bytes`].
pub fn to_document(
    bytes: &[u8],
    format: impl Into<Option<Format>>,
) -> Result<model::Document, ConvertError> {
    formats::parse(bytes, resolve_format(bytes, format.into())?)
}

/// Parse and render a non-PDF document while preserving embedded assets.
///
/// `asset_path` is invoked only for assets present in the parsed model. The
/// caller owns filename/MIME validation and must return artifact-relative
/// paths. PDF continues to use pdf-inspector's page-aware route.
pub fn to_markdown_bundle(
    bytes: &[u8],
    format: impl Into<Option<Format>>,
    mut asset_path: impl FnMut(&model::Asset) -> Option<String>,
) -> Result<MarkdownBundle, ConvertError> {
    let format = resolve_format(bytes, format.into())?;
    if format == Format::Pdf {
        return Err(ConvertError::Unsupported(
            "PDF requires the page-aware extraction route".into(),
        ));
    }
    diagnostics::clear();
    let document = to_document(bytes, format);
    let document = match document {
        Ok(document) => document,
        Err(error) => {
            let _ = diagnostics::take();
            return Err(error);
        }
    };
    let paths = document
        .assets
        .iter()
        .filter_map(|asset| asset_path(asset).map(|path| (asset.id, path)))
        .collect::<HashMap<_, _>>();
    let markdown = document_to_markdown_with_asset_paths(&document, paths);
    let diagnostics = diagnostics::take();
    Ok(MarkdownBundle {
        markdown,
        assets: document.assets,
        diagnostics,
    })
}

fn resolve_format(bytes: &[u8], format: Option<Format>) -> Result<Format, ConvertError> {
    format.or_else(|| Format::from_bytes(bytes)).ok_or_else(|| {
        ConvertError::Unsupported("unrecognized file content: name the format explicitly".into())
    })
}
