// ===== 岐黃尋 app.js =====
// Static, client-side only. No user data is sent anywhere.

const DATA_BASE = 'data';

const state = {
  booksIndex: null,       // array from books-index.json
  booksById: new Map(),
  diseaseMap: null,       // array from disease-map.json
  charNormalizeMap: null, // 簡體/異體字 -> 正規化字 對照表
  shardCache: new Map(),  // 雙字元索引分片快取: hexCodePoint -> {bigram:[bookIdx,...]}
  bookContentCache: new Map(), // bookId -> parsed book json (chapters etc.)
  currentQuery: '',
  currentMatches: [],     // indices of <mark> in reader for nav
  currentMatchPos: 0,
  searchToken: 0,          // 遞增序號，避免舊搜尋（較慢）蓋掉新搜尋（較快）的結果
  loadMore: null,          // 目前搜尋尚未驗證的候選典籍狀態，供「顯示更多」按鈕使用
  activeFilters: { categories: new Set(), dynasties: new Set() }, // 進階篩選：分類／朝代（多選）
};

const el = {
  searchInput: document.getElementById('searchInput'),
  searchIconBtn: document.getElementById('searchIconBtn'),
  autocompleteList: document.getElementById('autocompleteList'),
  corpusStats: document.getElementById('corpusStats'),
  resultsArea: document.getElementById('resultsArea'),
  landingArea: document.getElementById('landingArea'),
  mappingCard: document.getElementById('mappingCard'),
  resultsTitle: document.getElementById('resultsTitle'),
  resultsCount: document.getElementById('resultsCount'),
  bookResultsList: document.getElementById('bookResultsList'),
  noResults: document.getElementById('noResults'),
  categoryList: document.getElementById('categoryList'),
  landingCategoryList: document.getElementById('landingCategoryList'),
  filterToggleBtn: document.getElementById('filterToggleBtn'),
  filterPanel: document.getElementById('filterPanel'),
  filterCategoryOptions: document.getElementById('filterCategoryOptions'),
  filterDynastyOptions: document.getElementById('filterDynastyOptions'),
  filterClearBtn: document.getElementById('filterClearBtn'),
  activeFilterChips: document.getElementById('activeFilterChips'),
  bookCountLanding: document.getElementById('bookCountLanding'),
  readerOverlay: document.getElementById('readerOverlay'),
  readerTitle: document.getElementById('readerTitle'),
  readerMeta: document.getElementById('readerMeta'),
  chapterNav: document.getElementById('chapterNav'),
  chapterContent: document.getElementById('chapterContent'),
  readerClose: document.getElementById('readerClose'),
  matchNav: document.getElementById('matchNav'),
  matchPrev: document.getElementById('matchPrev'),
  matchNext: document.getElementById('matchNext'),
  matchCounter: document.getElementById('matchCounter'),
  loadingToast: document.getElementById('loadingToast'),
};

let loadingSafetyTimer = null;
function showLoading(msg){
  el.loadingToast.textContent = msg || '載入中…';
  el.loadingToast.hidden = false;
  // 每次顯示載入提示都重新設定保護計時器，避免任何一次操作卡住時提示永遠不消失
  if(loadingSafetyTimer) clearTimeout(loadingSafetyTimer);
  loadingSafetyTimer = setTimeout(()=>{
    console.warn('載入提示逾時，自動隱藏');
    el.loadingToast.hidden = true;
  }, 15000);
}
function hideLoading(){
  el.loadingToast.hidden = true;
  if(loadingSafetyTimer){ clearTimeout(loadingSafetyTimer); loadingSafetyTimer = null; }
}

// ===== 背景驗證 Worker =====
// 把「下載候選典籍全文 + 逐字掃描比對」搬到背景執行緒，避免候選數量一多就卡住主執行緒的
// 輸入框、捲動與其他 UI 互動。不支援 Worker 的環境（極少見）會自動退回主執行緒版本。
let verifyWorker = null;
let workerReqCounter = 0;
const workerPending = new Map();
try{
  if('Worker' in window){
    verifyWorker = new Worker('verify-worker.js');
    verifyWorker.onmessage = (e)=>{
      const msg = e.data;
      if(msg.type === 'verify-result' && workerPending.has(msg.reqId)){
        workerPending.get(msg.reqId)(msg.hits);
        workerPending.delete(msg.reqId);
      }
    };
    verifyWorker.onerror = (err)=>{
      console.warn('驗證 Worker 發生錯誤，之後的驗證將退回主執行緒處理：', err.message);
      verifyWorker = null; // 出錯就停用，改走 fallback，避免整站無法搜尋
    };
  }
}catch(err){
  console.warn('無法建立驗證 Worker，改用主執行緒驗證：', err);
  verifyWorker = null;
}

async function fetchJSON(path){
  const res = await fetch(path);
  if(!res.ok){
    const errMsg = `無法載入 ${path} (HTTP ${res.status})`;
    console.error(errMsg);
    // 顯示錯誤在 corpusStats
    const el2 = document.getElementById('corpusStats');
    if(el2) el2.textContent = errMsg;
    throw new Error(errMsg);
  }
  return res.json();
}

