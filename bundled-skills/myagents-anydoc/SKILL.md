---
name: myagents-anydoc
description: >-
  当用户要读取、解析、提取或转换本地 Office、PDF、扫描件、图片、OpenDocument、RTF、EPUB 或 CSV，尤其需要离线 OCR、文档转 Markdown、处理加密文档或追踪转换任务时使用。通过 MyAgents 内置 `myagents anydoc` CLI 提交和管理本地异步转换；不用于 URL 抓取、目录批量处理、云 OCR、GPT/VLM 识别或文档索引。
metadata:
  author: MyAgents
---

# myagents-anydoc — 本地文档转 Markdown

这是 MyAgents 随 App 发布的全离线文档转换能力。底层任务由 Desktop App 持有；CLI 退出、当前会话结束或切换 Runtime 都不会转移任务 owner。

## 使用顺序

1. 先运行 `myagents anydoc --help` 选择命令。
2. 调用前读取 exact leaf help，例如 `myagents anydoc convert --help`；参数和格式支持以当前安装版本的 help 为准，不凭记忆补参数。
3. 需要机器读取结果时加 `--json`。不要为这个命令组添加 `--dry-run`。

## 核心命令

```bash
myagents anydoc convert --file <input> [--output <directory>] [--password <password>] [--wait] [--json]
myagents anydoc status <job-id> [--json]
myagents anydoc wait <job-id> [--json]
myagents anydoc cancel <job-id> [--json]
myagents anydoc list [--limit <1..100>] [--json]
```

`convert` 每次只接收一个本地文件。`--output` 始终是输出根目录，不是 `document.md` 的文件地址；省略时使用当前 Workspace 的默认转换目录。没有可确认 Workspace 时，按错误提示显式传目录。

所有转换都是异步 job。默认提交后立即返回；只有用户或后续工作必须拿到结果时才用 `--wait` 或独立 `wait`。Ctrl-C 只停止本次等待，不会取消 App 持有的 job；要真正停止处理必须显式调用 `cancel`。

成功产物位于 `<output-root>/<job-id>/document.md`，并可能包含被 Markdown 相对引用的 `assets/`。后续读取时使用返回的实际 `documentPath`，不要猜 job 目录。

## 安全与边界

- 只传本地普通文件；不传 URL、目录、stdin、glob 或特殊设备。
- 密码只在用户明确提供时通过 `--password` 传入；不要在回复、日志或恢复命令中复述真实密码。
- 不需要 GPT、API key、Hugging Face token、系统 Python/Node、Docker、GPU 或运行时联网。
- 遇到失败，保留 `code`、`suggestion` 和 recovery command；按提示继续，不把 partial 目录当作成功产物。
- 需要网页抓取、批量目录摄取、知识库索引或生成式视觉理解时，选择对应工具；AnyDoc 不承担这些能力。

## 常见流程

立即提交，让 Agent 稍后查询：

```bash
myagents anydoc convert --file ./proposal.docx --json
myagents anydoc status <job-id> --json
```

当前工作必须等待结果：

```bash
myagents anydoc convert --file ./scan.pdf --output ./converted --wait --json
```

恢复一个遗忘的任务 ID：

```bash
myagents anydoc list --limit 20 --json
```

任何不确定项都回到 exact help：`myagents anydoc <command> --help`。
