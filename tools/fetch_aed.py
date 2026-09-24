#!/usr/bin/env python3
"""
fetch_aed.py — 下載衛福部「公共場所 AED 急救資訊網」開放資料（CSV，每日更新），
轉成 app 使用的精簡 JSON：data/aed.json

用法：
  python3 tools/fetch_aed.py                 # 直接下載
  python3 tools/fetch_aed.py --csv aed.csv   # 已手動下載的 CSV

資料來源（政府資料開放平臺 #12063）：https://tw-aed.mohw.gov.tw/openData?t=csv
欄位名稱會以關鍵字自動比對（場所名稱／地址／緯度／經度／放置地點／開放時間），
因此官方欄位小幅變動時仍可運作；比對不到時會列出實際欄位讓你指定。
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.request

URL = 'https://tw-aed.mohw.gov.tw/openData?t=csv'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'aed.json')

KEYS = {
    'name': ['場所名稱', '設置場所', '場所', '機構名稱', 'name'],
    'addr': ['地址', '場所地址', 'address'],
    'lat': ['緯度', 'lat', 'latitude', 'WGS84緯度'],
    'lng': ['經度', 'lng', 'lon', 'longitude', 'WGS84經度'],
    'place': ['放置地點', '放置位置', '位置描述', '設置位置', 'location'],
    'hours': ['開放時間', '開放時段', '可使用時間', 'hours'],
}


def pick(header, cands):
    hl = [h.strip() for h in header]
    for c in cands:
        for i, h in enumerate(hl):
            if c.lower() == h.lower():
                return i
    for c in cands:
        for i, h in enumerate(hl):
            if c.lower() in h.lower():
                return i
    return None


def load_csv_bytes(path=None):
    if path:
        with open(path, 'rb') as f:
            return f.read()
    req = urllib.request.Request(URL, headers={'User-Agent': 'cpr-guardian-fetch/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def decode(b):
    for enc in ('utf-8-sig', 'utf-8', 'cp950', 'big5'):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode('utf-8', errors='replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', help='已下載的 CSV 路徑')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--map', help='手動指定欄位，例如 name=場所名稱,lat=緯度,lng=經度')
    args = ap.parse_args()

    raw = load_csv_bytes(args.csv)
    text = decode(raw)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        sys.exit('CSV 沒有內容')
    header = rows[0]
    idx = {k: pick(header, v) for k, v in KEYS.items()}
    if args.map:
        for kv in args.map.split(','):
            k, v = kv.split('=')
            idx[k.strip()] = header.index(v.strip())
    missing = [k for k in ('name', 'lat', 'lng') if idx.get(k) is None]
    if missing:
        print('找不到欄位：', missing)
        print('實際欄位：', header)
        print('請用 --map 指定，例如 --map name=場所名稱,lat=緯度,lng=經度')
        sys.exit(2)

    items = []
    bad = 0
    for r in rows[1:]:
        try:
            lat = float(r[idx['lat']])
            lng = float(r[idx['lng']])
        except (ValueError, IndexError):
            bad += 1
            continue
        if not (21.5 <= lat <= 26.5 and 118 <= lng <= 123):  # 台灣範圍（含離島）
            bad += 1
            continue

        def g(k):
            i = idx.get(k)
            return r[i].strip() if i is not None and i < len(r) else ''

        items.append([round(lat, 6), round(lng, 6), g('name'), g('addr'), g('place'), g('hours')])

    out = {
        'updated': dt.date.today().isoformat(),
        'source': URL if not args.csv else os.path.basename(args.csv),
        'sample': False,
        'count': len(items),
        'items': items,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(args.out) / 1e6
    print(f'寫入 {args.out}：{len(items)} 筆（略過 {bad} 筆無效座標），{size:.1f} MB')


if __name__ == '__main__':
    main()
