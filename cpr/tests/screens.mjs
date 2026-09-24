/**
 * screens.mjs — 用假鏡頭把每個畫面走一遍並截圖（淺色 + 深色），同時收集 console 錯誤
 *   node tests/screens.mjs <normal.y4m> <outDir>
 * 需先啟動靜態伺服器：python3 -m http.server 8080
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const [y4m, outDir = 'tests/out/screens'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8080';

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];

async function run(scheme) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    permissions: ['camera', 'microphone', 'geolocation'],
    geolocation: { latitude: 25.0418, longitude: 121.5327 },
    locale: 'zh-TW',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${scheme}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_TUNNEL|404|Failed to load resource/.test(m.text())) errors.push(`[${scheme}] console: ${m.text()}`);
  });
  const shot = (name, opts = {}) => page.screenshot({ path: `${outDir}/${scheme}-${name}.png`, ...opts });

  // 首次導覽（未 onboarded）
  await page.goto(`${BASE}/index.html#home`);
  await page.waitForTimeout(500);
  await shot('00-intro-1');
  await page.click('#btnIntroNext');
  await page.waitForTimeout(300);
  await shot('00-intro-2');
  await page.click('#btnIntroNext');
  await page.waitForTimeout(300);
  await shot('00-intro-3');
  await page.click('#btnGrantPerms');
  await page.waitForTimeout(1500);
  await page.check('#chkAgree');
  await page.click('#btnIntroNext');
  await page.waitForTimeout(400);
  await shot('01-home');

  await page.click('[data-nav="check-respond"]');
  await page.waitForTimeout(400);
  await shot('02-respond');
  await page.click('[data-nav="responsive"]');
  await page.waitForTimeout(300);
  await shot('02b-responsive');

  await page.goto(`${BASE}/index.html#check-breath`);
  await page.waitForFunction(() => document.querySelector('#cam').videoWidth > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot('03-camera');
  await page.click('#btnStartObs');
  await page.waitForTimeout(4000);
  await shot('04-observing');
  await page.waitForFunction(() => location.hash.startsWith('#result'), null, { timeout: 25000 });
  await page.waitForTimeout(700);
  await shot('05-result-normal');
  const verdict = await page.evaluate(() => window.__cpr.lastResult.verdict);
  console.log(`[${scheme}] verdict:`, verdict);

  // 用假結果看「疑似瀕死呼吸」畫面
  await page.evaluate(() => {
    const r = window.__cpr.lastResult;
    window.__cpr.lastResult = { ...r, verdict: 'agonal', label: '疑似瀕死呼吸', recommendCPR: true, reasons: ['起伏之間曾間隔 6.2 秒', '起伏短促、其餘時間胸口靜止（喘息樣）'], confidence: 0.8 };
  });
  await page.goto(`${BASE}/index.html#home`);
  await page.waitForTimeout(200);
  await page.goto(`${BASE}/index.html#result`);
  await page.waitForTimeout(600);
  await shot('05-result-agonal');

  // CPR
  await page.click('#resultActions .btn-primary');
  await page.waitForTimeout(2600);
  await shot('06-cpr-c');
  await page.click('[data-step="call2"]');
  await page.waitForTimeout(500);
  await shot('06-cpr-call2');
  await page.click('[data-step="d"]');
  await page.waitForTimeout(300);
  await shot('07-cpr-d');
  await page.click('#btnAedPause');
  await page.waitForTimeout(300);
  await page.click('#btnAedResume');
  await page.waitForTimeout(1500);
  await page.click('#btnToEnd');
  await page.waitForTimeout(400);
  await shot('08-cpr-end');
  const total = await page.textContent('#statTotal');
  console.log(`[${scheme}] compressions counted:`, total);

  await page.goto(`${BASE}/index.html#aed`);
  await page.waitForTimeout(2500);
  await shot('09-aed');
  await page.goto(`${BASE}/index.html#learn`);
  await page.waitForTimeout(300);
  await shot('10-learn', { fullPage: true });
  await page.goto(`${BASE}/index.html#settings`);
  await page.waitForTimeout(300);
  await shot('11-settings', { fullPage: true });
  await ctx.close();
}

await run('light');
await run('dark');
await browser.close();
if (errors.length) {
  console.log('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('OK, screenshots in', outDir);
