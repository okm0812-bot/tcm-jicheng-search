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
};

const el = {
  searchInput: document.getElementById('searchInput'),
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
    console.log('[DEBUG] renderCategoryLists done');
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
  const books = state.booksIndex.filter(b => (b.category||'').split(/\s+/).includes(cat));
  showResults({
    title: `分類：${cat}`,
    mapping: null,
    bookResults: books.map(b=>({book:b, count:null, terms:[]})),
  });
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

const MAX_CANDIDATE_BOOKS = 60;  // 候選典籍上限，避免極常見關鍵字造成過多下載
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

// 對單一關鍵字做全文檢索，回傳 Map(bookIndex -> {count, rawMatches:Set})
async function fullTextSearchTerm(term){
  const q = normalizeText(term.trim());
  const result = new Map();
  if(!q) return result;

  let candidateIndices;

  if(q.length === 1){
    // 單字查詢：用「以此字開頭的所有雙字元」聯集，近似代表「典籍含有此字」
    const shard = await getShard(q[0]);
    const set = new Set();
    Object.values(shard).forEach(arr => arr.forEach(i => set.add(i)));
    candidateIndices = [...set];
  } else {
    // 多字查詢：拆成連續雙字元，逐一取交集
    let candidateSet = null;
    for(let i = 0; i < q.length - 1; i++){
      const bigram = q.slice(i, i+2);
      const shard = await getShard(bigram[0]);
      const bookList = shard[bigram] || [];
      const bookSet = new Set(bookList);
      if(candidateSet === null){
        candidateSet = bookSet;
      } else {
        candidateSet = new Set([...candidateSet].filter(x => bookSet.has(x)));
      }
      if(candidateSet.size === 0) break; // 提早結束：不可能有結果
    }
    candidateIndices = candidateSet ? [...candidateSet] : [];
  }

  if(candidateIndices.length > MAX_CANDIDATE_BOOKS){
    // 優先驗證字數較少的典籍：下載快、驗證快，讓使用者更快看到結果
    candidateIndices.sort((a, b) => {
      const ca = Number(state.booksIndex[a]?.charCount) || Infinity;
      const cb = Number(state.booksIndex[b]?.charCount) || Infinity;
      return ca - cb;
    });
    candidateIndices = candidateIndices.slice(0, MAX_CANDIDATE_BOOKS);
  }

  // 平行抓取候選典籍全文，實際驗證比對位置與次數
  await mapWithConcurrency(candidateIndices, FETCH_CONCURRENCY, async (idx)=>{
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
el.searchInput.addEventListener('input', ()=>{
  clearTimeout(autocompleteDebounceTimer);
  autocompleteDebounceTimer = setTimeout(()=> buildAutocomplete(el.searchInput.value), 120);
});

el.searchInput.addEventListener('keydown', (e)=>{
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

// ===== Search =====
async function runSearch(rawQuery){
  const q = rawQuery.trim();
  if(!q) return;
  if(!state.booksIndex || !state.diseaseMap){
    showLoading('資料尚未載入完成，請稍候再試一次…');
    setTimeout(hideLoading, 2000);
    return;
  }
  state.currentQuery = q;

  // 序號機制：如果使用者又觸發了新的搜尋，這次搜尋跑完後就不再更新畫面
  const myToken = ++state.searchToken;

  // 1. disease-map lookup（病名古今對照，僅供顯示與延伸搜尋詞用）
  //    同時比對正規化後的字串，讓輸入簡體字/異體字時病名對照卡片也能正確顯示
  const normQ = normalizeText(q);
  const mappingMatches = state.diseaseMap.filter(entry =>
    entry.modern.includes(q) || normalizeText(entry.modern).includes(normQ) ||
    entry.ancient.some(a => a.includes(q) || q.includes(a) || normalizeText(a).includes(normQ))
  );

  // 2. gather candidate search terms：原始查詢 + 病名對照表中的古代病名
  //    （病名、藥名、方劑名、任意關鍵字都走同一套全文檢索邏輯）
  const searchTerms = new Set([q]);
  mappingMatches.forEach(m => m.ancient.forEach(a => searchTerms.add(a)));

  showLoading('搜尋典籍全文中…');

  const bookScores = new Map(); // bookIndex -> {count, terms:Set}
  try{
    // 多個搜尋詞（原始輸入 + 古今病名對照延伸詞）平行處理，避免依序等待造成長時間卡住
    const allHits = await Promise.all([...searchTerms].map(term => fullTextSearchTerm(term)));

    if(myToken !== state.searchToken) return; // 已經有更新的搜尋在跑，這次結果直接丟棄

    allHits.forEach(hits=>{
      hits.forEach((rec, idx)=>{
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
  state.booksIndex.forEach((b, idx)=>{
    const normTitle = normalizeText(b.title);
    if((b.title.includes(q) || normTitle.includes(normQ)) && !bookScores.has(idx)){
      bookScores.set(idx, {count:0, terms:new Set(['(書名相符)'])});
    }
  });

  const bookResults = [...bookScores.entries()]
    .map(([idx, rec])=>({book: state.booksIndex[idx], count: rec.count, terms:[...rec.terms]}))
    .filter(r=>r.book)
    .sort((a,b)=> b.count - a.count)
    .slice(0, 60);

  showResults({
    title: `「${q}」相關典籍`,
    mapping: mappingMatches.length ? mappingMatches : null,
    bookResults,
    searchTerms: [...searchTerms],
  });
}

function showResults({title, mapping, bookResults, searchTerms}){
  el.landingArea.hidden = true;
  el.resultsArea.hidden = false;
  el.resultsTitle.textContent = title;
  el.resultsCount.textContent = bookResults.length ? `共 ${bookResults.length} 部典籍` : '';

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