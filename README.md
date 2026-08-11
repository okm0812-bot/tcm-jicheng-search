# 岐黃尋 — 中醫典籍病名檢索

純前端（靜態網頁）中醫典籍檢索工具，可依「現代病名」或「古代病名」搜尋，並自動提示古今病名對照，找出典籍中相關段落。

## 專案結構

```
.
├── index.html          # 主頁面
├── style.css           # 樣式（設計系統：宣紙、墨、硃砂印）
├── app.js              # 前端邏輯（搜尋、對照、閱讀器）
├── README.md
└── data/
    ├── books-index.json    # 803 部典籍的中繼資料（書名/作者/朝代/分類），約 1.1MB，頁面載入時直接讀取
    ├── disease-map.json    # 118 筆古今病名對照表（可自行擴充）
    ├── term-index.json     # 約 1.9 萬個病證詞彙的全文索引（詞 → 出現典籍與次數），約 3.3MB，首次搜尋時才載入
    └── books/               # 803 個典籍內容檔（每部書一個 JSON），使用者點開某本書時才會載入
```

資料來源：中醫笈成（jicheng.tw）公開典籍資料，共 803 部、約 8700 個篇章。

## 如何運作

1. 頁面載入時只抓取 `books-index.json`（書目清單）與 `disease-map.json`（病名對照表），總計約 1.2MB，速度很快。
2. 使用者輸入病名時，即時比對 `disease-map.json`，若輸入的是現代病名，會列出對應的古代病名（反之亦然）。
3. 第一次執行搜尋時，才會載入 `term-index.json`（全文詞彙索引），之後留在瀏覽器快取中，不用重複下載。
4. 點擊某本典籍時，才會抓取該書自己的 JSON 檔（`data/books/書名.json`），並在內文中標出符合的詞語、支援上一個/下一個跳轉。

這樣設計是因為全部典籍解壓後約 290MB，不適合一次全部載入瀏覽器；改成「先查索引、再依需要載入內容」，可以讓純靜態網站（GitHub Pages）也能提供接近全文搜尋的體驗。

## 部署到 GitHub Pages

### 方法一：使用 Git 指令（建議，檔案數量多時比網頁上傳穩定）

```bash
# 1. 在 GitHub 上新增一個空的 repository，例如命名為 tcm-jicheng-search
#    （不要勾選自動加入 README/.gitignore）

# 2. 進入這個資料夾，初始化 git
cd 岐黃尋   # 或你解壓縮後的資料夾名稱
git init
git add .
git commit -m "建立中醫典籍病名檢索網站"

# 3. 連結到你的 GitHub repo（記得換成你自己的帳號與 repo 名稱）
git branch -M main
git remote add origin https://github.com/你的帳號/tcm-jicheng-search.git
git push -u origin main
```

> 65MB 壓縮檔解開後變成很多獨立小檔案，`git push` 第一次會花一點時間上傳（約 300MB），請保持網路穩定，不要中斷。

### 開啟 GitHub Pages

1. 到你的 repo 頁面 → **Settings** → 左側選單 **Pages**
2. **Source** 選擇 `Deploy from a branch`
3. **Branch** 選擇 `main`，資料夾選擇 `/ (root)`，按 **Save**
4. 等待 1–2 分鐘，頁面會顯示網址，格式通常是：
   `https://你的帳號.github.io/tcm-jicheng-search/`

### 之後更新資料或程式碼

```bash
git add .
git commit -m "更新內容"
git push
```

## 之後可以擴充的方向

- **擴充病名對照表**：直接編輯 `data/disease-map.json`，格式為：
  ```json
  {"modern": "現代病名", "ancient": ["古代病名1", "古代病名2"], "note": "說明文字（可留空字串）"}
  ```
  新增後不需要重新處理典籍資料，重新整理頁面即可生效。

- **重新產生全文索引**：若日後要更新典籍資料本身，`data/books/` 與 `data/term-index.json` 是由原始 .7z 檔案透過 Python 腳本自動產生的（腳本邏輯：解析 DokuWiki 格式標記、擷取 `<book>` 中繼資料、掃描病證詞彙建立索引）。若你需要，我可以之後幫你把產生腳本一併整理進repo（例如 `scripts/build_data.py`），方便未來更新典籍時重新產生。

- **免責聲明**：頁面下方已加註「古今病名對照僅供臨床參考與文獻檢索輔助」的提醒，建議正式對外使用前，可請中醫師審閱 `disease-map.json` 的對照內容是否恰當。
