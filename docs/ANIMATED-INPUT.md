## 从 CMD 输入到正在监听的编辑器

在受信任的本地 VS Code 窗口打开目标文件，运行 **Code Swarm: 监听当前代码文件**。从 CMD 启动接入的生成器。终端显示 `Code Swarm connected` 后切回目标编辑器，保持其可见。生成器每次发布一批文本后会等待编辑器写完。结束后由用户保存目标文件，编辑器的自动保存设置照常生效。

桌面的 `stream_coder.py` 已接入。其他采用 `TARGET_FILE`、`with open(...)` 和 `run_streaming_pipeline()` 的 Python 生成器，可把 `swarm_input.py` 放在脚本旁，在主入口调用 `run_managed(run_streaming_pipeline, TARGET_FILE)`。当前辅助模块处理 UTF-8 文本的追加和重写。未接入的生成器可将输出路径设置为“启动通用动画输入”提供的暂存文件。直接写真实文件属于事后监听。

## 从 VS Code AI 模型实时流入

打开本地目标文件，运行 **Code Swarm: 让 VS Code AI 流式写入当前文件**，输入任务并选择 VS Code 提供给扩展的模型。扩展逐段读取模型响应，并在响应还未结束时就交给动画输入控制器；真实文档通过动画进度逐步修改。AI 必须返回完整文件源码，扩展会识别并剥掉外围 Markdown 代码围栏。

此路径适用于 VS Code Language Model API 提供的模型。VS Code 不向其他扩展开放对 Copilot、Codex、Claude 等全部现有 AI 编辑动作的通用拦截/取消入口；要让特定工具也这样写入，需要该工具主动调用 Code Swarm 适配器。用户也可用扩展 API 的 `beginAnimatedInput`、`updateAnimatedInput`、`finishAnimatedInput` 将每个流式增量交给动画输入控制器。

## 从 Copilot 聊天侧栏调用

扩展注册了 VS Code Agent 工具 `swarm_animate_edit`。安装或升级后重新加载 VS Code，在 Copilot Chat 里切换到 **Agent** 模式并启用 Code Swarm 工具；也可在请求中通过 `#swarm_animate_edit` 显式引用。先在编辑器中聚焦目标本地文件，再发出类似“`#swarm_animate_edit 请在当前文件增加输入校验`”的请求。Agent 应把完整的新文件内容交给该工具，而不是先用普通编辑工具改文件。VS Code 会在执行前请求确认；随后 Code Swarm 创建备份并把实际编辑逐步动画写入当前文件，完成后由用户检查和保存。

这个工具收到的是 Agent 完成规划后提交的完整文件内容，因此它动画呈现真实的编辑器写入过程；它不显示模型内部逐 token 的生成过程，也无法追回已由 Copilot 普通编辑工具提交的改动。如果目标文件已经等于输出，工具会拒绝空回放并提示先让 Agent 调用此工具。

# 0.6：动画驱动真实输入

## 使用方法

1. 安装 0.6.0 后重新加载 VS Code，打开要输入的本地代码文件。初次体验建议新建一个空白 Python 文件。
2. 运行 **Code Swarm: 用动画输入运行 Python 生成脚本**，选择桌面的 `stream_coder.py`。
3. 保持目标代码文件可见、VS Code 在前台。代码先进入独立暂存文件，虚拟鼠标到达输入或落位阶段后，才真正修改目标编辑器。
4. 状态栏可暂停、继续；命令 **停止动画输入（保留已输入内容）** 可停止生成器与后续写入。
5. 输入完成后按需要保存。扩展不主动保存，VS Code 自己的自动保存设置仍适用。普通成功会话可用一次撤销恢复输入前内容；**查看输入前备份** 始终通过只读视图展示本地备份。

脚本必须通过这个命令启动。当前内置适配器要求脚本提供 `TARGET_FILE` 与 `run_streaming_pipeline`，适用于本次的 `stream_coder.py`；没有修改该脚本文件。它会把该生产者的输出路径改为私有暂存位置，后续读写和重构都在暂存内容上进行。

此适配器不是 Python 沙箱，也不是操作系统级的文件写入钩子。用户选择的 Python 脚本仍是正常执行的程序，只有约定的目标输出被重定向。当前适配器不覆盖任意脚本的其他文件操作。

## 为什么这次是真实输入

普通监听模式在代码已改变之后播放视觉效果。动画输入模式则有独立的写入控制器：接收期望内容 → 计算有界编辑 → 显示动画 → 收到该动画绘制进度 → 验证版本与磁盘状态 → 通过 `TextEditor.edit` 应用对应编辑。

文字输入分阶段提交，卡片、复制、替换和删除在落位阶段提交。渲染器只返回会话内的数字进度，不返回源代码、目标路径或编辑指令；写入控制器持有经过检查的编辑内容。没有模拟系统键盘或鼠标。

每次编辑前验证文档版本和内容，磁盘内容发生竞争变化时停止。用户手动编辑、撤销、语言模型被替换等导致版本不再匹配时，保留当前内容并停止后续输入。停止不会自动回退，以免盖掉新的人工编辑；输入前文本、暂存输出均保存在扩展本地存储。

失去前台或目标编辑器不可见时暂停，不在没有动画进度的情况下继续写入。窗口重新获得焦点可恢复焦点暂停；其他中断可点击状态栏继续，恢复前再次验证目标状态。重测失败不会改为直接提交整段代码。

## VS Code 的边界

公开的 [`onDidChangeTextDocument`](https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument) 是变化后的通知，不能取消其他扩展或外部程序已经做出的编辑。因此没有声称能透明接管所有 Copilot、Codex、Claude 的直接文件写入。

AI 需要把待写内容送入本扩展的适配器，或将生产者的目标重定向到暂存通道。其他工具直接修改目标文件时，继续使用普通观察模式；动画输入过程中发生这种竞争修改则停止。

原生定位仍沿用当前的单视口、关闭自动换行的约束；复杂折叠、水平滚动或遮挡可能中断定位。插件会暂停写入，避免用未显示的动画推进内容。输入边界上限仍为 120,000 个 UTF-16 字符和 2,000 行。

## 给其他扩展的入口

```ts
const swarm = await vscode.extensions
  .getExtension('code-swarm-local.code-swarm-prototype')!.activate();
const doc = vscode.window.activeTextEditor!.document;
const session = await swarm.beginAnimatedInput({
  uri: doc.uri.toString(), expectedVersion: doc.version,
});
// 每次提交该会话期望的完整内容；尚未播放的输入会合并。
swarm.updateAnimatedInput(session.id, accumulatedText);
const result = await swarm.finishAnimatedInput(session.id);
if (result.state !== 'completed') throw new Error(result.reason);
// 此时编辑器缓冲区已完成，保存由调用方或用户按自己的策略处理。
```

## 复现验证

```powershell
npm ci
npm run check
npm test
$env:VSCODE_EXECUTABLE_PATH = 'C:\Program Files\Microsoft VS Code\Code.exe'
$env:SWARM_FOCUS_WAIT = '30000'
$env:SWARM_MANAGED_SCRIPT = 'C:\path\to\stream_coder.py'
npm run test:managed
```

自动打开的窗口使用独立配置与测试文件。测试包括输入先被持有、真实缓冲区中间状态、原生绘制进度、Unicode 完整性、一次撤销、只读备份、人工编辑与磁盘冲突，以及原始完整生产者通过私有通道输入。日志在 `test-results/managed-input.log`。
