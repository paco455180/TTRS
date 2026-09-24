/**
 * e2e.mjs — 用 Playwright + Chromium 假鏡頭做端對端測試
 *
 *   node tests/e2e.mjs <scenario> <y4m 路徑> [截圖資料夾]
 *
 * 需要先啟動靜態伺服器：python3 -m http.server 8080
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const [scenario, y4m, shotDir = 'shots'] = process.argv.slice(2);
if (!scenario || !y4m) {
  console.error('usage: node tests/e2e.mjs <normal|none|agonal> <file.y4m> [shotDir]');
  process.exit(2);
}
fs.mkdirSync(shotDir, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8080';

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  permissions: ['camera', 'microphone', 'geolocation'],
  geolocation: { latitude: 25.0418, longitude: 121.5327 },
  locale: 'zh-TW',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(`${BASE}/index.html#home`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${shotDir}/01-home.png` });

await page.click('[data-nav="check-respond"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${shotDir}/02-respond.png` });

await page.click('[data-nav="check-breath"]');
await page.waitForSelector('#btnStartObs');
await page.waitForFunction(() => document.querySelector('#cam').videoWidth > 0, null, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shotDir}/03-camera.png` });

await page.click('#btnStartObs');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${shotDir}/04-observing.png` });

await page.waitForFunction(() => location.hash.startsWith('#result'), null, { timeout: 25000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shotDir}/05-result-${scenario}.png` });
const result = await page.evaluate(() => {
  const r = window.__cpr.lastResult;
  return {
    verdict: r.verdict,
    label: r.label,
    recommendCPR: r.recommendCPR,
    reasons: r.reasons,
    breaths: r.motion?.breaths,
    rate: r.motion?.rate,
    quality: r.motion?.quality,
    fps: r.motion?.fps,
    durationSec: r.motion?.durationSec,
    signal: r.motion?.signalName,
    activeFrac: r.motion?.activeFrac,
    audio: r.audio && { bursts: r.audio.bursts, noisy: r.audio.noisy, gaspLike: r.audio.gaspLike },
  };
});
console.log(JSON.stringify({ scenario, result }, null, 2));

// CPR 畫面
await page.goto(`${BASE}/index.html#cpr?step=c`);
await page.waitForTimeout(500);
await page.click('#btnMetro');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${shotDir}/06-cpr.png` });
const count = await page.textContent('#metroCount');
console.log('metronome count after 2.5s:', count);
await page.click('[data-step="d"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${shotDir}/07-aed-step.png` });

// AED 地圖
await page.goto(`${BASE}/index.html#aed`);
await page.waitForTimeout(3500);
await page.screenshot({ path: `${shotDir}/08-aed-map.png` });
const aedStatus = await page.textContent('#aedStatus');
console.log('aed status:', aedStatus);

await page.goto(`${BASE}/index.html#learn`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shotDir}/09-learn.png`, fullPage: true });
await page.goto(`${BASE}/index.html#settings`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shotDir}/10-settings.png` });

const expected = { normal: 'normal', none: 'none', agonal: 'agonal' }[scenario];
const ok = result.verdict === expected;
console.log(ok ? `PASS verdict=${result.verdict}` : `FAIL expected ${expected} got ${result.verdict}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();
process.exit(ok && !errors.some((e) => e.startsWith('pageerror')) ? 0 : 1);
