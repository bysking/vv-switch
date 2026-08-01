# 火山 GLM-5.2 chat  接入 claude报错


[vv-switch] [DEBUG] /v1/messages | activeProvider=火山-GLM-5.2-chat | model=GLM-5.2 | baseUrl=https://ark.cn-beijing.volces.com/api/coding/v3 | protocolType=chat | stream=false
ℹ️ [2026-07-03 22:19:38] 📥 Claude Request: model=GLM-5.2 stream=false protocol=chat messages=2 tools=30
ℹ️ [2026-07-03 22:19:38] 🚀 claude-route | non-stream | msgId=msg_2a51d51f48614cf795993f23
[vv-switch] [openai-compatible-provider] 🌐 chat | start | url=https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions | model=GLM-5.2 | messages=3 | tools=30
[vv-switch] [openai-compatible-provider] 🟢 chat | fetch_done | status=500 | duration=437ms
[vv-switch] [openai-compatible-provider] ❌ chat | UPSTREAM_ERROR | status=500 | body={"error":{"code":"InternalServiceError","message":"Service has some internal Error: please contact with platform administrator Request id: 0217830883782129a0d83abff91b62c26f47d22f8f162252a25b1","param
[vv-switch] [openai-compatible-provider] ⚠️ chat | STRIP_TRY | status=500 | 剥离 thinking 重试
[vv-switch] [openai-compatible-provider] ❌ chat | STRIP_FAIL | retry_status=500 | 报原 500
[vv-switch] [openai-compatible-provider] 🌐 chat | start | url=https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions | model=GLM-5.2 | messages=3 | tools=30
[vv-switch] [openai-compatible-provider] 🟢 chat | fetch_done | status=500 | duration=362ms
[vv-switch] [openai-compatible-provider] ❌ chat | UPSTREAM_ERROR | status=500 | body={"error":{"code":"InternalServiceError","message":"Service has some internal Error: please contact with platform administrator Request id: 0217830883800269a0d83abff91b62c26f47d22f8f16225f04f24","param
[vv-switch] [openai-compatible-provider] ⚠️ chat | STRIP_TRY | status=500 | 剥离 thinking 重试
[vv-switch] [openai-compatible-provider] ❌ chat | STRIP_FAIL | retry_status=500 | 报原 500


当前项目有很多测试用例，期望针对 claude和codex统一一份测试用例，针对不同的模型跑一轮
