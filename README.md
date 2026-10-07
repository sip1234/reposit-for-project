# 工艺智控平台

深色工艺总览、仿真推演和知识文档页面。设备指标、AI 回答与仿真结果仍为演示数据；知识文档的上传、保存、列表和下载已接入本地服务。

## 启动本地文档服务

需要 Docker Desktop。Windows PowerShell 在项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

首次启动会生成不提交到 Git 的 `.env` 随机凭据、拉取镜像并创建数据目录。打开 [知识文档](http://localhost:3000/#documents)。之后可用 `docker compose up -d` 启动、`docker compose down` 停止；后者不会删除持久数据。修改代码后再次运行启动脚本以重新构建。

文档上传支持拖放或选择多个文件，断线后重新选择同一文件可从已保存的偏移量续传。单文件上限 10 GiB。支持 doc、docx、txt、pdf、xls、xlsx、ppt、pptx、csv、rtf、odt、ods、odp。上传后服务流式计算 SHA-256 并保存原件，页面可查看状态、按文件名搜索、预览和下载原件。当前尚未提取文档正文或构建知识检索索引。

PDF 在页面直接显示；TXT 和 CSV 显示文本内容，超过 5 MiB 时先显示前 5 MiB；Office 和 OpenDocument 文件由本地 LibreOffice 转为 PDF 预览，转换结果缓存在 `DATA_DIR/previews`，原件不变。Office 文件超过 100 MiB 时请下载原件查看。预览转换可能与原软件排版略有差异。

### 存储

- tusd 临时上传目录：默认 `../dachuang-data/uploads`。
- 永久原件目录：默认 `../dachuang-data/raw`，位于 Git 项目之外；不提供删除操作。
- 预览缓存目录：默认 `../dachuang-data/previews`，可从原件重新生成。
- PostgreSQL 存放文件名、大小、状态、时间和 SHA-256 等元数据，使用 Docker 命名卷 `dachuang_postgres_data`。
- 上传服务和页面仅绑定到本机 `127.0.0.1`。云存储接口留到后续阶段。

可在 `.env` 中更改 `DATA_DIR`，将原件放到容量充足的本地磁盘。按每天 20 GB 估算，一年约新增 7.3 TB，长期保留需要持续扩容。备份时应同时备份 `DATA_DIR/raw` 和 PostgreSQL 数据；`uploads` 是未完成上传的续传数据，也建议纳入日常备份。不要使用 `docker compose down -v`，该命令会删除数据库卷。

### 验证

```powershell
npm install
npm run check
node scripts/smoke-test.js
```

集成测试会经真实 tusd 上传一个小型 TXT 文件，验证分段续传、数据库记录、哈希和下载；测试文件会留在知识文档列表中。

工艺总览和仿真推演仍可直接打开 `index.html` 查看静态原型；知识文档功能需要从本地服务地址打开。
