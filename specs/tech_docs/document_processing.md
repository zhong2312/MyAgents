# 本地文档转换与端侧 OCR 架构

本文是 `myagents anydoc` 当前实现的模块规范。产品范围与验收目标见 PRD 0.4.9；本文件只维护 owner、状态机、协议、资源、限制、安全不变量和排查路径。若数值或字段与代码冲突，以 `src-tauri/src/document_processing.rs`、`src-tauri/document-worker/`、CLI exact help 和测试为准，并同步修正文档。

## 定位与边界

AnyDoc 是统一的“本地文件转 Markdown”能力，OCR 只是扫描 PDF 与图片的 fallback。支持 Office/OpenDocument/RTF/EPUB/CSV、PDF、PNG/JPEG/WebP；不接 URL、stdin、目录、多文件批量、GPT/云 OCR、VLM、知识库索引、GUI 或 PDF Viewer 文本层。

公开入口只有：

```text
myagents anydoc convert --file <input> [--output <directory>] [--password <password>] [--wait] [--json]
myagents anydoc status <job-id> [--json]
myagents anydoc wait <job-id> [--json]
myagents anydoc cancel <job-id> [--json]
myagents anydoc list [--limit <1..100>] [--json]
```

不存在 `inspect`、`readme`、同步 backend、结果内联或分页协议。所有 backend conversion 都是异步 job；`wait` 只在 CLI 进程内轮询短 `status` 请求。

## Owner 与调用链

```text
myagents CLI bundle
  -> current Sidecar /api/admin/anydoc/*
  -> Rust loopback Management API /api/document/*
  -> App-global DocumentProcessingManager
  -> one-job myagents-document-worker (ChildTree)
  -> AnyDoc / pdf-inspector / PDFium / PP-OCRv6 Small
```

- CLI：参数语法、lexical absolute path、human/JSON 输出、wait polling 和退出码；不拥有 workspace 或 job。
- Sidecar Admin API：注入当前 Sidecar 的 authoritative Workspace（仅默认输出需要），薄转发并保留结构化错误；不解析文档。
- `DocumentProcessingManager`：queue、job store、active generation、资源 admission、source handle、取消、timeout、App shutdown、原子发布的唯一 owner。
- Worker：只拥有当前 job 的 parser/OCR effective runtime state 和 staging 写入；不监听端口、不持久化、不重试、不接网络。
- required system Skill `myagents-anydoc`：WHEN TO USE 与工作流说明；不执行转换、不保存状态。`myagents-cli` 只保留薄索引。

AnyDoc 不属于 Session，因此关闭 Tab、切 Runtime 或 CLI 退出不会取消 job；App 退出会统一收敛所有 queued/running job。

## Job identity、状态与持久化

Job ID 为本地日期加 12 位小写十六进制随机值：

```text
YYYYMMDD_<12 lowercase hex>
```

公开输出固定为：

```text
<output-root>/<job-id>/
  document.md
  assets/               # 仅实际被 Markdown 引用时存在
```

Manager 在输出根先创建 `.myagents-anydoc-<job-id>.staging`；只有 Worker 成功、artifact 校验通过、job/generation 仍是 active owner 且输出根 directory identity 未变化时，才同卷 rename 为公开 job 目录。rename 前先在私有 job 目录 crash-durable 写入 `publish-intent.json`；owner marker 随 staging 一起进入公开目录，输出根 directory sync 与 terminal `job.json` durable 后才移除 marker，marker 删除也 sync 后才清 intent。启动恢复因此能区分并完成已提交 success，或清理未提交的 authenticated public directory 后把非终态 job 收敛为 `interrupted`。一旦 durable job 是 success，终态不可逆：authenticated staging 会完成 no-replace publish；用户随后删除或修改 artifact 只改变查询时派生的 `artifactAvailable`，不会倒写 history 或移动用户目录。失败、取消、超时、crash、identity drift 均清理 staging，不发布 `conversion.json`、输入副本、解密副本、页图或 OCR crop。

状态机：

```text
queued -> running -> succeeded | succeeded_with_warnings | failed
   |          |
   |          -> cancelling -> cancelled
   -> cancelled

queued/running/cancelling --App restart/shutdown--> interrupted
```

`succeeded_with_warnings` 是带可用 artifact 的成功。`status/list` 查询成功时退出 0，即使所查 job 已失败；`wait` 对 failed/cancelled/interrupted 退出 1。Ctrl-C wait 退出 130，job 继续运行。

