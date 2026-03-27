import { useState, useEffect, useCallback, useRef } from "react";

// ─── API ──────────────────────────────────────────────────────────────────────
// Market data : Yahoo Finance via backend (no key needed)
// News        : Finnhub via backend     (free key at finnhub.io)
// AI          : Groq/Llama via backend  (free key at console.groq.com)
const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const fetchMovers    = async () => { const d = await apiFetch("/movers");  return { gainers: d.gainers||[], losers: d.losers||[] }; };
const fetchDetail    = async (s) => { try { return await apiFetch(`/ticker/${s}`); } catch { return { name:s, sector:"—", mktCap:"—", employees:"—" }; } };
const fetchNewsApi   = async (s) => { try { return await apiFetch(`/news/${s}`); }   catch { return []; } };
const fetchSparkline = async (s) => { try { const d = await apiFetch(`/sparkline/${s}`); return (d.results||[]).map(b=>b.c); } catch { return []; } };
const fetchIndexes   = async ()  => { try { return await apiFetch("/indexes"); } catch { return null; } };

async function callAnalyze(payload) {
  const res = await fetch(`${API}/analyze`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload),
  });
  const d = await res.json();
  return d.analysis || "Analysis unavailable.";
}

async function streamChat(payload, onChunk, onDone, onError) {
  try {
    const res = await fetch(`${API}/chat`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload),
    });
    if (!res.ok) { onError(`Server error ${res.status}`); return; }
    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onChunk(dec.decode(value));
    }
    onDone();
  } catch(e) { onError(e.message); }
}

// ─── FORMATTERS ───────────────────────────────────────────────────────────────
const fmtVol  = v => !v?"—":v>=1e9?`${(v/1e9).toFixed(1)}B`:v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(0)}K`:String(v);
const timeAgo = iso => { const s=(Date.now()-new Date(iso))/1000; return s<3600?`${~~(s/60)}m ago`:s<86400?`${~~(s/3600)}h ago`:`${~~(s/86400)}d ago`; };
const REFRESH_MS = 30000;

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
// BUG FIX: pass symbol so gradient id is always unique per ticker
function Sparkline({ data, positive, symbol="x", width=80, height=28 }) {
  if (!data || data.length < 2)
    return <svg width={width} height={height}><line x1="0" y1={height/2} x2={width} y2={height/2} stroke="#252525" strokeWidth="1.5"/></svg>;
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts = data.map((v,i)=>`${(i/(data.length-1))*width},${height-((v-min)/range)*(height-4)-2}`).join(" ");
  const c  = positive?"#22c55e":"#ef4444";
  // Use ticker symbol in gradient ID to avoid collisions between losers/gainers
  const id = `sk_${symbol.replace(/[^a-z0-9]/gi,"")}`;
  return (
    <svg width={width} height={height} style={{overflow:"visible"}}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor={c} stopOpacity="0.2"/>
        <stop offset="100%" stopColor={c} stopOpacity="0"/>
      </linearGradient></defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#${id})`}/>
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

// ─── STOCK CARD ───────────────────────────────────────────────────────────────
function StockCard({ stock, onClick, selected, sparkData, flash }) {
  const pos    = stock.todaysChangePerc >= 0;
  const price  = stock.day?.c ?? 0;
  const change = stock.todaysChangePerc ?? 0;
  return (
    <button onClick={()=>onClick(stock)} style={{
      display:"flex",alignItems:"center",justifyContent:"space-between",
      width:"100%",padding:"9px 11px",marginBottom:3,textAlign:"left",cursor:"pointer",
      background:flash?(pos?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.15)"):selected?(pos?"rgba(34,197,94,0.07)":"rgba(239,68,68,0.07)"):"rgba(255,255,255,0.025)",
      border:selected?`1px solid ${pos?"#22c55e30":"#ef444430"}`:"1px solid rgba(255,255,255,0.05)",
      borderRadius:8,transition:"background 0.25s",
    }}
    onMouseEnter={e=>{if(!selected)e.currentTarget.style.background="rgba(255,255,255,0.05)";}}
    onMouseLeave={e=>{if(!selected)e.currentTarget.style.background="rgba(255,255,255,0.025)";}}>
      <div style={{display:"flex",alignItems:"center",gap:9,minWidth:0,flex:1}}>
        <div style={{width:34,height:34,borderRadius:7,flexShrink:0,
          background:pos?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)",
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:9,fontWeight:700,color:pos?"#22c55e":"#ef4444",fontFamily:"'DM Mono',monospace"}}>
          {stock.ticker?.slice(0,4)}
        </div>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:13,fontWeight:600,color:"#efefef",fontFamily:"'DM Mono',monospace"}}>{stock.ticker}</div>
          <div style={{fontSize:11,color:"#484848",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:130}}>
            {stock.name&&stock.name!==stock.ticker?stock.name:"—"}
          </div>
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {/* BUG FIX: pass symbol prop so each sparkline gets unique gradient */}
        <Sparkline data={sparkData} positive={pos} symbol={stock.ticker||"x"}/>
        <div style={{textAlign:"right",minWidth:74}}>
          <div style={{fontSize:13,fontWeight:600,color:"#efefef",fontFamily:"'DM Mono',monospace"}}>{price>0?`$${price.toFixed(2)}`:"—"}</div>
          <div style={{fontSize:12,fontWeight:600,color:pos?"#22c55e":"#ef4444"}}>{pos?"+":""}{change.toFixed(2)}%</div>
        </div>
      </div>
    </button>
  );
}

