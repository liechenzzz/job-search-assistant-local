# Changelog

## 2026-06-04

### Prompt 架构重构：Evidence-First 生成

**目的**：让 AI 生成的 resume 更精准地对齐 JD 要求，充分利用 master resume 结构和 reference folder 里的 chunks，减少生成后的人工修改量。

**问题诊断**：
- AI 收到 13 段散落的 prompt 片段，需要自己做 cross-reference
- 原始 JD 文本吃掉 40-60% token 预算，reference evidence 被挤到边缘
- Coverage plan 状态码没有词汇表，AI 靠猜
- 每个 experience entry 只有 sourceText，没有附上匹配的 reference chunks 和 JD qualifications
- 结果：经验 bullet 偏少（3个）、summary 只有 3 条、技能 underrepresented、对齐不稳定

**修改内容**：

| 文件 | 改动 | 目的 |
|------|------|------|
| `shared/src/prompt-template-definitions.ts` | 重写 `tailoringPromptTemplate`，从单一 JSON dump 改为 4 个 task block（EXPERIENCE / SKILLS / SUMMARY / EDUCATION），加 coverage legend | 让 AI 按 section 接收预组装的证据，不再自己做 cross-reference |
| `shared/src/prompt-template-definitions.js` | 同步 | 容器运行时通过 `.js` 扩展名直接引用此文件 |
| `orchestrator/src/server/services/summary.ts` | 新增 7 个 helper function：`buildJdRequirementsText`、`buildCoverageLegend`、`buildExperienceBrief`、`buildSkillsBrief`、`buildSummaryBrief`、`buildEducationBrief`、`buildLegacyProfileJson`；重写 `buildTailoringPrompt` | 在 prompt 构建阶段预组装证据——每个 experience entry 直接附上匹配的 reference chunks 和 target qualifications |
| `orchestrator/src/server/services/rxresume/tailoring.ts` | `applyTailoredExperience` 加 positional fallback：ID 匹配失败时用 `String(index)` 回退 | 修复 master resume experience ID 为空字符串导致所有 tailored bullet 无法写入渲染输出的 bug |
| `orchestrator/src/server/services/rxresume/tailoring.js` | 同步 | 同上 |

**设计决策**：
1. Evidence pre-assembly — 证据在 prompt 构建时匹配到目标 section，AI 不需要自己找
2. Per-entry evidence — 每个 experience entry 带着自己的 reference chunks 和 JD qualifications 出现在 prompt 里
3. Coverage status glossary — prompt 内置 `direct`/`transferable`/`none` 解释
4. 向后兼容 — 保留 `{{jobDescription}}` 和 `{{profileJson}}` placeholder，自定义模板不受影响
5. 确定性分析层不动 — JD 资格提取、覆盖规划、对齐评分、domain gate、reference 扫描全部保持不变

### 经验 Bullet 数量要求

**目的**：确保每个经验条目生成 5-6 个具体 bullet point，而不是 3 个。

**修改**：prompt 模板的 experience instruction 和 EXPERIENCE REWRITE RULES 中明确要求 "Generate 5-6 specific bullets per experience"，并指示使用 REFERENCE EVIDENCE 和 REFERENCE KNOWLEDGE HITS 补充内容。

### 经验 Bullet 渲染修复

**目的**：修复生成的 HTML/PDF 中 experience section 的 bullet 全部为空的问题。

**根因**：master resume 的 experience item `id` 为空字符串 `""`，AI 生成的 tailored experience 使用序号 ID（`"0"`, `"1"`, `"2"`），`applyTailoredExperience` 做 `byId.get("")` 返回 undefined，所有 item 被跳过（`continue`），`item.description` 保持空值。

**修复**：`orchestrator/src/server/services/rxresume/tailoring.ts:391-393` — ID 查找失败时，回退到位置索引匹配 `byId.get(String(index))`。