持久 metadata 位于 MyAgents data root 的 `document-processing/jobs/<job-id>/job.json`，可包含 source/output path、格式、大小/hash、timestamps、warning/error、metrics 和 pipeline provenance；不得包含密码、正文、资产、解密数据或 OCR crop。同目录的 `publish-intent.json` 只是 Manager-owned 两阶段发布恢复记录，不是第二份 job 状态源：它只保存 job/path/token identity；任何 metadata write 的未知结果都保留 intent，直到 terminal authority 与 artifact 结果明确且相关目录 mutation 已 sync 才删除。非终态记录在下次启动统一转 `interrupted`，不自动重放；已 durable 的终态不可逆。终态 metadata 可见期 30 天；过期清理 metadata，不删除已经发布到用户输出根的 artifact。

## Queue 与 Worker lifecycle

- 全 App FIFO 上限 16（running 计入），首版并发固定为 1。
- admission 打开 source 的 no-follow regular-file handle；queued job 持有该 handle，避免 path 后续被替换成别的文件。
- running 首先把 held source 分块复制到私有 `input/source.bin` 并计算 SHA-256；每块检查 cancellation/deadline，实际字节数以及复制前后的 size、mtime/ctime（Windows 为 last-write time）必须与 admission metadata 一致。即使同一 inode 被等长改写也 fail closed 为 `DOCUMENT_SOURCE_CHANGED`。
- Worker 使用 `process_cmd::new()` + `spawn_tree()`；环境清空，stdin/stdout 仅承载私有协议，stderr 不进入用户错误。
- job deadline 从 source admission copy 开始计 30 分钟。cancel 先持久化 `cancelling`，再发送 exact `(jobId,generation)` frame，2 秒仍运行才 kill retained `ChildTree`；cancel、timeout 与成功发布在同一 Manager lock 内裁决，发布 IO 后、写入成功终态前再次以 monotonic deadline 确定逻辑 commit time，超时不能因 watchdog 等锁而赢得成功。
- App shutdown 先关闭 admission，把所有非终态持久化为 `interrupted`，释放 queued handle，随后取消/终止 retained Worker tree。
- Worker crash 不自动重试；当前 job 失败为 `DOCUMENT_WORKER_CRASHED`，用户显式重试会创建新 ID。

## 私有 framed protocol

Manager 与 Worker 使用 4-byte big-endian payload length + UTF-8 JSON；单 frame 最大 1 MiB。第一帧必须为 `start`，后续 Manager 只能发 `cancel`。Worker 必须依次发送一个 `ready`、零到多个 `progress`，以及恰好一个 `completed` 或 `failed`，之后 clean EOF。

每帧都有 `protocolVersion`，所有响应都有 `jobId` 与 `workerGeneration`。Manager 只接受 exact identity 和固定 stage；`current/total/unit` 要么同时存在且是有效真实单位，要么全部省略，不传假百分比。旧 generation、畸形 JSON、空/超限 frame、截断 prefix/payload、ready 前 progress、重复 ready、重复终态、终态后消息或字段 shape 错误都返回 `DOCUMENT_WORKER_PROTOCOL_ERROR`；Worker 未给合法终态即退出才返回 `DOCUMENT_WORKER_CRASHED`。clean EOF 只有在一个 prefix byte 都没读到时成立。

密码不进入 Worker argv、环境变量、job store、日志或 recovery command。它只出现在 CLI argv（用户已接受其 shell history/process-list 风险）、Sidecar/Rust 请求内存和 start frame；Rust secret wrapper Drop zeroize，Manager 写完 IPC 立即清除自己的副本，发送与接收 JSON buffer 写完/解析完立即 zeroize。恢复命令只使用 `<password>` 占位符。

## 转换 pipeline

### 结构化文档 fast path

AnyDoc 0.1.9 源码以精确上游版本 vendored，MyAgents patch 只增加 typed recovery diagnostic 与 opt-in asset serialization：parser 生成 `Document` 后，由 caller 给安全 asset 分配相对路径，renderer 才写 `![alt](assets/...)`。Worker 对资产做 MIME + magic sniff，只发布 PNG/JPEG/WebP passive raster；SVG、HTML、OLE、executable、外部 payload、未引用资产均不写出并产生 warning。被省略的内嵌资产会在原文位置留下 `**[Embedded asset omitted]**`，同时在顶部 warning summary 汇总。

