# 工艺智控平台

深色工艺总览、仿真推演、知识文档和 AI 助手页面。工艺总览中的设备指标仍为演示数据；仿真推演由本地 BSM1 机理模型真实计算；知识文档的上传、预览，以及 AI 助手中的知识库、模型管理与问答使用本地服务。

## 启动本地文档服务

需要 Docker Desktop。Windows PowerShell 在项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

首次启动会生成不提交到 Git 的 `.env` 随机凭据、拉取镜像和本机模型并创建数据目录。模型约需数 GiB 下载空间。打开 [知识文档](http://localhost:3000/#documents) 上传文件，或在 [AI 助手](http://localhost:3000/#assistant) 的知识库页直接上传。上传完成后选择 embedding 模型并点击文件旁的“解析”，再把文件加入知识库提问。之后仍建议运行启动脚本，它会检查模型并重建代码；`docker compose down` 停止服务但保留持久数据。

文档上传支持拖放或选择多个文件，断线后重新选择同一文件可从已保存的偏移量续传。单文件上限 10 GiB。支持 doc、docx、txt、pdf、xls、xlsx、ppt、pptx、csv、rtf、odt、ods、odp。上传后服务流式计算 SHA-256 并保存原件，页面可查看状态、按文件名搜索、预览和下载原件。

上传完成后不会自动分块或生成向量。用户为单个文件选择 Ollama embedding 模型并点击“解析”后，后台按页、幻灯片或段落提取文字，切成约 700–1200 字的片段，保存到 PostgreSQL `pgvector`。默认选择 `qwen3-embedding:0.6b`。相同 SHA-256 且选用同一模型的文件复用解析结果；不同模型可分别解析同一内容。支持 PDF、DOCX、PPTX、TXT、DOC、PPT、RTF、ODT、ODP、XLS、XLSX、CSV、ODS。扫描版 PDF 尚无 OCR；超过 512 MiB 的 Office 文件仍保存原件，但暂不解析。

AI 助手可创建多个知识库，每个知识库可以选择已保存但尚未解析的文件；提问时可同时选择多个知识库。后端只检索所选知识库中已解析完成的文件，按文件实际选用的 embedding 模型分别计算问题向量。未加入任何知识库的文件不会进入问答。回答由当前启用的 LLM 生成并显示引用，默认使用本地 `qwen3:4b-instruct`；请核对下方原文。

### 模型管理

在 AI 助手的“模型管理”分页添加、编辑和切换模型。LLM 可使用 Ollama 或 DeepSeek，embedding 当前使用 Ollama。添加 Ollama 模型前先通过 `docker compose exec ollama ollama pull <模型名>` 下载；保存 embedding 模型时会调用一次本地 embedding 接口以确定向量维度。DeepSeek 可添加 `deepseek-flash` 或 `deepseek-v4-pro`，需要在页面输入 API 密钥；密钥经 AES-256-GCM 加密保存在 PostgreSQL，界面和列表接口不会回显。加密密钥由本地 `.env` 的 `HOOK_TOKEN` 派生，迁移数据库时应同时保留该值。

每种模型类型启用一个默认模型。切换 LLM 立即用于后续问答；启用 DeepSeek 后，提问内容及检索出的段落会发送至 DeepSeek 接口。切换默认 embedding 模型只影响之后手动解析时的默认选项，已有文件保留各自的模型和索引。不同维度的向量可共存；跨模型检索结果按余弦相似度合并。在线 API 需要本机网络可连接其服务。

PDF 在页面直接显示；TXT 和 CSV 显示文本内容，超过 5 MiB 时先显示前 5 MiB；Office 和 OpenDocument 文件由本地 LibreOffice 转为 PDF 预览，转换结果缓存在 `DATA_DIR/previews`，原件不变。Office 文件超过 100 MiB 时请下载原件查看。预览转换可能与原软件排版略有差异。

## 机理模型仿真（BSM1）

仿真推演页的滑块驱动一个真实的机理模型，页面上显示的指标与曲线由模型计算得出，不再是界面演示值。

### 模型与实现来源

模型采用 IWA 的 **BSM1**（Benchmark Simulation Model No. 1）：5 格活性污泥反应池（2 格缺氧 + 3 格好氧）加一座 10 层二沉池，含硝化与反硝化脱氮，是活性污泥法控制策略评估的国际基准。

数值实现使用开源库 **`bsm2-python`**（BSD-3-Clause 许可），由 `pip` 在构建 `simulator` 镜像时安装，**代码本身不提交到本仓库**，仓库只记录依赖与构建方式，与 Ollama 模型的处理方式一致：

- 依赖声明：`simulator/requirements.txt`（版本已固定）
- 构建方式：`Dockerfile.simulator`
- 服务编排：`compose.yaml` 中的 `simulator` 服务

该实现的曝气能耗、泵送能耗、搅拌能耗三项与 IWA 官方参考值完全一致，进水质量指数偏差 0.03%，可作为可信依据。注意：`bsm2-python` 另含闭环实现 `BSM1CL`，但其文档明确标注尚未通过校验，因此本项目未采用，改为在已验证的开环实现上自行实现溶解氧控制器。

### 参数映射

| 界面控件 | 含义 | 范围 | 默认 |
| --- | --- | --- | --- |
| 第 5 格溶解氧设定值 | 由 PI 控制器调节该格 KLa 以跟踪设定值 | 0.5–4 mg/L | 2 mg/L |
| 内回流倍数 | 好氧末端至首格的混合液回流，按平均干季流量换算 | 0–5 倍 | 3 倍 |
| 外加碳源投加量 | 投入第 1 格（缺氧区）以强化反硝化，碳源浓度 400,000 g COD/m³ | 0–5 m³/d | 0 |

PI 控制器参数取自 `bsm2-python` 中基于 BSM1 调校的值；实测在评价窗口内可将溶解氧标准差控制在 0.08 mg/L 以内。

仿真固定使用干季入流数据，运行 14 天并评价最后 7 天，与规范的评估方式一致。单次约需 20–30 秒，因此走后台任务队列：页面点击后提交任务、轮询进度并展示结果。任务表为 `sim_jobs` 与 `sim_results`。

### 已知局限

- **出水质量指数（EQI）实测比官方参考值偏低约 8%**，原因尚未查明，因此界面暂不展示该指标，只展示已核验的能耗指标。做参数优化时需要先解决。
- 曲线中除曝气能耗、泵送与搅拌能耗、出水氨氮均值外的指标尚未接入。
- 仿真从默认稳态初值开始。改动参数后严格来说需要重新稳定，因此短时间窗内的前段结果含有瞬态，界面按"评价窗口"整体呈现。
- **BSM1 是基准模型，代表一类工艺的标准算例，不是本厂真实工况。** 结果不能直接用于生产判断。
- 上游库存在 `simtime` 与 `timesteps` 长度不一致的问题，`simulator/run.py` 中以 `step_count()` 规避。

### 存储

- tusd 临时上传目录：默认 `../dachuang-data/uploads`。
- 永久原件目录：默认 `../dachuang-data/raw`，位于 Git 项目之外；不提供删除操作。
- 预览缓存目录：默认 `../dachuang-data/previews`，可从原件重新生成。
- PostgreSQL 存放文件元数据、段落、向量、知识库及其文件关联、模型配置与加密后的 API 密钥，使用 Docker 命名卷 `dachuang_postgres_data`。Ollama 模型存放在 `dachuang_ollama_models`。
- 上传服务和页面仅绑定到本机 `127.0.0.1`。云存储接口留到后续阶段。

可在 `.env` 中更改 `DATA_DIR`，将原件放到容量充足的本地磁盘。按每天 20 GB 估算，一年约新增 7.3 TB，长期保留需要持续扩容。备份时应同时备份 `DATA_DIR/raw` 和 PostgreSQL 数据；`uploads` 是未完成上传的续传数据，也建议纳入日常备份。不要使用 `docker compose down -v`，该命令会删除数据库卷。

### 验证

```powershell
npm install
npm run check
node scripts/smoke-test.js
node scripts/check-knowledge-bases.js
node scripts/check-models.js
```

机理模型仿真的接口可用于自检：

```powershell
curl http://localhost:3000/api/simulation
curl -X POST http://localhost:3000/api/simulation -H "Content-Type: application/json" -d "{}"
```

`GET /api/simulation` 返回最近任务；`POST` 入队后用 `GET /api/simulation/<id>` 轮询进度与结果。`simulator` 首次启动会输出 JIT 预热日志，该预热是一次性成本，之后每个任务都走热路径。

上传集成测试会经真实 tusd 上传一个小型 TXT 文件，验证分段续传、原件保存、上传后未解析、未解析文件不参与检索，以及点击“解析”后的索引；测试文件会留在知识文档列表中。知识库集成测试会创建临时知识库，验证单库隔离、多库检索、文件成员更新和问答，然后删除临时知识库。模型集成测试会创建临时配置，验证密钥不回显、按文件选择模型及混合模型检索，最后恢复原配置。

工艺总览和仿真推演仍可直接打开 `index.html` 查看静态原型；知识文档与 AI 助手功能需要从本地服务地址打开。
