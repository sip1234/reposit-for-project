# 文档解析与分块使用说明

## 启动与依赖

沿用 PostgreSQL/pgvector、Ollama、Node API 和 Python worker。首次构建需要访问 Debian、PyPI 和 npm 软件源。镜像新增 `openpyxl==3.1.5`、Tesseract CLI，以及 Debian `tesseract-ocr-eng`、`tesseract-ocr-chi-sim` 语言包；OCR 无需在线 API 或额外下载大模型。PyMuPDF、python-docx、python-pptx 和 LibreOffice 沿用固定依赖。OCR 默认 200 DPI，每页最长 120 秒；`OMP_THREAD_LIMIT=2` 限制 OCR 线程。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
# 已有服务升级时也可只构建相关镜像
docker compose up -d --build api indexer
```

API 在启动期间执行兼容迁移；indexer 等待 API 健康检查通过。迁移在事务和数据库锁中执行，并按 `app_migrations` 标记幂等运行。不删除旧解析表。旧版已完成结果复制为各文件的独立有效版本，标记为 `legacy-1`；旧版未完成或失败的任务标记为失败，需要在详情页重新提交。旧版历史参数只能按原代码记录，缺少精细位置，页面会提示重新解析。

Ollama 只通过容器网络 `http://ollama:11434` 访问，避免 Windows 保留宿主机端口导致启动失败。所有文件原件保持不变；不要删除数据库卷或 `.env` 中的凭据。

## 使用流程

1. 在知识文档页面上传原件，等待“已保存”。AI 助手知识库中的文件也可进入同一解析详情。
2. 点击“解析详情 / 分块管理”，选取已有配置，或修改字段后保存为配置快照。名称不参与内容缓存；相同配置会复用已有配置记录。
3. 选择向量模型，点击“按此配置解析 / 重试”。“强制重新解析”跳过缓存并创建新任务。
4. 查看等待、提取、OCR、分块、向量化、完成或失败阶段。页面诊断展示页/工作表结果、OCR 标记、错误、警告、耗时及最近 100 条阶段事件与人工操作。
5. 新结果全部完成后自动成为当前有效版本；失败时保留原来的有效版本。可以在版本列表查看历史配置与分块，历史版本只读。
6. 当前有效版本支持正文搜索、每页 20 段的分页、完整正文、来源元数据、原件预览、编辑与启停。保存正文后进入向量更新队列，更新中或失败的分块不参与检索，可单独重试。
7. 在详情底部输入测试问题，选择当前文件或一个/多个知识库。结果按向量模型分别显示分数、分块和来源；这里不调用在线问答模型。

编辑仅作用于指定文档的指定有效版本，不会修改相同文件的其他上传副本，也不会修改共享的只读解析缓存。同一个文档如果加入多个知识库，这些知识库都会使用它的当前有效版本。强制重新解析会生成新的机器解析版本，不自动叠加旧版人工编辑；旧版编辑仍可查看。启停不会删除正文。

## 配置与长度定义

配置字段见 `worker/parser_manifest.json`，解析器版本为 `structured-2.0.1`，配置格式版本为 1。配置不可原地修改，新参数保存为新快照，任务通过配置 ID 引用实际参数。

| 字段 | 默认值 | 约束或行为 |
| --- | --- | --- |
| method | auto | auto、text、ocr；原生 Office/CSV/TXT 按格式处理；此字段控制 PDF 或转换 PDF 的 OCR |
| strategy | paragraph | paragraph、section、table、qa |
| lengthUnit | unicode_char | Python Unicode 码点；不是字节、UTF-16 单元或 token；补充的章节和表头计入长度 |
| targetLength | 800 | 至少 100；目标长度是建议边界 |
| maxLength | 1200 | 不小于目标，最多 16000；表格单行或完整问答对超限时明确失败，保留原文，不静默截断 |
| overlapLength | 100 | 非负且小于目标长度的一半 |
| ocrEnabled | true | 强制 OCR 模式下必须启用 |
| ocrLanguage | chi_sim+eng | 也可选择 chi_sim、eng |
| headerContext | true | 表格块重复补充表头；关闭后每个单元格仍保留列名与值 |
| sectionContext | true | 在正文前补充章节路径；结构元数据始终保留路径 |
| headerRows | 1 | 1–5；可用于多层表头或单位行 |

通用段落按自然段、句子边界和长度切分；标题策略先按标题路径分组。所有策略都保留表格行的结构，不把表格行拆成无上下文的碎片。文本重叠发生在同一章节内，表格按同一张表的完整数据行重叠，实际重叠可能小于配置值。不同章节、幻灯片、工作表和不同表格之间不会互相重叠。

Q:/A: 或 问:/答: 等明确标记形成完整问答对；没有问题标记时回退为通用段落，并记录警告。存在问题但缺少答案标记时保留完整条目并提示核对。完整问答对超出最大长度时需要扩大配置或整理原件。

## 数据结构与缓存隔离

统一提取块包含 `content`、`content_type`、`source`、`section_path`。source 按格式记录 PDF 页与边界框、DOCX 段落或表格行列、工作表与行号、TXT 行区间、PPTX 页与对象坐标；表格保留列名、单元格和表头行。分块额外记录策略、顺序、Unicode 长度、组内字符区间和来源位置集合。