// ===== Init =====
async function init(){
  console.log('[DEBUG] init() start');
  try{
    console.log('[DEBUG] fetching books-index.json...');
    const booksIndex = await fetchJSON(`${DATA_BASE}/books-index.json`);
    console.log('[DEBUG] books-index loaded:', booksIndex.length, 'books');
    console.log('[DEBUG] fetching disease-map.json...');
    const diseaseMap = await fetchJSON(`${DATA_BASE}/disease-map.json`);
    console.log('[DEBUG] disease-map loaded:', diseaseMap.length, 'entries');
    console.log('[DEBUG] fetching char-normalize-map.json...');
    const charNormalizeMap = await fetchJSON(`${DATA_BASE}/char-normalize-map.json`);
    console.log('[DEBUG] char-normalize-map loaded:', Object.keys(charNormalizeMap).length, 'entries');

    state.booksIndex = booksIndex;
    state.diseaseMap = diseaseMap;
    state.charNormalizeMap = charNormalizeMap;
    booksIndex.forEach(b => state.booksById.set(b.id, b));

    const totalChars = booksIndex.reduce((s,b)=>s+b.charCount,0);
    el.corpusStats.textContent = `收錄 ${booksIndex.length} 部典籍・約 ${(totalChars/10000).toFixed(0)} 萬字`;
    el.bookCountLanding.textContent = booksIndex.length;
    console.log('[DEBUG] corpusStats set, bookCountLanding set');

    renderCategoryLists();
    renderFilterOptions();
    console.log('[DEBUG] renderCategoryLists done');

    // 把正規化表交給 Worker，之後每次驗證候選典籍時 Worker 才能自行做簡體/異體字比對
    if(verifyWorker) verifyWorker.postMessage({type:'init', charNormalizeMap});

    hideLoading();  // FIX: hide toast after init completes successfully
  }catch(err){
    console.error('[DEBUG] init() ERROR:', err);
    hideLoading();
    const msg = '資料載入失敗: ' + err.message;
    el.corpusStats.textContent = msg;
    el.corpusStats.style.color = 'red';
    // 也在 landing 區顯示錯誤
    const landing = document.getElementById('landingArea');
    if(landing){
      landing.innerHTML = '<div style="padding:40px;color:red;font-size:1.1rem;">' + msg + '<br><br><button onclick="location.reload()">重新整理</button></div>';
    }
  }
}

function renderCategoryLists(){
  const counts = new Map();
  state.booksIndex.forEach(b=>{
    const cats = (b.category || '未分類').split(/\s+/);
    cats.forEach(c=>{
      counts.set(c, (counts.get(c)||0)+1);
    });
  });
  const sorted = [...counts.entries()].sort((a,b)=>b[1]-a[1]);

  el.categoryList.innerHTML = '';
  sorted.forEach(([cat,count])=>{
    const li = document.createElement('li');
    li.innerHTML = `<span>${cat}</span><span>${count}</span>`;
    li.addEventListener('click', ()=> browseCategory(cat));
    el.categoryList.appendChild(li);
  });

  el.landingCategoryList.innerHTML = '';
  sorted.slice(0,16).forEach(([cat,count])=>{
    const li = document.createElement('li');
    li.innerHTML = `<span>${cat}</span><span>${count}</span>`;
    li.addEventListener('click', ()=> browseCategory(cat));
    el.landingCategoryList.appendChild(li);
  });
}

function browseCategory(cat){
  el.searchInput.value = '';
  state.currentQuery = ''; // 清空上次搜尋詞，避免點進典籍時錯誤標記到不相關的舊搜尋字
  state.loadMore = null;   // 分類瀏覽不是全文檢索，清掉上次搜尋殘留的「顯示更多」狀態
  const dynasties = state.activeFilters.dynasties;
  const books = state.booksIndex.filter(b =>
    (b.category||'').split(/\s+/).includes(cat) &&
    (dynasties.size === 0 || dynasties.has(b.dynasty || '朝代不詳')) // 分類是使用者剛點的，這裡只需再套用朝代篩選，跟搜尋時的邏輯一致
  );
  showResults({
    title: `分類：${cat}`,
    mapping: null,
    bookResults: books.map(b=>({book:b, count:null, terms:[]})),
  });
}

// ===== 進階篩選（分類／朝代）=====
// 概念參考自同量級古籍全文檢索系統（如 CBETA 閱讀器）的標準配置：
// 讓使用者可以自行先縮小搜尋範圍，範圍以外的候選不會出現在結果裡，且隨時可見、可清除。
function renderFilterOptions(){
  const catCounts = new Map(), dynCounts = new Map();
  state.booksIndex.forEach(b=>{
    (b.category || '未分類').split(/\s+/).forEach(c => catCounts.set(c, (catCounts.get(c)||0)+1));
    const dyn = b.dynasty || '朝代不詳';
    dynCounts.set(dyn, (dynCounts.get(dyn)||0)+1);
  });

  const buildOptions = (counts, container, filterSet) => {
    container.innerHTML = '';
    [...counts.entries()].sort((a,b)=>b[1]-a[1]).forEach(([name,count])=>{
      const label = document.createElement('label');
      label.className = 'filter-option';
      const checked = filterSet.has(name) ? 'checked' : '';
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(name)}" ${checked}> ${escapeHtml(name)}（${count}）`;
      label.querySelector('input').addEventListener('change', (e)=>{
        if(e.target.checked) filterSet.add(name); else filterSet.delete(name);
        renderActiveFilterChips();
        if(state.currentQuery) runSearch(state.currentQuery); // 篩選一改變就立刻套用到目前的搜尋結果
      });
      container.appendChild(label);
    });
  };

  buildOptions(catCounts, el.filterCategoryOptions, state.activeFilters.categories);
  buildOptions(dynCounts, el.filterDynastyOptions, state.activeFilters.dynasties);
  renderActiveFilterChips();
}

function renderActiveFilterChips(){
  const chips = [
    ...[...state.activeFilters.categories].map(v => ({type:'categories', value:v})),
    ...[...state.activeFilters.dynasties].map(v => ({type:'dynasties', value:v})),
  ];
  el.activeFilterChips.innerHTML = '';
  chips.forEach(chip=>{
    const span = document.createElement('span');
    span.className = 'filter-chip';
    span.textContent = chip.value;
    span.title = '點擊移除此篩選';
    span.addEventListener('click', ()=>{
      state.activeFilters[chip.type].delete(chip.value);
      renderFilterOptions(); // 連同勾選框一起同步取消
      if(state.currentQuery) runSearch(state.currentQuery);
    });
    el.activeFilterChips.appendChild(span);
  });
  el.filterToggleBtn.textContent = chips.length ? `進階篩選（${chips.length}）▾` : '進階篩選▾';
  el.filterToggleBtn.classList.toggle('has-active', chips.length > 0);
}

