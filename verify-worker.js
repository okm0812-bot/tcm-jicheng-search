// ===== 岐黃尋 verify-worker.js（修復版）=====
// 背景執行緒：下載候選典籍全文並比對關鍵字出現位置/次數。
//
// 修復重點：
// 1. 佇列化驗證請求——同一時間只處理一個 verify，避免主查詢與病名延伸詞
//    同時各開 15 個 fetch，造成 30~45 個並行請求壅塞網路（原本會讓搜尋
//    耗時 2 分鐘以上、看起來像壞掉）。
// 2. 支援取消——新搜尋開始時，舊的 verify 請求直接丟棄，不再繼續下載。
// 3. 新增超時保護——單本典籍下載超過 30 秒自動略過，不讓整批卡住。

let charNormalizeMap = {};

function normalizeText(text){
  let out = '';
  for(const ch of text){ out += charNormalizeMap[ch] || ch; }
  return out;
}

// 單本典籍下載超時（毫秒）
const FETCH_TIMEOUT = 30000;

async function fetchWithTimeout(url, timeout){
  const controller = new AbortController();
  const timer = setTimeout(()=> controller.abort(), timeout);
  try{
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
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

// ===== 請求佇列 =====
// 所有 verify 請求照順序處理，確保同一時間只有一批書籍在下載比對。
let currentReqId = null;       // 目前正在處理的 reqId
let pendingQueue = [];         // 等待中的請求 [{reqId, q, dataBase, items, resolve}]
const FETCH_CONCURRENCY = 6;   // 併發下載數（從 15 降為 6，避免 HTTP/2 串流排隊）

async function processVerify(reqId, q, dataBase, items){
  const hits = [];
  await mapWithConcurrency(items, FETCH_CONCURRENCY, async (item)=>{
    // 若已被新請求取消，立即停止
    if(currentReqId !== reqId) return;
    try{
      const res = await fetchWithTimeout(
        `${dataBase}/books/${encodeURIComponent(item.bookId)}.json`,
        FETCH_TIMEOUT
      );
      if(!res.ok) return;
      const data = await res.json();
      if(!data.chapters || !Array.isArray(data.chapters)) return;
      const fullText = data.chapters.map(ch => ch.content || '').join('');
      const normFull = normalizeText(fullText);

      let count = 0;
      const rawMatches = [];
      let pos = normFull.indexOf(q);
      while(pos !== -1){
        count++;
        const m = fullText.slice(pos, pos + q.length);
        if(!rawMatches.includes(m)) rawMatches.push(m);
        pos = normFull.indexOf(q, pos + 1);
      }
      if(count > 0) hits.push({idx: item.idx, count, rawMatches});
    }catch(err){
      // 個別典籍下載/解析失敗（含超時）時略過，不讓整批驗證失敗
    }
  });
  // 若在處理期間被取消，不回傳結果（resolve 已被取消流程呼叫過）
  if(currentReqId === reqId){
    self.postMessage({type:'verify-result', reqId, hits});
  }
}

function enqueueVerify(reqId, q, dataBase, items){
  pendingQueue.push({reqId, q, dataBase, items});
  drainQueue();
}

async function drainQueue(){
  // 已有請求在處理中，直接返回（它處理完會繼續拉下一個）
  if(currentReqId !== null) return;
  const job = pendingQueue.shift();
  if(!job) return;
  currentReqId = job.reqId;
  try{
    await processVerify(job.reqId, job.q, job.dataBase, job.items);
  }catch(err){
    // 不讓單一請求的意外中斷整個佇列
    if(currentReqId === job.reqId){
      self.postMessage({type:'verify-result', reqId: job.reqId, hits: []});
    }
  } finally {
    // 只有在沒有被取消的情況下才清除 currentReqId
    if(currentReqId === job.reqId){
      currentReqId = null;
    }
    // 繼續處理佇列中的下一個
    if(currentReqId === null && pendingQueue.length > 0){
      drainQueue();
    }
  }
}

self.onmessage = async (e)=>{
  const msg = e.data;

  if(msg.type === 'init'){
    charNormalizeMap = msg.charNormalizeMap || {};
    return;
  }

  if(msg.type === 'cancel'){
    // 取消所有等待中與目前正在處理的請求
    pendingQueue = [];
    currentReqId = null;
    return;
  }

  if(msg.type === 'verify'){
    const {reqId, q, dataBase, items} = msg;
    enqueueVerify(reqId, q, dataBase, items);
  }
};
