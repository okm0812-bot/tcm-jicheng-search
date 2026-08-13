#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
岐黃尋 — 全文檢索索引建置腳本

用途：
    掃描 data/books/*.json，重新產生 data/bigram-shards/ 底下的雙字元索引分片。
    新增典籍、或修改 char-normalize-map.json 之後，重新跑這支腳本即可更新索引。

設計原則（跟 app.js 的 fullTextSearchTerm 搭配使用，缺一不可）：
    1. 索引只負責「快速篩出候選典籍」，不是最終答案。
       雙字元交集只能證明「這兩個字各自都在書裡出現過」，
       不能保證這幾個字連續組成你要找的完整字串（會有假命中）。
    2. 因此 app.js 在拿到候選典籍清單後，一定要再實際下載該書全文、
       用字串比對確認真的有出現，並在文中找出正確位置與命中次數。
       這支腳本只做「建索引」，不要拿掉 app.js 那段驗證邏輯。
    3. 分片檔名採用「bigram 第一個字的 Unicode code point（16 進位）」，
       跟 app.js 的 getShard() 用同一套規則，兩邊改動要一起改。

用法：
    python3 scripts/build_index.py

執行時間：約 1-2 分鐘（803 部典籍、約 1 億字）。
"""

import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
BOOKS_DIR = os.path.join(DATA_DIR, "books")
SHARDS_DIR = os.path.join(DATA_DIR, "bigram-shards")
BOOKS_INDEX_FILE = os.path.join(DATA_DIR, "books-index.json")
NORMALIZE_FILE = os.path.join(DATA_DIR, "char-normalize-map.json")


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def normalize(text, char_map):
    return "".join(char_map.get(ch, ch) for ch in text)


def main():
    t0 = time.time()
    print("=" * 50)
    print("岐黃尋 — 全文檢索索引建置")
    print("=" * 50)

    if not os.path.isdir(BOOKS_DIR):
        print(f"[錯誤] 找不到典籍資料夾：{BOOKS_DIR}")
        return

    norm_map = load_json(NORMALIZE_FILE) if os.path.exists(NORMALIZE_FILE) else {}
    print(f"[OK] 載入字元正規化表：{len(norm_map)} 筆")

    books_index = load_json(BOOKS_INDEX_FILE)
    print(f"[OK] 載入書目清單：{len(books_index)} 部")

    bigram_to_books = {}  # bigram -> list[book_index]

    for i, b in enumerate(books_index):
        path = os.path.join(BOOKS_DIR, b["id"] + ".json")
        if not os.path.exists(path):
            print(f"[警告] 找不到典籍檔案，略過：{path}")
            continue
        data = load_json(path)
        full_text = "".join(ch.get("content", "") for ch in data.get("chapters", []))
        norm_text = normalize(full_text, norm_map)

        seen = set()
        for j in range(len(norm_text) - 1):
            seen.add(norm_text[j:j + 2])

        for bg in seen:
            bigram_to_books.setdefault(bg, []).append(i)

        if (i + 1) % 100 == 0 or i == len(books_index) - 1:
            print(f"  已處理 {i + 1}/{len(books_index)} 部，耗時 {time.time() - t0:.1f}s")

    print(f"[OK] 總計 {len(bigram_to_books)} 個不重複雙字元")

    # 清空舊分片，避免殘留過期資料
    if os.path.isdir(SHARDS_DIR):
        for fn in os.listdir(SHARDS_DIR):
            os.remove(os.path.join(SHARDS_DIR, fn))
    os.makedirs(SHARDS_DIR, exist_ok=True)

    shards = {}
    for bg, books in bigram_to_books.items():
        shards.setdefault(bg[0], {})[bg] = books

    for first_char, d in shards.items():
        fname = f"{ord(first_char):x}.json"
        with open(os.path.join(SHARDS_DIR, fname), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))

    print(f"[完成] 產生 {len(shards)} 個分片檔案，總耗時 {time.time() - t0:.1f}s")

    # 簡單自我測試，確認索引結果合理
    print("\n測試幾個常見詞：")
    for term in ["大黃蟅蟲丸", "黃芪", "咳嗽", "一貫煎"]:
        norm_term = normalize(term, norm_map)
        candidate = None
        for k in range(len(norm_term) - 1):
            bg = norm_term[k:k + 2]
            shard = shards.get(bg[0], {})
            books = set(shard.get(bg, []))
            candidate = books if candidate is None else candidate & books
            if not candidate:
                break
        n = len(candidate) if candidate else 0
        print(f"  {term} -> {n} 部典籍包含全部雙字元組合（實際命中數仍須經 app.js 全文驗證確認）")


if __name__ == "__main__":
    main()
