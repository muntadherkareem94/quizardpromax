// supabaseClient.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.48.0/+esm';

export const SUPABASE_URL = 'https://ftcttxpmuqhqtbcdwgtr.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0Y3R0eHBtdXFocXRiY2R3Z3RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4OTg5MDQsImV4cCI6MjA3MTQ3NDkwNH0.AR3qXatnIZZSwGu_E1tH7elEyPIXS-zTFrd0b-YKqjg';


export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
