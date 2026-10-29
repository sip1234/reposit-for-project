# 分块查看与维护

本模块复用 PostgreSQL、`parsing_version_chunks`、`parsing_chunk_updates` 和 `parsing_audit`，没有建立第二套分块或后台队列。接口沿用项目本机单用户边界；项目目前没有登录、角色或租户体系，本次也未宣称提供跨租户授权。

## 页面入口与使用

1. 打开 `http://localhost:3000` → **知识文档**，在文件行点击 **解析详情 / 分块管理**。AI 助手的知识库文件行及已选知识库成员也有入口；检索引用支持“查看分块”。
2. 顶部展示当前有效版本及向量模型；版本选择器控制正在查看的版本。最近请求若仍处理中或失败，会单独展示，检索仍使用有效版本。侧栏是下一次解析的配置，正文上方的“实际配置”才是所查看版本的不可变快照。
3. 查看总数、启用、停用、等待、处理中、失败和可检索数量。正文搜索、启用状态和向量状态可组合筛选，每页 20 段。统计针对整个所选版本，匹配数量针对筛选后的结果。
4. 点击 **查看全文**，查看完整正文、适用的来源信息、字符数、策略、版本、修订及最近操作。未记录的位置明确显示“未记录”。完整来源 JSON 保留坐标和细节；正文以纯文本显示，保留换行及表格的列名和值，避免将资料作为 HTML 执行。
5. 当前有效版本可 **编辑正文**、**停用 / 启用**，失败分块可 **重试向量更新**。正文必须非空且不超过 16000 个 Unicode 码点；人工维护上限独立于机器解析的 maxLength 配置。保留原件来源信息用于对照，不表示人工正文仍逐字对应原件。
6. 编辑期间禁止切换分块、翻页、筛选、刷新版本或关闭详情；取消后明确放弃草稿。浏览器关闭/刷新通过 beforeunload 提醒，草稿不持久化到服务器或浏览器存储。保存冲突保留草稿，显示服务器正文和启用状态；核对后可采用最新修订号继续保存，或取消并重新加载。历史版本始终只读。
7. 保存正文即将分块标记为“等待更新”，后台认领后显示“处理中”，成功后显示正文/向量相同的修订号；失败显示实际错误和重试入口。每 3 秒刷新状态，编辑框不会被轮询覆盖。
8. 下方 **检索验证** 可选择当前文件或一个/多个知识库。仅查询当前有效版本、启用且向量有效一致的分块；结果按模型 ID 分组，不混排模型间分数。显示正文、余弦匹配分数和来源，可跳转到实际召回的文件、版本、分块。这里不调用问答 LLM。

## 编辑、向量与并发规则

正文变化递增 `revision`；正文变化、启停及显式重试递增 `row_version`，向量任务完成不改变操作版本。PATCH 必须携带读取时的两项版本号，任意不一致返回 409 `chunk_conflict`。服务端在事务内锁定文档和分块，重新检查有效版本归属；版本切换后返回 409 `version_changed`。不会默默覆盖另一个页面的维护。

保存或重试分配独立 `embedding_job_id`。worker 只认领当前正文修订及任务标识一致的队列记录，其余标记 superseded；回写时再次匹配修订、任务及正文。失败回写同样检查任务标识，防止旧失败污染新任务。worker 重启将未完成的 processing 任务恢复为 pending。

正常问答检索和测试检索都要求：当前有效版本、`enabled=true`、`embedding_state='ready'`、`revision=vector_revision`、向量非零且维度符合该版本的模型。保存正文后即使旧向量仍存于数据库也被屏蔽。启用操作不强行改变向量状态，因此启用失败或未更新的分块也不会使其参与检索。

沿用审计表记录 edit/enable/disable/retry_embedding 及 embedding_started/complete/failed，包含时间、分块序号、正文/操作/向量修订、任务标识、启停变化和内容哈希。正文详情展示最近 30 条，版本诊断展示最近 100 条；这不是保存每次正文全文的撤销系统。

## 版本与共享缓存

`parsing_artifact_chunks` 是共享且不可编辑的机器解析结果；每个文档的每个版本拥有自己的 `parsing_version_chunks` 副本。维护只影响当前文件的指定有效版本；其他复用缓存的文件不受影响。同一文件加入多个知识库时，这些库同步使用它的维护结果。

