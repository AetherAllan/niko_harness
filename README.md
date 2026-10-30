# Niko Harness · 喵酱群聊实验室

本机群聊原型：随机心跳 → Jev 的三个独立 Noul 判断 → 必要时 Exa 查询 → 原版 source31 自主生成。支持本地模拟，以及唯一允许的 QQ 测试群 **1104887928**。没有独立 planner、训练或向量数据库。

## 启动

双击本目录的 `start.command`，打开 **http://127.0.0.1:4317**。它启动页面并复用现有模型文件；父目录的配置和启动脚本保持原样。若 8080 已有正确的 source31 服务，会直接复用，页面显示它的实际上下文。

双击 `stop.command` 停止本目录启动的页面、模型和 `niko-napcat` 容器。独立启动的其他模型服务不会被停止。

终端方式（Node.js 22.18+；本机验证 Node 26.13）：

```sh
npm install
npm run build
npm run model:start
npm start
```

开发时用 `npm run dev`，后端与 Vite 共用 4317；生产启动会直接服务 `dist/`。监听地址固定为 `127.0.0.1`，不发布站点，不安装开机服务。

## 配置密钥

在本目录 `.env` 填写：

```dotenv
TYPESAFE_API_KEY=你的_Jev_密钥
EXA_API_KEY=你的_Exa_密钥
LLAMA_BASE_URL=http://127.0.0.1:8080
PORT=4317
```

保存后在「连接与参数」点击「重新读取 .env」。修改页面端口须重启。密钥只由后端读取，文件权限为 0600，浏览器与导出记录不接收密钥。不要提交 `.env`；`.env.example` 是空模板。

Jev 会接收本轮群聊片段和人设；Exa 只接收本地模型提取并经基本隐私清理的公开搜索词。输入本身就是本地实验记录，仍应避免用真实敏感资料进行试验。

## QQ 限定群测试

首次接入已复制旧麦 Bot 的 QQ 登录数据到 `data/napcat/qq`，并创建独立配置；旧目录未改动。当前登录机器人为 **2032635652**，测试群为 **1104887928（中途岛工作室）**。原生 Mac QQ 保留运行，NapCat 使用官方文档推荐的 Docker 镜像，锁定镜像 digest；容器最多 1.5 GiB 内存。

1. 保持 Docker Desktop 运行，双击 `qq-start.command`。它先启动 NapCat，再复用原有 Harness 和模型入口。
2. 页面侧栏选「QQ 限定测试群」。必须显示账号和群校验通过，才能开始心跳；每次重启 Harness 默认暂停。
3. 点「开始观察」，在 QQ 群里 @机器人或回复她的消息。页面接收真实新消息并显示判断、生成和 QQ 送达回执。网页不会代发模拟消息，也不会向 QQ 发送演示夹具。
4. 「暂停心跳」在 QQ 模式下还会取消尚未发送的当前回复；已经提交给 QQ 的消息无法通过暂停撤回，收到成功回执仍如实记录。

仅这一个群号写在 `shared.ts:QQ_GROUP_ID`，不接受来自网页、消息或模型的其他目标。收到其他群、私聊、通知、机器人自身发言时，在保存和模型调用前丢弃。每次连接先核验 QQ 登录身份、群信息和机器人群成员身份。模型输出只能作为普通文字消息段发送，不能插入 CQ 码、文件、管理员操作或动态收件人。

`NAPCAT_WS_URL` 和 `NAPCAT_TOKEN` 已在本机 `.env` 配对配置，连接地址只允许回环地址。WebUI 与 OneBot 端口只映射到 `127.0.0.1:6099` / `127.0.0.1:3001`。登录态失效时需手机扫码；登录页面为 `http://127.0.0.1:6099/webui`，WebUI 登录凭据在 `data/napcat/config/webui.json`，它与 OneBot Token 不同。不要在聊天中粘贴该文件。

QQ 独立记录在 `data/qq-1104887928.json`，模拟消息仍在 `data/state.json`。不拉取历史群消息；只处理连接后收到的新事件。重复消息 ID 不重复入队，最近 100 轮轨迹和 1000 条消息保存在本地，已处理旧消息会在接收新消息时滚动淘汰。网页可导出 QQ 记录，但不提供清空按钮。

发送前先落盘意图，再等待 NapCat 的消息 ID 回执。连接中断、超时或进程重启造成的发送不确定性会显示为错误，**不会自动重发，也禁止手动重试该轮**；先到 QQ 核对。生成之前的错误仍可以手动重试。

```sh
docker compose -f napcat.compose.yml up -d
docker compose -f napcat.compose.yml stop
```

当前仅处理文字、@、引用；图片、表情、语音和视频只有明确的占位说明，不识别内容。首次真实群内收发证据保存在 `reports/qq-live-run.json`。

## 使用

