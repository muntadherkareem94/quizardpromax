
import { supabase } from './supabaseClient.js';

// Quizard: Premium -> Platinum paid upgrade.
// Prices and unused credit are calculated by Supabase.

const formatIQD = value =>
    Number(value).toLocaleString('en-IQ') + ' IQD';

const formatDate = value =>
    new Date(value).toLocaleString();

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

let activeWindow = null;

export function openPlanUpgradeModal() {
    if (activeWindow) return;

    let selectedMonths = 6;
    let currentQuote = null;
    let quoteVersion = 0;
    let busy = false;

    const previousOverflow = document.body.style.overflow;

    const overlay = document.createElement('div');
    activeWindow = overlay;

    overlay.id = 'qzUpgradeOverlay';

    overlay.innerHTML = `
        <style>
            #qzUpgradeOverlay {
                position: fixed;
                inset: 0;
                z-index: 110000;
                background: rgba(13, 37, 55, .72);
                backdrop-filter: blur(5px);
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 16px;
                font-family: Inter, Arial, sans-serif;
            }

            #qzUpgradeOverlay * {
                box-sizing: border-box;
            }

            #qzUpgradeOverlay .qzu-panel {
                background: #fff;
                color: #19364b;
                width: 100%;
                max-width: 570px;
                max-height: 94vh;
                overflow-y: auto;
                border-radius: 19px;
                padding: 25px;
                box-shadow: 0 20px 60px #0003;
            }

            #qzUpgradeOverlay .qzu-head {
                display: flex;
                align-items: start;
                justify-content: space-between;
                gap: 15px;
            }

            #qzUpgradeOverlay h2 {
                font-size: 22px;
                font-weight: 800;
                margin: 0;
            }

            #qzUpgradeOverlay .qzu-muted {
                color: #657b8d;
                font-size: 13px;
                line-height: 1.6;
                margin-top: 7px;
            }

            #qzUpgradeOverlay .qzu-close {
                border: 0;
                background: #edf3f6;
                border-radius: 50%;
                width: 35px;
                height: 35px;
                cursor: pointer;
                font-size: 22px;
            }

            #qzUpgradeOverlay .qzu-terms {
                display: flex;
                gap: 9px;
                margin: 22px 0 15px;
            }

            #qzUpgradeOverlay .qzu-term {
                flex: 1;
                padding: 12px;
                background: #f2f6f9;
                color: #28485d;
                border: 1px solid #d8e6ee;
                border-radius: 9px;
                font-weight: 700;
                cursor: pointer;
            }

            #qzUpgradeOverlay .qzu-term.selected {
                background: #258eae;
                border-color: #258eae;
                color: white;
            }

            #qzUpgradeOverlay .qzu-summary {
                padding: 17px;
                border: 1px solid #dce7ee;
                background: #f6fafc;
                border-radius: 12px;
                margin-top: 14px;
            }

            #qzUpgradeOverlay .qzu-row {
                display: flex;
                justify-content: space-between;
                gap: 15px;
                padding: 10px 0;
                font-size: 14px;
                border-bottom: 1px solid #e1eaf0;
            }

            #qzUpgradeOverlay .qzu-row:last-child {
                border-bottom: 0;
            }

            #qzUpgradeOverlay .qzu-credit {
                color: #16814f;
                font-weight: 800;
            }

            #qzUpgradeOverlay .qzu-pay {
                font-size: 23px;
                font-weight: 900;
                color: #143c58;
            }

            #qzUpgradeOverlay .qzu-button {
                width: 100%;
                padding: 15px;
                border: 0;
                border-radius: 10px;
                background: #258eae;
                color: #fff;
                font-size: 15px;
                font-weight: 800;
                cursor: pointer;
                margin-top: 18px;
            }

            #qzUpgradeOverlay .qzu-button:disabled {
                background: #9dbcca;
                cursor: not-allowed;
            }

            #qzUpgradeOverlay .qzu-status {
                margin-top: 12px;
                color: #536d80;
                font-size: 13px;
                line-height: 1.5;
            }
        </style>

        <div class="qzu-panel"
             role="dialog"
             aria-modal="true"
             aria-labelledby="qzuTitle">

            <div class="qzu-head">
                <div>
                    <h2 id="qzuTitle">
                        Upgrade to Platinum
                    </h2>

                    <p class="qzu-muted">
                        Your remaining paid Premium value will
                        be deducted from the Platinum price.
                        Your new plan starts after payment
                        confirmation.
                    </p>
                </div>

                <button type="button"
                        class="qzu-close"
                        aria-label="Close">×</button>
            </div>

            <div class="qzu-terms">
                <button type="button"
                        class="qzu-term"
                        data-months="3">3 Months</button>

                <button type="button"
                        class="qzu-term selected"
                        data-months="6">6 Months</button>

                <button type="button"
                        class="qzu-term"
                        data-months="12">12 Months</button>
            </div>

            <div class="qzu-summary" id="qzuSummary">
                Calculating your upgrade...
            </div>

            <button type="button"
                    class="qzu-button"
                    id="qzuCheckout"
                    disabled>
                Calculate upgrade
            </button>

            <p id="qzuStatus"
               class="qzu-status"
               role="status"
               aria-live="polite">
                Loading current subscription information...
            </p>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const summary = overlay.querySelector('#qzuSummary');
    const status = overlay.querySelector('#qzuStatus');
    const checkoutButton =
        overlay.querySelector('#qzuCheckout');

    function close() {
        if (busy) return;

        ++quoteVersion;
        overlay.remove();
        activeWindow = null;

        document.body.style.overflow = previousOverflow;
    }

    async function loadQuote() {
        const version = ++quoteVersion;

        currentQuote = null;
        checkoutButton.disabled = true;

        summary.textContent = 'Calculating your upgrade...';
        status.textContent = 'Checking your paid Premium term...';

        try {
            const { data, error } = await supabase.rpc(
                'qz_upgrade_quote',
                {
                    p_months: selectedMonths,
                    p_create: false,
                    p_max_amount_iqd: null
                }
            );

            if (error) throw error;
            if (version !== quoteVersion) return;
            if (!overlay.isConnected) return;

            currentQuote = data;

            summary.innerHTML = `
                <div class="qzu-row">
                    <span>Current membership</span>
                    <strong>Premium</strong>
                </div>

                <div class="qzu-row">
                    <span>New Platinum (${selectedMonths} months)</span>
                    <strong>
                        ${formatIQD(data.gross_iqd)}
                    </strong>
                </div>

                <div class="qzu-row">
                    <span>Unused Premium credit</span>
                    <span class="qzu-credit">
                        −${formatIQD(data.credit_iqd)}
                    </span>
                </div>

                <div class="qzu-row">
                    <strong>Amount to pay through Qi</strong>
                    <strong class="qzu-pay">
                        ${formatIQD(data.net_iqd)}
                    </strong>
                </div>

                <p class="qzu-muted">
                    Current Premium ends:
                    ${escapeHtml(formatDate(data.current_expires_at))}
                </p>

                <p class="qzu-muted">
                    Estimated new Platinum expiry:
                    ${escapeHtml(
                        formatDate(data.estimated_new_expires_at)
                    )}
                </p>

                <p class="qzu-muted">
                    Exact Platinum activation and expiry are
                    calculated after confirmed payment.
                </p>
            `;

            checkoutButton.disabled = false;
            checkoutButton.textContent =
                'Upgrade — Pay ' + formatIQD(data.net_iqd);

            status.textContent =
                'Your current Premium remains active until ' +
                'the upgrade payment succeeds.';

        } catch (error) {
            if (version !== quoteVersion) return;

            status.textContent =
                'Upgrade unavailable: ' + error.message;

            summary.textContent =
                'Unable to calculate a secure upgrade quote.';
        }
    }

    overlay.querySelector('.qzu-close')
        .addEventListener('click', close);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });

    overlay.querySelectorAll('[data-months]')
        .forEach(button => {
            button.addEventListener('click', () => {
                if (busy) return;

                selectedMonths = Number(
                    button.dataset.months
                );

                overlay.querySelectorAll('[data-months]')
                    .forEach(item => {
                        item.classList.toggle(
                            'selected',
                            item === button
                        );
                    });

                loadQuote();
            });
        });

    checkoutButton.addEventListener('click', async () => {
        if (busy || !currentQuote) return;

        const quote = currentQuote;

        const confirmed = window.confirm(
            'Upgrade Premium to Platinum?\n\n' +
            'New duration: ' + selectedMonths + ' months\n' +
            'Full price: ' + formatIQD(quote.gross_iqd) + '\n' +
            'Unused credit: −' +
                formatIQD(quote.credit_iqd) + '\n' +
            'Pay now: ' + formatIQD(quote.net_iqd) +
            '\n\nYour new Platinum period will start ' +
            'after successful Qi payment verification.'
        );

        if (!confirmed) return;

        busy = true;
        checkoutButton.disabled = true;
        checkoutButton.textContent = 'Opening Qi checkout...';

        try {
            const { data, error } =
                await supabase.functions.invoke(
                    'qi-start-plan-upgrade',
                    {
                        body: {
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
                    data?.error || 'Payment link unavailable'
                );
            }

            const destination = new URL(data.checkout_url);
            const host = destination.hostname.toLowerCase();

            if (
                destination.protocol !== 'https:' ||
                !(host === 'qi.iq' || host.endsWith('.qi.iq'))
            ) {
                throw Error('Invalid gateway destination');
            }

            window.location.assign(destination.href);

        } catch (error) {
            busy = false;

            status.textContent =
                'Could not start upgrade: ' + error.message;

            checkoutButton.disabled = false;
            checkoutButton.textContent = 'Review upgrade again';

            // Recalculate before allowing another attempt.
            loadQuote();
        }
    });

    loadQuote();
}