AnyDoc 的 recoverable 分支直接产生 typed `{code, message, location}` diagnostic；日志只供本地排查，不作为产品 warning 数据源。能定位的恢复项还必须占据原内容位置，例如不可读 PPTX slide 在对应 slide 顺序插入可见 warning placeholder；Worker 再于文首汇总同一 typed diagnostics。CSV 等结构化格式不加载 OCR native runtime。

加密 OOXML/legacy Office 由精确 vendored 的 `office-crypto 0.3.0` 在 Worker 内解密；MyAgents 的窄 patch 只把 legacy DOC verifier 的密码校验失败提升为独立 `InvalidPassword`，其余 `InvalidStructure` 继续映射 `DOCUMENT_MALFORMED`。解密 bytes 只存在内存；缺密码、错误密码和不支持 scheme 分别返回稳定错误，损坏文件不得默认映射成密码错误。

### PDF 逐页 routing

未加密 PDF 先由 `pdf-inspector 1.14.2` 输出逐页 native Markdown 和 `needs_ocr`。页码 adapter 显式按 0-based source index 校验 coverage；只有 `needs_ocr` 页由 PDFium `chromium/7999` 渲染后 OCR，再按原页顺序组合并保留 `## Page N` 边界。不得用字符数另造 routing，也不得对混合 PDF 全文 OCR。

PDF 始终先由 `pdf-inspector` 区分损坏与加密；传入密码不会把损坏 PDF 错判为密码错误。确认加密后才用 transient password 由 PDFium 打开，首版对加密 PDF 所有页 render + OCR；未加密 PDF 即使多传了密码仍走原生逐页 routing。PDFium 只从 manifest 的绝对库路径加载；系统库与 PATH 不参与 fallback。

### 图片与 OCR

图片按内容 sniff 解码 PNG/JPEG/WebP，扩展不一致产生 warning；JPEG EXIF orientation 在 OCR 前归一。单图/单 PDF render 超过像素上限即失败。

OCR 固定为 PP-OCRv6 Small detector + recognizer，CPU-only ONNX Runtime 1.28：

| 资源 | 固定 revision / digest |
|---|---|
| detector | HF `28fe5895c24fd108c19eb3e8479f4ab385fbfc62`; SHA-256 `d73e0058...c9410e` |
| recognizer | HF `b8f84f0b80c529de40b4fbb3544b84fa7233a513`; SHA-256 `5435fd74...24634` |
| PP-OCRv6 dictionary | PaddleOCR `b03f46425e8ff4442b268ce449e3eef758146cd4`; 18,708 行；SHA-256 `b5f2bfe2...01c5d` |

Adapter 负责 detector resize/normalize、DB bitmap/box filtering、crop/order、recognizer dynamic width/normalize、CTC collapse、space class 与 confidence。任何模型 shape/class mismatch fail closed。正式发布必须用相同 revision 的官方 PaddleOCR pipeline 作为 oracle 跑 golden corpus；模型能加载不等于 OCR 正确。

## 固定资源限制

| 边界 | 当前值 |
|---|---:|
| queue（含 running） | 16 jobs |
| source bytes | 512 MiB |
| PDF pages | 500 |
| decoded image pixels | 100,000,000 |
| Markdown bytes | 128 MiB |
| Markdown characters | 5,000,000 |
| protocol frame | 1 MiB |
| job deadline | 30 min |
| history | 30 days，list 单次 1..100 |
| detector min / max side | 736 / 4000 px（32 对齐） |
| recognizer width | min 320 / max 3200 at height 48 |
| OCR text boxes | 3000 |
| output volume preflight | 128 MiB + 256 MiB reserve |
| private volume preflight | source bytes + 256 MiB reserve |

AnyDoc 自身 package entry、展开与 asset hard cap 继续生效。上限不是设置项或环境变量；修改必须有压力/性能证据并同步代码、help、测试和本文。

## 路径与 artifact 安全

