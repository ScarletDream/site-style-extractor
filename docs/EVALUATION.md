# 中距离风格迁移评测

日期：2026-08-20

## 验证什么

这次评测验证一个有边界的主张：StyleJuicer 能从公开、免登录、主线相对明确的营销页面中提取可用的视觉语言，并帮助 Agent 将其迁移到功能明显不同的产品界面，同时不复制来源身份或完整构图。

它不验证任意 URL 成功、私有源码访问、像素克隆、穷举全部分支或精确还原所有动效。

## 隔离协议

- 三个实现者分别获得一个此前未使用的公开参考站，以及一个不同业务领域的虚构产品需求。
- 桌面与窄屏 fresh scan 必须为 `complete`；`partial` 或 `blocked` 不得开始实现。
- 五件交付物必须先通过 capture 和 delivery 两道验证。
- 验证后，实现者停止访问参考站，只能使用本地风格包。
- 禁止复用来源名称、Logo、文案、图片、字体文件、专有插画和整套构图。
- 实现者不能查看彼此的作品或评分。

每个实现至少需要四个可导航界面、一个密集操作面、一个输入面、搜索或筛选、空状态、表单成功与错误状态、桌面和 390 像素窄屏渲染，以及页面错误和横向溢出自动检查。

## 硬门

1. capture 与 delivery 均完整通过，且没有 error 或 warning。
2. 实现可以重复运行。
3. 四类界面与异常状态均可到达。
4. 不复用来源身份资产或整套构图。
5. 窄屏真实重排，主要内容没有实质裁切或不可到达。
6. 参考站与目标产品的业务功能不同。

## 预先固定的评分表

| 维度 | 分值 |
|---|---:|
| 提取诚实性 | 20 |
| 迁移保真度 | 25 |
| 产品适配 | 20 |
| 覆盖广度与一致性 | 15 |
| 响应式与状态质量 | 15 |
| 原创性与边界纪律 | 5 |

达到 Beta 门槛需要：通过全部硬门，总分至少 80/100，且每个维度至少得到该维度 60% 的分数。

## 结果

| 迁移 | 最终证据 | 验证结果 | 实现检查 | 得分 |
|---|---:|---|---|---:|
| 户外编辑参考 → 临床试验运营台 | 6 | complete；0 error；0 warning | 11 张渲染 + 3 次交互转换；无页面/控制台错误或溢出 | **93** |
| 高饱和工作室参考 → 公交事件指挥台 | 6 | complete；0 error；0 warning | 12 张渲染；4 条导航路径；无页面/控制台错误或溢出 | **96** |
| 旅行编辑参考 → 社区食物库存 | 6 | complete；0 error；0 warning | 12 张渲染 + 6 次交互检查；无页面/控制台错误或溢出 | **92** |

三组都通过了全部硬门和各维度最低分。根评审者独立重跑了三套 delivery validator 和可用的实现检查脚本。

## 偏差与限制

- 三个实现者彼此隔离，但每个实现者都同时负责风格综合与产品实现。这是独立 Agent 的盲迁移，不是双盲人类研究。
- 参考站按公开可访问和主线明确筛选。更早的 `partial` 与 `blocked` 样本仍然存在，因此本评测不是 URL 成功率统计。
- 确定性 validator 只能证明哈希、包结构、状态传播和指定运行检查，不能证明审美。分数是评审者依据预先固定评分表做出的视觉与产品判断。
- 其中一张移动空状态截图在首屏与普通状态视觉重复，尽管该状态可以到达并通过独立检查，仍然据此扣分，没有隐藏缺陷。

## 可以支持的发布表述

本评测证明了三个功能不同产品上的有边界迁移。它支持“桌面与窄屏 fresh evidence”“单条有界主线”“哈希绑定的五件风格包”“带 `O/R/I/U` 置信度的公开机制线索”和“诚实失败产物”等表述。

它不支持“一键复刻”“所有网站都能用”“读取私有源码”或“完美还原动效”。

---

# Medium-distance transfer evaluation

Date: 2026-08-20

## Claim under test

This evaluation tests a bounded claim: StyleJuicer can extract a useful visual language from a public, unauthenticated, mostly linear marketing surface and help an Agent transfer that language into a functionally different product interface without copying the source identity or complete composition.

It does not test universal URL success, private-source access, pixel cloning, exhaustive branches, or perfect motion reconstruction.

## Isolation protocol

- Three implementers each received a previously unused public reference and a fictional product brief in a different business domain.
- A fresh desktop and narrow scan had to finish `complete`; `partial` or `blocked` evidence did not authorize implementation.
- All five artifacts had to pass capture and delivery validation before implementation began.
- After validation, each implementer stopped accessing the reference and worked only from the local evidence package.
- Source names, logos, copy, imagery, font files, proprietary illustrations, and wholesale compositions were prohibited.
- Implementers did not inspect one another's work or scores.

Each implementation had to provide at least four navigable screens, a dense operational surface, an input surface, search or filter behavior, an empty state, form success and error states, desktop and 390-pixel renders, and automated checks for page errors and horizontal overflow.

## Hard gates

1. Complete capture and delivery validation with no errors or warnings.
2. Reproducibly runnable implementation.
3. Four required surfaces and exceptional states are reachable.
4. No source identity asset or wholesale composition is reused.
5. Narrow layouts recompose without materially clipped or unreachable primary content.
6. Reference and target differ in business function.

## Precommitted scoring rubric

| Area | Points |
|---|---:|
| Extraction truthfulness | 20 |
| Transfer fidelity | 25 |
| Product adaptation | 20 |
| Breadth and consistency | 15 |
| Responsive and state quality | 15 |
| Originality and boundary discipline | 5 |

A Beta-ready result required every hard gate, at least 80/100 overall, and at least 60% in every scored area.

## Results

| Transfer | Final evidence | Validator result | Implementation QA | Score |
|---|---:|---|---|---:|
| Editorial outdoor reference → clinical trial operations | 6 | complete; 0 errors; 0 warnings | 11 renders + 3 interaction transitions; no page/console errors or overflow | **93** |
| Saturated studio reference → transit incident console | 6 | complete; 0 errors; 0 warnings | 12 renders; 4 navigation paths; no page/console errors or overflow | **96** |
| Travel editorial reference → community food inventory | 6 | complete; 0 errors; 0 warnings | 12 renders + 6 interaction checks; no page/console errors or overflow | **92** |

All three passed every hard gate and every rubric floor. The root reviewer reran all three delivery validators and the available implementation QA harnesses.

## Bias and limits

- Implementers were isolated from one another, but each implementer both synthesized its style package and built its product. This was an independent-Agent blind transfer, not a double-blind human study.
- References were selected for public access and coherent main paths. Earlier `partial` and `blocked` runs exist and this evaluation is not a URL success-rate measurement.
- Deterministic validators prove hashes, package structure, status propagation, and named runtime checks. They cannot prove taste. The numerical scores are the reviewer's visual and product judgment under the precommitted rubric.
- One mobile empty-state screenshot was visually redundant above the fold even though the state was reachable and independently checked; the score was reduced rather than the defect being hidden.

## Supported release statement

The run demonstrates bounded transfer across three functionally different products. It supports claims about fresh desktop and narrow evidence, one bounded main path, hash-bound five-artifact packages, public mechanism clues with `O/R/I/U` confidence, and honest failure artifacts.

It does not support “one-click clone,” “works on every website,” “reads private source,” or “perfectly recovers animation.”
