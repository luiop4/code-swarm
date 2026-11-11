# 可实施架构与 API 研究

**0.2 更新：** 现在增加了 Windows 透明点击穿透覆盖程序，作为 Windows 默认体验。下文保留原先的稳定 API 研究与 Webview 分层设计；新的进程边界、定位方法、生命周期与测试见 [NATIVE-OVERLAY.md](NATIVE-OVERLAY.md)。标准扩展 DOM 限制仍成立，原生覆盖由操作系统窗口实现。

研究日期：2026-11-10。使用稳定 VS Code API，编译目标为 VS Code 1.100+，不依赖 proposed API、CSS 注入、修改 VS Code 安装文件或系统鼠标控制。

## API 的真实边界

| 问题 | 官方能力与限制 | 实现选择 |
|---|---|---|
| 能否自由覆盖原生代码编辑器？ | 扩展宿主不访问工作台 DOM，不能插入任意 HTML/CSS。 | 独立的只读 Webview 编辑器页，与原生源文件并排。 |
| Decorations 能否代替完整动画引擎？ | Decoration 提供范围背景、边框、前后附加文本/图标等文档锚定效果；稳定 API 不提供自由 Canvas 覆盖层或任意原生 glyph 像素坐标。 | 不对原生编辑器做 60fps decoration 更新；所有自由移动发生在自己控制的 Canvas 内。 |
| Webview 能否访问文件？ | Webview 与宿主通过消息通信；Webview 本身不直接访问 VS Code 编辑 API。 | 舞台只接收快照。消息只允许打开/监听/预览/提交等固定动作，不接收路径或替换文本。 |
| 文档事件能否区分 AI？ | `TextDocumentChangeEvent` 包含内容变化及 Undo/Redo 原因，没有通用的修改者/模型身份字段。 | 原生变化归为未知来源；适配器显式传入来源。 |
| 能否捕获终端 AI 修改？ | 已打开干净文档的外部落盘通常经 VS Code 重新加载并触发文档变化；未载入文件不是通用文档事件流。 | 仅捕获明确监听且由 VS Code 同步的文档，避免工作区全量扫描及错误覆盖。 |
| 能否安全逐字写入真实文件？ | 编辑器支持有撤销边界的批量文本编辑；每帧写真实文件会污染撤销栈并增加并发冲突。 | 一次提交真实结果；逐字输入只画在只读舞台。 |
| 为什么不用 CustomTextEditorProvider？ | 它可以替代特定资源的编辑视图，但需要承担完整编辑器体验。 | MVP 不取代原生编辑器。后续若需真正可交互的块编辑器，再引入该机制。 |

以上关于“无法实现原生自由覆盖层”是基于官方 DOM 限制和公开稳定 API 范围得出的实现判断，不表示不能在 VS Code 内使用 Webview 做出相同视觉语言。

官方依据：

