

# ---------------------------------------------------------------- GEO: one country, its news and its markets
# search names for world-atlas labels that are abbreviated
GEO_SEARCH = {
    "United States of America": "United States", "Dem. Rep. Congo": "DR Congo", "S. Sudan": "South Sudan", "Central African Rep.": "Central African Republic",
    "Eq. Guinea": "Equatorial Guinea", "Bosnia and Herz.": "Bosnia", "Dominican Rep.": "Dominican Republic", "Solomon Is.": "Solomon Islands",
    "Falkland Is.": "Falkland Islands", "Fr. S. Antarctic Lands": "French Southern Territories", "N. Cyprus": "Northern Cyprus", "W. Sahara": "Western Sahara",
    "eSwatini": "Eswatini", "Côte d'Ivoire": "Ivory Coast", "Macedonia": "North Macedonia", "Czechia": "Czech Republic", "Palestine": "Gaza OR \"West Bank\" OR Palestinian",
    "Georgia": "Georgia Tbilisi", "Jordan": "Jordan Amman", "Chad": "Chad N'Djamena", "Niger": "Niger Niamey", "Turkey": "Turkey OR Türkiye",
}
# country -> [equity proxy (index/ETF), currency vs USD, commodity exposure ...]; others fall back by currency and region
GEO_COUNTRY_ASSETS = {
    "United States of America": ["SPY", "DX-Y.NYB", "^TNX"], "Canada": ["EWC", "CAD=X", "CL=F"], "Mexico": ["EWW", "MXN=X"], "Brazil": ["EWZ", "BRL=X", "KC=F"],
    "Argentina": ["ARGT", "ARS=X", "ZS=F"], "Chile": ["ECH", "CLP=X", "HG=F"], "Peru": ["EPU", "PEN=X", "HG=F"], "Colombia": ["GXG", "COP=X", "BZ=F"],
    "Venezuela": ["CL=F", "ILF"], "United Kingdom": ["EWU", "GBPUSD=X", "^FTSE"], "Ireland": ["EIRL", "EURUSD=X"], "France": ["EWQ", "EURUSD=X", "^FCHI"],
    "Germany": ["EWG", "EURUSD=X", "^GDAXI"], "Italy": ["EWI", "EURUSD=X"], "Spain": ["EWP", "EURUSD=X"], "Netherlands": ["EWN", "EURUSD=X"], "Belgium": ["EWK", "EURUSD=X"],
    "Switzerland": ["EWL", "CHF=X"], "Austria": ["EWO", "EURUSD=X"], "Poland": ["EPOL", "PLN=X"], "Greece": ["GREK", "EURUSD=X"], "Sweden": ["EWD", "SEK=X"],
    "Norway": ["NORW", "NOK=X", "BZ=F"], "Denmark": ["EDEN", "DKK=X"], "Finland": ["EFNL", "EURUSD=X"], "Hungary": ["HUF=X", "VGK"], "Czechia": ["CZK=X", "VGK"],
    "Romania": ["RON=X", "VGK"], "Ukraine": ["ZW=F", "ZC=F", "UAH=X", "EURUSD=X"], "Russia": ["BZ=F", "RUB=X", "NG=F", "ZW=F"], "Belarus": ["ZW=F", "EURUSD=X"],
    "Turkey": ["TUR", "TRY=X", "XU100.IS"], "Israel": ["EIS", "ILS=X", "GC=F"], "Palestine": ["EIS", "GC=F", "BZ=F"], "Lebanon": ["EIS", "BZ=F"], "Iran": ["BZ=F", "CL=F", "GC=F"],
    "Iraq": ["BZ=F", "CL=F"], "Syria": ["BZ=F", "TUR"], "Saudi Arabia": ["KSA", "BZ=F"], "United Arab Emirates": ["UAE", "BZ=F"], "Qatar": ["QAT", "NG=F"],
    "Kuwait": ["KWT", "BZ=F"], "Yemen": ["BZ=F", "ZIM"], "Egypt": ["EGP=X", "BZ=F", "ZIM"], "Libya": ["BZ=F"], "Algeria": ["NG=F", "BZ=F"], "Nigeria": ["BZ=F", "NGN=X", "AFK"],
    "Angola": ["BZ=F", "AFK"], "South Africa": ["EZA", "ZAR=X", "GC=F", "PL=F"], "Ghana": ["CC=F", "GC=F", "AFK"], "Côte d'Ivoire": ["CC=F", "AFK"], "Kenya": ["KES=X", "AFK"],
    "Ethiopia": ["KC=F", "AFK"], "Morocco": ["MAD=X", "AFK"], "Dem. Rep. Congo": ["HG=F", "AFK"], "Zambia": ["HG=F", "AFK"], "Mali": ["GC=F", "AFK"], "Burkina Faso": ["GC=F", "AFK"],
    "China": ["MCHI", "CNY=X", "^HSI", "HG=F"], "Taiwan": ["EWT", "TWD=X", "TSM", "SOXX"], "Japan": ["EWJ", "JPY=X", "^N225"], "South Korea": ["EWY", "KRW=X"],
    "North Korea": ["EWY", "KRW=X", "JPY=X"], "Mongolia": ["MNT=X", "HG=F", "CNY=X"], "India": ["INDA", "INR=X", "^NSEI"], "Pakistan": ["PKR=X", "INDA"],
    "Bangladesh": ["BDT=X", "AAXJ"], "Sri Lanka": ["LKR=X", "AAXJ"], "Indonesia": ["EIDO", "IDR=X"], "Malaysia": ["EWM", "MYR=X"], "Thailand": ["THD", "THB=X"],
    "Philippines": ["EPHE", "PHP=X"], "Vietnam": ["VNM", "VND=X", "KC=F"], "Myanmar": ["THB=X", "AAXJ"], "Australia": ["EWA", "AUDUSD=X", "^AXJO"],
    "New Zealand": ["ENZL", "NZDUSD=X"], "Kazakhstan": ["KZT=X", "BZ=F", "URA"], "Azerbaijan": ["BZ=F", "NG=F"], "Armenia": ["AMD=X"], "Georgia": ["GEL=X"],
    "Afghanistan": ["GC=F", "^VIX"], "Serbia": ["RSD=X", "VGK"], "Cuba": ["^VIX"], "Haiti": ["^VIX"], "Panama": ["ZIM", "ZC=F"], "Greenland": ["DKK=X", "URA"],
}
GEO_CCY = {"Bolivia": "BOB", "Paraguay": "PYG", "Uruguay": "UYU", "Guatemala": "GTQ", "Honduras": "HNL", "Nicaragua": "NIO", "Costa Rica": "CRC", "Dominican Rep.": "DOP",
           "Jamaica": "JMD", "Iceland": "ISK", "Bulgaria": "BGN", "Croatia": "EUR", "Slovenia": "EUR", "Slovakia": "EUR", "Lithuania": "EUR", "Latvia": "EUR", "Estonia": "EUR",
           "Portugal": "EUR", "Luxembourg": "EUR", "Cyprus": "EUR", "Moldova": "MDL", "Albania": "ALL", "Bosnia and Herz.": "BAM", "Macedonia": "MKD", "Uzbekistan": "UZS",
           "Kyrgyzstan": "KGS", "Tajikistan": "TJS", "Turkmenistan": "TMT", "Nepal": "NPR", "Cambodia": "KHR", "Laos": "LAK", "Papua New Guinea": "PGK", "Fiji": "FJD",
           "Tunisia": "TND", "Sudan": "SDG", "Uganda": "UGX", "Tanzania": "TZS", "Rwanda": "RWF", "Mozambique": "MZN", "Madagascar": "MGA", "Botswana": "BWP", "Namibia": "NAD",
           "Zimbabwe": "ZWL", "Malawi": "MWK", "Senegal": "XOF", "Cameroon": "XAF", "Gabon": "XAF", "Oman": "OMR", "Jordan": "JOD", "Bahrain": "BHD", "Somalia": "SOS",
           "Ecuador": None, "El Salvador": None, "Puerto Rico": None, "Timor-Leste": None}