// 「進階篩選」按鈕跟搜尋圖示一樣，常常是使用者剛打完字後緊接著點擊，
// 一樣可能遇到鍵盤收合造成的畫面重排讓 click 沒觸發，所以也用同樣的 touchend 處理。
function toggleFilterPanel(e){
  if(e.cancelable) e.preventDefault();
  el.filterPanel.hidden = !el.filterPanel.hidden;
}
el.filterToggleBtn.addEventListener('click', toggleFilterPanel);
el.filterToggleBtn.addEventListener('touchend', toggleFilterPanel, {passive:false});
el.filterClearBtn.addEventListener('click', ()=>{
  state.activeFilters.categories.clear();
  state.activeFilters.dynasties.clear();
  renderFilterOptions();
  if(state.currentQuery) runSearch(state.currentQuery);
});
document.addEventListener('click', (e)=>{
  if(!el.filterPanel.hidden && !el.filterPanel.contains(e.target) && e.target !== el.filterToggleBtn){
    el.filterPanel.hidden = true;
  }
});

// 判斷某本典籍（依索引）是否符合目前的分類／朝代篩選；沒有勾選任何篩選時一律通過
function passesFilters(idx){
  const {categories, dynasties} = state.activeFilters;
  if(categories.size === 0 && dynasties.size === 0) return true;
  const b = state.booksIndex[idx];
  if(!b) return false;
  const cats = (b.category || '未分類').split(/\s+/);
  const dyn = b.dynasty || '朝代不詳';
  const catOk = categories.size === 0 || cats.some(c => categories.has(c));
  const dynOk = dynasties.size === 0 || dynasties.has(dyn);
  return catOk && dynOk;
}

// ===== 全文檢索引擎 =====
// 原理：把查詢字串正規化（簡體轉繁體 + 中醫常見異體字統一），
// 拆成連續雙字元（bigram），用預先建立好的分片索引找出「可能包含」
// 這個字串的候選典籍，再實際抓取候選典籍全文逐一驗證比對，
// 找出真正出現的段落並標記命中次數。

function normalizeText(text){
  const map = state.charNormalizeMap || {};
  let out = '';
  for(const ch of text){
    out += map[ch] || ch;
  }
  return out;
}

// 依字元取得雙字元索引分片（有快取，找不到回傳空物件而不是報錯）
// 快取存的是 Promise 本身（而非等下載完的結果），避免多個搜尋詞同時搶著抓同一個分片時重複發送請求
function getShard(ch){
  const hex = ch.codePointAt(0).toString(16);
  if(state.shardCache.has(hex)) return state.shardCache.get(hex);
  const promise = fetch(`${DATA_BASE}/bigram-shards/${hex}.json`)
    .then(res => res.ok ? res.json() : {})
    .catch(() => ({}));
  state.shardCache.set(hex, promise);
  return promise;
}

// 取得典籍全文內容（有快取，供搜尋驗證與閱讀器共用，避免重複下載）
// 同樣快取 Promise 本身，避免多個搜尋詞同時要驗證同一本書時重複下載
function getBookContent(bookId){
  if(state.bookContentCache.has(bookId)) return state.bookContentCache.get(bookId);
  const promise = fetchJSON(`${DATA_BASE}/books/${encodeURIComponent(bookId)}.json`)
    .catch(err => { state.bookContentCache.delete(bookId); throw err; }); // 失敗時清掉快取，允許之後重試
  state.bookContentCache.set(bookId, promise);
  return promise;
}

const MAX_CANDIDATE_BOOKS = 90;  // 每一批實際下載驗證的候選典籍數上限（超過的部分不會被丟棄，而是保留給「顯示更多」使用）
const FETCH_CONCURRENCY = 15;    // 候選典籍平行下載數，加速驗證階段

// 以固定併發數平行處理陣列，避免一次發出過多請求
async function mapWithConcurrency(items, limit, asyncFn){
  const results = [];
  let i = 0;
  async function worker(){
    while(i < items.length){
      const idx = i++;
      results[idx] = await asyncFn(items[idx], idx);
    }
  }
  const workers = Array.from({length: Math.min(limit, items.length)}, worker);
  await Promise.all(workers);
  return results;
}

// 計算某個查詢詞的候選典籍清單，依「相關度」（命中的雙字元索引數）由高到低排序。
// 這裡只算候選、不下載全文驗證，讓呼叫端可以自行決定要驗證前幾筆（供分批載入使用）。
//
// 排序邏輯特別說明：舊版是「一律依字數由小到大排序」，這會讓本草綱目、普濟方這類
// 字數龐大的重要典籍，只因為字數大就永遠排不進候選上限，跟關鍵字實際相不相關無關。
// 改成依「命中幾個雙字元」排序後，真正高度相關的大部頭典籍會排到前面；只有在
// 候選數量真的超過負荷、且相關度較低時，才會被排到後面等待「顯示更多」。
async function computeCandidates(term){
  const q = normalizeText(term.trim());
  if(!q) return {q, candidates: []};

  const relevance = new Map(); // bookIndex -> 命中雙字元數量（相關度分數的近似值）
  let candidateIndices;

  if(q.length === 1){
    // 單字查詢：以此字開頭的每個雙字元各自計一分，命中越多不同雙字元，代表此字在該書出現越頻繁
    const shard = await getShard(q[0]);
    Object.values(shard).forEach(arr => arr.forEach(i => relevance.set(i, (relevance.get(i)||0) + 1)));
    candidateIndices = [...relevance.keys()];
  } else {
    // 多字查詢：先平行抓取全部雙字元分片（取代舊版逐一 await），減少查詢字越長、
    // 網路往返延遲越高的問題；再依序取交集找出同時包含所有雙字元的典籍。
    const bigrams = [];
    for(let i = 0; i < q.length - 1; i++) bigrams.push(q.slice(i, i+2));
    const shards = await Promise.all(bigrams.map(bg => getShard(bg[0])));

    let candidateSet = null;
    for(let i = 0; i < bigrams.length; i++){
      const bookList = shards[i][bigrams[i]] || [];
      bookList.forEach(b => relevance.set(b, (relevance.get(b)||0) + 1));
      const bookSet = new Set(bookList);
      candidateSet = candidateSet === null ? bookSet : new Set([...candidateSet].filter(x => bookSet.has(x)));
      if(candidateSet.size === 0) break; // 交集已空，不可能有結果，提早結束
    }
    candidateIndices = candidateSet ? [...candidateSet] : [];
  }

  candidateIndices.sort((a, b) => {
    const ra = relevance.get(a) || 0, rb = relevance.get(b) || 0;
    if(rb !== ra) return rb - ra; // 相關度高的優先
    const ca = Number(state.booksIndex[a]?.charCount) || Infinity;
    const cb = Number(state.booksIndex[b]?.charCount) || Infinity;
    return ca - cb; // 相關度相同時，字數小的優先（下載較快）
  });

  return {q, candidates: candidateIndices, relevance};
}

