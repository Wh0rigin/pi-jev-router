# pi-jev-router 测试设计

> 本目录文档说明路由器的验证体系：三层测试如何设计、各自覆盖什么、如何运行。
> 实验结果与图表见根 [README](../README.md) §6。

## 总览

```
第 1 层  单元测试        纯函数：档位/错误分类/状态/策略钳制/配置      （全离线，毫秒级）
第 2 层  集成测试        完整决策回路 + mock Jev HTTP 服务器           （全离线，秒级）
第 3 层  live 测试       真实 jev-1.13.0 连通性与判别力                 （需 JEV_LIVE=1 + 配置）
第 4 层  E2E / A·B 实验  真实 pi 会话中的端到端行为与 3-seed 消耗对比   （需模型凭据）
```

设计原则：**每层只信任下一层的输出**。单元层保证钳制规则数学上正确；集成层保证编排与 fallback 行为正确；live 层保证协议与凭据链真实可用；E2E 层保证在真实 pi 中这些行为按预期发生。

## 1. 单元测试（`test/unit.test.ts`）

### 1.1 档位代数（levels.ts）

- `parseLevel`：只接受四个路由档位（大小写/空白容忍）；`off/max/superhigh/非字符串` 一律拒绝 —— **Jev 的非法输出永远进不了 `setThinkingLevel`**。
- `foldLevel`：pi 的扩展档位折叠进路由空间（`off/minimal→low`，`max→xhigh`），保证比较与日志的 `before/after` 永远落在四档上。

### 1.2 错误分类（errors.ts）—— "推理困难 vs 执行困难" 的落点

分类器是规格 §8 的直接实现，测试用对抗样本锁定边界：

| 样本 | 期望分类 | 设计意图 |
|---|---|---|
| `npm test` 失败 + `AssertionError` | reasoning + testFailure | 升级候选 |
| `npm install` + `ECONNREFUSED` | **environment** | 网络故障不升级 |
| `Cannot connect to the Docker daemon` | **environment** | 守护进程问题不升级 |
| `error TS2345` / `compilation failed` | reasoning | 编译错误升级候选 |
| `ETIMEDOUT` + `AssertionError` 同时出现 | **environment** | 环境模式优先（宁可漏升级，不可因网络误升） |
| `src/app.py:500:1`（行号含 500） | unknown | 对抗误匹配：裸数字不得命中 HTTP 5xx 规则 |
| `HTTP 503 Service Unavailable` | environment | 真正的服务端错误要命中 |
| 成功结果（无论文本含什么） | 无失败 | 只处理 `isError`/非零退出的结果 |

测试运行识别（`looksLikeTestRun`）覆盖 npm test / jest / vitest / pytest / go test / cargo test / node --test / mvn / ctest 等常见命令。

### 1.3 状态机（state.ts）

- 任务类型分类：中英文关键词（含对抗样本——`suffix` 不应命中 `fix`）；CJK 不进 `\b` 边界（曾因此全挂，已修）。
- 计数器：tool_calls / reasoning_failures / env_failures / tests_run（**绿色运行也计数**——曾只统计失败运行，已修）/ tests_failed / changed_files。
- 失败注入会清零 `consecutiveCleanTurns`；`recent_error_kind` 供升级判定。

### 1.4 策略钳制（policy.ts）—— 全部防抖规则的数学验证

| 用例 | 断言 |
|---|---|
| Jev 建议 +1 步 | 原样采纳 |
| Jev 建议 +2 步（medium→xhigh） | 钳到 +1（high） |
| 升级次数达上限 | 保持，reason 含 `cap reached` |
| 仅环境型失败时建议升级 | 拒绝（spec §8） |
| 干净轮次不足时降级 | 保持，`not stable long enough` |
| 降级跨 2 步 | 钳到 -1 且不低于任务基线 |
| 长期稳定（2× 窗口） | 允许击穿基线地板降到建议值 |
| 升级后下一轮立即降级 | 被 `pinTurns` 锁定 |
| 同档建议 | 无副作用（计数器不动） |
| 调用频率门 | 15s 冷却内关闭；`force` 旁路 |
| 新鲜失败旁路 | `reasoningFailures > 上次调用时已见失败数` → 绕过冷却（E2E 发现的 bug 的回归用例） |

### 1.5 配置（config.ts）

数值键必须为正数、布尔键接受 on/off/true/false、字符串键 trim；默认值满足"开箱即安全"（routing on、jev 未配置 → 规则引擎）。

## 2. 集成测试（`test/integration.test.ts`）

### 2.1 mock Jev 服务器

