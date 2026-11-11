# 0.5：参考实现与真实磁盘流

研究与实现日期：2026-11-10。

## 参考了什么

- [Swarm Rebuild](https://github.com/DhvanilPatel/swarm-cursors) 及其 `swarm-rebuild/swarm.js`：同一种鼠标会经历不同任务阶段，包含框线、文字、复制和对齐；自动浏览根据任务积压调整节奏。0.5 采用附近出发、分阶段绘制、不同片段形态和滚动节奏控制。实现为本项目自己的 C#/WPF 代码，没有复制该仓库的动画引擎。
- [Joel Califa 的原始 Swarm](https://github.com/califa/swarm-site)：确认 Swarm Rebuild 的动效来源。该项目面向网站重建，不能直接作为 VS Code 原生编辑器覆盖层使用。
- [Shiki Magic Move 核心](https://github.com/shikijs/shiki/blob/main/packages/magic-move/src/core.ts)：通过稳定身份关联变化前后的片段。0.5 用稳定的行/片段键续接和去重；尚未实现完整的语法 token 位置插值。
- [Motion Canvas Code](https://motioncanvas.io/docs/code/)：将选择、插入、替换分别编排成可阅读的动作。0.5 新增绘框、描摹、复制落位，加上输入、替换、擦除与搬运。
- [Node 文件监听说明](https://nodejs.org/api/fs.html#caveats) 和 [VS Code 文档事件](https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument)：文件系统通知与编辑器文档同步是不同环节。目录监听之外增加有界轮询，不把文件通知数量视作逐行渲染保证。

## 原先漏掉的路径

用户的 `stream_coder.py` 使用 `flush/fsync` 向磁盘逐行写入，并通过整文件重写执行删除与替换。此前主要原生压力测试通过 `WorkspaceEdit` 修改缓冲区，未覆盖这种路径，不能由那些测试推断真实脚本也会有同样效果。

外部重载还可能上报整个文档被替换。原先直接按该范围调整动画，会让正在播放的任务提前结束；现在比较公共前后缀，只调整实际发生变化的行区间。

外部重载也会移动或清除临时定位标记。缓存有效时对重测限频约 1.5 秒，测量失败仍沿用现有几何，混合模式测量不会冻结播放。文档同时变化时保留原有纵向基准，并校验行距，再更新可确认的横向代码列。复杂布局和快速改变的工作台仍可能有短暂定位误差。

## 新的数据流

只读磁盘采样 → 有界合并 → 尚未同步时显示浮动接收片段；文档同步 → 真实位置上的动画。两者共享串行调度，减少并行定位争用。接收片段代表新到达的代码，不表示已经放进编辑器缓冲区；编辑器同步后会收起这些片段。

目录监听与 80ms 轮询只读取一个明确监听的本地文件。每次读取前后核对大小与时间，拒绝不完整 UTF-8 和超限内容。若缓冲区未保存，则不展示竞争的磁盘版本，也不自动覆盖、保存或强制重载。

## 动作与布局

流式新增按行分配输入、描摹、绘框、复制及卡片任务；小替换保留选区提示，删除保留无框旧文本擦除。卡片包含圆角片段、边注和小面板，出生位置在目标附近的多个方向，移动任务使用已知源位置。离开可见区域的任务收起，避免所有目标被夹到同一个边缘。

滚动至少为当前动作留出约 320ms 的间隔；输入仍正常发生。过载时合并快照、保留最近片段，最多 96 个在途任务。这不是每一行都完整演一遍的保证；实际写入速度超出观看速度时，采用有界的代表性表现，最终文件内容不受影响。

## 真实脚本复现

测试包装器仅在 `.vscode-test` 内重定向输出位置，加载原脚本的函数并执行其完整流程。用户脚本与桌面 `ytg.py` 都不会被测试包装器写入。原脚本静态统计含 1,607 行追加片段，实际完整输出 1,655 个文本行（编辑器含末尾空行为 1,656 行），无需依赖脚本注释中的估计行数。

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'C:\Program Files\Microsoft VS Code\Code.exe'
$env:SWARM_STREAM_SCRIPT = 'C:\path\to\stream_coder.py'
$env:SWARM_STREAM_SPEED = 'normal'
$env:SWARM_FOCUS_WAIT = '30000'
npm run test:overlay
```

保持自动打开的测试窗口在前台。测试采样真实绘制帧、磁盘变化、接收批次和动作种类，最后核对磁盘与编辑器内容一致、缓冲区未变脏、原脚本字节未变。日志在 `test-results/native-integration.log`。具体通过结果记录在 `TESTING.md`。
