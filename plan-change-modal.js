
import { supabase } from './supabaseClient.js';

// Quizard — Upgrade plan, duration, or both.
// All prices and credits are calculated server-side.

const money = value =>
    Number(value).toLocaleString('en-IQ') + ' IQD';

const prettyDate = value =>
    new Date(value).toLocaleString();

const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

let openOverlay = null;

function allowedChanges(plan, months) {
    const choices = [];

    for (const tier of ['premium', 'platinum']) {
        // Never downgrade Platinum to Premium.
        if (plan === 'platinum' && tier === 'premium') {
            continue;
        }

        for (const duration of [3, 6, 12]) {
            // Never reduce the purchased duration.
            if (duration < months) continue;

            // Same tier needs a strictly longer duration.
            if (tier === plan && duration <= months) {
                continue;
            }

            choices.push({
                tier,
                months: duration
            });
        }
    }

    return choices;
}

export function openPlanChangeModal({
    currentPlan,
    currentMonths
} = {}) {
    if (openOverlay) return;

    const sourcePlan = String(
        currentPlan || ''
    ).toLowerCase();

    const sourceMonths = Number(currentMonths);

    if (
        !['premium', 'platinum'].includes(sourcePlan) ||
        ![3, 6, 12].includes(sourceMonths)
    ) {
        window.alert(
            'Please refresh your Profile before managing this plan.'
        );
        return;
    }

    const choices = allowedChanges(
        sourcePlan,
        sourceMonths
    );

    if (!choices.length) {
        return;
    }

    // Prefer upgrading to Platinum, when available.
    const preferred = choices.find(choice =>
        choice.tier === 'platinum' &&
        choice.months === Math.max(6, sourceMonths)
    ) || choices[0];

    let targetPlan = preferred.tier;
    let targetMonths = preferred.months;

    let currentQuote = null;
    let quoteSequence = 0;
    let busy = false;

    const oldOverflow = document.body.style.overflow;

    const overlay = document.createElement('div');
    openOverlay = overlay;

    overlay.id = 'qzPlanChangeOverlay';

    overlay.innerHTML = `
        <style>
            #qzPlanChangeOverlay {
                position: fixed;
                inset: 0;
                z-index: 110000;
                background: rgba(12, 35, 55, .72);
                backdrop-filter: blur(5px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                font-family: Inter, Arial, sans-serif;
            }

            #qzPlanChangeOverlay * {
                box-sizing: border-box;
            }

            #qzPlanChangeOverlay .qzc-panel {
                width: 100%;
                max-width: 580px;
                max-height: 94vh;
                overflow-y: auto;
                background: #fff;
                color: #17394f;
                border-radius: 18px;
                padding: 24px;
                box-shadow: 0 20px 65px #0003;
            }

            #qzPlanChangeOverlay .qzc-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
            }

            #qzPlanChangeOverlay h2 {
                margin: 0;
                font-size: 22px;
                font-weight: 800;
            }

            #qzPlanChangeOverlay .qzc-muted {
                color: #657c8c;
                font-size: 13px;
                line-height: 1.65;
                margin: 7px 0;
            }

            #qzPlanChangeOverlay .qzc-close {
                border: 0;
                background: #edf2f6;
                border-radius: 50%;
                width: 36px;
                height: 36px;
                font-size: 23px;
                cursor: pointer;
                flex-shrink: 0;
            }

            #qzPlanChangeOverlay .qzc-label {
                font-weight: 700;
                font-size: 14px;
                margin-top: 18px;
                margin-bottom: 9px;
            }

            #qzPlanChangeOverlay .qzc-choices {
                display: flex;
                flex-wrap: wrap;
                gap: 9px;
            }

            #qzPlanChangeOverlay .qzc-choice {
                flex: 1;
                min-width: 100px;
                border: 1px solid #d6e4ec;
                background: #f3f7fa;
                color: #27506a;
                padding: 12px;
                border-radius: 10px;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
            }

            #qzPlanChangeOverlay .qzc-choice.selected {
                background: #238aab;
                border-color: #238aab;
                color: #fff;
            }

            #qzPlanChangeOverlay .qzc-summary {
                margin-top: 18px;
                padding: 16px;
                border: 1px solid #dbe8ef;
                background: #f7fafc;
                border-radius: 12px;
            }

            #qzPlanChangeOverlay .qzc-row {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                padding: 10px 0;
                border-bottom: 1px solid #e3edf2;
                font-size: 14px;
            }

            #qzPlanChangeOverlay .qzc-row:last-child {
                border-bottom: 0;
            }

            #qzPlanChangeOverlay .qzc-credit {
                font-weight: 800;
                color: #15844e;
            }

            #qzPlanChangeOverlay .qzc-total {
                font-weight: 900;
                font-size: 21px;
                color: #12435e;
            }

            #qzPlanChangeOverlay .qzc-checkout {
                margin-top: 18px;
                border: 0;
                width: 100%;
                padding: 15px;
                border-radius: 10px;
                background: #238aab;
                color: white;
                font-size: 15px;
                font-weight: 800;
                cursor: pointer;
            }

            #qzPlanChangeOverlay .qzc-checkout:disabled {
                background: #9fbac7;
                cursor: not-allowed;
            }

            #qzPlanChangeOverlay .qzc-refresh {
                margin-top: 12px;
                border: 0;
                background: transparent;
                color: #176986;
                font-size: 13px;
                font-weight: 700;
                cursor: pointer;
            }

            #qzPlanChangeOverlay .qzc-status {
                font-size: 13px;
                margin-top: 12px;
                color: #526e80;
                line-height: 1.6;
                white-space: pre-wrap;
            }
        </style>

        <div class="qzc-panel"
             role="dialog"
             aria-modal="true"
             aria-labelledby="qzcTitle">

            <div class="qzc-header">
                <div>
                    <h2 id="qzcTitle">
                        Upgrade My Subscription
                    </h2>

                    <p class="qzc-muted">
                        Current membership:
                        <strong>
                            ${escapeHtml(sourcePlan.toUpperCase())}
                            — ${sourceMonths} months
                        </strong>
                    </p>

                    <p class="qzc-muted">
                        Upgrade your tier, duration, or both.
                        Unused paid value is deducted
                        automatically.
                    </p>
                </div>

                <button type="button"
                    class="qzc-close"
                    aria-label="Close">×</button>
            </div>

            <div class="qzc-label">New membership</div>
            <div id="qzcTiers"
                 class="qzc-choices"></div>

            <div class="qzc-label">New duration</div>
            <div id="qzcMonths"
                 class="qzc-choices"></div>

            <div id="qzcSummary"
                 class="qzc-summary">
                Calculating your upgrade...
            </div>

            <button id="qzcCheckout"
                type="button"
                class="qzc-checkout"
                disabled>
                Calculate Upgrade
            </button>

            <button id="qzcRefresh"
                type="button"
                class="qzc-refresh">
                Refresh Price
            </button>

            <p id="qzcStatus"
               class="qzc-status"
               role="status"
               aria-live="polite">
                Checking your subscription...
            </p>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const tiers = overlay.querySelector('#qzcTiers');
    const durations = overlay.querySelector('#qzcMonths');
    const summary = overlay.querySelector('#qzcSummary');
    const status = overlay.querySelector('#qzcStatus');
    const checkout = overlay.querySelector('#qzcCheckout');
    const refresh = overlay.querySelector('#qzcRefresh');

    function close() {
        if (busy) return;

        ++quoteSequence;
        overlay.remove();
        openOverlay = null;
        document.body.style.overflow = oldOverflow;
        document.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') close();
    }

    function availableMonths(plan) {
        return choices
            .filter(choice => choice.tier === plan)
            .map(choice => choice.months);
    }

    function renderChoices() {
        const plans = [...new Set(
            choices.map(choice => choice.tier)
        )];

        tiers.innerHTML = plans.map(plan => `
            <button type="button"
                class="qzc-choice
                    ${plan === targetPlan ? 'selected' : ''}"
                data-qzc-tier="${plan}">
                ${plan.toUpperCase()}
            </button>
        `).join('');

        durations.innerHTML =
            availableMonths(targetPlan).map(months => `
                <button type="button"
                    class="qzc-choice
                        ${months === targetMonths ? 'selected' : ''}"
                    data-qzc-months="${months}">
                    ${months} Months
                </button>
            `).join('');

        tiers.querySelectorAll('[data-qzc-tier]')
            .forEach(button => {
                button.addEventListener('click', () => {
                    if (busy) return;

                    targetPlan = button.dataset.qzcTier;

                    const available = availableMonths(targetPlan);

                    if (!available.includes(targetMonths)) {
                        targetMonths = available[0];
                    }

                    renderChoices();
                    loadQuote();
                });
            });

        durations.querySelectorAll('[data-qzc-months]')
            .forEach(button => {
                button.addEventListener('click', () => {
                    if (busy) return;

                    targetMonths = Number(
                        button.dataset.qzcMonths
                    );

                    renderChoices();
                    loadQuote();
                });
            });
    }

    async function loadQuote() {
        const sequence = ++quoteSequence;

        currentQuote = null;
        checkout.disabled = true;
        summary.textContent = 'Calculating...';
        status.textContent = 'Checking subscription and prices...';

        const expectedPlan = targetPlan;
        const expectedMonths = targetMonths;

        try {
            const { data, error } = await supabase.rpc(
                'qz_plan_change_quote',
                {
                    p_target_plan_slug: expectedPlan,
                    p_months: expectedMonths,
                    p_create: false,
                    p_max_amount_iqd: null
                }
            );

            if (error) throw error;

            if (
                sequence !== quoteSequence ||
                !overlay.isConnected
            ) {
                return;
            }

            if (
                data.current_plan !== sourcePlan ||
                Number(data.current_months) !== sourceMonths ||
                data.target_plan !== expectedPlan ||
                Number(data.target_months) !== expectedMonths
            ) {
                throw Error(
                    'Membership has changed. Refresh Personal Profile.'
                );
            }

            currentQuote = data;

            summary.innerHTML = `
                <div class="qzc-row">
                    <span>Current subscription</span>
                    <strong>
                        ${escapeHtml(sourcePlan.toUpperCase())}
                        — ${sourceMonths} months
                    </strong>
                </div>

                <div class="qzc-row">
                    <span>
                        New ${escapeHtml(expectedPlan.toUpperCase())}
                        (${expectedMonths} months)
                    </span>

                    <strong>${money(data.gross_iqd)}</strong>
                </div>

                <div class="qzc-row">
                    <span>Unused subscription credit</span>

                    <strong class="qzc-credit">
                        −${money(data.credit_iqd)}
                    </strong>
                </div>

                <div class="qzc-row">
                    <strong>Pay now through Qi</strong>
                    <strong class="qzc-total">
                        ${money(data.net_iqd)}
                    </strong>
                </div>

                <p class="qzc-muted">
                    Old subscription expiry:
                    ${escapeHtml(
                        prettyDate(data.current_expires_at)
                    )}
                </p>

                <p class="qzc-muted">
                    Estimated new expiry:
                    ${escapeHtml(
                        prettyDate(data.estimated_new_expires_at)
                    )}
                </p>

                <p class="qzc-muted">
                    The full new term starts immediately after
                    successful payment verification.
                    The old subscription is ended at that time.
                </p>
            `;

            checkout.disabled = false;
            checkout.textContent =
                'Upgrade — Pay ' + money(data.net_iqd);

            status.textContent =
                'Your current subscription remains active ' +
                'until the new payment is verified.';

        } catch (error) {
            if (
                sequence !== quoteSequence ||
                !overlay.isConnected
            ) {
                return;
            }

            checkout.disabled = true;

            summary.textContent =
                'This option is currently unavailable.';

            status.textContent =
                'Unable to calculate: ' + error.message;
        }
    }

    checkout.addEventListener('click', async () => {
        if (busy || !currentQuote) return;

        const quote = currentQuote;
        const selectedPlan = targetPlan;
        const selectedMonths = targetMonths;

        const confirmed = window.confirm(
            'Confirm subscription upgrade\n\n' +
            'Current: ' + sourcePlan.toUpperCase() +
            ' (' + sourceMonths + ' months)\n' +
            'New: ' + selectedPlan.toUpperCase() +
            ' (' + selectedMonths + ' months)\n\n' +
            'Full price: ' + money(quote.gross_iqd) + '\n' +
            'Unused credit: −' + money(quote.credit_iqd) + '\n' +
            'Amount to pay: ' + money(quote.net_iqd) +
            '\n\nThe new term starts after verified payment.'
        );

        if (!confirmed) return;

        busy = true;
        checkout.disabled = true;
        refresh.disabled = true;

        checkout.textContent = 'Opening Qi...';

        try {
            const { data, error } =
                await supabase.functions.invoke(
                    'qi-start-plan-upgrade',
                    {
                        body: {
                            target_plan_slug: selectedPlan,
                            months: selectedMonths,
                            max_amount_iqd: quote.net_iqd
                        }
                    }
                );

            if (error) {
                let message = error.message;

                try {
                    const detail =
                        await error.context?.json?.();

                    if (detail?.error) {
                        message = detail.error;
                    }
                } catch (_) {}

                throw Error(message);
            }

            if (!data?.checkout_url) {
                throw Error(
                    data?.error || 'Missing Qi payment link'
                );
            }

            if (
                data.target_plan !== selectedPlan ||
                Number(data.target_months) !== selectedMonths ||
                Number(data.net_iqd) > Number(quote.net_iqd)
            ) {
                throw Error('Checkout quote does not match selection');
            }

            const destination = new URL(data.checkout_url);
            const host = destination.hostname.toLowerCase();

            if (
                destination.protocol !== 'https:' ||
                !(host === 'qi.iq' || host.endsWith('.qi.iq'))
            ) {
                throw Error('Untrusted payment destination');
            }

            window.location.assign(destination.href);

        } catch (error) {
            busy = false;
            checkout.disabled = true;
            refresh.disabled = false;
            currentQuote = null;

            checkout.textContent = 'Refresh Price to Retry';

            status.textContent =
                'Unable to start checkout: ' + error.message;
        }
    });

    refresh.addEventListener('click', () => {
        if (!busy) loadQuote();
    });

    overlay.querySelector('.qzc-close')
        .addEventListener('click', close);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });

    document.addEventListener('keydown', onKeyDown);

    renderChoices();
    loadQuote();
}