新增表：`parsing_configs`（配置）、`parsing_jobs`（缓存任务）、`parsing_blocks`（提取块）、`parsing_artifact_chunks`（只读缓存分块）、`parsing_versions`（文档解析版本）、`parsing_version_chunks`（文档独立分块）、`parsing_chunk_updates`（人工编辑向量更新队列）、`parsing_events`（阶段事件）、`parsing_audit`（操作记录）。documents 的 `requested_parse_version_id` 与 `active_parse_version_id` 分别指向最近请求和当前可检索版本。

缓存指纹包含文件 SHA-256、扩展名、向量模型 ID/名称/维度、规范化配置哈希、配置版本和解析器版本。修改解析逻辑、依赖或 OCR 语言资源时应同步提升 parserVersion，使缓存失效。普通提交可复用成功结果或等待同一在途任务；失败任务不直接复用，重试生成新任务。强制提交产生独立任务标识。缓存完成后为每个文档复制独立分块；人工编辑不回写缓存。

分块正文修订号与向量修订号必须一致，且启用、向量状态 ready，才参与检索。编辑请求带 revision 与 rowVersion，正文或启停/重试操作版本过期均返回 409。详见 [分块维护说明](chunk-maintenance.md)。人工编辑会在检索结果、引用和传入模型的资料中标记“可能与原件不同”。worker 在重启后恢复未完成任务；发布时只更新仍指向该请求的文件，避免先提交但后完成的任务覆盖较新的请求。

## 接口

| 接口 | 用途 |
| --- | --- |
| GET /api/parsing/configs | 配置、默认值、版本信息 |
| POST /api/parsing/configs | 保存 `{name, config}` 配置快照 |
| POST /api/documents/:id/parse | `{modelId, configId?, force?, acknowledgeEdits?}` 提交任务，返回 versionId/jobId/reused |
| GET /api/documents/:id/parsing?version=... | 当前有效或指定版本、最近 100 个版本、诊断、操作记录 |
| GET /api/documents/:id/chunks?version=...&page=1&q=...&enabled=all&state=all | 完整分块正文、分页与来源；默认当前有效版本 |
| PATCH /api/documents/:id/chunks/:index?version=... | `{revision, rowVersion, content?, enabled?, retry?}`，编辑只允许当前有效版本；人工正文最多 16000 字符 |
| POST /api/documents/:id/retrieval-test | `{query, knowledgeBaseIds?}` 检索当前文件或指定知识库的有效版本 |

## 验证

```powershell
npm run check
# Docker 镜像包含所需 Python、OCR 语言包；测试只读挂载源码
docker compose run --rm --no-deps -v "${PWD}/tests:/app/tests:ro" indexer /opt/venv/bin/python -m unittest discover -s tests -p test_structured_parser.py -v
npm run test:parsing
```

Python 用临时文件生成普通/扫描混合 PDF、DOCX 标题表格、XLSX 多工作表与合并单元格、UTF-8/UTF-16/GB18030 CSV、PPTX 和短行 TXT，检查边界、重叠、问答对、单位/空值及原件不变。OCR 测试真正调用本地 Tesseract。接口测试使用本地 embedding，覆盖配置校验、缓存复用、人工编辑隔离、启停检索、修订冲突、配置变更、失败保留旧版与强制重解析，不调用在线 LLM。接口测试会留下带“解析模块验证”前缀的四份 TXT 文件供查看，临时知识库会清理。问答超长失败是主动构造的恢复测试，属于预期结果。

原有回归脚本也可继续使用：`node scripts/smoke-test.js` 检查上传续传和解析；`node scripts/check-models.js` 使用本地模型检查多模型解析，历史引用的验证向量模型会保留。知识库脚本默认会调用当前问答模型；只做本地检索回归时先设置 `$env:SKIP_MODEL_ANSWER='1'`，再运行 `node scripts/check-knowledge-bases.js`，结束后移除此环境变量。

## 已知限制

- PDF 文字框和 OCR 行保留坐标，但不识别复杂跨栏阅读顺序、PDF 表格拓扑或公式结构。缺少文本的判定采用少于 20 字符/明显替代字符的启发式；包含大量文本但局部扫描图像的页面不会自动完整识别，可选择强制 OCR。
- OCR 仅内置简体中文和英文；低分辨率、手写、竖排、复杂表格需人工核对。单页失败会记录原因，其余页面仍可解析；全部无有效内容则任务失败。
- DOCX 保留标题层级、正文和顶层表格；浮动文本框、嵌套表格和复杂修订内容不保证完整。DOCX 段落没有可靠的物理页码，不伪造 PDF 页码。
- XLSX 合并单元格扩展父单元格值；不计算公式，优先读取缓存值，无缓存时保留“公式未计算”提示。每工作表最多 500000 个网格单元；表头与单位行需通过 headerRows 明确配置，不自动识别同一工作表内多个独立数据表。CSV 多行字段仍视为同一数据记录。
- DOC、XLS、ODT、ODS 等旧格式经 LibreOffice 转为 PDF，页码来自转换预览，不能保证原表格结构。建议上传 DOCX/XLSX 原生格式。
- PDF 和 PPTX 预览尝试按记录页码跳转，TXT 可按物理文本行定位；CSV 按解析器记录的物理起始行尝试定位，多行字段仅定位起点；XLSX 的工作表/行与 DOCX 段落无法可靠映射到转换 PDF 的页码，详情中保留其精确结构位置供核对。
- 向量更新和解析按单 worker 执行。历史版本和缓存暂不自动回收；没有新增团队权限、多租户、混合检索或 reranker，这些属于后续模块。
