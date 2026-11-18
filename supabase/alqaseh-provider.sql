-- Run once before deploying the Al-Qaseh Edge Functions and frontend.
-- Existing Qi records are explicitly labelled 'qi' by the DEFAULT.
-- No entitlements, prices, or payment statuses are modified.
ALTER TABLE public.qz_card_checkouts
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'qi';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.qz_card_checkouts'::regclass
      AND conname = 'qz_card_checkouts_provider_check'
  ) THEN
    ALTER TABLE public.qz_card_checkouts
      ADD CONSTRAINT qz_card_checkouts_provider_check
      CHECK (provider IN ('qi', 'alqaseh'));
  END IF;
END $$;