- CLI 仅做 cwd-relative lexical absolute resolution；Rust 才是 regular-file、链接、大小、权限、identity 与持久化 authority。
- source/output 必须是绝对直达路径，拒绝 `.`、`..`、symlink 和 Windows reparse point 祖先；source 用 no-follow handle。
- `--output` 是目录。像 `report.md` 的已知文档扩展 leaf 直接返回 `DOCUMENT_OUTPUT_NOT_DIRECTORY`，说明工具会自己创建 `<job-id>/document.md` 并给出目录形式恢复命令。
- output root 创建后再次走完整 link/reparse 检查并 canonicalize；job 持有 directory identity，publish 前复核，阻止 root swap。
- staging 目录同时持有 directory handle、公开 marker 与 App 私有 token；publish 把 marker 随目录做 no-replace rename，再从目标路径重开并对照 retained handle；输出根 rename 必须 directory-sync，terminal `job.json` 必须 file+parent-dir durable，marker 删除必须 destination-dir sync，最后才 durable 删除 crash-recovery intent。任一 substitution 都把非预期目标移出公开路径并 fail closed。cleanup 先把 staging 原子移到随机隐藏 quarantine，重新核对 inode/token 后才递归删除，避免 validate-delete 路径替换。Linux 使用 `renameat2(RENAME_NOREPLACE)`，macOS 使用 `renamex_np(RENAME_EXCL)`，Windows 显式使用不带 replace flag 的 `MoveFileExW`；竞争者先创建空目录、非空目录或文件都不能被覆盖。终态 metadata 写盘未知或 deadline 在 publish 后到达时优先回滚公开 rename但保留 intent；若进程在提交窗口退出，启动恢复完成已 durable 的 success，或清理未提交的 authenticated public path 后恢复为 `interrupted`。durable success 不因 artifact 后续缺失/修改而回退。启动时也会重试终态遗留的私有 input/staging 清理。
- staging 文件一律 `create_new`；Markdown 中只接受 `assets/<normal-component>` 相对引用，引用必须存在且为普通非链接文件，assets 目录不得含未引用文件。
- Worker 只看到 Manager 私有输入和当前 staging，不具备 URL/network surface。

## 随包资源与构建

权威供应链锁为 `src-tauri/document-worker/resource-lock.json`，唯一 prepare owner 为 `scripts/prepare-document-processing.mjs`。`setup.sh`、`setup_windows.ps1`、macOS/Windows dev build、三平台 release build 与 `npm run tauri:dev` 都只能调用该 owner，不得各自实现下载、展开、Worker 构建或签名逻辑。

prepare owner 把生命周期分成三层：

- `src-tauri/resources/document-processing-cache/downloads/` 是按锁定 digest 内容寻址的原始下载缓存；每次命中仍校验 regular file、size 与 SHA，损坏文件不得命中。旧版 `src-tauri/target/document-processing-cache` 中的有效原始文件仅作为一次性迁移源。
- `.../prepared/<target>/<build-fingerprint>/` 是完整的已验证 bundle 缓存。fingerprint 覆盖 App 版本、target、resource lock、prepare/helper 源码、Worker/AnyDoc/office-crypto 源码与 Cargo lock、固定 Rust toolchain identity 和签名 identity/配置；只有这些输入完全相同时才能复用，因此版本发布或任一构建输入变化都会生成新 bundle，完全相同版本的 warm build 才不重复下载、展开、Worker build 或签名。
- `src-tauri/resources/document-processing/v1` 只是当前 Tauri build 要快照的投影，不是缓存 authority。prepare 在仓库级跨进程锁内使用唯一 work/staging，完整校验 manifest 与所有 artifact 后才切换投影；切换失败会恢复上一份有效投影。

持久缓存不入 Git，也不在 `npm run clean`/Cargo `target` 生命周期内；这是刻意的 repo-local derived cache，不读取用户级模型 cache，也不会随 App 打包。可用 `--offline` 验证全离线路径，缓存缺项时 fail closed；`--force` 只用于显式重建当前 fingerprint。构建 Worker 使用 `cargo build --locked --release --target ...`。macOS 有 signing identity 时先 codesign native 文件和 Worker；Windows 同时提供 `WINDOWS_SIGNTOOL_PATH` 与 `WINDOWS_CERTIFICATE_SHA1` 时先做 Authenticode 签名与验证。manifest 最后按签名后的实际 bytes 生成，并记录 fingerprint、每个 artifact 的来源及 signing kind/identity。

正式目标：

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc`
- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`