// ===== 多詞 AND 搜尋（例如輸入「黃芪 消渴」，用空格/頓號/逗號分隔） =====
// 標準的多詞搜尋作法：先用候選數最少（最稀有、最具篩選力）的詞縮小範圍，
// 再依序跟其他詞的候選集合取交集，最後才對縮小後的候選批次做全文驗證，
// 確保每一本入選的典籍是「所有詞都真的有出現」而不是只出現其中一個詞。
async function computeAndCandidates(subTerms){
  const results = await Promise.all(subTerms.map(t => computeCandidates(t)));
  const valid = results.filter(r => r.q); // 防禦：正規化後變空字串的子詞（理論上不會發生，外層已過濾）就跳過

  if(valid.length === 0) return {subQueries: [], candidates: []};
  if(valid.length === 1) return {subQueries: [valid[0].q], candidates: valid[0].candidates};

  valid.sort((a,b)=> a.candidates.length - b.candidates.length);
  let candidateSet = new Set(valid[0].candidates);
  for(let i = 1; i < valid.length; i++){
    const s = new Set(valid[i].candidates);
    candidateSet = new Set([...candidateSet].filter(x => s.has(x)));
    if(candidateSet.size === 0) break;
  }

  // 相關度＝每個子詞各自命中雙字元數的加總，交集後的候選通常已經不多，
  // 這裡排序主要是決定「萬一還是超過批次上限，優先驗證誰」
  const candidates = [...candidateSet].sort((a,b)=>{
    let ra = 0, rb = 0;
    valid.forEach(r=>{ ra += r.relevance.get(a) || 0; rb += r.relevance.get(b) || 0; });
    if(rb !== ra) return rb - ra;
    const ca = Number(state.booksIndex[a]?.charCount) || Infinity;
    const cb = Number(state.booksIndex[b]?.charCount) || Infinity;
    return ca - cb;
  });

  return {subQueries: valid.map(r=>r.q), candidates};
}

// 對一批候選典籍，驗證是否「同時」包含所有子詞（AND）；任一子詞在某本書比對次數為 0，整本排除。
// 回傳 Map(bookIndex -> {count, rawMatches:Set})，count 是各子詞比對次數加總，
// rawMatches 是各子詞比對到的原文寫法聯集（供後續在典籍內文中一起標亮）。
async function verifyAndCandidates(subQueries, indices){
  const result = new Map();
  if(indices.length === 0 || subQueries.length === 0) return result;
  if(subQueries.length === 1) return verifyCandidates(subQueries[0], indices);

  const perTermHits = await Promise.all(subQueries.map(sq => verifyCandidates(sq, indices)));

  indices.forEach(idx=>{
    let totalCount = 0;
    const rawMatches = new Set();
    const allPresent = perTermHits.every(hits=>{
      const rec = hits.get(idx);
      if(!rec || rec.count === 0) return false;
      totalCount += rec.count;
      rec.rawMatches.forEach(t => rawMatches.add(t));
      return true;
    });
    if(allPresent) result.set(idx, {count: totalCount, rawMatches});
  });
  return result;
}

// 對一批候選典籍索引，實際下載全文並驗證關鍵字實際出現的位置與次數
// 回傳 Map(bookIndex -> {count, rawMatches:Set})
// 優先透過背景 Worker 執行（下載+掃描比對都不佔用主執行緒）；Worker 不可用時退回主執行緒版本。
async function verifyCandidates(q, indices){
  const result = new Map();
  if(indices.length === 0) return result;

  if(verifyWorker){
    const items = indices
      .map(idx => ({idx, bookId: state.booksIndex[idx]?.id}))
      .filter(item => item.bookId);
    const hits = await new Promise((resolve)=>{
      const reqId = ++workerReqCounter;
      workerPending.set(reqId, resolve);
      verifyWorker.postMessage({type:'verify', reqId, q, dataBase: DATA_BASE, items});
    });
    hits.forEach(h=>{
      const bookMeta = state.booksIndex[h.idx];
      if(bookMeta) result.set(h.idx, {count: h.count, rawMatches: new Set(h.rawMatches), book: bookMeta});
    });
    return result;
  }

  // Fallback：Worker 不可用時，在主執行緒逐一驗證（邏輯與 Worker 版本相同）
  await mapWithConcurrency(indices, FETCH_CONCURRENCY, async (idx)=>{
    const bookMeta = state.booksIndex[idx];
    if(!bookMeta) return;
    let data;
    try{
      data = await getBookContent(bookMeta.id);
    }catch(err){ return; }
    const fullText = data.chapters.map(ch => ch.content || '').join('');
    const normFull = normalizeText(fullText);

    let count = 0;
    const rawMatches = new Set();
    let pos = normFull.indexOf(q);
    while(pos !== -1){
      count++;
      rawMatches.add(fullText.slice(pos, pos + q.length));
      pos = normFull.indexOf(q, pos + 1);
    }
    if(count > 0) result.set(idx, {count, rawMatches, book: bookMeta});
  });
  return result;
}

