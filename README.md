# StyleJuicer · 风格榨汁机

**简体中文** | [English](README_EN.md)

**把一个网站，榨成一套能迁移的 UI 风格。**

我给 Codex 装了一双“设计师的眼睛”：丢给它一个公开网址，它自己滚、自己截、检查浏览器收到的公开前端线索，最后只带走风格，不抄走网站。

你得到的是一套有截图、有代码线索、有置信度标注、可以继续交给 Agent 使用的 UI 风格档案，而不是一堆“简洁、现代、高级”的空泛形容词。

这个项目只负责提取风格，不替用户设计产品，也不复制来源网站的品牌资产和标志性构图。

## 它是怎么工作的

项目由三层组成：

1. 确定性的 Playwright 采集器沿桌面和窄屏的单一代表主线扫描页面，保存不可变候选截图、渲染测量、公开资源和真实失败状态。
2. Agent 从候选证据中选择代表画面，提炼可迁移的视觉规则、设计决策和取舍。
3. 确定性的收束与验证程序检查截图哈希、状态传播、证据引用和五件交付物是否一致。

机械脚本负责“看见了什么、证据有没有被改过”；Agent 负责“这些证据意味着什么”。

## 为什么不是又一个提示词

- 不只看首屏：桌面和窄屏沿一条有界主线增量扫描，并识别空白壳、加载器和没有视觉进展的假成功。
- 不让模型随口概括：Agent 只能从哈希绑定的候选帧中选择 2–6 张代表证据。
- 不把资源列表冒充代码理解：公开机制线索必须关联到可见效果、selector、资源和置信度。
- 不强行交作业：取证不完整就输出可复核的 `partial` / `blocked`，不会拿诊断帧编造完整风格。
- 不负责抄站：StyleJuicer 到五件风格包为止，具体产品由下游 Agent 按用户需求设计。

在发布门评测中，三个未见过的参考站分别被迁移为临床试验运营台、公交事件指挥台和社区食物库存产品；三组都通过五件包验证、双端重排、状态覆盖和运行检查。这证明的是有边界的跨产品迁移，不是“任意网站一键复刻”。协议、评分与偏差说明见 [docs/EVALUATION.md](docs/EVALUATION.md)。

## 安装

- Node.js 20 或更新版本
- npm
- 与 Playwright 1.62.1 配套的 Chromium

公开 Beta 发布后，CLI 与浏览器运行时需要单独安装：

```bash
npm install -g stylejuicer@beta
npx --yes playwright@1.62.1 install chromium
stylejuicer doctor --json
```

Codex Plugin 提供 Agent 的判断与编排，不会替你安装 npm CLI 或 Chromium。也就是说，Plugin 能被 Codex 发现不等于浏览器采集环境已经就绪；以 `doctor` 的真实启动结果为准。

从源码开发时使用：

```bash
npm ci
node node_modules/playwright/cli.js install chromium
node bin/stylejuicer.cjs doctor --json
```

如果机器上有多个 Node 版本，请明确使用受支持的 Node 可执行文件。`doctor` 会报告实际使用的 Node、Playwright、Chromium、操作系统、CPU 架构、无头模式和输出目录写入能力。

## CLI

```bash
stylejuicer doctor
stylejuicer scan https://example.com --run work/example-scan
# 慢站点可显式提高，但最多 15 分钟：
stylejuicer scan https://example.com --run work/example-scan --timeout-ms 480000
stylejuicer interact https://example.com --run work/example-scan --selection work/example-scan/selection.json
stylejuicer finalize --run work/example-scan --selection work/example-scan/selection.json --out output/example-style
stylejuicer render --profile output/example-style/style-profile.yaml --analysis output/example-style/analysis.md
stylejuicer validate delivery output/example-style
```

所有命令都支持 `--json`。机器结果写到 stdout，诊断信息写到 stderr。

| 退出码 | 含义 |
|---:|---|
| 0 | 完整成功 |
| 1 | 执行或校验失败 |
| 2 | 命令用法错误 |
| 3 | 成功生成或验证了诚实的 `partial` / `blocked` 产物 |

`interact` 被设计为显式命令，因为它会重新访问网站；`finalize` 不会把在线点击偷偷藏进一个看起来离线的操作里。

