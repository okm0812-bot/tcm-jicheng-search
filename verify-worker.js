// ===== 岐黃尋 verify-worker.js（V2 穩定版）=====
// 背景執行緒：下載候選典籍全文並比對關鍵字出現位置/次數。
//
// 這一版在 TCM Bot 那次修復（佇列化 + 取消 + 逾時保護）的基礎上，再補三件事：
// 1. LRU 內容快取——同一本書在同一次搜尋（多詞 AND、或古今病名延伸詞）被
//    重複用到時，只下載+解析一次，之後都是直接從快取拿正規化好的全文來掃描。
//    這是刻意選的做法：原本規格書要求「多詞 AND / 延伸詞改成一本書只下載一次」，
//    需要重新設計成合併的批次任務；但這裡評估後認為，用快取來消除「重複下載
//    +重複 JSON.parse+重複正規化」（真正貴的部分），風險比重寫批次協定低很多，
//    而且不用去動「延伸詞有自己的候選清單與排序規則」這件事——掃描比對本身
//    （indexOf）相對便宜，不用特別合併也沒關係。
// 2. 取消時真的中止「正在下載中」的 fetch（用 AbortController），不是只丟棄
//    還沒開始的項目——原本的版本 cancel 之後，已經送出的 fetch 還是會繼續跑完，
//    直到自己的 30 秒逾時或請求成功才結束，白白佔用資源。
// 3. 回報進度（verify-progress），讓畫面能顯示「正在驗證第 17 / 50 部」。

let charNormalizeMap = {};

function normalizeText(text){
  let out = '';
  for(const ch of text){ out += charNormalizeMap[ch] || ch; }
  return out;
}

// 單本典籍下載超時（毫秒）——超過就視為這本書失敗，跳過繼續下一本，不讓整批卡住
const FETCH_TIMEOUT = 30000;

// ===== LRU 內容快取 =====
// bookId -> {fullText, normFull, charCount}
// Map 的鍵值插入順序拿來當作「最近使用」順序：每次命中就刪除再重新插入，
// 讓它排到最後面；淘汰時從最前面（最久沒用到的）開始刪。
//
// 書本數上限刻意訂得比 app.js 的 MAX_CANDIDATE_BOOKS（目前 50）略高，
// 而不是照原規格建議的 20：快取存在的主要目的就是讓「同一批候選」在被多詞
// AND 或古今病名延伸詞重複用到時只下載一次，如果快取裝不下一整批候選，
// 這個效果會被打折——批次愈後面的書，反而愈可能因為快取已經被前面擠掉而
// 重新下載。
const bookCache = new Map();
let cacheCharTotal = 0;
const MAX_CACHE_BOOKS = 60;
const MAX_CACHE_CHARS = 12000000;

function cacheGet(bookId){
  if(!bookCache.has(bookId)) return null;
  const entry = bookCache.get(bookId);
  bookCache.delete(bookId);
  bookCache.set(bookId, entry); // 搬到最後面＝標記為最近使用
  return entry;
}

function cacheSet(bookId, entry){
  bookCache.set(bookId, entry);
  cacheCharTotal += entry.charCount;
  while((bookCache.size > MAX_CACHE_BOOKS || cacheCharTotal > MAX_CACHE_CHARS) && bookCache.size > 1){
    const oldestKey = bookCache.keys().next().value;
    cacheCharTotal -= bookCache.get(oldestKey).charCount;
    bookCache.delete(oldestKey);
  }
}

// ===== 請求佇列 + 取消 =====
// 同一時間只處理一個 verify job（沿用 TCM Bot 的修復：避免主查詢與延伸詞
// 同時各開一堆 fetch 造成壅塞）。currentControllers 記錄「目前這個 job 底下
// 所有還在飛行中的 fetch」，取消時全部一起 abort，而不是只丟棄還沒開始的項目。
let currentReqId = null;
let currentControllers = new Set();
let pendingQueue = [];
const FETCH_CONCURRENCY = 6;

