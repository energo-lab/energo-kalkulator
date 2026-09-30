import { createClient } from "@supabase/supabase-js";

// Veřejné údaje projektu (anon key je určen pro prohlížeč; přístup k datům hlídá RLS v databázi).
// Nastavují se ve Vercel → Settings → Environment Variables, lokálně v .env.local (viz .env.example).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Bez konfigurace je klient null – kalkulačka funguje dál, jen bez cloudového archivu.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
