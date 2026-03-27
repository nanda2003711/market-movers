"""
Market Movers Backend
─────────────────────────────────────────────────────────
Market data : Yahoo Finance (query2.finance.yahoo.com) — no key needed
News        : Finnhub (finnhub.io)  — free key at finnhub.io
LLM         : Groq   (console.groq.com) — free key, Llama-3.3-70B
─────────────────────────────────────────────────────────
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import requests, time, os
from datetime import datetime, date, timedelta
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()
GROQ_KEY    = os.environ.get("GROQ_API_KEY", "").strip()

groq_client = OpenAI(
    api_key=GROQ_KEY,
    base_url="https://api.groq.com/openai/v1",
) if GROQ_KEY else None

app = FastAPI(title="Market Movers API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Yahoo Finance ──────────────────────────────────────────────────────────────
YF = "https://query2.finance.yahoo.com"

YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/",
}

# ── In-memory cache ────────────────────────────────────────────────────────────
_cache: dict = {}

def cached(key: str, ttl: int, fn):
    now = time.time()
    if key in _cache and now - _cache[key]["ts"] < ttl:
        return _cache[key]["data"]
    result = fn()
    _cache[key] = {"data": result, "ts": now}
    return result

def yf_get(path: str, params: dict = {}) -> dict:
    r = requests.get(f"{YF}{path}", headers=YF_HEADERS, params=params, timeout=10)
    r.raise_for_status()
    return r.json()

def _map_quote(q: dict) -> dict:
    return {
        "ticker":           q.get("symbol", ""),
        "name":             q.get("shortName") or q.get("longName") or q.get("symbol", ""),
        "day": {
            "c":  q.get("regularMarketPrice", 0),
            "o":  q.get("regularMarketOpen", 0),
            "h":  q.get("regularMarketDayHigh", 0),
            "l":  q.get("regularMarketDayLow", 0),
            "v":  q.get("regularMarketVolume", 0),
            "vw": q.get("regularMarketPrice", 0),
        },
        "prevDay":          {"c": q.get("regularMarketPreviousClose", 0)},
        "todaysChangePerc": round(q.get("regularMarketChangePercent", 0), 4),
        "todaysChange":     round(q.get("regularMarketChange", 0), 4),
        "marketCap":        q.get("marketCap"),
        "sector":           q.get("sector"),
        "fiftyTwoWeekHigh": q.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow":  q.get("fiftyTwoWeekLow"),
        "avgVolume":        q.get("averageDailyVolume3Month"),
        "pe":               q.get("trailingPE"),
    }

def _fmt_big(n) -> str:
    if not n: return "—"
    n = float(n)
    if n >= 1e12: return f"${n/1e12:.2f}T"
    if n >= 1e9:  return f"${n/1e9:.1f}B"
    if n >= 1e6:  return f"${n/1e6:.0f}M"
    return f"${n:,.0f}"

# ── Yahoo Finance endpoints ────────────────────────────────────────────────────

@app.get("/movers")
def movers():
    def fetch():
        def screener(scr_id):
            d = yf_get("/v1/finance/screener/predefined/saved", {
                "scrIds": scr_id, "count": 10, "formatted": "false",
                "lang": "en-US", "region": "US", "corsDomain": "finance.yahoo.com",
            })
            return d.get("finance", {}).get("result", [{}])[0].get("quotes", [])
        return {
            "gainers": [_map_quote(q) for q in screener("day_gainers")],
            "losers":  [_map_quote(q) for q in screener("day_losers")],
        }
    try:
        return cached("movers", ttl=60, fn=fetch)
    except Exception as e:
        raise HTTPException(502, f"Yahoo Finance error: {e}")

@app.get("/ticker/{symbol}")
def ticker_detail(symbol: str):
    def fetch():
        data = yf_get(f"/v10/finance/quoteSummary/{symbol.upper()}", {
            "modules": "assetProfile,summaryDetail,price",
        })
        res     = data.get("quoteSummary", {}).get("result", [{}])[0]
        profile = res.get("assetProfile", {})
        price   = res.get("price", {})
        summary = res.get("summaryDetail", {})
        mktcap  = price.get("marketCap", {})
        raw_cap = mktcap.get("raw", 0) if isinstance(mktcap, dict) else (mktcap or 0)
        pe_raw  = summary.get("trailingPE", {})
        pe      = pe_raw.get("raw") if isinstance(pe_raw, dict) else pe_raw
        return {
            "name":      price.get("shortName") or price.get("longName") or symbol,
            "sector":    profile.get("sector", "—"),
            "industry":  profile.get("industry", "—"),
            "employees": f'{profile.get("fullTimeEmployees", 0):,}' if profile.get("fullTimeEmployees") else "—",
            "mktCap":    _fmt_big(raw_cap),
            "website":   profile.get("website", ""),
            "pe":        round(pe, 2) if pe else "—",
        }
    try:
        return cached(f"ticker:{symbol}", ttl=3600, fn=fetch)
    except Exception as e:
        raise HTTPException(502, str(e))

@app.get("/sparkline/{symbol}")
def sparkline(symbol: str):
    def fetch():
        data   = yf_get(f"/v8/finance/chart/{symbol.upper()}", {
            "interval": "5m", "range": "1d", "includePrePost": "false",
        })
        result = data.get("chart", {}).get("result", [{}])[0]
        closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
        return {"results": [{"c": c} for c in closes if c is not None]}
    try:
        return cached(f"sparkline:{symbol}", ttl=120, fn=fetch)
    except Exception as e:
        raise HTTPException(502, str(e))

@app.get("/indexes")
def indexes():
    def fetch():
        data   = yf_get("/v7/finance/quote", {
            "symbols": "SPY,QQQ,^VIX",
            "fields":  "regularMarketChangePercent,regularMarketPrice",
        })
        quotes = {q["symbol"]: q for q in data.get("quoteResponse", {}).get("result", [])}
        return {
            "spy": {"change": round(quotes.get("SPY", {}).get("regularMarketChangePercent", 0), 2)},
            "qqq": {"change": round(quotes.get("QQQ", {}).get("regularMarketChangePercent", 0), 2)},
            "vix": {"price":  round(quotes.get("^VIX", {}).get("regularMarketPrice", 0), 2)},
        }
    try:
        return cached("indexes", ttl=60, fn=fetch)
    except Exception as e:
        raise HTTPException(502, str(e))

# ── Finnhub news ───────────────────────────────────────────────────────────────

@app.get("/news/{symbol}")
def news(symbol: str):
    """
    Company news from Finnhub.
    Free tier: 60 req/min. Get key at https://finnhub.io (no credit card).
    Falls back to general market news if no company-specific results found.
    """
    if not FINNHUB_KEY:
        return []

    def fetch():
        to_dt   = date.today()
        from_dt = to_dt - timedelta(days=7)
        r = requests.get("https://finnhub.io/api/v1/company-news", params={
            "symbol": symbol.upper(),
            "from":   from_dt.isoformat(),
            "to":     to_dt.isoformat(),
            "token":  FINNHUB_KEY,
        }, timeout=8)
        r.raise_for_status()
        items = r.json()

        # Fallback to general news if empty (weekend / small-cap)
        if not items:
            r2 = requests.get("https://finnhub.io/api/v1/news", params={
                "category": "general", "token": FINNHUB_KEY,
            }, timeout=8)
            r2.raise_for_status()
            items = r2.json()[:4]

        return [
            {
                "title":     n.get("headline", ""),
                "url":       n.get("url", "#"),
                "published": datetime.utcfromtimestamp(n.get("datetime", 0)).isoformat() + "Z",
                "publisher": n.get("source", ""),
                "summary":   n.get("summary", ""),
            }
            for n in items[:5]
            if n.get("headline")
        ]

    try:
        return cached(f"news:{symbol}", ttl=300, fn=fetch)
    except Exception as e:
        raise HTTPException(502, f"Finnhub error: {e}")

# ── Groq LLM endpoints ─────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    symbol:    str
    name:      str = ""
    sector:    str = "—"
    industry:  str = "—"
    mktCap:    str = "—"
    price:     float = 0
    change:    float = 0
    changeAmt: float = 0
    volume:    int   = 0
    open:      float = 0
    high:      float = 0
    low:       float = 0
    prevClose: float = 0
    pe:        str   = "—"
    headlines: list[str] = []

class ChatRequest(BaseModel):
    symbol:   str
    context:  dict
    messages: list[dict]

def _build_system(req: AnalyzeRequest | dict) -> str:
    if isinstance(req, dict):
        r = AnalyzeRequest(**req)
    else:
        r = req
    hdls = "\n".join(f"- {h}" for h in r.headlines[:5]) or "None available."
    return f"""You are a concise financial analyst. Answer using ONLY the data below.
