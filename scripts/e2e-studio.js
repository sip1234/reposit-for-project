#!/usr/bin/env node
/* Browser E2E for the simulation studio: run, metric cards, CSV/JSON export, optimization UI. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.env.E2E_URL || 'http://127.0.0.1:3000';
const ARTIFACTS = path.join(process.cwd(), 'artifacts', 'e2e');
const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function browserPath() {
  const found = BROWSER_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Chrome/Edge；请设置 E2E_BROWSER');
  return found;
}

async function waitText(page, selector, needle, timeout) {
  await page.waitForFunction(
    ([sel, text]) => (document.querySelector(sel)?.textContent || '').includes(text),
    [selector, needle],
    { timeout }
  );
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: browserPath(),
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(`${BASE}/#studio`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#run-simulation', { state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#run-simulation')?.disabled, null, { timeout: 30000 });

    if (!(await page.locator('#load-factor').count())) throw new Error('缺少负荷选择器');
    if (!(await page.locator('#optimization-evaluations').count())) throw new Error('缺少优化评估次数选择器');

    await page.click('#run-simulation');
    await waitText(page, '#simulation-status', '仿真完成', 120000);
    await page.waitForFunction(() => document.querySelectorAll('.studio-metric-card').length >= 8, null, { timeout: 15000 });
    const cards = await page.locator('.studio-metric-card').count();
    if (cards < 8) throw new Error(`指标卡数量不足：${cards}`);

    const csvDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#export-csv');
    const csvDownload = await csvDownloadPromise;
    const csvPath = await csvDownload.path();
    const csv = fs.readFileSync(csvPath, 'utf8');
    if (!csv.includes('指标') || !csv.includes('时间 (d)') || !csvDownload.suggestedFilename().endsWith('.csv')) {
      throw new Error('CSV 导出内容或文件名不正确');
    }

    const jsonDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#export-json');
    const jsonDownload = await jsonDownloadPromise;
    const jsonPath = await jsonDownload.path();
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!json.metrics || !json.series || !jsonDownload.suggestedFilename().endsWith('.json')) {
      throw new Error('JSON 导出内容或文件名不正确');
    }

    await page.selectOption('#optimization-evaluations', '4');
    await page.click('#run-optimization');
    await waitText(page, '#optimization-status', '优化完成', 420000);
    const paretoRows = await page.locator('#optimization-result tbody tr').count();
    if (paretoRows < 1) throw new Error('优化结果没有 Pareto 行');

    await page.screenshot({ path: path.join(ARTIFACTS, 'studio.png'), fullPage: true });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(JSON.stringify({
      result: 'PASS',
      cards,
      csv: csvDownload.suggestedFilename(),
      json: jsonDownload.suggestedFilename(),
      paretoRows,
      screenshot: 'artifacts/e2e/studio.png',
    }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`E2E FAIL: ${error.message}`);
  process.exit(1);
});
