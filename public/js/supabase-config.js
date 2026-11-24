// Isi dua nilai ini dari Supabase Dashboard -> Project Settings -> API (atau tombol "Connect").
// Keduanya MEMANG boleh publik (sama seperti firebaseConfig): keamanan data diatur oleh aturan RLS di supabase/schema.sql.
// Pakai kunci "anon" (eyJ...) atau "publishable" (sb_publishable_...). JANGAN pernah memakai kunci "service_role" / "secret" di sini.
export const SUPABASE_URL = "https://ioenawfyjuoqpwoofrqw.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_BMXLER7Pq4g7jZUlYpmifw_L0GdUIe4";