GEO_REGION_ETF = [({"Mexico", "Brazil", "Argentina", "Chile", "Peru", "Colombia", "Venezuela", "Ecuador", "Bolivia", "Paraguay", "Uruguay", "Guatemala", "Honduras", "Nicaragua", "El Salvador",
                     "Costa Rica", "Panama", "Cuba", "Haiti", "Dominican Rep.", "Jamaica", "Guyana", "Suriname", "Puerto Rico", "Trinidad and Tobago", "Belize", "Bahamas"}, "ILF"),
                  ({"Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Oman", "Yemen", "Iraq", "Iran", "Syria", "Lebanon", "Jordan", "Israel", "Palestine"}, "BZ=F"),
                  ({"Russia", "Ukraine", "Belarus", "Moldova", "Kazakhstan", "Uzbekistan", "Kyrgyzstan", "Tajikistan", "Turkmenistan", "Azerbaijan", "Armenia", "Georgia"}, "EEM")]
_AFRICA = {"Egypt", "Libya", "Algeria", "Tunisia", "Morocco", "W. Sahara", "Mauritania", "Mali", "Niger", "Chad", "Sudan", "S. Sudan", "Ethiopia", "Eritrea", "Djibouti", "Somalia", "Somaliland",
           "Kenya", "Uganda", "Rwanda", "Burundi", "Tanzania", "Dem. Rep. Congo", "Congo", "Gabon", "Eq. Guinea", "Cameroon", "Central African Rep.", "Nigeria", "Benin", "Togo", "Ghana",
           "Côte d'Ivoire", "Liberia", "Sierra Leone", "Guinea", "Guinea-Bissau", "Senegal", "Gambia", "Burkina Faso", "Angola", "Zambia", "Malawi", "Mozambique", "Zimbabwe", "Botswana",
           "Namibia", "South Africa", "Lesotho", "eSwatini", "Madagascar"}