- 切换阿青、小白、柚子发言；点击「@喵酱」或消息旁的回复按钮建立明确关系。处理期间仍可继续发送消息。
- 「单步心跳」处理当前未处理消息；「开始观察」启用随机循环。默认先暂停，避免启动就产生 API 请求。
- 随机间隔默认 5–12 秒，定义为**上一轮结束后**到下一轮开始的等待。它不是经过校准的最佳间隔。暂停心跳会让当前快照处理完毕，停止安排后续轮次。
- 每轮优先选择最新的明确 @喵酱消息作为焦点，其次是最新的回复喵酱消息，否则取最新消息。三个 Noul 围绕同一焦点判断，其他消息作为背景。
- 明确 @喵酱时，程序的接话决策固定为 100%，与 Jev 返回的 `should_reply` 分开保存。Jev 仍判断联网和记忆需求；其他人的 @ 和仅在正文写出名字不触发这个规则。未被 @ 的消息使用会话中设置的接话阈值（当前 QQ 测试群为 60%）。
- 一次成功判断（包括沉默）就消费这份快照。新到消息留给下一次；喵酱自己的发言不触发下一轮。
- Jev 失败至多自动重试一次；最终失败会记录并消费快照，避免无限重复计费。可手动重试。生成失败后的重试复用成功的 Jev 判断和已取得的搜索结果；成功重试后不能再次重复回复。
- `[[NO_REPLY]]` 仅在完整输出等于该标记时被吞掉，不发送到聊天里。

右侧可查看概率、阈值、焦点、各阶段耗时、搜索词、引用网页、实际 token 预算和原始请求。历史页保存最近 100 轮轨迹。所有聊天与轨迹原子写入 `data/state.json`，最多 1000 条消息；新建实验前可导出记录。

「演示回放」使用固定夹具与预录台词，醒目标注，不调用任何模型或外部 API。它用于观察界面和分支，不代表 Jev 或 source31 的质量。演示会追加到当前会话并暂停自动心跳；想进行干净的质量对照，请先导出再新建实验。

## 模型与上下文

复用父目录的 `system-prompt.txt`、`ui-config.json` 和已验证的 GGUF 文件。角色名字统一为「喵酱」，猫娘是角色设定；原始身份配置备份在 `data/backups/`，采样设置保留。每次真实生成前检查 `/props` 与 `/lora-adapters`：必须是指定 Q8_0 底模、指定 source31 LoRA 且强度为 1.0，否则阻止生成。

新启动入口默认 4096 上下文、单请求、Metal 全层、Flash Attention、128/64 batch、Q8_0 K/V 缓存；关闭额外主机提示缓存。保留 0.7 / 0.8 / 20 / 0 采样、192 输出 token 与 non-thinking 模式。KV 缓存精度变化仍可能影响数值结果，不声称与 F16 KV 逐字等价。

生成前用同一服务的 `/apply-template` + `/tokenize` 对完整输入计数。输入预算为 `min(实际上下文,4096) - 192 - 96`；优先裁旧消息、保留焦点和其引用。焦点与人设本身过长时明确报错，不静默截断。固定系统前缀与前置历史有利于单 slot 的 prompt cache；不会为了缓存额外常驻 8 GiB 主机内存。

Exa 默认最多 3 条结果，只请求 `contents.highlights.maxCharacters=420`，不请求全文或额外摘要。每条再作本地长度限制，网页资料总预算默认 600 token，超出后继续裁剪。网页文字作为资料传入，不能覆盖系统规则。未配置、搜索失败、零结果分别明确记录。

搜索词提取使用同一个 source31，通过约束为 `{"query":"..."}` 的 JSON 输出减少聊天语气污染；这不是工具调用，也不是回复规划。程序验证和清理搜索词后自行调用 Exa。普通闲聊只有一次本地回复生成；需要搜索时会多一次本地查询提取。

记忆接口在 `server/providers.ts:retrieveMemory`，第一版始终返回未启用。`needs_memory` 通过后也不会伪装成成功检索到历史。

## 验证与性能记录

```sh
npm test
npm run build
node scripts/smoke-local.ts
```

`smoke-local.ts` 使用真实本地 source31 和 tokenizer，配合合成聊天与固定参考资料测试搜索词提取、长上下文裁剪和实际生成，不调用 Jev / Exa。

- `reports/inference-benchmark.json`：三组 4096 启动设置、冷 / 热前缀、真实回复和系统压力。
- `reports/local-smoke.json`：真实查询提取与接近 4K 的裁剪测试；资料为夹具，来源明确。
- `reports/live-search-run.json`：配置密钥后的真实 Jev → Exa → source31 联调（若已运行）。
- `reports/http-checks.json`：本地来源限制和导出接口检查。
- [推理研究与限制](reports/INFERENCE.md)。

断言测试覆盖固定快照、忙时新消息、沉默消费、自言自语防护、焦点与参数冻结、失败重试去重、搜索复用、重置防迟到回复、不回复标记、未配置工具和外部接口契约，以及 QQ 群号限制、私聊 / 自身消息过滤、重复事件、普通文字消息段和发送不确定时禁止重发。测试与构建通过不代表群聊自然度已经校准。

## 代码范围

`server/core.ts` 管时序和快照；`server/providers.ts` 管 Jev、Exa、本地模型和预算；`server/qq.ts` 管限定群的 OneBot 正向 WebSocket 收发；`server/index.ts` 提供本地 HTTP / SSE 和原子持久化。前端是 React + TypeScript + Vite，使用 Cult UI 的 TextureCard；来源和 MIT 许可见 `THIRD_PARTY_NOTICES.md`。

官方接口依据：[TypeSafe System One](https://docs.typesafe.ai/api/system-one)、[Noul](https://docs.typesafe.ai/primitives/noul)、[Exa Search](https://exa.ai/docs/reference/search)、[Exa highlights 预算](https://github.com/exa-labs/agent-skills/blob/main/skills/build-with-exa/references/search.md)。

QQ 依据：[NapCat Docker 官方说明](https://github.com/NapNeko/NapCat-Docker)、[NapCat 网络配置](https://doc.napneko.icu/config/basic)、[OneBot 11 群消息接口](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。