新解析版本**不继承正文编辑及启停状态**。当前有效版本存在人工维护时，提交前页面显示确认复选框，服务端也要求 `acknowledgeEdits:true`，否则返回 409 `reparse_requires_ack`。这是明确的产品行为确认。普通缓存复用和强制解析都生成独立新版本；完成后原子切换，失败保留旧有效版本，旧版本的维护仍可只读查看。较早的请求晚完成也不会覆盖较新的请求。

## 预览的实际支持范围

| 格式 | 已实现的对照范围 | 明确限制 |
| --- | --- | --- |
| PDF | 原件预览链接附带 `#page=N`，显示真实记录的页码 | 是否跳页由浏览器 PDF 预览器决定；无页内高亮、坐标框交互 |
| TXT | 根据记录的物理文本行标记、滚动到来源行 | 只展示前 5 MiB，超出范围提示下载；人工编辑不会修改原件 |
| CSV | 文本预览，显示数据行、列名及工作表元数据；按解析器记录的物理起始行尝试标记 | 多行字段仅定位起始行，无单元格高亮 |
| DOCX | 转换 PDF 预览，保留章节/段落/表格信息供对照 | 无可靠的原始物理页码，不能按段落定位 PDF |
| XLSX | 转换 PDF 预览，显示工作表及数据行供对照 | 不可靠映射工作表/行号到预览页 |
| PPTX | 记录幻灯片编号，按编号尝试定位转换 PDF | 页序可能受转换影响，不定位具体文本框/对象 |
| 旧 Office/OpenDocument | 沿用 LibreOffice 转换预览；已记录转换页时尝试跳页 | 不保证原生结构；超过既有 100 MiB Office 预览限制需下载 |

暂不支持人工修改来源、富文本/表格结构编辑、批量维护、自动继承/合并人工修订、历史正文逐次撤销、自动回收历史版本和缓存。这些均未在页面中以模拟能力呈现。

## 迁移与接口

API 启动执行兼容迁移，新增分块 `row_version`、`embedding_job_id`、`maintained_at`、`last_action` 及队列 `started_at`，扩展向量状态 processing，新增筛选索引。`app_migrations` 中 `chunk-maintenance-v1` 一次性补齐旧队列关联、已有维护记录并屏蔽无效旧向量。不删除原表、缓存、版本或正文。升级时先停止旧 worker，再构建 API/indexer，让新版 worker 等待 API 健康及迁移完成：

```powershell
docker compose stop indexer
docker compose up -d --no-deps --build api indexer
```

| 接口 | 参数与结果 |
| --- | --- |
| GET /api/documents/:id/parsing?version=... | 默认有效版本，返回 selected version、activeVersion、requestedVersion、stats、activeStats、版本/诊断/审计 |
| GET /api/documents/:id/chunks | version、page、q（最多200字）、enabled（all/enabled/disabled）、state（all/pending/processing/ready/failed）；返回统计和分页 |
| GET /api/documents/:id/chunks/:index?version=... | 全文、来源、修订、editable、当前向量任务时间及最近30条分块审计 |
| PATCH /api/documents/:id/chunks/:index?version=... | `{revision,rowVersion,content?,enabled?,retry?}`；返回修订、向量状态及任务标识 |
| POST /api/documents/:id/parse | `{modelId,configId?,force?,acknowledgeEdits?}`；必要时要求明确接受新版本不继承人工维护 |
| POST /api/documents/:id/retrieval-test | `{query,knowledgeBaseIds?}`；按模型分组，结果包含实际 version_id/chunk_index |

## 自动验证

```powershell
npm run check
npm run test:parsing
npm run test:chunks
```

`test:chunks` 需要正在运行的 Compose、本地 embedding 和 Docker CLI 权限。它创建明确带“分块维护验证”前缀的资料及独立模型别名，短暂 pause/unpause indexer 观察等待状态；只删除临时别名来触发真实 Ollama 404，然后恢复并重试。原模型和默认模型不变，无在线 LLM 调用。测试保留文档/历史及被引用模型供页面检查，临时知识库在结束后清理。报告写入已忽略的 `artifacts/chunks/integration.json`。避免在正在处理重要解析任务时运行该测试。
