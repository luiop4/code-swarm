# 构建与验证

[返回首页](../README.md)

## 当前发布范围

0.9.1 已完成类型检查、构建与 VSIX 打包。Copilot Agent 工具和 VS Code 模型入口尚未以真实模型账户完成端到端验证，不应将早期本机记录当作这两个新入口的验证结果。

## 常用命令

```powershell
npm ci
npm run check
npm test
npm run package
```

| 命令 | 范围 |
|---|---|
| `npm test` | 任务规划、文本边界、快照、卡片与输入差异等核心用例 |
| `npm run test:ui` | 舞台的浏览器交互；需要 Edge 或 `PLAYWRIGHT_CHANNEL=chrome` |
| `npm run test:extension` | 独立 Extension Host 的文档与补丁行为 |
| `npm run test:webview` | 实际 Webview 资源与通信 |
| `npm run test:overlay` | Windows 原生定位与覆盖；需要保持测试窗口前台 |
| `npm run test:managed` | 受控输入、撤销、备份与冲突；Windows 前台运行 |

未设置 `VSCODE_EXECUTABLE_PATH` 时，官方测试库可能下载 VS Code。测试使用 `.vscode-test` 下的独立配置；产物在 `test-results`，均不提交仓库。

需要外部 Python 生成器的可选分支，必须自行提供符合约定的脚本，不依赖作者桌面文件。设置 `SWARM_MANAGED_SCRIPT` 或相关测试脚本要求的变量，并查看对应源码。

早期本机记录保留在 [历史验证记录](history/TESTING-2026-11-10.md)，仅用于理解当时的环境和覆盖范围。
