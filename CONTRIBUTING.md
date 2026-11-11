# 贡献指南

欢迎提交复现清晰的问题与范围明确的改进。

## 本地开发

需要 Node.js 22+ 和 npm。Windows 原生覆盖编译还依赖 .NET Framework 编译器与 WPF 引用；入口见 `scripts/build-native.mjs`。

```powershell
npm ci
npm run check
npm run build
code .
```

按 F5 启动扩展开发宿主。舞台样式可通过 `npm run preview` 查看；验证命令见 [TESTING.md](docs/TESTING.md)。

## 提交前

保持动画渲染与真实编辑边界清晰。渲染器只应上报进度，不应决定路径、代码内容或真实文件写入。涉及输入通道时，请说明版本检查、冲突、取消和恢复行为。

提交问题时说明版本、操作系统、输入来源与复现步骤。可附去除私人代码、密钥及桌面信息后的 GIF；不要上传完整本机日志或敏感项目。

Pull request 应描述行为变化和实际完成的验证；未运行的检查请直接说明。无需为纯文案改动补充测试。