// 對單一關鍵字做全文檢索：算出候選、套用篩選後驗證前 MAX_CANDIDATE_BOOKS 筆。
// 供古今病名對照延伸出的查詢詞使用（這類詞通常較具體，候選數較少，暫不做分批載入）。
async function fullTextSearchTerm(term){
  const {q, candidates} = await computeCandidates(term);
  if(!q) return new Map();
  // 篩選要在截斷之前套用，否則使用者開了分類/朝代篩選時，驗證名額可能被
  // 「反正會被篩掉」的書佔走，導致真正符合篩選的書因為名額用完而沒被驗證到
  const filtered = candidates.filter(passesFilters);
  return verifyCandidates(q, filtered.slice(0, MAX_CANDIDATE_BOOKS));
}

// ===== Autocomplete =====
let acItems = [];
let acActiveIndex = -1;

function buildAutocomplete(query){
  if(!query){ el.autocompleteList.hidden = true; return; }
  if(!state.diseaseMap || !state.booksIndex) return; // 資料尚未載入完成，先不處理，避免報錯
  const q = query.trim();
  const results = [];

  state.diseaseMap.forEach(entry=>{
    if(entry.modern.includes(q)){
      results.push({type:'modern', label: entry.modern, sub: entry.ancient.join('、'), entry});
    }
    entry.ancient.forEach(a=>{
      if(a.includes(q)){
        results.push({type:'ancient', label: a, sub: `→ ${entry.modern}`, entry});
      }
    });
  });

  // book title matches
  state.booksIndex.forEach(b=>{
    if(b.title.includes(q)){
      results.push({type:'book', label: b.title, sub: `${b.author||''} ${b.dynasty||''}`, book:b});
    }
  });

  acItems = results.slice(0, 12);
  acActiveIndex = -1;
  renderAutocomplete();
}

function renderAutocomplete(){
  if(acItems.length === 0){ el.autocompleteList.hidden = true; return; }
  el.autocompleteList.innerHTML = '';
  acItems.forEach((item, i)=>{
    const li = document.createElement('li');
    li.className = i === acActiveIndex ? 'active' : '';
    const tag = item.type === 'modern' ? '現代病名' : item.type === 'ancient' ? '古代病名' : '典籍';
    const tagClass = item.type === 'modern' ? 'ac-tag modern' : 'ac-tag';
    li.innerHTML = `
      <span><span class="ac-main">${escapeHtml(item.label)}</span></span>
      <span class="ac-sub">${escapeHtml(item.sub)} <span class="${tagClass}">${tag}</span></span>
    `;
    li.addEventListener('click', ()=>{
      el.searchInput.value = item.label;
      el.autocompleteList.hidden = true;
      runSearch(item.label);
    });
    el.autocompleteList.appendChild(li);
  });
  el.autocompleteList.hidden = false;
}

let autocompleteDebounceTimer = null;
let isComposing = false; // 中文輸入法（注音/拼音等）是否正在組字中

el.searchInput.addEventListener('compositionstart', ()=>{ isComposing = true; });
el.searchInput.addEventListener('compositionend', ()=>{
  isComposing = false;
  // 組字剛結束時，input 事件在部分瀏覽器/輸入法下可能已經先發生過（值還是組字中的狀態），
  // 這裡在組字真正結束的當下再觸發一次，確保自動完成拿到的是完整的中文字
  clearTimeout(autocompleteDebounceTimer);
  autocompleteDebounceTimer = setTimeout(()=> buildAutocomplete(el.searchInput.value), 0);
});

el.searchInput.addEventListener('input', ()=>{
  if(isComposing) return; // 組字過程中的中間狀態（例如注音符號、拼音字母）不觸發自動完成，避免顯示無意義的建議
  clearTimeout(autocompleteDebounceTimer);
  autocompleteDebounceTimer = setTimeout(()=> buildAutocomplete(el.searchInput.value), 120);
});

el.searchInput.addEventListener('keydown', (e)=>{
  // 輸入法組字中按下 Enter，通常是用來「確認選字」，不是使用者要送出搜尋——
  // 有些瀏覽器/輸入法組合下 e.isComposing 判斷不完全可靠，e.keyCode === 229 是常見的相容判斷方式
  if(e.isComposing || e.keyCode === 229) return;

  if(el.autocompleteList.hidden === false){
    if(e.key === 'ArrowDown'){ e.preventDefault(); acActiveIndex = Math.min(acActiveIndex+1, acItems.length-1); renderAutocomplete(); return; }
    if(e.key === 'ArrowUp'){ e.preventDefault(); acActiveIndex = Math.max(acActiveIndex-1, 0); renderAutocomplete(); return; }
    if(e.key === 'Escape'){ el.autocompleteList.hidden = true; return; }
  }
  if(e.key === 'Enter'){
    e.preventDefault();
    if(acActiveIndex >= 0 && acItems[acActiveIndex]){
      const item = acItems[acActiveIndex];
      el.searchInput.value = item.label;
    }
    el.autocompleteList.hidden = true;
    runSearch(el.searchInput.value);
  }
});

document.addEventListener('click', (e)=>{
  if(!el.searchInput.contains(e.target) && !el.autocompleteList.contains(e.target)){
    el.autocompleteList.hidden = true;
  }
});

// 搜尋框右側的「尋」字圖示：點擊直接執行搜尋，效果等同按下 Enter
// 手機上額外處理 touchend：輸入框失焦、虛擬鍵盤收合造成的畫面重排，
// 常常會讓瀏覽器之後合成的 click 事件對不準原本的觸控座標而沒有觸發，
// 改成在 touchend 當下就直接執行，並用 preventDefault() 避免之後又重複觸發一次 click。
function triggerSearchFromIcon(e){
  if(e.cancelable) e.preventDefault();
  el.autocompleteList.hidden = true;
  runSearch(el.searchInput.value);
}
el.searchIconBtn.addEventListener('click', triggerSearchFromIcon);
el.searchIconBtn.addEventListener('touchend', triggerSearchFromIcon, {passive:false});