_ASIA = {"Nepal", "Bhutan", "Bangladesh", "Sri Lanka", "Myanmar", "Laos", "Cambodia", "Vietnam", "Thailand", "Malaysia", "Indonesia", "Philippines", "Papua New Guinea", "Timor-Leste",
         "Brunei", "Afghanistan", "Pakistan", "Mongolia", "North Korea"}


def geo_assets_for(name: str) -> list[str]:
    a = list(GEO_COUNTRY_ASSETS.get(name, []))
    if name in GEO_SPOTS:
        a = list(GEO_ASSETS.get(name, []))
    ccy = GEO_CCY.get(name, "")
    if ccy and not any(x.endswith("=X") for x in a):
        a.append("EURUSD=X" if ccy == "EUR" else f"{ccy}=X")
    for members, etf in GEO_REGION_ETF:
        if name in members:
            a.append(etf)
    if name in _AFRICA:
        a.append("AFK")
    if name in _ASIA:
        a.append("AAXJ")
    if not a:
        a = ["VGK", "EURUSD=X"] if ccy == "EUR" else ["EEM", "^VIX"]
    a += ["GC=F", "^VIX"]                                   # global risk gauges, always shown last
    return list(dict.fromkeys(a))[:6]


def _riskoff_sign(sym: str) -> int:
    """Which way a price usually moves when this country's news is bad (risk-off)."""
    if sym in ("GC=F", "^VIX", "ITA", "DX-Y.NYB", "CHF=X", "JPY=X", "SI=F") or sym.endswith("=F"):
        return 1 if sym not in ("HG=F",) else -1            # gold, VIX, defense, supply-shock commodities up; copper down
    if sym.endswith("=X"):
        return -1 if sym[:3] in ("EUR", "GBP", "AUD", "NZD") else 1   # local currency weakens
    if sym == "^TNX":
        return -1
    return -1                                                # equities fall


