// Hands the browser the two PUBLIC Supabase values. The anon key is designed to be
// public; row-level security in Supabase is what protects the data.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  });
}
