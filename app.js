// ===== 岐黃尋 app.js =====
// Static, client-side only. No user data is sent anywhere.

const DATA_BASE = 'data';

const state = {
  booksIndex: null,       // array from books-index.json
  booksById: new Map(),
  diseaseMap: null,       // array from disease-map.json
  termIndex: null,        // lazy-loaded object: term -> [[bookId,count],...]
  termIndexLoading: null,
  currentQuery: '',
  currentMatches: [],     // indices of <mark> in reader for nav
  currentMatchPos: 0,
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

function showLoading(msg){
  el.loadingToast.textContent = msg || '載入中…';
  el.loadingToast.hidden = false;
}
function hideLoading(){ el.loadingToast.hidden = true; }

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

    state.booksIndex = booksIndex;
    state.diseaseMap = diseaseMap;
    booksIndex.forEach(b => state.booksById.set(b.id, b));

    const totalChars = booksIndex.reduce((s,b)=>s+b.charCount,0);
    el.corpusStats.textContent = `收錄 ${booksIndex.length} 部典籍・約 ${(totalChars/10000).toFixed(0)} 萬字`;
    el.bookCountLanding.textContent = booksIndex.length;
    console.log('[DEBUG] corpusStats set, bookCountLanding set');

    renderCategoryLists();
    console.log('[DEBUG] renderCategoryLists done');
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
  const books = state.booksIndex.filter(b => (b.category||'').split(/\s+/).includes(cat));
  showResults({
    title: `分類：${cat}`,
    mapping: null,
    bookResults: books.map(b=>({book:b, count:null})),
  });
}

// ===== Term index (lazy) =====
function loadTermIndex(){
  if(state.termIndex) return Promise.resolve(state.termIndex);
  if(state.termIndexLoading) return state.termIndexLoading;
  showLoading('載入全文索引…');
  state.termIndexLoading = fetchJSON(`${DATA_BASE}/term-index.json`)
    .then(data=>{ state.termIndex = data; hideLoading(); return data; })
    .catch(err=>{ hideLoading(); console.error(err); return {}; });
  return state.termIndexLoading;
}

// ===== Autocomplete =====
let acItems = [];
let acActiveIndex = -1;

function buildAutocomplete(query){
  if(!query){ el.autocompleteList.hidden = true; return; }
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

el.searchInput.addEventListener('input', ()=>{
  buildAutocomplete(el.searchInput.value);
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
  state.currentQuery = q;

  // 1. disease-map lookup
  const mappingMatches = state.diseaseMap.filter(entry =>
    entry.modern.includes(q) || entry.ancient.some(a => a.includes(q) || q.includes(a))
  );

  // 2. gather candidate search terms (the raw query + any ancient terms from mapping)
  const searchTerms = new Set([q]);
  mappingMatches.forEach(m => m.ancient.forEach(a => searchTerms.add(a)));

  showLoading('搜尋典籍中…');
  const termIndex = await loadTermIndex();
  hideLoading();

  const bookScores = new Map(); // bookId -> {count, matchedTerms:Set}
  searchTerms.forEach(term=>{
    // exact match
    if(termIndex[term]){
      termIndex[term].forEach(([bookId,count])=>{
        const rec = bookScores.get(bookId) || {count:0, terms:new Set()};
        rec.count += count;
        rec.terms.add(term);
        bookScores.set(bookId, rec);
      });
    }
  });

  // fallback: substring match across term-index keys if nothing found and query length>=2
  if(bookScores.size === 0 && q.length >= 2){
    const keys = Object.keys(termIndex).filter(k => k.includes(q)).slice(0, 30);
    keys.forEach(term=>{
      termIndex[term].forEach(([bookId,count])=>{
        const rec = bookScores.get(bookId) || {count:0, terms:new Set()};
        rec.count += count;
        rec.terms.add(term);
        bookScores.set(bookId, rec);
      });
    });
  }

  // also include books whose title matches directly
  state.booksIndex.forEach(b=>{
    if(b.title.includes(q) && !bookScores.has(b.id)){
      bookScores.set(b.id, {count:0, terms:new Set(['(書名相符)'])});
    }
  });

  const bookResults = [...bookScores.entries()]
    .map(([bookId, rec])=>({book: state.booksById.get(bookId), count: rec.count, terms:[...rec.terms]}))
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
          ${r.count !== null ? `<span class="book-result-count">符合 ${r.count} 次</span>` : ''}
        </div>
        <div class="book-result-meta">
          <span>${escapeHtml(r.book.author || '作者不詳')}</span>
          <span>${escapeHtml(r.book.dynasty || '')}</span>
          <span>${escapeHtml(r.book.category || '')}</span>
          <span>共 ${r.book.chapterCount} 章</span>
        </div>
        <div class="book-result-desc">${escapeHtml(r.book.desc || '')}</div>
      `;
      li.addEventListener('click', ()=> openReader(r.book.id, state.currentQuery ? [...(searchTerms||[state.currentQuery])] : []));
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
    data = await fetchJSON(`${DATA_BASE}/books/${encodeURIComponent(bookId)}.json`);
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
  const pattern = new RegExp(uniqueTerms.map(t => escapeRegex(t)).join('|'), 'g');
  return escaped.replace(pattern, m => `<mark>${m}</mark>`);
}
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Safety: auto-hide loading toast after 5 seconds
setTimeout(function(){
  var t = document.getElementById('loadingToast');
  if(t && !t.hidden) {
    console.warn('Auto-hiding stuck loading toast');
    t.hidden = true;
  }
}, 5000);
init();