// ===== Search =====
async function runSearch(rawQuery){
  const q = rawQuery.trim();
  if(!q) return;
  if(!state.booksIndex || !state.diseaseMap){
    showLoading('資料尚未載入完成，請稍候再試一次…');
    setTimeout(hideLoading, 2000);
    return;
  }
  // 序號機制：如果使用者又觸發了新的搜尋，這次搜尋跑完後就不再更新畫面
  const myToken = ++state.searchToken;

  // 0. 多詞 AND 偵測：用空格、頓號、逗號分隔多個關鍵字（例如「黃芪 消渴」），
  //    每個詞都必須在同一本書裡出現才算符合，不用是連續片語（不像單詞搜尋要求完全連續）。
  //    多詞模式下不做古今病名對照延伸，保持邏輯單純：使用者已經自己把想法拆成明確的詞了。
  const subTerms = [...new Set(q.split(/[\s\u3000、，,]+/).map(t=>t.trim()).filter(Boolean))];
  const isMultiTerm = subTerms.length > 1;
  // 拆完只剩一個有效詞時（例如打了多餘空格、或重複打了兩次同樣的詞），
  // 一律改用「去除多餘分隔符/重複後」的乾淨字串來實際搜尋，而不是原始輸入本身
  // ——原始輸入若含空格，直接當成連續片語去比對幾乎不可能命中任何典籍。
  const searchQ = subTerms.length === 1 ? subTerms[0] : q;
  state.currentQuery = searchQ;

  // 1. disease-map lookup（病名古今對照，僅供顯示與延伸搜尋詞用；多詞模式不做）
  //    同時比對正規化後的字串，讓輸入簡體字/異體字時病名對照卡片也能正確顯示
  //
  //    q.includes(a) 這個方向刻意加上長度限制：如果不限制，任何長查詢字串只要「剛好內嵌」
  //    一個很短的古代病名當子字串（例如查一個方劑全名，裡面恰好包含某個 2 字病名），
  //    就會誤觸發一張不相關的「古今病名對照」卡片，稀釋掉真正想看的搜尋結果版面。
  //    只有在查詢字串沒有比對照表詞長出太多時才視為「大概就是在講這個病名」。
  const normQ = normalizeText(searchQ);
  const mappingMatches = isMultiTerm ? [] : state.diseaseMap.filter(entry =>
    entry.modern.includes(searchQ) || normalizeText(entry.modern).includes(normQ) ||
    entry.ancient.some(a =>
      a.includes(searchQ) || normalizeText(a).includes(normQ) || (searchQ.includes(a) && searchQ.length <= a.length + 2)
    )
  );

  // 2. gather candidate search terms：原始查詢 + 病名對照表中的古代病名
  //    （病名、藥名、方劑名、任意關鍵字都走同一套全文檢索邏輯；多詞模式沒有延伸詞）
  const searchTerms = new Set([searchQ]);
  mappingMatches.forEach(m => m.ancient.forEach(a => searchTerms.add(a)));
  const extraTerms = isMultiTerm ? [] : [...searchTerms].filter(t => t !== searchQ);

  showLoading('搜尋典籍全文中…');

  const bookScores = new Map(); // bookIndex -> {count, terms:Set}
  let mainCandidates = [];
  let mainVerifiedCount = 0;
  let mainNormQ = normQ; // 單詞模式：正規化後的查詢字串；多詞模式：改存字串陣列（見下）

  try{
    // 主查詢詞：先算出「全部」候選並依相關度排序，再套用使用者選的分類/朝代篩選（若有），
    // 只驗證篩選後前 MAX_CANDIDATE_BOOKS 筆；其餘候選不丟棄，存進 state.loadMore，
    // 讓使用者可以按「顯示更多」繼續載入——呼應 jicheng.tw 的原則：範圍受限沒關係，
    // 但一定要讓使用者知道、且能自己選擇要不要繼續。
    const mainResult = isMultiTerm ? await computeAndCandidates(subTerms) : await computeCandidates(searchQ);
    mainCandidates = mainResult.candidates.filter(passesFilters);
    mainNormQ = isMultiTerm ? mainResult.subQueries : mainResult.q;
    const firstBatch = mainCandidates.slice(0, MAX_CANDIDATE_BOOKS);
    mainVerifiedCount = firstBatch.length;

    // 主查詢詞的驗證 + 病名對照延伸詞的完整搜尋，平行處理，避免依序等待造成長時間卡住
    const [mainHits, ...extraHits] = await Promise.all([
      isMultiTerm ? verifyAndCandidates(mainNormQ, firstBatch) : verifyCandidates(mainNormQ, firstBatch),
      ...extraTerms.map(term => fullTextSearchTerm(term)),
    ]);

    if(myToken !== state.searchToken) return; // 已經有更新的搜尋在跑，這次結果直接丟棄

    [mainHits, ...extraHits].forEach(hits=>{
      hits.forEach((rec, idx)=>{
        if(!passesFilters(idx)) return; // 延伸詞的候選也要套用同一套篩選，避免結果不一致
        const cur = bookScores.get(idx) || {count:0, terms:new Set()};
        cur.count += rec.count;
        rec.rawMatches.forEach(t => cur.terms.add(t));
        bookScores.set(idx, cur);
      });
    });
  }catch(err){
    console.error('全文搜尋發生錯誤：', err);
  }finally{
    if(myToken === state.searchToken) hideLoading();
  }

  if(myToken !== state.searchToken) return;

  // 也納入書名直接相符的典籍（含正規化比對，處理簡體/異體字輸入書名的情況）
  // 多詞模式下，書名要「同時」包含每個子詞才算相符，跟全文檢索的 AND 邏輯一致
  // （不能直接拿整個 q 去比對書名，因為 q 這時候含有分隔符號，書名不會剛好長那樣）
  state.booksIndex.forEach((b, idx)=>{
    const normTitle = normalizeText(b.title);
    const titleMatches = isMultiTerm
      ? subTerms.every(st => b.title.includes(st) || normTitle.includes(normalizeText(st)))
      : (b.title.includes(searchQ) || normTitle.includes(normQ));
    if(titleMatches && !bookScores.has(idx) && passesFilters(idx)){
      bookScores.set(idx, {count:0, terms:new Set(['(書名相符)'])});
    }
  });

  const bookResults = [...bookScores.entries()]
    .map(([idx, rec])=>({book: state.booksIndex[idx], count: rec.count, terms:[...rec.terms]}))
    .filter(r=>r.book)
    .sort((a,b)=> b.count - a.count);

  const remainingCount = Math.max(0, mainCandidates.length - mainVerifiedCount);

  // 保留「尚未驗證的候選」與目前累積的分數，供「顯示更多」按鈕使用
  state.loadMore = remainingCount > 0 ? {
    token: myToken,
    q: mainNormQ,
    isMultiTerm,
    candidates: mainCandidates,
    verifiedCount: mainVerifiedCount,
    bookScores,
    mappingMatches,
    resultsTitle: `「${q}」相關典籍`,
  } : null;

  showResults({
    title: `「${q}」相關典籍`,
    mapping: mappingMatches.length ? mappingMatches : null,
    bookResults,
    searchTerms: [...searchTerms],
    totalCandidates: mainCandidates.length,
    remainingCount,
  });
}

