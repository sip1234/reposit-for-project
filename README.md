# 工艺智控平台

深色工艺总览、仿真推演、知识文档和 AI 助手页面。工艺总览中的设备指标与仿真结果仍为演示数据；知识文档的上传、预览，以及 AI 助手中的知识库、模型管理与问答使用本地服务。

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

上传集成测试会经真实 tusd 上传一个小型 TXT 文件，验证分段续传、原件保存、上传后未解析、未解析文件不参与检索，以及点击“解析”后的索引；测试文件会留在知识文档列表中。知识库集成测试会创建临时知识库，验证单库隔离、多库检索、文件成员更新和问答，然后删除临时知识库。模型集成测试会创建临时配置，验证密钥不回显、按文件选择模型及混合模型检索，最后恢复原配置。

工艺总览和仿真推演仍可直接打开 `index.html` 查看静态原型；知识文档与 AI 助手功能需要从本地服务地址打开。