// ─── CHAT BUBBLE ──────────────────────────────────────────────────────────────
function ChatMsg({ msg }) {
  return (
    <div style={{marginBottom:13,display:"flex",flexDirection:"column",alignItems:msg.role==="user"?"flex-end":"flex-start"}}>
      {msg.role==="user"
        ?<div style={{background:"rgba(99,102,241,0.18)",border:"1px solid rgba(99,102,241,0.28)",borderRadius:"12px 12px 3px 12px",padding:"8px 12px",maxWidth:"82%",fontSize:13,color:"#c4c4ff",lineHeight:1.55}}>{msg.content}</div>
        :<div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"3px 12px 12px 12px",padding:"10px 14px",maxWidth:"92%",fontSize:13,color:"#d0d0d0",lineHeight:1.65,whiteSpace:"pre-wrap"}}>
          {msg.loading
            ?<span style={{color:"#555",fontFamily:"'DM Mono',monospace",fontSize:12}}>Analyzing<span style={{animation:"blink 1s step-end infinite"}}>_</span></span>
            :msg.content||<span style={{color:"#555",fontFamily:"'DM Mono',monospace",fontSize:12}}>…</span>}
        </div>}
    </div>
  );
}

// ─── DETAIL DRAWER ────────────────────────────────────────────────────────────
function DetailDrawer({ stock, onClose }) {
  const [messages, setMessages]       = useState([]);
  const [input, setInput]             = useState("");
  const [aiLoading, setAiLoading]     = useState(false);
  const [details, setDetails]         = useState(null);
  const [news, setNews]               = useState([]);
  const [spark, setSpark]             = useState([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const chatEnd  = useRef(null);
  const init     = useRef(false);
  const detRef   = useRef(null);
  const newsRef  = useRef([]);

  const price     = stock.day?.c ?? 0;
  const change    = stock.todaysChangePerc ?? 0;
  const changeAmt = stock.todaysChange ?? 0;
  const pos       = change >= 0;

  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  useEffect(()=>{
    if(init.current) return; init.current=true;
    Promise.all([fetchDetail(stock.ticker), fetchNewsApi(stock.ticker), fetchSparkline(stock.ticker)])
      .then(([det, nws, spk])=>{
        setDetails(det); detRef.current=det;
        setNews(nws);    newsRef.current=nws;
        setSpark(spk);
        setMetaLoading(false);
        // Auto-trigger analysis on drawer open
        triggerAnalysis(det, nws);
      }).catch(()=>setMetaLoading(false));
  },[stock.ticker]);

  const buildPayload = (det, nws) => ({
    symbol:    stock.ticker,
    name:      det?.name || stock.name || stock.ticker,
    sector:    det?.sector || "—",
    industry:  det?.industry || "—",
    mktCap:    det?.mktCap || "—",
    price,
    change,
    changeAmt,
    volume:    stock.day?.v || 0,
    open:      stock.day?.o || 0,
    high:      stock.day?.h || 0,
    low:       stock.day?.l || 0,
    prevClose: stock.prevDay?.c || 0,
    pe:        String(det?.pe || stock.pe || "—"),
    headlines: (nws||[]).map(n=>n.title).slice(0,5),
  });

  const triggerAnalysis = async (det, nws) => {
    const userQ = `Why did ${stock.ticker} ${pos?"rise":"fall"} today? 3-sentence summary.`;
    setMessages([
      { role:"user",      content: userQ },
      { role:"assistant", content: "",   loading: true },
    ]);
    setAiLoading(true);
    try {
      const text = await callAnalyze(buildPayload(det, nws));
      setMessages([
        { role:"user",      content: userQ },
        { role:"assistant", content: text, loading: false },
      ]);
    } catch {
      setMessages([
        { role:"user",      content: userQ },
        { role:"assistant", content: "Analysis unavailable — check GROQ_API_KEY in backend/.env", loading: false },
      ]);
    } finally { setAiLoading(false); }
  };

  const sendChat = (question) => {
    if (!question.trim() || aiLoading) return;
    const q = question.trim();
    setInput("");
    setAiLoading(true);

    // Append user msg + empty assistant msg (will stream into)
    setMessages(prev => [
      ...prev,
      { role:"user",      content: q },
      { role:"assistant", content: "", loading: true },
    ]);

    const history = messages
      .filter(m => !m.loading)
      .map(m => ({ role: m.role, content: m.content }));

    const payload = {
      symbol:   stock.ticker,
      context:  { ...stock, ...buildPayload(detRef.current, newsRef.current) },
      messages: [...history, { role:"user", content: q }],
    };

    streamChat(
      payload,
      (chunk) => {
        setMessages(prev => prev.map((m,i) =>
          i === prev.length - 1 ? { ...m, content: m.content + chunk, loading: false } : m
        ));
      },
      () => setAiLoading(false),
      (err) => {
        setMessages(prev => prev.map((m,i) =>
          i === prev.length - 1 ? { ...m, content: `Error: ${err}`, loading: false } : m
        ));
        setAiLoading(false);
      }
    );
  };

  return (
    <div style={{width:430,height:"100%",display:"flex",flexDirection:"column",background:"#0b0b0e",borderLeft:"1px solid rgba(255,255,255,0.07)"}}>
      {/* Header */}
      <div style={{padding:"16px 16px 12px",borderBottom:"1px solid rgba(255,255,255,0.07)",flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:22,fontWeight:700,color:"#f0f0f0",fontFamily:"'DM Mono',monospace"}}>{stock.ticker}</span>
              {details?.sector&&details.sector!=="—"&&(
                <span style={{fontSize:10,color:"#555",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:4,padding:"2px 7px"}}>{details.sector}</span>
              )}
            </div>
            <div style={{fontSize:12,color:"#505050",marginTop:2}}>{details?.name||stock.name||"—"}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#444",cursor:"pointer",fontSize:22,padding:"0 4px",lineHeight:1}}>×</button>
        </div>

        <div style={{display:"flex",alignItems:"flex-end",gap:14,marginTop:12}}>
          <div>
            <div style={{fontSize:26,fontWeight:700,color:"#f0f0f0",fontFamily:"'DM Mono',monospace",letterSpacing:"-0.03em"}}>{price>0?`$${price.toFixed(2)}`:"—"}</div>
            <div style={{fontSize:13,fontWeight:600,color:pos?"#22c55e":"#ef4444",marginTop:2}}>
              {pos?"▲":"▼"} {Math.abs(change).toFixed(2)}%
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,marginLeft:6}}>{changeAmt>0?"+":""}{changeAmt.toFixed(2)}</span>
            </div>
          </div>
          <div style={{flex:1,paddingBottom:3}}>
            <Sparkline data={spark} positive={pos} symbol={stock.ticker} width={120} height={38}/>
          </div>
          <div style={{fontSize:11,color:"#404040",textAlign:"right",lineHeight:1.9}}>
            <div>Vol <span style={{color:"#666"}}>{fmtVol(stock.day?.v)}</span></div>
            <div>Cap <span style={{color:"#666"}}>{details?.mktCap||"—"}</span></div>
            <div>P/E <span style={{color:"#666"}}>{details?.pe||"—"}</span></div>
          </div>
        </div>

        {/* OHLC */}
        <div style={{display:"flex",marginTop:10,background:"rgba(255,255,255,0.025)",borderRadius:7,overflow:"hidden",border:"1px solid rgba(255,255,255,0.05)"}}>
          {[["O",stock.day?.o],["H",stock.day?.h],["L",stock.day?.l],["PC",stock.prevDay?.c]].map(([l,v],i,a)=>(
            <div key={l} style={{flex:1,padding:"5px 0",borderRight:i<a.length-1?"1px solid rgba(255,255,255,0.05)":"none",textAlign:"center"}}>
              <div style={{fontSize:9,color:"#383838",textTransform:"uppercase",letterSpacing:"0.06em"}}>{l}</div>
              <div style={{fontSize:12,color:"#888",fontFamily:"'DM Mono',monospace",marginTop:2}}>{v?`$${v.toFixed(2)}`:"—"}</div>
            </div>
          ))}
        </div>

        {/* News — Finnhub */}
        <div style={{marginTop:11}}>
          <div style={{fontSize:10,color:"#333",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>
            Live News · Finnhub
          </div>
          {metaLoading&&<div style={{fontSize:11,color:"#333"}}>Fetching headlines…</div>}
          {!metaLoading&&news.length===0&&(
            <div style={{fontSize:11,color:"#333"}}>No headlines — add FINNHUB_API_KEY to backend/.env (free at finnhub.io)</div>
          )}
          {news.slice(0,3).map((n,i)=>(
            <a key={i} href={n.url} target="_blank" rel="noreferrer"
              style={{display:"flex",gap:7,padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",textDecoration:"none",alignItems:"flex-start"}}>
              <span style={{color:pos?"#16a34a":"#dc2626",fontSize:9,marginTop:2,flexShrink:0}}>●</span>
              <span style={{fontSize:11,color:"#707070",lineHeight:1.45}}>{n.title}</span>
              <span style={{fontSize:10,color:"#333",flexShrink:0,marginLeft:"auto",paddingLeft:8}}>{timeAgo(n.published)}</span>
            </a>
          ))}
        </div>
      </div>

      {/* Chat messages */}
      <div style={{flex:1,overflowY:"auto",padding:"13px 13px 0"}}>
        {messages.map((m,i)=><ChatMsg key={i} msg={m}/>)}
        <div ref={chatEnd}/>
      </div>

      {/* Quick questions */}
      {messages.length<4&&!aiLoading&&(
        <div style={{padding:"6px 13px",display:"flex",flexWrap:"wrap",gap:5,flexShrink:0}}>
          {["Was this earnings-driven?","Macro or sector move?","Is volume elevated?","Analyst sentiment?"].map(q=>(
            <button key={q} onClick={()=>sendChat(q)} disabled={aiLoading}
              style={{fontSize:11,padding:"4px 10px",borderRadius:20,background:"rgba(255,255,255,0.035)",border:"1px solid rgba(255,255,255,0.07)",color:"#666",cursor:"pointer"}}>
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{padding:"9px 13px 13px",borderTop:"1px solid rgba(255,255,255,0.05)",flexShrink:0}}>
        <div style={{display:"flex",gap:8}}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat(input)}
            placeholder="Ask anything about this stock…"
            style={{flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:8,padding:"8px 12px",color:"#f0f0f0",fontSize:13,outline:"none",fontFamily:"inherit"}}/>
          <button onClick={()=>sendChat(input)} disabled={aiLoading||!input.trim()}
            style={{padding:"8px 14px",borderRadius:8,background:aiLoading||!input.trim()?"#1a1a20":"#6366f1",border:"none",color:aiLoading||!input.trim()?"#404040":"#fff",cursor:aiLoading||!input.trim()?"default":"pointer",fontSize:13,fontWeight:600,transition:"all 0.15s"}}>
            Ask
          </button>
        </div>
        <div style={{fontSize:10,color:"#252525",marginTop:6,textAlign:"right",fontFamily:"'DM Mono',monospace"}}>
          Groq · Llama-3.3-70B
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [gainers, setGainers]         = useState([]);
  const [losers, setLosers]           = useState([]);
  const [sparklines, setSparklines]   = useState({});
  const [flashing, setFlashing]       = useState({});
  const [indexes, setIndexes]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const [lastFetch, setLastFetch]     = useState(null);
  const [now, setNow]                 = useState(new Date());
  const [selectedStock, setSelectedStock] = useState(null);
  const [search, setSearch]           = useState("");
  const [countdown, setCountdown]     = useState(REFRESH_MS/1000);
  const prevPrices  = useRef({});
  const refreshRef  = useRef(null);
  const countRef    = useRef(null);

  useEffect(()=>{ const t=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(t); },[]);

  const loadData = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [{gainers:g, losers:l}, idxData] = await Promise.all([fetchMovers(), fetchIndexes()]);

      // Flash changed prices
      const flash={};
      [...g,...l].forEach(s=>{
        const p=s.day?.c;
        if(prevPrices.current[s.ticker]!==undefined&&prevPrices.current[s.ticker]!==p) flash[s.ticker]=true;
        prevPrices.current[s.ticker]=p;
      });
      if(Object.keys(flash).length){ setFlashing(flash); setTimeout(()=>setFlashing({}),1400); }

      setGainers(g); setLosers(l); setIndexes(idxData);
      setLastFetch(new Date()); setCountdown(REFRESH_MS/1000);

      // ── BUG FIX: fetch sparklines for ALL stocks (gainers AND losers) ──────
      // Previously was [...g,...l].slice(0,10) which only got gainers.
      // Now we fetch all 20 sparklines — losers will finally get their charts.
      [...g,...l].forEach(async s => {
        try {
          const spk = await fetchSparkline(s.ticker);
          if (spk.length) setSparklines(prev => ({ ...prev, [s.ticker]: spk }));
        } catch {}
      });

    } catch(e) {
      setError(e.message.includes("Failed to fetch")
        ? "Cannot reach backend — is uvicorn running on port 8000?"
        : e.message);
    } finally { setLoading(false); }
  },[]);

  useEffect(()=>{
    loadData();
    refreshRef.current = setInterval(loadData, REFRESH_MS);
    countRef.current   = setInterval(()=>setCountdown(c=>c<=1?REFRESH_MS/1000:c-1), 1000);
    return()=>{ clearInterval(refreshRef.current); clearInterval(countRef.current); };
  },[loadData]);

  const isOpen = () => {
    const d=now.getDay(); if(d===0||d===6) return false;
    const m=now.getUTCHours()*60+now.getUTCMinutes()-300;
    return m>=570&&m<960;
  };
  const open   = isOpen();
  const filter = arr => !search ? arr : arr.filter(s =>
    s.ticker?.includes(search.toUpperCase()) ||
    (s.name||"").toUpperCase().includes(search.toUpperCase())
  );

  return (
    <div style={{display:"flex",height:"100vh",background:"#080809",fontFamily:"'DM Sans',system-ui,sans-serif",overflow:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input::placeholder{color:#383838} input:focus{border-color:rgba(99,102,241,0.35)!important}
        button:focus{outline:none}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#222;border-radius:2px}
        @keyframes fadeSlide{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes blink{50%{opacity:0}}
      `}</style>

      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

        {/* ── Top Bar ── */}
        <div style={{padding:"11px 18px",borderBottom:"1px solid rgba(255,255,255,0.065)",display:"flex",alignItems:"center",gap:14,flexShrink:0,flexWrap:"wrap"}}>

          {/* Brand + status */}
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <div style={{position:"relative",width:9,height:9}}>
              <div style={{position:"absolute",inset:0,borderRadius:"50%",background:open?"#22c55e":"#f59e0b",boxShadow:`0 0 10px ${open?"#22c55e":"#f59e0b"}`}}/>
              {open&&<div style={{position:"absolute",inset:-3,borderRadius:"50%",border:"1px solid #22c55e55",animation:"spin 3s linear infinite"}}/>}
            </div>
            <span style={{fontSize:14,fontWeight:700,color:"#efefef",letterSpacing:"-0.02em"}}>Market Movers</span>
            <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,
              background:open?"rgba(34,197,94,0.07)":"rgba(245,158,11,0.07)",
              border:`1px solid ${open?"rgba(34,197,94,0.18)":"rgba(245,158,11,0.18)"}`,
              color:open?"#22c55e":"#f59e0b"}}>
              {open?"OPEN":"CLOSED"}
            </span>
          </div>

          {/* Clock */}
          <div style={{flexShrink:0}}>
            <div style={{fontSize:15,fontWeight:600,color:"#ccc",fontFamily:"'DM Mono',monospace",letterSpacing:"0.03em",lineHeight:1}}>
              {now.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true})}
            </div>
            <div style={{fontSize:10,color:"#383838",marginTop:2}}>
              {now.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}
            </div>
          </div>

          {/* Index pills */}
          {indexes&&(
            <div style={{display:"flex",gap:5,flexShrink:0}}>
              {[["SPY",indexes.spy?.change],["QQQ",indexes.qqq?.change],["VIX",null,indexes.vix?.price]].map(([n,c,p])=>(
                <div key={n} style={{fontSize:11,padding:"5px 10px",borderRadius:6,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",lineHeight:1.4}}>
                  <span style={{color:"#444",marginRight:5}}>{n}</span>
                  {c!=null
                    ?<span style={{color:c>=0?"#22c55e":"#ef4444",fontFamily:"'DM Mono',monospace"}}>{c>=0?"+":""}{c.toFixed(2)}%</span>
                    :<span style={{color:"#888",fontFamily:"'DM Mono',monospace"}}>{p?.toFixed(1)}</span>}
                </div>
              ))}
            </div>
          )}

          {loading&&<div style={{width:7,height:7,borderRadius:"50%",border:"1.5px solid #6366f1",borderTopColor:"transparent",animation:"spin 0.7s linear infinite",flexShrink:0}}/>}
          <div style={{fontSize:10,color:"#2a2a2a",fontFamily:"'DM Mono',monospace",flexShrink:0}}>refresh in {countdown}s</div>

          <div style={{flex:1}}/>

          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search ticker…"
            style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:8,padding:"6px 12px",color:"#f0f0f0",fontSize:13,width:145,outline:"none",fontFamily:"inherit"}}/>
          <button onClick={loadData} disabled={loading}
            style={{padding:"6px 12px",borderRadius:7,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",color:"#777",cursor:"pointer",fontSize:12}}>
            ↻ Refresh
          </button>
        </div>

        {/* Error banner */}
        {error&&(
          <div style={{margin:"10px 18px 0",padding:"9px 14px",background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.18)",borderRadius:8,fontSize:12,color:"#ef4444",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>⚠ {error}</span>
            <div style={{display:"flex",gap:8}}>
              <button onClick={loadData} style={{background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"3px 10px",color:"#ef4444",cursor:"pointer",fontSize:11}}>Retry</button>
              <button onClick={()=>setError("")} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
            </div>
          </div>
        )}

        {/* ── Columns ── */}
        <div style={{flex:1,display:"flex",overflow:"hidden"}}>
          {[
            {label:"Top Gainers",data:filter(gainers),color:"#22c55e"},
            {label:"Top Losers", data:filter(losers), color:"#ef4444"},
          ].map(({label,data,color},ci)=>(
            <div key={label} style={{flex:1,display:"flex",flexDirection:"column",borderRight:ci===0?"1px solid rgba(255,255,255,0.055)":"none"}}>
              <div style={{padding:"11px 15px 7px",flexShrink:0,display:"flex",alignItems:"center",gap:7}}>
                <div style={{width:5,height:5,borderRadius:"50%",background:color}}/>
                <span style={{fontSize:11,fontWeight:700,color,textTransform:"uppercase",letterSpacing:"0.1em"}}>{label}</span>
                <span style={{fontSize:10,color:"#2e2e2e",fontFamily:"'DM Mono',monospace"}}>{data.length}</span>
                {lastFetch&&<span style={{fontSize:10,color:"#252525",marginLeft:"auto",fontFamily:"'DM Mono',monospace"}}>{lastFetch.toLocaleTimeString()}</span>}
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"0 9px 9px"}}>
                {loading&&data.length===0
                  ?<div style={{color:"#2e2e2e",fontSize:12,textAlign:"center",paddingTop:70}}>Fetching from Yahoo Finance…</div>
                  :data.length===0
                    ?<div style={{color:"#2e2e2e",fontSize:12,textAlign:"center",paddingTop:50}}>No results</div>
                    :data.map((s,i)=>(
                      <div key={s.ticker} style={{animation:`fadeSlide 0.3s ease ${i*0.035}s both`}}>
                        <StockCard stock={s} onClick={setSelectedStock}
                          selected={selectedStock?.ticker===s.ticker}
                          sparkData={sparklines[s.ticker]||[]}
                          flash={!!flashing[s.ticker]}/>
                      </div>
                    ))
                }
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{padding:"7px 18px",borderTop:"1px solid rgba(255,255,255,0.04)",display:"flex",justifyContent:"space-between",flexShrink:0}}>
          <span style={{fontSize:10,color:"#242424"}}>
            Market data: Yahoo Finance · News: Finnhub · AI: Groq / Llama-3.3-70B · {open?"Market open":"Market closed"}
          </span>
          {lastFetch&&<span style={{fontSize:10,color:"#242424",fontFamily:"'DM Mono',monospace"}}>Last fetch {lastFetch.toLocaleTimeString()}</span>}
        </div>
      </div>

      {selectedStock&&<DetailDrawer stock={selectedStock} onClose={()=>setSelectedStock(null)}/>}
    </div>
  );
}
