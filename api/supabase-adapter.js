/*
  Supabase adapter.
  The app was written against a small data API (db + user). This file provides
  that same API on top of Supabase, so index.html needs no other changes.
  Everything is stored in one table, "docs" (collection, id, data), and
  Supabase row-level security decides who can write what (see supabase/schema.sql).
*/
(function () {
  let sb = null, session = null, isAdmin = null, dbInst = null, userInst = null;

  /* ---------- Login screen ---------- */
  function showLogin() {
    const box = document.createElement("div");
    box.id = "login";
    box.className = "login";
    box.innerHTML = `
      <form class="login-card">
        <h2>Sign in to play</h2>
        <p>We'll email you a sign-in link. No password needed.</p>
        <label class="f">Email<input class="t" type="email" data-f="email" required autocomplete="email"></label>
        <label class="f">Your name (first time only)<input class="t" type="text" data-f="name" maxlength="32" autocomplete="name"></label>
        <button class="btn" type="submit">Email me a sign-in link</button>
        <p class="msg" role="status" aria-live="polite"></p>
      </form>`;
    document.body.append(box);
    const form = box.querySelector("form");
    const msg = box.querySelector(".msg");
    const btn = box.querySelector("button");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.textContent = "Sending…";
      const email = form.querySelector('[data-f="email"]').value.trim();
      const name = form.querySelector('[data-f="name"]').value.trim();
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { data: name ? { name } : {}, emailRedirectTo: location.origin + location.pathname },
      });
      btn.disabled = false;
      msg.textContent = error
        ? "That didn't send: " + error.message
        : "Check your email and tap the link to sign in.";
    });
  }

  /* ---------- Startup: config, session ---------- */
  const ready = (async () => {
    let cfg;
    try {
      cfg = await (await fetch("/api/config")).json();
    } catch {
      return null;
    }
    if (!cfg || !cfg.url || !cfg.anonKey || !window.supabase) return null;
    sb = window.supabase.createClient(cfg.url, cfg.anonKey);

    const { data } = await sb.auth.getSession();
    session = data.session;
    if (!session) {
      showLogin();
      session = await new Promise((resolve) => {
        const { data: { subscription } } = sb.auth.onAuthStateChange((_evt, s) => {
          if (s) { subscription.unsubscribe(); resolve(s); }
        });
      });
      const el = document.getElementById("login");
      if (el) el.remove();
    }
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "SIGNED_OUT") location.reload();
      else if (s) session = s;
    });
    return sb;
  })();

  function toAppError(error) {
    const e = new Error(error.message || "Request failed");
    const denied = error.code === "42501" || /row-level security|permission/i.test(error.message || "");
    e.code = denied ? "invalid_argument" : "unavailable";
    return e;
  }
  function addSub(map, key, sub) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(sub);
    return () => map.get(key).delete(sub);
  }

  /* ---------- db: collections + documents with live updates ---------- */
  function makeDb() {
    const colSubs = new Map();  // collection -> Set<{fn, err}>
    const docSubs = new Map();  // "collection/id" -> Set<{fn, err}>
    const timers = new Map();

    async function pushCol(c) {
      const subs = colSubs.get(c);
      if (!subs || !subs.size) return;
      const { data, error } = await sb.from("docs").select("id,data").eq("collection", c).limit(1000);
      if (error) { subs.forEach((s) => s.err && s.err(toAppError(error))); return; }
      const snap = { docs: data.map((r) => ({ id: r.id, exists: true, data: () => r.data })) };
      subs.forEach((s) => s.fn(snap));
    }
    async function pushDoc(key) {
      const subs = docSubs.get(key);
      if (!subs || !subs.size) return;
      const i = key.indexOf("/");
      const c = key.slice(0, i), id = key.slice(i + 1);
      const { data, error } = await sb.from("docs").select("data").eq("collection", c).eq("id", id).maybeSingle();
      if (error) { subs.forEach((s) => s.err && s.err(toAppError(error))); return; }
      const snap = { id, exists: !!data, data: () => (data ? data.data : undefined) };
      subs.forEach((s) => s.fn(snap));
    }
    function refresh(c) {
      clearTimeout(timers.get(c));
      timers.set(c, setTimeout(() => {
        pushCol(c);
        for (const key of docSubs.keys()) if (key.startsWith(c + "/")) pushDoc(key);
      }, 150));
    }
    function refreshAll() {
      const cols = new Set([...colSubs.keys(), ...[...docSubs.keys()].map((k) => k.split("/")[0])]);
      cols.forEach(refresh);
    }

    sb.channel("docs-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const row = (p.new && p.new.collection) ? p.new : p.old;
        if (row && row.collection) refresh(row.collection); else refreshAll();
      })
      .subscribe((status) => { if (status === "SUBSCRIBED") refreshAll(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

    return {
      collection(c) {
        return {
          onSnapshot(fn, err) { const off = addSub(colSubs, c, { fn, err }); pushCol(c); return off; },
        };
      },
      doc(path) {
        const i = path.indexOf("/");
        const c = path.slice(0, i), id = path.slice(i + 1);
        return {
          onSnapshot(fn, err) { const off = addSub(docSubs, path, { fn, err }); pushDoc(path); return off; },
          async set(data) {
            const { error } = await sb.from("docs").upsert({ collection: c, id, data, updated_at: new Date().toISOString() });
            if (error) throw toAppError(error);
            refresh(c);
          },
          async delete() {
            const { error } = await sb.from("docs").delete().eq("collection", c).eq("id", id);
            if (error) throw toAppError(error);
            refresh(c);
          },
        };
      },
    };
  }

  /* ---------- user: who's signed in, names, search ---------- */
  function makeUser() {
    const myId = () => session.user.id;
    return {
      async me() {
        if (isAdmin === null) {
          const { data } = await sb.rpc("is_admin");
          isAdmin = !!data;
        }
        const { data: p } = await sb.from("profiles").select("name").eq("id", myId()).maybeSingle();
        return { id: myId(), name: (p && p.name) || "", isMe: true, isOwner: isAdmin, canEdit: isAdmin };
      },
      async profiles(ids) {
        const out = {};
        const uniq = [...new Set(ids)].filter(Boolean);
        if (!uniq.length) return out;
        const { data } = await sb.from("profiles").select("id,name").in("id", uniq);
        for (const p of data || []) out[p.id] = { id: p.id, name: p.name || "", avatarUrl: null, isMe: p.id === myId() };
        return out;
      },
      async search(q) {
        let query = sb.from("profiles").select("id,name").order("name").limit(20);
        const term = (q || "").trim().replace(/[%_]/g, "");
        if (term) query = query.ilike("name", "%" + term + "%");
        const { data } = await query;
        return (data || []).map((p) => ({ id: p.id, name: p.name || "Unnamed", avatarUrl: null, isMe: p.id === myId() }));
      },
      async can() { return true; },
    };
  }

  window.claude = {
    async use(name) {
      const client = await ready;
      if (!client) return null;
      if (name === "db") return dbInst || (dbInst = makeDb());
      if (name === "user") return userInst || (userInst = makeUser());
      return null;
    },
    async signOut() {
      await sb.auth.signOut();
      location.reload();
    },
    async syncResults(opts) {
      const body = { season: !!(opts && opts.season), week: opts && opts.week ? String(opts.week) : "" };
      const qs = body.season ? "?season=1" : body.week ? "?week=" + encodeURIComponent(body.week) : "";
      const r = await fetch("/api/sync-results" + qs, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + session.access_token,
          "Content-Type": "application/json",
          "X-Adapter-Version": "5",
        },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "the server said no (" + r.status + ")");
      return j;
    },
  };
})();