async function fetchBookText(bookId, dataBase){
  const cached = cacheGet(bookId);
  if(cached) return cached;

  const controller = new AbortController();
  currentControllers.add(controller);
  const timer = setTimeout(()=> controller.abort(), FETCH_TIMEOUT);
  try{
    const res = await fetch(`${dataBase}/books/${encodeURIComponent(bookId)}.json`, { signal: controller.signal });
    if(!res.ok) return null;
    const data = await res.json();
    if(!data.chapters || !Array.isArray(data.chapters)) return null;
    const fullText = data.chapters.map(ch => ch.content || '').join('');
    const normFull = normalizeText(fullText);
    const entry = {fullText, normFull, charCount: fullText.length};
    cacheSet(bookId, entry);
    return entry;
  } finally {
    clearTimeout(timer);
    currentControllers.delete(controller);
  }
}

async function processVerify(reqId, q, dataBase, items){
  const hits = [];
  let done = 0;
  const total = items.length;

  await mapWithConcurrency(items, FETCH_CONCURRENCY, async (item)=>{
    if(currentReqId !== reqId) return; // 已被新請求取消，不再處理剩餘項目
    try{
      const entry = await fetchBookText(item.bookId, dataBase);
      if(entry){
        let count = 0;
        const rawMatches = [];
        let pos = entry.normFull.indexOf(q);
        while(pos !== -1){
          count++;
          const m = entry.fullText.slice(pos, pos + q.length);
          if(!rawMatches.includes(m)) rawMatches.push(m);
          pos = entry.normFull.indexOf(q, pos + 1);
        }
        if(count > 0) hits.push({idx: item.idx, count, rawMatches});
      }
    }catch(err){
      // 個別典籍下載/解析失敗（含逾時、含被 cancel 中止）時略過，不讓整批驗證失敗
    } finally {
      done++;
      if(currentReqId === reqId){
        self.postMessage({type:'verify-progress', reqId, done, total});
      }
    }
  });

  if(currentReqId === reqId){
    self.postMessage({type:'verify-result', reqId, hits});
  }
}

function enqueueVerify(reqId, q, dataBase, items){
  pendingQueue.push({reqId, q, dataBase, items});
  drainQueue();
}

async function drainQueue(){
  if(currentReqId !== null) return;
  const job = pendingQueue.shift();
  if(!job) return;
  currentReqId = job.reqId;
  currentControllers = new Set();
  try{
    await processVerify(job.reqId, job.q, job.dataBase, job.items);
  }catch(err){
    if(currentReqId === job.reqId){
      self.postMessage({type:'verify-result', reqId: job.reqId, hits: []});
    }
  } finally {
    if(currentReqId === job.reqId){
      currentReqId = null;
      currentControllers = new Set();
    }
    if(currentReqId === null && pendingQueue.length > 0){
      drainQueue();
    }
  }
}

// 以固定併發數平行處理陣列
async function mapWithConcurrency(items, limit, asyncFn){
  const results = [];
  let i = 0;
  async function run(){
    while(i < items.length){
      const idx = i++;
      results[idx] = await asyncFn(items[idx]);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return results;
}

self.onmessage = async (e)=>{
  const msg = e.data;

  if(msg.type === 'init'){
    charNormalizeMap = msg.charNormalizeMap || {};
    return;
  }

  if(msg.type === 'cancel'){
    // 取消時，不能只是默默清掉狀態——被取消的每個 reqId（不管是正在處理中的，
    // 還是還排在佇列裡沒開始的）都要回傳一個空結果，讓 app.js 那邊等待中的
    // Promise 立刻被解決，而不是要等到逾時計時器才被動清乾淨。
    const cancelledReqIds = pendingQueue.map(job => job.reqId);
    if(currentReqId !== null) cancelledReqIds.push(currentReqId);

    pendingQueue = [];
    currentControllers.forEach(c => { try{ c.abort(); }catch(_){} });
    currentControllers = new Set();
    currentReqId = null;

    cancelledReqIds.forEach(reqId=>{
      self.postMessage({type:'verify-result', reqId, hits: [], cancelled: true});
    });
    return;
  }

  if(msg.type === 'verify'){
    const {reqId, q, dataBase, items} = msg;
    enqueueVerify(reqId, q, dataBase, items);
  }
};
