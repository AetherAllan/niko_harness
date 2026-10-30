> 此文记录初版 4096 的探索。当前 Harness 已改为 2048 滚动窗口与网页热加载采样参数；以下测速是历史数据。当前用法见 README。

# 本机 source31 推理观察

实测设备沿用父目录验证：Apple M5，24 GiB 统一内存。固定官方 llama.cpp `e0f142d5ddc1461ce721644d92af33db23545105`，同一 Q8_0 底模、独立 F16 source31 LoRA（scale 1.0）。没有下载或转换其他模型，没有修改系统内存限制。

## 4096 的结论

4096 已完成真实加载和生成，`/props` 返回 4096，`/lora-adapters` 确认指定 source31 文件与 1.0 强度。按模型结构估算，4096 的 Q8 K/V 缓存约占 306 MiB，接近 2048 F16 KV 的约 288 MiB；这不包含运行时其他内存开销。模型权重仍为原 Q8_0。

短群聊输入约 211 token，同种子，每组仅两条短回复：

| 配置 | 首次生成速度 | 热前缀生成速度 | 首次整轮耗时 | 热前缀整轮耗时 |
| --- | ---: | ---: | ---: | ---: |
| 4096 / F16 KV / batch 32, ubatch 16 | 12.71 tok/s | 12.82 tok/s | 3.44 s | 2.10 s |
| 4096 / Q8 KV / batch 128, ubatch 64 | 13.55 tok/s | 14.10 tok/s | 2.77 s | 1.92 s |
| 4096 / Q8 KV / ngram-simple | 14.06 tok/s | 12.97 tok/s | 2.59 s | 2.08 s |

这只支持本机短样本观察，不能据此宣称稳定百分比提升。最终默认 Q8 KV、128/64 batch、推测解码关闭、请求启用 prompt cache。冷热前缀由服务报告的 cached tokens 区分。

长输入压力测试约 3689 token，网页夹具从三条摘要裁到 578 token，并裁掉三项旧上下文。真实计数等于 API 的 prompt_tokens。此时生成只有约 4.6 tok/s，明显慢于短输入。详情见 `local-smoke.json`；本次仅一条长样本，不是持续负载测试。

测试期间系统出现 warning 压力，swap 也较高。因此“4096 可以运行”不代表内存充裕或任何群聊都能快速响应。优先缩短消息与历史、限制搜索资料；保留 2048 的父目录入口作为可退回方案。不要并发启动两份模型。

## MTP 与其他加速

当前 399 个 GGUF 张量的验证清单没有 `mtp` / `nextn` 预测头；底模配置是 `Qwen3ForCausalLM`。即使这个 llama.cpp 版本支持 `draft-mtp`，现有文件也不能凭一个启动参数获得 MTP。

官方实现还支持 EAGLE-3 / DFlash 等外部 draft，但需要另外取得与目标对应的权重、转换并验证；还须实测 source31 LoRA 下的接受率、数值行为和内存。此次没有引入额外权重。

`ngram-simple` 无需额外模型，已做本机短样本对照，但没有观察到稳定优势，默认关闭。普通群聊短且变化较多，代码重写等重复文本场景的收益不能直接套用。

已经采用的轻量措施：关闭 thinking、单请求、Flash Attention、较大的 prompt batch、受限 Q8 KV、稳定前缀与 prompt cache、限定输出长度、按原生 tokenizer 裁剪输入。不更换底模量化，不更换后端，不上传权重。

依据：[固定版本的 speculative 文档](https://github.com/ggml-org/llama.cpp/blob/e0f142d5ddc1461ce721644d92af33db23545105/docs/speculative.md)、[固定版本 server 文档](https://github.com/ggml-org/llama.cpp/blob/e0f142d5ddc1461ce721644d92af33db23545105/tools/server/README.md)、本地 `logs/model-command.json`、`reports/inference-benchmark.json` 及父目录的 `reports/base-gguf-validation.json`。