## 五件交付物

一次完整交付包含：

- `screenshots/`：最终选中的代表截图
- `evidence.json`：页面、渲染、资源、状态和采集过程证据
- `public-code-map.json`：可见效果与公开 CSS/资源机制的映射线索
- `style-profile.yaml`：供其他 Agent 使用的结构化风格档案
- `analysis.md`：面向人的设计语言分析

内部候选帧、探针和 contact sheet 只作为审计材料。最终风格包最多包含六张选中截图，默认不会在聊天里向用户倾倒整套截图。

## `partial` 和 `blocked` 是什么

`partial` 表示结果可用但不完整，例如桌面视口成功、窄屏仍卡在加载器后面。`blocked` 表示无法在安全边界内取得所需证据。它们是有效的失败记录，不会被冒充成“成功提取风格”，CLI 返回退出码 3。

采集器不会把加载器、浏览器错误页、空白画布或低信息过渡帧当成目标设计的证据。`sparse-graphical-shell` 的含义是“当前画面不足以支持风格结论”，不武断断言所有无文字极简 splash 都是加载器。来自失败画面的 DOM/CSS 线索也会明确标成推断，而不是已观察事实。

遍历、DOM/CSS 采样、稳定等待、截图、诊断和交互候选都有上限。一次 `scan` 默认还有 240 秒进程内总时限，可用 `--timeout-ms` 在 1 秒至 15 分钟间显式调整；超时会关闭 Playwright，以逐文件原子替换写入 `blocked` manifest/evidence，并记录当时阶段。它不是操作系统级硬杀，也不限制内存和下载字节；面对不受信任的公开页面，仍应在一次性环境或 Docker 中配合外部资源限制运行。

## 渲染边界

本工具不承诺像素级复刻。WebGL、Canvas、视频、系统字体、编解码器、GPU 驱动、无头渲染、持续动画、A/B 测试和地区分发内容都可能随机器或运行时间变化。

Docker 能提高依赖一致性，但不能让这些表面与用户桌面完全相同。

## Codex Plugin

仓库在 `skills/stylejuicer` 中包含一个 Plugin Skill。Skill 提供 Agent 编排、视觉选择和语义分析规则；npm CLI 提供确定性的机械执行。Plugin 安装不一定会自动安装 npm 依赖和 Chromium，因此采集前必须运行 `stylejuicer doctor`。

它不是第二份浏览器引擎。使用未发布的源码检出时，请在仓库根目录运行 `node bin/stylejuicer.cjs ...`。旧的 `site-style` 命令在 Beta 期间保留为同一入口的兼容别名，不包含第二套实现。

## Docker

Docker 镜像暴露同一套 CLI，并固定配套 Playwright 镜像：

```bash
docker build -t stylejuicer:0.1.0-beta.2 .
docker run --rm stylejuicer:0.1.0-beta.2 doctor --json
docker run --rm --init --memory=2g --cpus=2 -v "$PWD/work:/work" stylejuicer:0.1.0-beta.2 \
  scan https://example.com --run /work/example-scan --json
```

容器以非 root 用户 `pwuser` 运行。只挂载专用输出目录，不要挂载个人浏览器配置、Cookie、凭据、主目录或 Docker socket。Linux 用户需要提前确保挂载目录可由容器用户写入。

## 开发与验证

```bash
npm test
npm pack --dry-run
npm run release:smoke
```

`release:smoke` 会真正生成 npm tarball，在临时消费者项目中安装它，使用安装包内的合成网页跑完 scan、finalize、render 和两道 validator；它不会访问第三方参考网站。公开回归测试只使用本地合成网页。真实网站会受 CDN、限流和在线改版影响，因此只作为非阻断 smoke test。

参与贡献或准备发布前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 和 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)。

## 许可证

MIT。它允许私人使用、修改、再发布、转授权和商业使用，只要求在软件副本或主要部分中保留版权与许可声明。

MIT 只覆盖本项目的代码和文档，不覆盖用户采集到的第三方网站、截图、字体、品牌或资产。完整条款见 [LICENSE](LICENSE)，直接运行依赖的许可证摘要见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
