#!/usr/bin/env python3
"""
make_fake_video.py — 產生 Chromium 假鏡頭用的 Y4M 影片（端對端測試）

  python3 tests/make_fake_video.py normal  out/normal.y4m
  python3 tests/make_fake_video.py none    out/none.y4m
  python3 tests/make_fake_video.py agonal  out/agonal.y4m

影片內容：帶紋理的背景 + 中央「胸口」區塊依情境上下位移（含次像素），並加入輕微手震與感測雜訊。
"""
import sys
import numpy as np

W, H, FPS, SEC = 480, 640, 15, 22
SUB = 8


def texture(rng, w, h, blur, contrast, base):
    raw = rng.standard_normal((h * SUB, w)).astype(np.float32)
    k = np.ones(2 * blur + 1, dtype=np.float32) / (2 * blur + 1)
    kv = np.ones(2 * blur * SUB + 1, dtype=np.float32) / (2 * blur * SUB + 1)
    t = np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 1, raw)
    t = np.apply_along_axis(lambda c: np.convolve(c, kv, mode='same'), 0, t)
    t = (t - t.mean()) / (t.std() + 1e-6) * contrast + base
    return t


def main():
    mode, out = sys.argv[1], sys.argv[2]
    rng = np.random.default_rng(1)
    bg = texture(rng, W, H, 10, 30, 120)
    ch = texture(rng, W, H, 6, 30, 120)
    # ROI（與 app 的 DEFAULT_ROI 相同比例）
    x0, y0 = int(0.18 * W), int(0.28 * H)
    x1, y1 = int((0.18 + 0.64) * W), int((0.28 + 0.44) * H)
    n = FPS * SEC
    shake = np.cumsum(rng.standard_normal(n) * 0.25)
    shake -= np.convolve(shake, np.ones(15) / 15, mode='same')

    def chest(t):
        if mode == 'normal':
            return 4.0 * np.sin(2 * np.pi * 0.25 * t)  # 15 次/分，振幅 4 px（480 寬）
        if mode == 'agonal':
            return sum(a * np.exp(-0.5 * ((t - c) / 0.4) ** 2) for c, a in [(1.5, 6), (7.0, 7), (14.5, 5), (19.5, 6)])
        return 0.0

    with open(out, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip C420jpeg\n'.encode())
        ys = np.arange(H)
        for i in range(n):
            t = i / FPS
            g = shake[i]
            d = chest(t)
            fr = np.empty((H, W), dtype=np.float32)
            iy = np.round((ys - g) * SUB).astype(int) % (H * SUB)
            fr[:] = bg[iy]
            iyc = np.round((ys[y0:y1] - g - d) * SUB).astype(int) % (H * SUB)
            fr[y0:y1, x0:x1] = ch[iyc][:, x0:x1]
            fr += rng.standard_normal(fr.shape).astype(np.float32) * 2.5
            y = np.clip(fr, 0, 255).astype(np.uint8)
            f.write(b'FRAME\n')
            f.write(y.tobytes())
            f.write(np.full((H // 2) * (W // 2), 128, dtype=np.uint8).tobytes())
            f.write(np.full((H // 2) * (W // 2), 128, dtype=np.uint8).tobytes())
    print('wrote', out)


if __name__ == '__main__':
    main()
