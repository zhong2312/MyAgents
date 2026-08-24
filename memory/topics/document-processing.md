# AnyDoc local document processing

## Current state

- Authority PRD: `specs/prd/prd_0.4.9_local-document-conversion-ocr.md`; status remains `in-progress`.
- Core implementation was committed as `3f7909e2`; the deep-test ownership/diagnostic follow-up was committed as `1a57b6cd` (`fix(anydoc): harden diagnostics and artifact output`).
- The full reproducible black-box corpus lives outside the repository at `/Users/zhihu/Downloads/test`. Start with `README.md` and `reports/anydoc-deep-test-report.md`; generators, expected manifests, converted artifacts, job records and five suite reports are retained there.
- The report describes dev/0.4.9 on macOS arm64 with AnyDoc `0.1.9+myagents-assets.1`, PP-OCRv6 Small and ONNX Runtime 1.28.0. It is pre-`1a57b6cd` evidence for the logging/artifact-display findings, so those findings must be reconciled against the fix rather than treated as still open.

## Deep-test evidence (2026-08-15)

- Coverage: PDF, PNG, JPEG, WebP, DOCX, XLSX, PPTX, ODT, ODS, ODP, CSV, RTF and EPUB; 33 accepted jobs, 26 content/format truth samples and 7 real user samples.
- Outcomes: 26 succeeded, 3 succeeded with warnings, 2 expected failures and 2 explicit cancellations. Strict truth assertions were 20 PASS / 6 FAIL; all 7 real samples produced artifacts, 5 were usable and 2 had deterministic content errors.
- Async ownership and atomicity were strong: CLI interruption did not cancel app-owned work, explicit cancel converged idempotently, failed/cancelled jobs published no public artifact, and no staging/partial residue was found.
- Confirmed content-quality gaps: 90° OCR silently garbled; scanned-table reading order could attach amounts to the wrong row; native PDF URLs, amounts and soft hyphens could be semantically damaged; DOCX heading hierarchy was flattened; XLSX formula/display formatting and several block/list structures degraded.

## Performance contract and observed range

Always report both metrics:

- **Worker duration** measures conversion-engine work.
- **Job end-to-end** measures `createdAt → finishedAt`, including queue, IPC, publish and polling. A shared single-concurrency worker can add cross-suite queue time, so this is product latency, not a pure engine benchmark.

Observed range:

- ODT/ODS/ODP: 4–8 ms worker, 286–308 ms end-to-end.
- Small Office/CSV/RTF/EPUB: 9–21 ms worker, 305–323 ms end-to-end.
- 10,001 × 48 XLSX: 827 ms worker, 1.20 s end-to-end, no truncation.
- 88-page native PDF: 335 ms worker, 716 ms end-to-end (~263 pages/s worker throughput).
- Ordinary one-page OCR: roughly 0.9–2.6 s worker; clear scanned table 5.46 s; mixed three-page PDF 6.32 s; degraded three-page PDF 9.08 s; 36 MP PNG 19.48 s.

Speed is not the leading release blocker; semantic fidelity and non-silent warnings are.

## Responsibility decision and remaining gates

The user explicitly scoped the 2026-08-15 follow-up to owner/diagnostic truth and deferred pure OCR/parser/layout quality to dependency-module upgrades. `1a57b6cd` therefore fixed only:

- safe semantic projection at SSE/Codex/external-runtime logging boundaries;
- CLI artifact display based on `artifactAvailable` and terminal-stage presentation;
- app-owned DocumentProcessingManager lifecycle diagnostics with no path/content/password fields.

Do not silently broaden a future ownership fix into a local parser fork. When dependencies are upgraded, rerun this retained golden corpus and prioritize rotation/low-confidence warnings, table order, PDF URL/soft-hyphen behavior, DOCX headings and XLSX display semantics.

The PRD cannot be marked implemented until its remaining release gates are proven: five signed/installed targets with offline native inference and process-tree cancellation, resource/pressure limits, fresh Skill discovery across Builtin/Claude Code/Codex/Gemini, and installed 0.4.9 CLI smoke. Local ARM64 success is not a substitute.
