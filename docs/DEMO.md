# 实机演示录制说明

[返回首页](../README.md) · [高清 MP4](https://github.com/luiop4/code-swarm/releases/download/v0.9.1/code-swarm-native-demo.mp4)

首页 GIF 来自本机 Windows 桌面录屏，画面中的应用是真实运行的 VS Code 扩展开发宿主和 Code Swarm 原生覆盖层。录制使用独立配置、纯色编辑器背景与专门的示例文件，不展示私人项目。

## 三个镜头

| 镜头 | 实际发生的行为 |
|---|---|
| Swarm rebuild | 对当前代码执行只读的悬浮卡片重建；原文保留，原生窗口绘制搬运过程 |
| Live input | 输入控制器将示例内容分阶段写入真实 VS Code 缓冲区 |
| Refine | 删除与替换示例代码，并观察混合动画反馈 |

本次原生诊断记录到最多 **50 只同时活动的虚拟鼠标**。动画输入完成 **44 次编辑、13 个操作、52 次绘制进度通知**。鼠标是视觉执行者，不代表 50 次模型调用。

## 录制参数

- Windows 原生 VS Code，项目当前扩展源码；关闭其他扩展和人物背景。
- 示例设置：`cursorCount = 50`、`pointerSize = 14`、`cardSpeed = 1`。
- 桌面以 30 fps 采集，保留真实应用界面；高清 MP4 为 1680 × 1072。
- 首页 GIF 为 1280 × 816、24 fps，节选鼠标密集的只读重建镜头并压缩色板；动作没有加速。完整视频包含三个镜头。
- 供给源为脚本生成的 TypeScript 示例，不包含真实 Copilot 或其他模型调用。

视频展示当前原生覆盖与真实编辑路径，不意味着可以拦截所有 AI 工具内部的生成流。模型入口与 Copilot 工具的差别见 [动画输入文档](ANIMATED-INPUT.md)。