// 「顯示更多典籍」：驗證下一批先前保留的候選典籍，把結果併入目前的搜尋結果
async function loadMoreCandidates(){
  const lm = state.loadMore;
  if(!lm || lm.token !== state.searchToken) return;

  const btn = document.getElementById('loadMoreCandidatesBtn');
  if(btn){ btn.disabled = true; btn.textContent = '載入中…'; }

  const nextBatch = lm.candidates.slice(lm.verifiedCount, lm.verifiedCount + MAX_CANDIDATE_BOOKS);
  let hits;
  try{
    hits = lm.isMultiTerm ? await verifyAndCandidates(lm.q, nextBatch) : await verifyCandidates(lm.q, nextBatch);
  }catch(err){
    console.error('載入更多典籍時發生錯誤：', err);
    if(btn){ btn.disabled = false; btn.textContent = '載入失敗，點此重試'; }
    return;
  }

  if(lm.token !== state.searchToken) return; // 使用者已經開始新搜尋，這批結果不再顯示

  hits.forEach((rec, idx)=>{
    const cur = lm.bookScores.get(idx) || {count:0, terms:new Set()};
    cur.count += rec.count;
    rec.rawMatches.forEach(t => cur.terms.add(t));
    lm.bookScores.set(idx, cur);
  });
  lm.verifiedCount += nextBatch.length;

  const bookResults = [...lm.bookScores.entries()]
    .map(([idx, rec])=>({book: state.booksIndex[idx], count: rec.count, terms:[...rec.terms]}))
    .filter(r=>r.book)
    .sort((a,b)=> b.count - a.count);

  const remainingCount = Math.max(0, lm.candidates.length - lm.verifiedCount);
  state.loadMore = remainingCount > 0 ? lm : null;

  showResults({
    title: lm.resultsTitle,
    mapping: lm.mappingMatches.length ? lm.mappingMatches : null,
    bookResults,
    searchTerms: [],
    totalCandidates: lm.candidates.length,
    remainingCount,
  });
}

