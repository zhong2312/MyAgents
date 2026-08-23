# MyAgents document-processing notices

This resource bundle contains the MyAgents document Worker and the following redistributed components. The exact revision and file digest for a built target are recorded in `manifest.json`; archive authorities are locked in `resource-lock.json`.

- AnyDoc 0.1.9, MIT, commit `e754e1d33a1a540ebc9226e36f11d3f401852c9e`, with the MyAgents embedded-asset serialization patch. Its MIT license is retained at `src-tauri/vendor/anydoc/LICENSE`.
- pdf-inspector 1.14.2, MIT, commit `4bee4f993ba28bd6a3334fa55e699b318663fba3`.
- office-crypto 0.3.0, MIT, commit `cddfc4832b80a170d07c68f404ef61bb4c7cc9ad`, with the MyAgents typed legacy-DOC password-verifier error patch. Its MIT license is retained at `src-tauri/vendor/office-crypto/LICENSE`.
- ort 2.0.0-rc.13, MIT OR Apache-2.0.
- ONNX Runtime 1.28.0 CPU, MIT, commit `da9b5e364c465de65c49d91e696cd6485270757f`.
- pdfium-render 0.9.3, MIT OR Apache-2.0.
- PDFium binary revision `chromium/7999`, BSD-style plus Chromium third-party notices, release repository commit `b9132659ca171211a8b7a996e0e4df2d317961ad`.
- PaddlePaddle PP-OCRv6 Small detector and recognizer ONNX models and the PP-OCRv6 multilingual dictionary, Apache-2.0. Exact Hugging Face and PaddleOCR revisions are recorded in `resource-lock.json`.

The Cargo dependency license inventory and the upstream PDFium/Chromium third-party notice inventory must be included in release SBOM/license output. No component is downloaded at application runtime.