Never give investment advice. Keep responses under 100 words.

{r.symbol} ({r.name}) | {r.sector} | {r.industry} | Cap: {r.mktCap}
Price: ${r.price:.2f} | Change: {r.change:+.2f}% (${r.changeAmt:+.2f})
O:{r.open:.2f}  H:{r.high:.2f}  L:{r.low:.2f}  PC:{r.prevClose:.2f}
Volume: {r.volume:,} | P/E: {r.pe}

Recent headlines:
{hdls}"""

@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """
    One-shot analysis using Groq (Llama-3.3-70B).
    Free tier: 30 req/min, 14 400 req/day. Get key at https://console.groq.com
    """
    if not groq_client:
        return {"analysis": "AI analysis unavailable — add GROQ_API_KEY to backend/.env (free at console.groq.com)"}
    try:
        direction = "rise" if req.change > 0 else "fall"
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=180,
            temperature=0.3,
            messages=[
                {"role": "system",  "content": _build_system(req)},
                {"role": "user",    "content": f"Why did {req.symbol} {direction} today? Give a clear 3-sentence summary of the likely drivers."},
            ],
        )
        return {"analysis": resp.choices[0].message.content.strip()}
    except Exception as e:
        return {"analysis": f"Analysis unavailable: {e}"}

@app.post("/chat")
def chat(req: ChatRequest):
    """
    Streaming chat using Groq. Tokens stream back as plain text chunks.
    """
    if not groq_client:
        def no_key():
            yield "AI chat unavailable — add GROQ_API_KEY to backend/.env (free at console.groq.com)"
        return StreamingResponse(no_key(), media_type="text/plain")

    sys_prompt = _build_system(AnalyzeRequest(**{
        "symbol":    req.context.get("ticker", req.symbol),
        "name":      req.context.get("name", ""),
        "sector":    req.context.get("sector", "—"),
        "industry":  req.context.get("industry", "—"),
        "mktCap":    req.context.get("mktCap", "—"),
        "price":     req.context.get("day", {}).get("c", 0),
        "change":    req.context.get("todaysChangePerc", 0),
        "changeAmt": req.context.get("todaysChange", 0),
        "volume":    req.context.get("day", {}).get("v", 0),
        "open":      req.context.get("day", {}).get("o", 0),
        "high":      req.context.get("day", {}).get("h", 0),
        "low":       req.context.get("day", {}).get("l", 0),
        "prevClose": req.context.get("prevDay", {}).get("c", 0),
        "pe":        str(req.context.get("pe", "—")),
        "headlines": req.context.get("headlines", []),
    }))

    def generate():
        try:
            stream = groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                max_tokens=250,
                temperature=0.3,
                stream=True,
                messages=[{"role": "system", "content": sys_prompt}] + req.messages,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except Exception as e:
            yield f"Chat error: {e}"

    return StreamingResponse(generate(), media_type="text/plain")

@app.get("/health")
def health():
    services = {}
    # Yahoo
    try:
        yf_get("/v7/finance/quote", {"symbols": "AAPL"})
        services["yahoo_finance"] = "ok"
    except:
        services["yahoo_finance"] = "error"
    # Finnhub
    if FINNHUB_KEY:
        try:
            r = requests.get("https://finnhub.io/api/v1/news",
                             params={"category":"general","token":FINNHUB_KEY}, timeout=5)
            services["finnhub"] = "ok" if r.ok else "error"
        except:
            services["finnhub"] = "error"
    else:
        services["finnhub"] = "no key"
    # Groq
    if GROQ_KEY:
        try:
            groq_client.chat.completions.create(
                model="llama-3.3-70b-versatile", max_tokens=5,
                messages=[{"role":"user","content":"ping"}],
            )
            services["groq"] = "ok"
        except:
            services["groq"] = "error"
    else:
        services["groq"] = "no key"

    overall = "ok" if all(v == "ok" for v in services.values()) else "degraded"
    return {"status": overall, "services": services, "timestamp": datetime.utcnow().isoformat()}