function showResults({title, mapping, bookResults, searchTerms, totalCandidates, remainingCount}){
  el.landingArea.hidden = true;
  el.resultsArea.hidden = false;
  el.resultsTitle.textContent = title;

  // 結果數量說明：如果還有候選典籍尚未載入驗證，明確告知使用者還有多少、而不是悄悄隱藏
  // （呼應 jicheng.tw「範圍受限沒關係，但要讓使用者知道」的原則）
  if(remainingCount > 0){
    el.resultsCount.textContent = `已顯示 ${bookResults.length} 部（依相關度排序）・符合關鍵字的候選典籍共 ${totalCandidates} 部，尚有 ${remainingCount} 部未載入`;
  } else {
    el.resultsCount.textContent = bookResults.length ? `共 ${bookResults.length} 部典籍` : '';
  }

  if(mapping && mapping.length){
    el.mappingCard.hidden = false;
    el.mappingCard.innerHTML = `<h3>古今病名對照</h3>` + mapping.map(m=>`
      <div class="mapping-entry">
        <span class="mp-modern">${escapeHtml(m.modern)}</span>
        <span class="mp-arrow">對應古代病名 →</span>
        <span class="mp-ancient-list">
          ${m.ancient.map(a=>`<span class="mp-ancient-chip" data-term="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join('')}
        </span>
        ${m.note ? `<div class="mp-note">${escapeHtml(m.note)}</div>` : ''}
      </div>
    `).join('');
    el.mappingCard.querySelectorAll('.mp-ancient-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        el.searchInput.value = chip.dataset.term;
        runSearch(chip.dataset.term);
      });
    });
  } else {
    el.mappingCard.hidden = true;
    el.mappingCard.innerHTML = '';
  }

  el.bookResultsList.innerHTML = '';
  if(bookResults.length === 0){
    el.noResults.hidden = false;
  } else {
    el.noResults.hidden = true;
    bookResults.forEach(r=>{
      const li = document.createElement('li');
      li.className = 'book-result';
      li.innerHTML = `
        <div class="book-result-top">
          <span class="book-result-title">${escapeHtml(r.book.title)}</span>
          ${r.count > 0 ? `<span class="book-result-count">符合 ${r.count} 次</span>` : (r.count === null ? '' : '<span class="book-result-count">書名相符</span>')}
        </div>
        <div class="book-result-meta">
          <span>${escapeHtml(r.book.author || '作者不詳')}</span>
          <span>${escapeHtml(r.book.dynasty || '')}</span>
          <span>${escapeHtml(r.book.category || '')}</span>
          <span>共 ${r.book.chapterCount} 章</span>
        </div>
        <div class="book-result-desc">${escapeHtml(r.book.desc || '')}</div>
      `;
      li.addEventListener('click', ()=>{
        // 優先用這本書實際比對到的原文寫法（可能含異體字）來高亮，
        // 若是純書名相符（沒有內文比對詞），退回用查詢字串本身
        const highlightTerms = (r.terms && r.terms.length && r.terms[0] !== '(書名相符)')
          ? r.terms
          : (state.currentQuery ? [state.currentQuery] : []);
        openReader(r.book.id, highlightTerms);
      });
      el.bookResultsList.appendChild(li);
    });
  }

  // 「顯示更多典籍」按鈕：每次重繪結果都先移除舊按鈕，避免重複或指向過期狀態
  const oldBtn = document.getElementById('loadMoreCandidatesBtn');
  if(oldBtn) oldBtn.remove();
  if(remainingCount > 0){
    const btn = document.createElement('button');
    btn.id = 'loadMoreCandidatesBtn';
    btn.type = 'button';
    btn.textContent = `顯示更多典籍（還有 ${remainingCount} 部候選未檢查，依相關度排序）`;
    btn.style.cssText = 'display:block;margin:16px auto 0;padding:10px 20px;cursor:pointer;';
    btn.addEventListener('click', loadMoreCandidates);
    el.bookResultsList.insertAdjacentElement('afterend', btn);
  }

  window.scrollTo({top: el.resultsArea.offsetTop - 20, behavior:'smooth'});
}

// ===== Reader =====
async function openReader(bookId, highlightTerms){
  showLoading('開啟典籍中…');
  let data;
  try{
    data = await getBookContent(bookId);
  }catch(err){
    hideLoading();
    alert('無法載入該典籍內容');
    return;
  }
  hideLoading();

  el.readerTitle.textContent = data.title;
  el.readerMeta.textContent = [data.author, data.dynasty, data.year, data.category].filter(Boolean).join(' ・ ');

  el.chapterNav.innerHTML = '';
  el.chapterContent.innerHTML = '';

  data.chapters.forEach((ch, idx)=>{
    const navItem = document.createElement('div');
    navItem.className = 'chapter-nav-item' + (idx===0 ? ' active' : '');
    navItem.textContent = ch.title;
    navItem.addEventListener('click', ()=>{
      document.querySelectorAll('.chapter-nav-item').forEach(n=>n.classList.remove('active'));
      navItem.classList.add('active');
      document.getElementById('ch-' + idx).scrollIntoView({behavior:'smooth', block:'start'});
    });
    el.chapterNav.appendChild(navItem);

    const section = document.createElement('section');
    section.id = 'ch-' + idx;
    const h3 = document.createElement('h3');
    h3.textContent = ch.title;
    section.appendChild(h3);
    const paragraphs = ch.content.split(/\n{2,}/);
    paragraphs.forEach(p=>{
      if(!p.trim()) return;
      const pEl = document.createElement('p');
      pEl.innerHTML = highlightTerms && highlightTerms.length ? highlightText(p, highlightTerms) : escapeHtml(p);
      section.appendChild(pEl);
    });
    el.chapterContent.appendChild(section);
  });

  el.readerOverlay.hidden = false;
  document.body.style.overflow = 'hidden';

  // set up match navigation
  const marks = [...el.chapterContent.querySelectorAll('mark')];
  state.currentMatches = marks;
  state.currentMatchPos = 0;
  if(marks.length){
    el.matchNav.hidden = false;
    updateMatchCounter();
    marks[0].classList.add('current-match');
    marks[0].scrollIntoView({block:'center'});
  } else {
    el.matchNav.hidden = true;
  }
}

function updateMatchCounter(){
  el.matchCounter.textContent = state.currentMatches.length
    ? `${state.currentMatchPos+1} / ${state.currentMatches.length}`
    : '0 / 0';
}

function gotoMatch(delta){
  if(!state.currentMatches.length) return;
  state.currentMatches[state.currentMatchPos].classList.remove('current-match');
  state.currentMatchPos = (state.currentMatchPos + delta + state.currentMatches.length) % state.currentMatches.length;
  const m = state.currentMatches[state.currentMatchPos];
  m.classList.add('current-match');
  m.scrollIntoView({block:'center', behavior:'smooth'});
  updateMatchCounter();
}

el.matchPrev.addEventListener('click', ()=>gotoMatch(-1));
el.matchNext.addEventListener('click', ()=>gotoMatch(1));

el.readerClose.addEventListener('click', closeReader);
el.readerOverlay.addEventListener('click', (e)=>{ if(e.target === el.readerOverlay) closeReader(); });
document.addEventListener('keydown', (e)=>{
  if(!el.readerOverlay.hidden){
    if(e.key === 'Escape') closeReader();
    if(e.key === 'ArrowRight' && !el.matchNav.hidden) gotoMatch(1);
    if(e.key === 'ArrowLeft' && !el.matchNav.hidden) gotoMatch(-1);
  }
});

function closeReader(){
  el.readerOverlay.hidden = true;
  document.body.style.overflow = '';
}

// ===== Helpers =====
function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

function highlightText(text, terms){
  let escaped = escapeHtml(text);
  const uniqueTerms = [...new Set(terms)].filter(t => t && t.length >= 1).sort((a,b)=>b.length-a.length);
  if(!uniqueTerms.length) return escaped;
  // 先做 HTML escape 再做正規表示式跳脫，確保比對對象跟 escaped 文字的編碼方式一致
  const pattern = new RegExp(uniqueTerms.map(t => escapeRegex(escapeHtml(t))).join('|'), 'g');
  return escaped.replace(pattern, m => `<mark>${m}</mark>`);
}
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

init();