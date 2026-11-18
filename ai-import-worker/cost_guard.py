"""Quizard AI importer: conservative per-book API *estimated* dollar accounting.

This is NOT a provider-enforced hard billing limit. It checks remaining budget
before each request, using conservative token reserves, and records completed
requests using actual returned usage. Actual invoices remain authoritative.

Published prices at https://developers.openai.com/api/docs/pricing
(viewed 2026-11-17). USD per 1,000,000 input/output/cached input tokens.
Regional, enterprise, and other surcharges are not reflected.
"""
from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP

PRICES = {
    # Official API list prices (USD per million tokens), 2026-11-18.
    # Standard tier is used for OpenAI-only import jobs to avoid occasional
    # Flex-unavailability during pilot; Flex entries are provisional only
    # if the operator enables it explicitly for a supported model.
    "gpt-5.4-mini": {
        "standard": (Decimal("0.75"), Decimal("4.50"), Decimal("0.075")),
        # Conservative quote even if a discounted Flex request is used.
        "flex": (Decimal("0.75"), Decimal("4.50"), Decimal("0.075")),
    },
    "gpt-6.1-sol": {
        "flex": (Decimal("1"), Decimal("5"), Decimal("0.05")),
        "standard": (Decimal("2"), Decimal("10"), Decimal("0.10")),
    },
    "gpt-6-astra": {
        "flex": (Decimal("5"), Decimal("25"), Decimal("0.50")),
        "standard": (Decimal("10"), Decimal("50"), Decimal("1.00")),
    },
    "gpt-6.1-terra": {
        "flex": (Decimal("0.50"), Decimal("2.50"), Decimal("0.025")),
        "standard": (Decimal("1"), Decimal("5"), Decimal("0.05")),
    }
}
MILLION = Decimal("1000000")


class BudgetExceeded(RuntimeError):
    """A preflight cost reserve does not fit the book's remaining budget."""


def rate(model: str, service_tier: str):
    if model not in PRICES:
        raise ValueError(f"No verified API token price configured for model {model}")
    tier = "flex" if service_tier == "flex" else "standard"
    return PRICES[model][tier]


def usage_cost_usd(model: str, service_tier: str,
                   input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> Decimal:
    input_rate, output_rate, cached_rate = rate(model, service_tier)
    if input_tokens < 0 or output_tokens < 0 or not 0 <= cached_tokens <= input_tokens:
        raise ValueError("Invalid token counts")
    cost = (
        Decimal(input_tokens - cached_tokens) * input_rate
        + Decimal(cached_tokens) * cached_rate
        + Decimal(output_tokens) * output_rate
    ) / MILLION
    return cost.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)


def reserve_cost_usd(model: str, service_tier: str, prompt: str,
                     page_count: int, pdf_attached: bool,
                     output_cap: int) -> Decimal:
    """Heuristic reserve, not an upper bound on PDF image tokens.

    PDF page image tokenization is model-dependent. A dollar hard cap cannot
    be guaranteed solely by client-side token estimation.
    """
    if page_count < 0 or output_cap < 1:
        raise ValueError("Invalid estimated input sizes")
    input_rate, output_rate, _ = rate(model, service_tier)
    estimated_input = max(
        1000,
        (len(prompt) + 1) // 2 + (4500 * page_count if pdf_attached else 0)
    )
    return (
        (Decimal(estimated_input) * input_rate
         + Decimal(output_cap) * output_rate) / MILLION
    ).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)


def assert_budget(budget: float, spent: float, reserve: Decimal) -> None:
    remaining = Decimal(str(budget)) - Decimal(str(spent))
    if remaining < reserve:
        raise BudgetExceeded(
            f"Estimated API budget pause: USD {remaining:.4f} remains, "
            f"next request may require about USD {reserve:.4f}. "
            "Increase this book's limit in the Import Center to continue."
        )


def safely_selectable_text(document, start_page: int, end_page: int) -> str | None:
    """Use text-first only with readable, simple single-column text.

    Any raster image, vector figure, table-like drawing, scan, or low-text
    page goes through original-PDF vision extraction instead.
    Independent verification *always* uses the source PDF.
    """
    out = []
    for page_num in range(start_page, end_page + 1):
        page = document[page_num - 1]
        text = page.get_text(sort=True)
        if len(text.strip()) < 130 or "\ufffd" in text or "\x00" in text:
            return None
        if page.get_images(full=True):
            return None
        try:
            if len(page.get_drawings()) >= 3:
                return None
            tables = page.find_tables()
            if getattr(tables, "tables", None):
                return None
        except Exception:
            return None
        blocks = [
            b for b in page.get_text("blocks")
            if len(b) >= 5 and isinstance(b[4], str) and len(b[4].strip()) >= 15
        ]
        if not blocks:
            return None
        for left in blocks:
            for right in blocks:
                if left is right:
                    continue
                if abs(float(left[1]) - float(right[1])) < 10:
                    non_overlap = (float(left[2]) < float(right[0]) - 18 or
                                   float(right[2]) < float(left[0]) - 18)
                    if non_overlap and min(len(left[4]), len(right[4])) > 35:
                        return None
        out.append(f"=== ORIGINAL PDF PAGE {page_num} ===\n{text[:45000]}")
    return "\n\n".join(out)