用 `node:http` 起真实 HTTP 服务器（临时端口），实现与 pi-decision-prior 相同的 choice 协议应答。支持三种脚本行为：

1. **正常应答**：`{answers: {q: {choice, confidence, probabilities}}, usage}`；
2. **HTTP 5xx**：触发网络失败路径；
3. **畸形响应**：非 JSON 体，触发解析失败路径。

脚本按调用顺序出队，因此能精确编排"第 N 次咨询返回什么"。测试同时断言**扩展发出去的请求**：`model` 正确、`questions.q.options === ["low","medium","high","xhigh"]`、`state` 含任务快照字段。

### 2.2 主场景（脚本化五步）

```
task-start(medium) → 失败(high) → 干净轮(不动) → 干净轮(降级 medium)
→ 失败(xhigh 建议被钳到 high) → 失败(上限钳制，保持) → 用户手动接管(沉默) → 结算
```

断言三个观测面互相一致：
- **`setThinkingLevel` 调用序列** = `["medium","high","medium","high"]`；
- **通知序列** = 4 次档位变更；
- **JSONL 日志** = 每条含 spec §12 全部字段、before/after 在四档空间内、序列与设计一一对应、summary 的 esc/down/tests 计数正确。

### 2.3 fallback 矩阵

| 场景 | 期望 |
|---|---|
| Jev HTTP 500 | 规则引擎接管（source=fallback），reason 带 `[jev failed: ...]`，路由继续工作 |
| 畸形回答（非法档位） | 同上，非法值**从未**到达 `setThinkingLevel` |
| 未配置 endpoint | 每会话一次 warning；纯规则路由；第二次任务不重复告警 |
| 仅有环境型失败 | 不调 Jev、不升级、一次 warning |
| 非推理模型 | 路由器整体不激活 |
| `enabled: false`（/jev-router off） | 零决策、零调用 |
| 冷却窗口内出现新鲜失败 | **仍然升级**（真实 E2E 发现的吞升级 bug 的回归） |

### 2.4 数据完整性

JSONL logger：自动创建父目录、异步 flush 落盘、每行合法 JSON、字段名与 spec §12 一致（`timestamp/task_id/trigger/source/task_type/thinking_level_before/thinking_level_after/changed/clamped/reason/previous_failures/tool_calls/tests_run/tests_failed/context_tokens/jev_latency_ms/jev_input_tokens/jev_output_tokens/execution_time_ms`）。jev 自身 token 与主模型 usage 分列，便于按不同单价分别计费。

## 3. live 测试（`test/live-jev.test.ts`）

```bash
JEV_LIVE=1 node --test test/live-jev.test.ts
```

与扩展同一条配置链（`~/.pi/jev-router.json` → env → cc-switch 凭据库），用一个并发库存扣减 NPE 快照请求真实档位判断。断言：返回合法档位、confidence ∈ [0,1]、延迟非负。默认 skip，避免 CI 依赖外部服务。

## 4. E2E 与 3-seed A/B 实验（`scripts/benchmark.ts`）

```bash
node scripts/benchmark.ts            # 2 臂 × 3 seed，互 interleaved 执行
```

设计：

- **任务**：固定的先失败后修复任务（`calc.js` 整数除法 bug + `node --test`），每 seed 全新临时目录，杜绝跨污染；
- **A 臂（max，不切换）**：`pi --mode json --thinking max`，**不加载扩展**，档位恒为 max；
- **B 臂（jev，动态切换）**：`pi --mode json -e ./index.ts`，路由器自动选档；
- **顺序**：A/B 交替（max, jev, max, jev, …）以解耦时间漂移与服务端负载波动；
- **度量**（每次运行）：wall 时间、Σinput tokens、Σoutput tokens、ΣcacheRead tokens（从 `--mode json` 的 `message_end.usage` 事件聚合）、最终测试是否通过（运行后独立跑 `node --test` 验证）、路由器决策数（decisions.jsonl 行数差分）；
- **局限（如实）**：LLM API 无真正 seed，"3 seed"指 3 次独立重复；glm-5.3-flash 的 `thinkingLevelMap` 仅 `max→max`，其余档位不发思考参数，因此对比的本质是"每轮都带 max 思考 vs 大多数轮不带思考 + jev 开销"。

## 运行手册

```bash
npm test                                    # 第 1+2 层（离线，~1s；live 用例自动 skip）
JEV_LIVE=1 npm run test:live                # 第 3 层（真实 jev）
npm run ping                                # 双探针连通性/判别力
npm run benchmark                           # 第 4 层 A/B（约 10-20 分钟）
npm run charts                              # 重新生成 README 图表
```