def _rank_corr(a: list, b: list) -> float | None:
    if len(a) < 6:
        return None
    ra, rb = pd.Series(a).rank(), pd.Series(b).rank()
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def get_geo_country(name: str) -> dict:
    is_spot = name in GEO_SPOTS
    label = GEO_SPOTS[name][0] if is_spot else name
    if is_spot:
        q = " OR ".join(f'"{x.lstrip("=")}"' for x in GEO_SPOTS[name][3][:3])
    else:
        al = [x.lstrip("=") for x in GEO_PLACES.get(name, []) if not any(ch in x for ch in "\\(")][:3]
        base = GEO_SEARCH.get(name, name)
        q = " OR ".join(dict.fromkeys([base if " OR " in base else f'"{base}"'] + [f'"{x}"' for x in al if x.lower() != base.lower()]))
    items = google_news(f"({q}) when:30d", 100)
    now = time.time() * 1000
    heads = []
    for it in items:
        tag = geo_tag(it["title"])
        w = sorted((GEO_THEMES[t][1] for t in tag["themes"]), reverse=True)
        base_s = (w[0] + 0.35 * sum(w[1:])) if w else 0.6
        sev = base_s * (1.5 if tag["esc"] else 0.7 if tag["deesc"] else 1.0)
        heads.append({"title": it["title"], "url": it["url"], "site": it.get("site"), "ts": it.get("ts"), "sev": round(sev, 3), **tag})
    heads = [h for h in heads if h["ts"]]
    # risk from the last few days (same scale as the world map) and a daily news-intensity series
    recent = sum(h["sev"] * math.exp(-max(0, (now - h["ts"]) / 3.6e6) / 36) for h in heads)
    risk = 100 * (1 - math.exp(-recent / 5))
    days = {}
    for h in heads:
        d = datetime.fromtimestamp(h["ts"] / 1000, tz=timezone.utc).date().isoformat()
        e = days.setdefault(d, {"n": 0, "sev": 0.0, "esc": 0, "deesc": 0})
        e["n"] += 1
        e["sev"] += h["sev"]
        e["esc"] += h["esc"]
        e["deesc"] += h["deesc"]
    today = datetime.now(timezone.utc).date()
    series = [[(today - timedelta(days=k)).isoformat(), days.get((today - timedelta(days=k)).isoformat(), {"n": 0, "sev": 0.0, "esc": 0, "deesc": 0})] for k in range(29, -1, -1)]
    themes = defaultdict(int)
    for h in heads:
        for t in h["themes"]:
            themes[t] += 1
    assets = geo_assets_for(name)
    quotes = get_quotes(assets)
    out_assets = []
    hot_cut = max(2.0, float(np.percentile([d[1]["sev"] for d in series], 75))) if series else 2.0
    top_heads = sorted(heads, key=lambda h: -h["sev"])[:30]
    for k, sym in enumerate(assets):
        try:
            daily = get_history(sym, "1D")
        except Exception:
            daily = []
        if not daily or len(daily) < 25:
            out_assets.append({"sym": sym, "ok": False})
            continue
        c = pd.Series([b[4] for b in daily], index=pd.to_datetime([b[0] for b in daily], unit="ms").date).groupby(level=0).last()
        r = c.pct_change().dropna()
        vol20 = float(r.tail(60).std())
        q = quotes.get(sym) or {}
        today_r = q.get("chgPct")
        aligned = [(d, e) for d, e in series if pd.Timestamp(d).date() in r.index]
        rs = [float(r[pd.Timestamp(d).date()]) for d, _ in aligned]
        sev = [e["sev"] for _, e in aligned]
        hot = [x for x, s in zip(rs, sev) if s >= hot_cut]
        calm = [x for x, s in zip(rs, sev) if s < hot_cut]
        sign = _riskoff_sign(sym)
        tone = [e["esc"] - e["deesc"] for _, e in aligned]
        a = {"sym": sym, "ok": True, "last": q.get("last") or float(c.iloc[-1]), "today": today_r, "z": (today_r / vol20) if (today_r is not None and vol20) else None,
             "w1": float(c.iloc[-1] / c.iloc[-6] - 1) if len(c) > 6 else None, "m1": float(c.iloc[-1] / c.iloc[-22] - 1) if len(c) > 22 else None, "vol": vol20 * math.sqrt(252),
             "hotAbs": float(np.mean(np.abs(hot))) if hot else None, "calmAbs": float(np.mean(np.abs(calm))) if calm else None, "hotMean": float(np.mean(hot)) if hot else None,
             "nHot": len(hot), "corrAbs": _rank_corr(sev, [abs(x) for x in rs]), "corrTone": _rank_corr(tone, [x * sign for x in rs]), "riskoff": sign,
             "path": [[d, float(c[pd.Timestamp(d).date()])] for d, _ in series if pd.Timestamp(d).date() in c.index]}
        # reaction after each important headline: move over the next ~4 trading hours (hourly bars), else to the next daily close
        if k < 3:
            try:
                hb = get_history(sym, "1H")
            except Exception:
                hb = []
            ht = np.array([b[0] for b in hb], dtype=float) if hb else np.array([])
            hc = np.array([b[4] for b in hb], dtype=float) if hb else np.array([])
            moves = []
            typ = float(np.median(np.abs(hc[4:] / hc[:-4] - 1))) if len(hc) > 40 else None
            for h in top_heads:
                if not len(ht):
                    break
                j = int(np.searchsorted(ht, h["ts"]))
                if j <= 0 or j >= len(ht):
                    continue
                before, after = hc[j - 1], hc[min(len(hc) - 1, j + 3)]
                if not (before and after) or ht[min(len(hc) - 1, j + 3)] - h["ts"] > 4 * 86400e3:
                    continue
                mv = after / before - 1
                moves.append({"ts": h["ts"], "mv": mv, "norm": (abs(mv) / typ) if typ else None, "with": (np.sign(mv) == sign) if h["esc"] else None})
                h.setdefault("react", {})[sym] = round(mv, 6)
            if moves:
                nm = [m["norm"] for m in moves if m["norm"] is not None]
                wv = [m["with"] for m in moves if m["with"] is not None]
                a.update({"sens": float(np.mean(nm)) if nm else None, "nReact": len(moves), "riskoffHit": (sum(wv) / len(wv)) if wv else None, "nEsc": len(wv), "typ4h": typ})
        out_assets.append(a)
    # verdict on the primary market
    prim = next((x for x in out_assets if x.get("ok")), None)
    return _json_safe({"key": name, "name": label, "isSpot": is_spot, "query": q, "risk": round(risk, 1), "n": len(heads), "n7": sum(1 for h in heads if now - h["ts"] < 7 * 86400e3),
                       "esc": sum(h["esc"] for h in heads), "deesc": sum(h["deesc"] for h in heads), "themes": dict(themes), "series": series, "hotCut": hot_cut,
                       "headlines": sorted(heads, key=lambda h: -h["ts"])[:60], "assets": out_assets, "primary": prim["sym"] if prim else None, "asof": int(now)})
