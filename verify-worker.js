// ===== 岐黃尋 verify-worker.js =====
// 背景執行緒：下載候選典籍全文並比對關鍵字出現位置/次數，
// 讓大量候選驗證時不會卡住主執行緒（輸入框、捲動、UI 互動都不受影響）。
// 做法參考自同類「純靜態網站 + 瀏覽器端中文全文檢索」專案的實測經驗。

let charNormalizeMap = {};

function normalizeText(text){
  let out = '';
  for(const ch of text){ out += charNormalizeMap[ch] || ch; }
  return out;
}

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

  if(msg.type === 'verify'){
    const {reqId, q, dataBase, items} = msg; // items: [{idx, bookId}]
    const hits = [];
    await mapWithConcurrency(items, 15, async (item)=>{
      try{
        const res = await fetch(`${dataBase}/books/${encodeURIComponent(item.bookId)}.json`);
        if(!res.ok) return;
        const data = await res.json();
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
        // 個別典籍下載/解析失敗時略過，不讓整批驗證失敗
      }
    });
    self.postMessage({type:'verify-result', reqId, hits});
  }
};
