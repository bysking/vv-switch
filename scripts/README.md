# scripts/

手动调试与协议探针脚本（非自动化测试）。

## 文件说明

| 文件 | 用途 |
|------|------|
| `legacy-server.js` | 重构前的旧版单文件 server，保留作参考对照 |
| `simulate-claude-vvswitch.ts` | 模拟 Claude 客户端调用 vv-switch 的端到端验证 |
| `test-volcano-protocol-probe.ts` | 火山引擎 GLM-5.2 协议探针 |
| `test-claude-glm52.mjs` | Claude → 火山 GLM-5.2 端到端验证 |
| `test-codex-anthropic.mjs` | Codex → Anthropic 协议验证 |
| `test-codex-bailian.mjs` | Codex → 百炼协议验证 |
| `test-codex-simulate.mjs` | Codex 调用模拟 |
| `test-codex-toolcall.mjs` | Codex 工具调用验证 |
| `test-volcano-glm52-anthropic.mjs` | 火山 GLM-5.2 Anthropic 协议验证 |
| `test-volcano-glm52-chat.mjs` | 火山 GLM-5.2 Chat 协议验证 |

## 运行

```bash
npx tsx scripts/simulate-claude-vvswitch.ts
node scripts/test-codex-bailian.mjs
```

这些脚本需要本地启动 vv-switch，且会调用真实上游 API。
自动化测试见 `test/` 目录，运行 `npm test`。
