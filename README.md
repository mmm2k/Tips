# NFL Tipping — self-hosted on Vercel

A static page (`index.html`) plus two small serverless functions:

- `api/config.js` gives the browser your public Supabase settings.
- `api/sync-results.js` pulls fixtures and scores from ESPN's scoreboard feed into the comp.

Supabase (free tier) handles sign-in (emailed sign-in links, no passwords) and the database.

---

## 1. Set up Supabase (about 10 minutes)

1. Create a free account at https://supabase.com and start a **New project**. Pick a region near you (Sydney is available).
2. Open **SQL Editor → New query**, paste in all of `supabase/schema.sql`, then choose **Run**.
3. Go to **Project Settings → API** (called **API Keys** in newer dashboards) and copy three values:
   - **Project URL**
   - **anon / public key**
   - **service_role key**. Keep this one secret: it can bypass all security rules.

## 2. Deploy to Vercel

**Option A: through GitHub (easiest to update later)**
1. Put this folder in a new GitHub repository.
2. In Vercel, choose **Add New → Project** and import that repository. There's no build step, so leave the framework preset as **Other**.

**Option B: from your computer**
1. Install Node.js 18 or newer.
2. In this folder, run `npx vercel`.

Then, either way, go to **Project → Settings → Environment Variables** in Vercel and add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_ANON_KEY` | anon / public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `CRON_SECRET` | any long random string, e.g. from https://www.uuidgenerator.net |

**Redeploy** after adding them. Environment variables only take effect on a new deployment.

## 3. Point Supabase sign-in at your site

In Supabase, go to **Authentication → URL Configuration**:
- set **Site URL** to your Vercel address, e.g. `https://nfl-tipping.vercel.app`
- add the same address under **Redirect URLs**

## 4. Make yourself the admin

1. Open your site and sign in with your email. Tap the link that arrives.
2. In Supabase **SQL Editor**, run this, using your own email:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'you@example.com';
```

3. Reload the site. The **Admin** tab appears.

## 5. Run the comp

1. In **Admin**, choose **Sync NFL results now**. This loads last week, this week and next week from ESPN.
2. Send the link to your players. Once each of them has signed in, find them under **Players and their teams** and give them their four teams.
3. Results sync automatically once a day at 16:00 UTC (2am Sydney time). You can press **Sync NFL results now** any time to update immediately.

---

## Good to know

- **Sign-in emails:** Supabase's built-in email only sends a few messages per hour, which is fine for testing. For a whole group signing in at once, connect a free email provider such as Resend or Brevo under **Authentication → Emails → SMTP Settings** in Supabase.
- **Cron frequency:** Vercel's free Hobby plan runs cron jobs once a day. For syncs every 30 minutes on game days, either upgrade to Pro and edit `vercel.json`, or use a free service like https://cron-job.org to call `https://YOUR-SITE/api/sync-results` with the header `Authorization: Bearer YOUR_CRON_SECRET`.
- **ESPN feed:** the scoreboard feed is free but unofficial and could change without notice. If syncing ever breaks, you can still enter scores by hand in the Admin tab.
- **Pick locking:** the lock at kickoff uses the time on each player's device. It's fine for a friendly comp, but it isn't tamper-proof.
- **Local testing:** run `npx vercel dev` (after `npx vercel link` and `npx vercel env pull`), so that the `/api` routes work.
