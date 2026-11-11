# AI 适配器

MVP 使用模型无关的前后快照协议。它不要求 AI 逐字输出鼠标动作。动画工作者只是任务的视觉执行者，不能把 32 个指针解释成 32 个实际模型调用。

## 最低成本：直接观察现有工具

在 VS Code 中监听一个文件，再让 Codex / Claude / 其他工具修改它。文件变化事件会被转换成视觉任务。这条路径不用额外配置，但来源显示未知，不能可靠推断哪个工具做了修改。

## 结构化接入：由其他扩展调用

在你的适配器扩展中执行以下 TypeScript。先由用户打开并监听目标文件；通过 `getStatus()` 获取明确监听的 URI 与当前版本，不要将舞台页面当成写文件入口。

```ts
import * as vscode from 'vscode';

const swarm = vscode.extensions.getExtension('code-swarm-local.code-swarm-prototype');
if (!swarm) throw new Error('Install Code Swarm first.');
const api = await swarm.activate();
const status = api.getStatus();
if (!status.uri) throw new Error('Attach a source file in Code Swarm first.');
const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(status.uri));
const baseVersion = source.version;
const baseText = source.getText();

// Call your provider here. Keep the original version captured before the request.
const afterText = await yourAgentGenerate(baseText);

await api.previewEdit({
  uri: source.uri.toString(),
  expectedVersion: baseVersion,
  afterText,
  agent: 'Codex / your-adapter',
  label: 'Extract a shared helper'
});
// User now reviews the native diff and explicitly applies from Code Swarm.
```

接口：

```ts
type ProposalInput = {
  uri: string;             // 必须与已监听文档 URI 完全一致
  expectedVersion: number; // 必填：调用模型之前记录的 TextDocument.version
  afterText: string;       // 完整结果；宿主按文档 EOL 规范化
  agent?: string;          // 来源标签，截断到 80 字符
  label?: string;
};

previewEdit(input: ProposalInput): Promise<{
  proposalId: string;
  expectedVersion: number;
}>;
getStatus(): {
  mode: 'idle' | 'live' | 'demo';
  uri?: string;
  version?: number;
  history: Replay[];
  pending: boolean;
  panelOpen: boolean;
};
```

所有错误通过 Promise 拒绝返回，适配器应展示错误而不是重试覆盖。模型请求期间文档发生变化时，重新读取并重新生成。`history` 包含代码快照，适配器不应将它自动上传。

`previewEdit` 不执行任何真实写入。真正提交由 `codeSwarm.applyProposal` 命令处理，面向用户的入口是舞台按钮/命令面板。没有 HTTP 服务、无认证的本地写入端口或来自 Webview 的任意路径/文本提交协议。VS Code 扩展彼此不是安全隔离域；已安装的其他扩展本身有自己的文件权限。

## 文件交换格式

CLI 工具可写出以下 JSON，再由用户导入。`expectedVersion` 可省略；省略时只保证导入后到应用前的版本一致，不能证明生成期间没有变化，因此必须认真查看原生差异。

```json
{
  "agent": "Claude / manual import",
  "label": "Add input validation",
  "afterText": "export function greet(name: string): string {\n  return `Hello, ${name.trim() || 'world'}!`;\n}\n"
}
```

AI 原始输出若是 unified diff，需要由可信适配器在内存中对正确基线应用 diff，再将完整 `afterText` 交给宿主。不要直接执行模型返回的脚本或命令。
