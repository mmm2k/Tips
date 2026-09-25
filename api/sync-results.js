// Pulls NFL fixtures and scores from ESPN's public scoreboard feed and writes them
// into the "games" collection. Runs daily via Vercel Cron (see vercel.json) and
// whenever an admin presses "Sync NFL results now".
//
// Note: ESPN's scoreboard feed is free but unofficial. If ESPN changes it, this
// may stop working, and results can still be entered by hand in the Admin tab.

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
// ESPN abbreviations that differ from the ones the app uses
const CODE_FIX = { WSH: "WAS", JAX: "JAC", LAR: "LA" };
const code = (abbr) => CODE_FIX[abbr] || abbr;

// Works with both key styles:
//  - new secret keys (sb_secret_...) must go ONLY in the apikey header
//  - legacy service_role keys (JWTs starting "eyJ") also go in Authorization
function serverHeaders(key) {
  const h = { apikey: key };
  if (key && key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

// Reads a JSON request body whether or not Vercel has already parsed it
async function readBody(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
    if (req.method !== "POST" || typeof req.on !== "function") return {};
    const raw = await new Promise((resolve) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d));
      req.on("error", () => resolve(""));
    });
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function isAllowed(req) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET } = process.env;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (CRON_SECRET && token === CRON_SECRET) return true; // Vercel Cron
  // Otherwise it must be a signed-in admin
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!u.ok) return false;
  const user = await u.json();
  const a = await fetch(`${SUPABASE_URL}/rest/v1/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`, {
    headers: serverHeaders(SUPABASE_SERVICE_ROLE_KEY),
  });
  return a.ok && (await a.json()).length > 0;
}

export function gamesFromBoard(board) {
  if (!board || !board.season || board.season.type !== 2) return []; // regular season only
  const week = board.week && board.week.number;
  const out = [];
  for (const ev of board.events || []) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const h = code(home.team.abbreviation), a = code(away.team.abbreviation);
    const state = ev.status && ev.status.type ? ev.status.type.state : "pre"; // pre | in | post
    const completed = !!(ev.status && ev.status.type && ev.status.type.completed);
    const data = {
      week,
      away: a,
      home: h,
      kickoff: new Date(ev.date).toISOString(),
      status: completed ? "final" : "scheduled",
    };
    if (state !== "pre") {
      data.homeScore = Number(home.score);
      data.awayScore = Number(away.score);
    }
    out.push({ id: `w${week}-${a}-${h}`, data });
  }
  return out;
}

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Supabase environment variables are missing" });
  }
  try {
    if (!(await isAllowed(req))) return res.status(401).json({ error: "Only admins can sync results", version: "3" });

    const current = await (await fetch(ESPN)).json();
    const wk = current.week && current.week.number;
    const year = (current.season && current.season.year) || new Date().getFullYear();
    const getWeek = async (n) => (await fetch(`${ESPN}?seasontype=2&week=${n}&dates=${year}`)).json();

    // Which weeks to load: ?week=N (one week), ?season=1 (all 18), or the default
    // Options can arrive in the address (?week=1) or in the request body ({"week":"1"})
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    const body = await readBody(req);
    const seasonParam = params.get("season") || (body.season === true || body.season === "1" ? "1" : "");
    const oneWeek = parseInt(params.get("week") || body.week, 10);
    const debug = { url: req.url || "", body, adapter: req.headers["x-adapter-version"] || null };
    const mode = seasonParam === "1" || seasonParam === "true" ? "season" : oneWeek >= 1 && oneWeek <= 18 ? "week " + oneWeek : "default";
    let boards;
    if (mode === "season") {
      boards = await Promise.all(Array.from({ length: 18 }, (_, i) => getWeek(i + 1)));
    } else if (mode !== "default") {
      boards = [await getWeek(oneWeek)];
    } else {
      boards = [current];
      if (current.season && current.season.type === 2 && wk) {
        const extra = [];
        if (wk > 1) extra.push(getWeek(wk - 1));
        if (wk < 18) extra.push(getWeek(wk + 1));
        boards.push(...(await Promise.all(extra)));
      }
    }
    const games = boards.flatMap(gamesFromBoard);
    if (!games.length) return res.status(200).json({ updated: 0, weeks: [], mode, debug, version: "3", note: "No regular-season games found" });

    // Keep anything already stored on a game (like a venue note) and overwrite the rest
    const headers = { ...serverHeaders(SUPABASE_SERVICE_ROLE_KEY), "Content-Type": "application/json" };
    const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/docs?collection=eq.games&select=id,data`, { headers });
    const existing = Object.fromEntries((await existingRes.json()).map((r) => [r.id, r.data]));
    const now = new Date().toISOString();
    const rows = games.map((g) => ({
      collection: "games",
      id: g.id,
      data: { ...(existing[g.id] || {}), ...g.data },
      updated_at: now,
    }));
    const up = await fetch(`${SUPABASE_URL}/rest/v1/docs`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!up.ok) return res.status(500).json({ error: "Database write failed: " + (await up.text()) });

    const weeks = [...new Set(games.map((g) => g.data.week))].sort((a, b) => a - b);
    return res.status(200).json({ updated: rows.length, weeks, mode, debug, version: "3" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
