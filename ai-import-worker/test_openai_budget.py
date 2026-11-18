"""Offline regression tests for the paid OpenAI-only import cost controls."""
import unittest
from decimal import Decimal
from cost_guard import rate, usage_cost_usd, reserve_cost_usd, assert_budget, BudgetExceeded


class OpenAIImportBudgetTests(unittest.TestCase):
    def test_gpt_54_mini_standard_rates(self):
        self.assertEqual(rate("gpt-5.4-mini", "standard"),
            (Decimal("0.75"), Decimal("4.50"), Decimal("0.075")))

    def test_price_per_mcq_example(self):
        # 2K uncached input, 800 output -> $0.0051 per question.
        self.assertEqual(
            usage_cost_usd("gpt-5.4-mini", "standard", 2000, 800),
            Decimal("0.00510000"),
        )

    def test_cached_input_is_counted_separately(self):
        self.assertEqual(
            usage_cost_usd("gpt-5.4-mini", "standard", 2000, 800, 1000),
            Decimal("0.00442500"),
        )

    def test_pdf_vision_request_reserve_before_spending(self):
        reserve = reserve_cost_usd(
            "gpt-5.4-mini", "standard", "Transcribe every source question",
            3, True, 12000,
        )
        self.assertGreater(reserve, Decimal("0.05"))
        assert_budget(10.0, 9.0, reserve)
        with self.assertRaises(BudgetExceeded):
            assert_budget(10.0, 9.98, reserve)

    def test_usage_with_invalid_cache_is_rejected(self):
        with self.assertRaises(ValueError):
            usage_cost_usd("gpt-5.4-mini","standard",500,800,501)


if __name__ == "__main__":
    unittest.main()