- [能力与 DOM 限制](https://code.visualstudio.com/api/extension-capabilities/overview#restrictions)
- [Webview 与消息传递](https://code.visualstudio.com/api/extension-guides/webview)
- [Decoration、TextEditor.edit、文档版本与变化事件](https://code.visualstudio.com/api/references/vscode-api)
- [Custom Editor 文档模型与同步](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [官方扩展测试示例](https://github.com/microsoft/vscode-extension-samples/tree/main/helloworld-test-sample)

## 数据流

```mermaid
flowchart LR
  A[原生编辑器 / 外部 AI 修改] --> B[VS Code 文档事件]
  B --> C[前后快照 + 去抖合并]
  C --> D[只读 Diff Planner]
  D --> E[有界内存回放历史]
  E --> F[Webview 调度器]
  F --> G[Canvas 鼠标 / 选区 / 拖拽 / 打字]
  H[结构化 AI 补丁] --> I[宿主校验目标与版本]
  I --> J[原生差异预览]
  J --> K[用户点击应用]
  K --> L[再次校验 + TextEditor.edit]
  L --> B
```

动画时钟、鼠标位置和输入字符计数都不参与文件写入。播放与暂停不调用编辑 API。

## 分层职责

1. **宿主捕获层**：用户明确附加一个文档，保留之前快照；`onDidChangeTextDocument` 更新基线，忽略无内容变化事件；去抖后输出不可变的前后快照。Undo/Redo 可识别，其他来源默认未知。
2. **任务规划层**：行差异，最大 60ms 搜索预算；超时退化为整体替换的视觉摘要。变更按三行拆成任务。完全相同且含有足够非空内容的新增/删除片段配对为推断的搬运；不是结构语义判断。
3. **调度层**：分配到最早空闲的虚拟鼠标。单个任务包含接近、框选、输入/拖动/删除、落点四段。不同任务并行，单个鼠标按自己的时间线串行执行。
4. **渲染层**：DPR 上限 2，`requestAnimationFrame`，可视行裁剪、Canvas 绘制文字、浮动代码卡片与辅助线。UI 任务卡约 10Hz 更新。暂停时不持续请求动画帧；后台页面停止 RAF。
5. **写入层**：只处理一个已监听文本文件，不支持创建/删除资源及多文件部分提交。预览文本在内存虚拟 URI 中打开，用户应用时检查版本和原文，再用 `TextEditor.edit` 提交并分隔 Undo Stop。

## 编辑保护

- 保存 `uri + document.version + beforeText`；预览后的任何内容变化使待提交补丁失效。
- `showTextDocument` 是异步操作，因此在其完成后再检查一次基线。检查和调用 `editor.edit` 之间没有异步等待。
- `TextEditor.edit` 关联当前文档版本；主线程遇到版本不一致可拒绝，代码处理返回 `false`。预览版本拒绝已由真实扩展测试验证。不能把它当作跨进程文件系统锁：其他工具同时写磁盘的冲突仍由 VS Code 负责处理。
- 写入不经 `workspace.fs.writeFile`、不逐字符执行、无独立保存。原生缓冲区、Undo/Redo、保存冲突处理仍由 VS Code 管理。
- 不进行自动失败回滚覆盖。如果编辑被拒绝，保留当前文件并要求生成新的预览。
- 工作区不受信任时，允许演示/只读观察/预览，拒绝应用补丁。原型不会运行 AI 生成的代码。
- 本版没有磁盘备份或崩溃恢复日志；恢复依赖 VS Code 的撤销和备份机制，不能承诺防止外部进程或系统故障造成的数据丢失。

## 资源、隐私与生命周期

代码快照、补丁和差异只保存在内存中；没有遥测、网络请求、API Key 或模型对话读取。宿主最多保存 12 个片段，客户端队列同样最多 12 个。若回放落后且队列溢出，丢弃最旧片段并显示提示；原始文档不受影响。文件超出 120,000 个 UTF-16 字符或 2,000 行时停止捕获，恢复后重建基线。

隐藏页面不继续跑动画。宿主仍观察已附加文档；Webview 被销毁重建后，实时模式显示最近快照，演示从第一幕恢复。仅保存播放速度/跟随偏好等少量 UI 状态，不把代码写入 Webview 持久状态。关闭舞台、断开监听、切换演示或源文档关闭时清空当前监听与历史。

Webview 限制本地资源根目录为打包后的 `dist`，脚本使用随机 nonce，默认拒绝资源与网络连接；代码只经 Canvas `fillText` 和 DOM `textContent` 显示，不能被当作 HTML/脚本执行。原生只读补丁预览使用虚拟文档提供器。

## 后续迭代

先为 Codex/Claude 的具体插件或 CLI 增加公开事件适配器，携带真实任务 ID、Agent ID、活动与取消状态；再做按语言的 AST 移动检测、增量 Token 着色、多文件导航与冲突协调。真正跨文件原子写入需要单独设计，不能直接把当前单文档方案扩展为循环写文件。若希望鼠标出现在原生字符旁，可增加低频 decorations 提示，但不会获得 Webview 的自由悬浮能力。