ONNX Runtime 官方 1.28 release 未提供 macOS x64 binary，因此该 target 从精确 commit `da9b5e364c465de65c49d91e696cd6485270757f`、固定 recipe 构建 x86_64 shared library；其余 target 使用锁定官方 archive。该源码路径由 prepare owner 在 cache miss 后、任何文档资源网络/源码 mutation 前统一检查 Git、Python 3.8+、CMake 3.28+ 与 Apple Clang；`--check-prerequisites` 提供给平台 build 做早期只读预检。已有有效 prepared bundle 时不要求源码工具，脚本也不自动安装系统包。PDFium 全部使用 `chromium/7999` 锁定 archive。安装资源同时包含 AnyDoc/Paddle/ORT/PDFium license 与 PDFium 第三方 license tree；顶层 `THIRD_PARTY_NOTICES.md` 保留组件分类。

App 启动时 Manager 校验 manifest target/pipeline、Worker 可执行位和 Worker/native/model/dictionary 的 size + SHA；资源问题只让 document admission fail closed，不阻止 MyAgents UI 启动。Worker 启动后再次校验它实际要加载的五个资源。运行时不得下载、访问 Hugging Face 或使用用户 cache。

## Skill 与 help 防漂移

- `myagents-anydoc` 必须同时存在于 TS required set、Rust system bundle、workspace required mirror，并随 `SYSTEM_SKILLS_VERSION` 同步安装。
- 其 frontmatter description 承担相关意图发现；正文说明异步 workflow、安全和边界。
- `myagents-cli` frontmatter description 不得出现 AnyDoc；正文只含 AnyDoc 能力名、`myagents anydoc --help`、`/myagents-anydoc` 三个索引要素。
- `system-prompt-cli-tools.ts` 不增加 AnyDoc section/hint。
- exact group/leaf help 是当前 CLI 参数、输出、exit 和 recovery authority；没有 `readme` route。

## 验证与发布门槛

本地确定性检查至少包括 CLI/Admin/help/Skill parity、Manager path/protocol/state helper、Worker protocol/manifest/AnyDoc asset、OCR pre/postprocess、resource-lock/build staging、Rust fmt/clippy/test、TypeScript typecheck/lint 和 CLI/Tauri build。

发布前还必须在五个真实 target 的签名/安装包中完成：解包 manifest/hash/notices、断网启动、无系统 native runtime fallback、PDFium load/password/render、ONNX Runtime + PP-OCRv6 最小推理、混合 PDF coverage、真实 process-tree cancel、资源增量和 cold/warm 性能/RSS。OCR golden corpus需覆盖中英混排、表格/小字、旋转/透视、低清扫描、长图、EXIF、空白页和 adversarial input。未取得这些证据时只能称“本地实现/本机 smoke 通过”，不能称 0.4.9 可发布。

## 排查

先看 `~/.myagents/logs/unified-<本地日期>.log` 中 `[document]` 的非敏感 Manager 生命周期事件：`accepted / started / stage_changed / cancel_requested / terminal / recovered_terminal`。固定投影只含 job ID、state、stage、format、artifact 可用性、warning/页/OCR/asset 数量、耗时、稳定 error code 与 retryable；不含 source/output 绝对路径、文件名、warning/error 正文、OCR 原文或密码。常见恢复：

| code | 含义 / 下一步 |
|---|---|
| `DOCUMENT_OUTPUT_NOT_DIRECTORY` | `--output` 指向文件形 leaf；改传父目录 |
| `DOCUMENT_PASSWORD_REQUIRED/INVALID` | 重新提交新 job，命令中只显示 `<password>` 占位符 |
| `DOCUMENT_RESOURCE_*` | bundle 缺失/损坏/target 不符；重装当前 build |
| `DOCUMENT_OCR_RUNTIME_UNAVAILABLE` / `DOCUMENT_PDFIUM_LOAD_FAILED` | bundled native runtime 无法加载；重装并检查平台包 |
| `DOCUMENT_OUTPUT_COLLISION` | publish 前目标被其他进程占用；不会覆盖，重新提交获得新 ID |
| `DOCUMENT_WORKER_CRASHED` | 隔离 Worker 异常退出；partial 未发布，显式重试产生新 ID |
| `DOCUMENT_INTERRUPTED` | App 退出/重启；旧 job 不恢复，重新 submit |
| `DOCUMENT_INSUFFICIENT_DISK_SPACE` | 清理 private/output 所在卷或换输出根 |

诊断只能展示稳定 code、阶段、数量、耗时和恢复动作；底层堆栈、private temp path、模型 cache、正文与密码不能进入用户错误。
