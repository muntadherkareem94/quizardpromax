

import { supabase } from './supabaseClient.js';
import './standalone-book-checkout.js';


// QUIZARD SUBSCRIPTION MODAL
// Opens over dashboard.html without leaving the page.


let overlay = null;
let currentBookId = null;



let selectedMonths = 3;       // Premium/Platinum: 3/6/12
let selectedBookMonths = 3;   // Individual book: 3/6/12
let modalData = null;

// Prevent stale upgrade quotes and duplicate checkout clicks.
let upgradeQuoteVersion = 0;
let planCheckoutBusy = false;



// Supports plan renewal without selecting a particular book.
let planOnlyMode = false;
let preferredPlanSlug = null;


let previousOverflow = '';
let previousFocus = null;
let loadVersion = 0;

const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);


const formatPrice = value =>
    Number(value).toLocaleString('en-IQ') + ' IQD';

// Calculate savings against repeatedly buying the
// same 3-month plan over the selected duration.
function calculatePlanSavings(prices, planSlug, months) {
    if (![6, 12].includes(months)) {
        return null;
    }

    const quarterly = prices.find(p =>
        p.plan_slug === planSlug &&
        p.months === 3 &&
        p.enabled === true
    );

    const selected = prices.find(p =>
        p.plan_slug === planSlug &&
        p.months === months &&
        p.enabled === true
    );

    if (!quarterly || !selected) {
        return null;
    }

    const quarterlyPrice = Number(quarterly.amount_iqd);
    const selectedPrice = Number(selected.amount_iqd);

    if (
        !Number.isFinite(quarterlyPrice) ||
        !Number.isFinite(selectedPrice) ||
        quarterlyPrice <= 0 ||
        selectedPrice <= 0
    ) {
        return null;
    }

    const baselinePrice = quarterlyPrice * (months / 3);
    const amountSaved = baselinePrice - selectedPrice;

    // Never advertise savings if there is no discount.
    if (amountSaved <= 0) {
        return null;
    }

    const percentSaved = Math.round(
        (amountSaved / baselinePrice) * 100
    );

    return {
        amount: amountSaved,
        percentage: percentSaved,
        baselinePrice
    };
}


function setMessage(message) {
    document.getElementById('qz-sub-message').textContent = message;
}

function createSubscriptionModal() {
    if (overlay) return;

    const style = document.createElement('style');
    style.textContent = `
        #qz-sub-overlay {
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 18px;
            background: rgba(12, 30, 48, .68);
            backdrop-filter: blur(5px);
        }

        #qz-sub-overlay[hidden] {
            display: none;
        }

        #qz-sub-overlay * {
            box-sizing: border-box;
        }

        
#qz-sub-overlay .qz-panel {
    width: 100%;
    max-width: 1180px;
    max-height: 92vh;
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    overscroll-behavior: contain;
    position: relative;
    background: #fff;
    border-radius: 20px;
    padding: 28px;
    box-shadow: 0 20px 65px rgba(0, 0, 0, .24);
    color: #16334b;
    font-family: Inter, Arial, sans-serif;
}


        #qz-sub-overlay .qz-close {
            position: absolute;
            top: 12px;
            right: 15px;
            border: none;
            border-radius: 50%;
            width: 34px;
            height: 34px;
            background: #edf2f6;
            color: #4b6174;
            font-size: 23px;
            cursor: pointer;
        }

        #qz-sub-overlay .qz-heading {
            font-size: 23px;
            font-weight: 800;
            margin: 0 40px 7px 0;
        }

        #qz-sub-overlay .qz-description {
            color: #66798a;
            font-size: 13px;
            line-height: 1.6;
            margin-bottom: 20px;
        }

        #qz-sub-overlay .qz-durations {
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 20px;
        }

        #qz-sub-overlay .qz-duration {
            padding: 10px 19px;
            background: #f2f6f9;
            border: 1px solid #d7e4ed;
            border-radius: 9px;
            color: #28485d;
            font-weight: 700;
            cursor: pointer;
        }

        #qz-sub-overlay .qz-duration.selected {
            background: #2994b5;
            color: #fff;
            border-color: #2994b5;
        }

    

#qz-sub-overlay .qz-cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
    align-items: stretch;
}

#qz-sub-overlay .qz-plan {
    border: 1px solid #dce7ee;
    border-radius: 15px;
    padding: 21px;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
}

/* Keep included/not-included text and buttons at the bottom */
#qz-sub-overlay .qz-plan > .qz-included,
#qz-sub-overlay .qz-plan > .qz-not-included {
    margin-top: auto;
    padding-top: 16px;
}

#qz-sub-overlay .qz-plan > .qz-purchase {
    margin-top: 10px;
    min-height: 46px;
    flex-shrink: 0;
}


#qz-sub-overlay .qz-plan.free {
    border: 2px solid #48a868;
}


#qz-sub-overlay .qz-cover-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 14px 0 12px;
    align-items: start;
}

#qz-sub-overlay .qz-included-details {
    margin: 12px 0;
}

#qz-sub-overlay .qz-included-details summary {
    display: list-item;
    cursor: pointer;
    color: #237eac;
    font-size: 13px;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
}

#qz-sub-overlay .qz-included-details summary:hover {
    color: #164b72;
}

#qz-sub-overlay .qz-included-details ol {
    margin: 12px 0 0;
    padding: 12px 12px 12px 35px;
    max-height: 230px;
    overflow-y: auto;
    list-style: decimal;
    background: #f5f9fc;
    border: 1px solid #e0e9ef;
    border-radius: 10px;
}

#qz-sub-overlay .qz-included-details li {
    padding: 6px 2px;
    font-size: 12px;
    line-height: 1.5;
    color: #344f63;
    border-bottom: 1px solid #e6edf2;
    overflow-wrap: anywhere;
}

#qz-sub-overlay .qz-included-details li:last-child {
    border-bottom: 0;
}

@media (max-width: 980px) {
    #qz-sub-overlay .qz-cards {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 600px) {
    #qz-sub-overlay .qz-cards {
        grid-template-columns: 1fr;
    }

    #qz-sub-overlay .qz-cover-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
}


#qz-sub-overlay .qz-cover-card {
    aspect-ratio: 3 / 4;
    border: 1px solid #d8e4ec;
    border-radius: 10px;
    overflow: hidden;
    background: #f5f8fb;
    display: flex;
    align-items: center;
    justify-content: center;
}

#qz-sub-overlay .qz-cover-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

#qz-sub-overlay .qz-cover-fallback {
    width: 100%;
    height: 100%;
    padding: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.25;
    color: #456173;
    background: linear-gradient(180deg, #f8fbfd 0%, #eaf2f7 100%);
}

        #qz-sub-overlay .qz-plan.platinum {
            border: 2px solid #6973b8;
        }

        #qz-sub-overlay .qz-plan.recommended {
            box-shadow: 0 0 0 2px #36a1bd;
        }

        #qz-sub-overlay .qz-plan h3 {
            margin: 0 0 7px;
            font-size: 21px;
            font-weight: 800;
        }

        #qz-sub-overlay .qz-price {
            font-size: 25px;
            font-weight: 800;
            margin: 14px 0 5px;
        }

        #qz-sub-overlay .qz-small {
            font-size: 12px;
            color: #67798a;
            line-height: 1.55;
        }

        #qz-sub-overlay .qz-included {
            color: #16805c;
            font-size: 13px;
            font-weight: 700;
            margin: 12px 0;
        }

        #qz-sub-overlay .qz-not-included {
            color: #a85e31;
            font-size: 12px;
            margin: 12px 0;
        }

        #qz-sub-overlay .qz-purchase {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 9px;
            background: #238eb0;
            color: #fff;
            font-weight: 700;
            cursor: pointer;
            margin-top: 12px;
        }

        #qz-sub-overlay .platinum .qz-purchase {
            background: #6571b5;
        }

        #qz-sub-overlay .qz-purchase:disabled {
            opacity: .5;
            cursor: not-allowed;
        }

     

#qz-sub-overlay .qz-standalone {
    background: #f4f8fb;
    border: 1px solid #dce7ee;
    border-radius: 13px;
    padding: 19px;
    margin-top: 17px;
}

#qz-sub-overlay .qz-standalone-header {
    display: flex;
    align-items: flex-start;
    gap: 18px;
    margin-bottom: 18px;
}

#qz-sub-overlay .qz-standalone-cover {
    flex: 0 0 110px;
    width: 110px;
    max-width: 110px;
    aspect-ratio: 3 / 4;
    border: 1px solid #d8e4ec;
    border-radius: 12px;
    overflow: hidden;
    background: #ffffff;
    box-shadow: 0 3px 12px rgba(16, 53, 75, 0.08);
}

#qz-sub-overlay .qz-standalone-cover img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #ffffff;
    display: block;
}

#qz-sub-overlay .qz-standalone-info {
    flex: 1;
    min-width: 0;
}

#qz-sub-overlay .qz-standalone-title {
    font-size: 17px;
    line-height: 1.4;
    font-weight: 800;
    color: #16334b;
    margin: 7px 0;
    overflow-wrap: anywhere;
}

#qz-sub-overlay .qz-standalone-label {
    display: inline-block;
    padding: 5px 9px;
    background: #e3f2f9;
    color: #237eac;
    border-radius: 7px;
    font-size: 11px;
    font-weight: 700;
    margin-top: 7px;
}

@media (max-width: 600px) {
    #qz-sub-overlay .qz-standalone-header {
        gap: 12px;
    }

    #qz-sub-overlay .qz-standalone-cover {
        flex-basis: 86px;
        width: 86px;
        max-width: 86px;
    }

    #qz-sub-overlay .qz-standalone-title {
        font-size: 15px;
    }
}


#qz-sub-overlay .qz-book-duration-options {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin: 15px 0;
}

#qz-sub-overlay .qz-book-term {
    padding: 11px 19px;
    border: 1px solid #cddfe9;
    border-radius: 9px;
    background: #fff;
    color: #264a63;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
}

#qz-sub-overlay .qz-book-term.selected {
    background: #258eb0;
    border-color: #258eb0;
    color: #fff;
}

#qz-sub-overlay .qz-book-term:disabled {
    opacity: .4;
    cursor: not-allowed;
}

#qz-sub-overlay .qz-book-discount {
    display: inline-block;
    padding: 7px 11px;
    background: #e4f5eb;
    color: #16784b;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
    margin: 6px 0 10px;
}


     
#qz-sub-overlay .qz-store-link {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 20px;
    padding: 17px;
    background: #f3f8fb;
    border: 1px solid #d6e7ef;
    border-radius: 13px;
    text-decoration: none;
    color: #173d54;
    transition: background .2s, border-color .2s;
}

#qz-sub-overlay .qz-store-link:hover {
    background: #e5f3fa;
    border-color: #2994b5;
}

#qz-sub-overlay .qz-store-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    background: #dceef8;
    color: #268caf;
    border-radius: 11px;
}

#qz-sub-overlay .qz-store-info {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 0;
}

#qz-sub-overlay .qz-store-info strong {
    font-size: 14px;
}

#qz-sub-overlay .qz-store-info > span {
    font-size: 12px;
    color: #698092;
    line-height: 1.5;
}

#qz-sub-overlay .qz-store-action {
    font-size: 13px;
    font-weight: 800;
    color: #2389aa;
    white-space: nowrap;
}

#qz-sub-overlay .qz-savings {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 9px 0;
    padding: 7px 10px;
    border-radius: 8px;
    background: #e5f6ed;
    color: #16764c;
    font-size: 12px;
    line-height: 1.4;
    font-weight: 700;
}

#qz-sub-overlay .qz-notice {
    font-size: 13px;
    text-align: center;
    padding: 12px;
    border-radius: 9px;
    background: #e8f4fa;
    margin-top: 17px;
    line-height: 1.5;
}

@media (max-width: 600px) {
    #qz-sub-overlay .qz-store-link {
        flex-wrap: wrap;
        gap: 10px;
    }

    #qz-sub-overlay .qz-store-action {
        margin-left: 58px;
    }
}


        @media (max-width: 600px) {
            #qz-sub-overlay .qz-panel {
                padding: 23px 16px;
                max-height: 92vh;
            }

            #qz-sub-overlay .qz-cards {
                grid-template-columns: 1fr;
            }

            #qz-sub-overlay .qz-heading {
                font-size: 20px;
            }
        }
    `;

    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'qz-sub-overlay';
    overlay.hidden = true;

    overlay.innerHTML = `
        <div class="qz-panel"
             role="dialog"
             aria-modal="true"
             aria-labelledby="qz-sub-heading">

            <button type="button"
                    class="qz-close"
                    data-qz-action="close"
                    aria-label="Close subscription window">
                &times;
            </button>

            <h2 id="qz-sub-heading" class="qz-heading">
                Unlock Medical Question Bank
            </h2>

            <p class="qz-description">
                Choose a subscription or purchase this book individually
                if available.
            </p>

            <div class="qz-durations">
                <button class="qz-duration"
                        data-qz-action="duration"
                        data-months="3">
                    3 Months
                </button>

                <button class="qz-duration"
                        data-qz-action="duration"
                        data-months="6">
                    6 Months
                </button>

                <button class="qz-duration"
                        data-qz-action="duration"
                        data-months="12">
                    12 Months
                </button>
            </div>

            <div id="qz-sub-cards" class="qz-cards"></div>

           
<div id="qz-sub-standalone"></div>

<a href="store.html" class="qz-store-link">
    <span class="qz-store-icon">
        <svg xmlns="http://www.w3.org/2000/svg"
             width="25" height="25"
             viewBox="0 0 24 24"
             fill="none"
             stroke="currentColor"
             stroke-width="1.8"
             stroke-linecap="round"
             stroke-linejoin="round">
            <path d="M6 7h12l1 14H5L6 7z"/>
            <path d="M9 9V6a3 3 0 0 1 6 0v3"/>
        </svg>
    </span>

    <span class="qz-store-info">
        <strong>Looking for more medical books?</strong>
        <span>
            Explore standalone books available
            for individual purchase.
        </span>
    </span>

    <span class="qz-store-action">
        Explore Store &#8599;
    </span>
</a>

<div id="qz-sub-message"
     class="qz-notice"
     role="status"
     aria-live="polite">
</div>

        </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeSubscriptionModal();
            return;
        }

        const button = event.target.closest('[data-qz-action]');
        if (!button) return;

        const action = button.dataset.qzAction;


if (action === 'close') {
    closeSubscriptionModal();
    return;
}

if (action === 'free-plan') {
    closeSubscriptionModal();
    window.location.assign('dashboard.html');
    return;
}



if (action === 'duration') {
    const months = Number(button.dataset.months);

    if (![3, 6, 12].includes(months)) {
        return;
    }

    selectedMonths = months;

    // Clear the previous duration's credit quote.
    if (modalData) {
        modalData.upgradeChoices = {};
    }

    renderSubscriptionModal();

    // Recalculate permitted upgrades for this duration.
    if (modalData?.subscriptionState?.mode === 'active') {
        refreshUpgradeChoices();
    }

    return;
}



if (action === 'book-duration') {
    const months = Number(button.dataset.months);

    if (![3, 6, 12].includes(months) || button.disabled) {
        return;
    }

    selectedBookMonths = months;
    renderSubscriptionModal();
    return;
}



      
if (action === 'plan') {
    startCardCheckout(button.dataset.slug, button);
    return;
}


        if (action === 'book') {
            submitSubscriptionRequest(
                'book',
                null,
                button
            );
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay && !overlay.hidden) {
            closeSubscriptionModal();
        }
    });
}

function closeSubscriptionModal() {
    if (!overlay) return;

    ++loadVersion;
    overlay.hidden = true;
    document.body.style.overflow = previousOverflow;
    previousFocus?.focus?.();
}

function bookIncludedInPlan(mode, planSlug) {
    if (mode === 'premium') {
        return planSlug === 'premium' ||
               planSlug === 'platinum';
    }

    if (mode === 'platinum') {
        return planSlug === 'platinum';
    }


    return false;
}

// Determine the original purchased duration.
// This is used for customer-facing labels only.
// Supabase remains authoritative for upgrade eligibility.
function getPurchasedPlanMonths(plan, payments = []) {
    const payment = payments.find(item =>
        item.status === 'paid' &&
        item.kind === 'plan' &&
        item.plan_slug === plan.plan_slug &&
        item.speciality === plan.speciality &&
        item.paid_at &&
        Math.abs(
            new Date(item.paid_at).getTime() -
            new Date(plan.starts_at).getTime()
        ) <= 1000
    );

    const recorded = Number(payment?.months);

    if ([3, 6, 12].includes(recorded)) {
        return recorded;
    }

    const start = new Date(plan.starts_at);
    const end = new Date(plan.expires_at);

    if (
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime())
    ) {
        return null;
    }

    for (const months of [3, 6, 12]) {
        const expected = new Date(start);
        const originalDay = start.getUTCDate();

        expected.setUTCDate(1);
        expected.setUTCMonth(
            start.getUTCMonth() + months
        );

        const lastDay = new Date(Date.UTC(
            expected.getUTCFullYear(),
            expected.getUTCMonth() + 1,
            0
        )).getUTCDate();

        expected.setUTCDate(
            Math.min(originalDay, lastDay)
        );

        if (
            Math.abs(expected.getTime() - end.getTime()) <= 1000
        ) {
            return months;
        }
    }

    return null;
}

// Read the currently effective subscription of the
// signed-in user, using the existing Profile summary RPC.
function getPurchaseSubscriptionState(summary, speciality) {
    const now = Date.now();

    const plans = (summary?.plans || []).filter(plan =>
        plan.speciality === speciality
    );

    const active = plans.filter(plan =>
        new Date(plan.starts_at).getTime() <= now &&
        new Date(plan.expires_at).getTime() > now
    );

    const scheduled = plans.filter(plan =>
        new Date(plan.starts_at).getTime() > now &&
        new Date(plan.expires_at).getTime() > now
    );

    // Avoid full-price purchases or upgrades when
    // overlapping memberships or manual overrides exist.
    if (
        summary?.override ||
        scheduled.length > 0 ||
        active.length > 1
    ) {
        return {
            mode: 'blocked',
            plan_slug: null,
            months: null
        };
    }

    if (active.length === 0) {
        return {
            mode: 'none',
            plan_slug: null,
            months: null
        };
    }

    return {
        mode: 'active',
        plan_slug: active[0].plan_slug,
        months: getPurchasedPlanMonths(
            active[0],
            summary?.payments || []
        )
    };
}

// Check upgrade availability using the real
// server-side proration calculator.
// An invalid upgrade is never offered for checkout.
async function refreshUpgradeChoices() {
    if (
        !modalData ||
        !overlay ||
        overlay.hidden ||
        modalData.subscriptionState?.mode !== 'active'
    ) {
        return;
    }

    const requestVersion = ++upgradeQuoteVersion;
    const modalVersion = loadVersion;
    const context = modalData;
    const months = selectedMonths;

    context.upgradeChoices = {
        premium: { state: 'loading' },
        platinum: { state: 'loading' }
    };

    renderSubscriptionModal();

    const results = await Promise.all(
        ['premium', 'platinum'].map(async slug => {
            try {
                const { data, error } = await supabase.rpc(
                    'qz_plan_change_quote',
                    {
                        p_target_plan_slug: slug,
                        p_months: months,
                        p_create: false,
                        p_max_amount_iqd: null
                    }
                );

                if (
                    error ||
                    !data ||
                    data.target_plan !== slug ||
                    Number(data.target_months) !== months ||
                    !Number.isSafeInteger(Number(data.net_iqd)) ||
                    Number(data.net_iqd) <= 0
                ) {
                    return {
                        slug,
                        state: 'unavailable',
                        quote: null
                    };
                }

                return {
                    slug,
                    state: 'available',
                    quote: data
                };

            } catch (error) {
                console.warn(
                    'Upgrade quote unavailable:',
                    slug,
                    error
                );

                return {
                    slug,
                    state: 'unavailable',
                    quote: null
                };
            }
        })
    );

    // Ignore responses from old popup sessions or
    // from previously selected duration buttons.
    if (
        requestVersion !== upgradeQuoteVersion ||
        modalVersion !== loadVersion ||
        modalData !== context ||
        selectedMonths !== months ||
        overlay.hidden
    ) {
        return;
    }

    context.upgradeChoices = {};

    for (const result of results) {
        context.upgradeChoices[result.slug] = result;
    }

    renderSubscriptionModal();
}

function getBookCoverSrc(book) {

    if (!book) return '';

    return (
        book.cover_image ||
        book.cover_url ||
        book.image_url ||
        book.thumbnail_url ||
        book.image ||
        book.cover ||
        book.book_cover ||
        ''
    );
}

function getBookShortTitle(title) {
    const words = String(title || '').trim().split(/\s+/).slice(0, 4);
    return words.join(' ');
}

function dedupeBooks(list) {
    const seen = new Set();
    const output = [];

    for (const book of list) {
        if (!book) continue;

        const id = String(book.id);
        if (seen.has(id)) continue;

        seen.add(id);
        output.push(book);
    }

    return output;
}


function renderPlanBookCovers(books) {
    // Remove duplicates and arrange books alphabetically.
    const items = dedupeBooks(books || []).sort((a, b) =>
        String(a.title || '').localeCompare(
            String(b.title || '')
        )
    );

    if (!items.length) {
        return `
            <div class="qz-small" style="margin:12px 0">
                No books assigned to this plan yet.
            </div>
        `;
    }

    // Display ALL covers. No six-book limitation.
    const coversHtml = items.map(book => {
        const src = getBookCoverSrc(book);
        const title = escapeHtml(book.title || 'Untitled book');

        return `
            <div class="qz-cover-card"
                 title="${title}">

                ${src
                    ? `
                        <img
                            src="${escapeHtml(src)}"
                            alt="${title}"
                            loading="lazy"
                            decoding="async"
                        >
                    `
                    : `
                        <div class="qz-cover-fallback">
                            ${escapeHtml(
                                getBookShortTitle(book.title)
                            )}
                        </div>
                    `
                }
            </div>
        `;
    }).join('');

    // Numbered list with the FULL names of every book.
    const bookListHtml = items.map(book => `
        <li>${escapeHtml(book.title || 'Untitled book')}</li>
    `).join('');

    const count = items.length;

    return `
        <div class="qz-cover-grid">
            ${coversHtml}
        </div>

        <div class="qz-small" style="margin-top:8px">
            All ${count} book cover${count === 1 ? '' : 's'} displayed
        </div>

        <details class="qz-included-details">
            <summary>
                View all ${count} included
                book${count === 1 ? '' : 's'}
            </summary>

            <ol>
                ${bookListHtml}
            </ol>
        </details>
    `;
}


function renderSubscriptionModal() {
    if (!modalData || !overlay || overlay.hidden) return;

    const {
        plans,
        prices,
        rules,
        memberships,
        speciality,
        catalog
    } = modalData;

    document.querySelectorAll(
        '#qz-sub-overlay .qz-duration'
    ).forEach(button => {
        button.classList.toggle(
            'selected',
            Number(button.dataset.months) === selectedMonths
        );
    });

    const ruleMap = new Map(
        (rules || []).map(rule => [String(rule.book_id), rule])
    );

    const bookMap = new Map(
        (catalog || []).map(book => [String(book.id), book])
    );

    const selectedRule = ruleMap.get(String(currentBookId));

    const accessMode = memberships.find(
        r => String(r.book_id) === currentBookId
    )?.tier || 'none';

    const freeBooks = dedupeBooks(
        (catalog || []).filter(book => {
            const rule = ruleMap.get(String(book.id));
            const mode = rule?.access_mode ||
                (book.access_level === 'purchasable'
                    ? 'standalone'
                    : book.access_level || 'free');

            return mode === 'free';
        })
    );

    const premiumBooks = dedupeBooks(
        memberships
            .filter(item => item.tier === 'premium')
            .map(item => bookMap.get(String(item.book_id)))
    );

    const platinumBooks = dedupeBooks(
        memberships
            .filter(item =>
                item.tier === 'premium' ||
                item.tier === 'platinum'
            )
            .map(item => bookMap.get(String(item.book_id)))
    );

    const premiumCount = premiumBooks.length;
    const platinumCount = platinumBooks.length;
    const freeCount = freeBooks.length;

    const freeIncludesBook = freeBooks.some(
        book => String(book.id) === String(currentBookId)
    );

    const cards = [];

    cards.push(`
        <div class="qz-plan free ${freeIncludesBook ? 'recommended' : ''}">
            <h3>● Free</h3>

            <div class="qz-small">
                Books available to every user
            </div>

            <div class="qz-price">
                Free
            </div>

            <div class="qz-small">
                Always available
                <br>
                Specialty: ${escapeHtml(speciality)}
            </div>

            <div class="qz-small" style="margin-top:10px">
                ${freeCount} included books
            </div>

            ${renderPlanBookCovers(freeBooks)}


<div class="${planOnlyMode
    ? 'qz-small'
    : freeIncludesBook
        ? 'qz-included'
        : 'qz-not-included'}">

    ${planOnlyMode
        ? 'Free books are always available on Dashboard.'
        : freeIncludesBook
            ? '✓ Includes this book'
            : 'This book is not included'}
</div>



<button type="button"
        class="qz-purchase"
        data-qz-action="free-plan">
    Free Plan
</button>

        </div>
    `);

    for (const slug of ['premium', 'platinum']) {
        const plan = plans.find(p => p.plan_slug === slug);
        if (!plan) continue;

        const price = prices.find(p =>
            p.plan_slug === slug &&
            p.months === selectedMonths
        );

        const includesBook =
            bookIncludedInPlan(accessMode, slug);

      
const purchasable =
    plan.enabled === true &&
    price?.enabled === true &&
    Number(price.amount_iqd) > 0;


       
const priceText =
    price?.enabled && Number(price.amount_iqd) > 0
        ? formatPrice(price.amount_iqd)
        : 'Not available yet';

const savings = calculatePlanSavings(
    prices,
    slug,
    selectedMonths
);

const savingsHtml = savings && plan.enabled === true
    ? `
        <div class="qz-savings">
            &#10003; Save ${formatPrice(savings.amount)}
            (${savings.percentage}%)
            compared with quarterly payments
        </div>
    `
    : '';


        const planBooks =
            slug === 'premium'
                ? premiumBooks
                : platinumBooks;


        const count =
            slug === 'premium'
                ? premiumCount
                : platinumCount;

        const subscription = modalData.subscriptionState;
        const upgradeResult =
            modalData.upgradeChoices?.[slug];

        const canPurchase =
            purchasable &&
            subscription.mode === 'none';

        const canUpgrade =
            purchasable &&
            subscription.mode === 'active' &&
            upgradeResult?.state === 'available' &&
            upgradeResult.quote?.target_plan === slug &&
            Number(upgradeResult.quote?.target_months) ===
                selectedMonths;

        const buttonEnabled = canPurchase || canUpgrade;

        let planButtonText = 'Plan currently unavailable';

        if (purchasable) {
            if (canPurchase) {
                planButtonText = 'Purchase';

            } else if (canUpgrade) {
                planButtonText =
                    'Upgrade — ' +
                    formatPrice(upgradeResult.quote.net_iqd);

            } else if (subscription.mode === 'blocked') {
                planButtonText = 'Manage in Personal Profile';

            } else if (subscription.mode === 'active') {
                if (
                    subscription.plan_slug === 'platinum' &&
                    subscription.months === 12
                ) {
                    planButtonText = 'Maximum Plan';

                } else if (
                    subscription.plan_slug === 'platinum' &&
                    slug === 'premium'
                ) {
                    planButtonText = 'Downgrade Unavailable';

                } else if (
                    subscription.plan_slug === slug &&
                    subscription.months === selectedMonths
                ) {
                    planButtonText = 'Current Plan';

                } else if (
                    upgradeResult?.state === 'loading' ||
                    !upgradeResult
                ) {
                    planButtonText = 'Checking Upgrades...';

                } else {
                    planButtonText = 'Upgrade Not Available';
                }
            }
        }

        cards.push(`


<div class="qz-plan ${slug}
     ${(planOnlyMode
        ? slug === preferredPlanSlug
        : includesBook) ? 'recommended' : ''}">


                <h3>
                    ${slug === 'premium' ? '★' : '◆'}
                    ${escapeHtml(plan.title)}
                </h3>

                <div class="qz-small">
                    ${escapeHtml(plan.description)}
                </div>

<div class="qz-price">
    ${priceText}
</div>

${savingsHtml}

<div class="qz-small">
    ${selectedMonths} months of access
    <br>
    Specialty: ${escapeHtml(speciality)}
</div>


                ${renderPlanBookCovers(planBooks)}


<div class="${planOnlyMode
    ? 'qz-included'
    : includesBook
        ? 'qz-included'
        : 'qz-not-included'}">

    ${planOnlyMode
        ? 'Select this plan to renew your membership.'
        : includesBook
            ? '✓ Includes this book'
            : 'This book is not included'}
</div>



                <button type="button"
                        class="qz-purchase"
                        data-qz-action="plan"
                        data-slug="${slug}"
                        data-qz-checkout-mode="${canUpgrade
                            ? 'upgrade'
                            : 'purchase'}"
                        ${buttonEnabled ? '' : 'disabled'}>
                    ${planButtonText}
                </button>

            </div>
        `);
    }

    document.getElementById('qz-sub-cards').innerHTML =
        cards.join('');


const standaloneContainer =
    document.getElementById('qz-sub-standalone');


// Read all available duration prices.
const bookPrices = {
    3: Number(selectedRule?.standalone_price_iqd || 0),
    6: Number(selectedRule?.standalone_price_6m_iqd || 0),
    12: Number(selectedRule?.standalone_price_12m_iqd || 0)
};

const availableMonths = [3, 6, 12].filter(months =>
    Number.isSafeInteger(bookPrices[months]) &&
    bookPrices[months] > 0
);


const standaloneAvailable =
    selectedRule?.standalone_enabled === true &&
    selectedRule.access_mode !== 'free' &&
    availableMonths.length > 0;

if (standaloneAvailable) {
    // If the selected duration is not offered,
    // choose the first available duration.
    if (!availableMonths.includes(selectedBookMonths)) {
        selectedBookMonths = availableMonths[0];
    }

    const selectedPrice = bookPrices[selectedBookMonths];

    // Compare with repeated 3-month purchases.
    // Only advertise a real positive discount.
    const baseline = bookPrices[3] *
        (selectedBookMonths / 3);

    const amountSaved =
        bookPrices[3] > 0 && selectedBookMonths > 3
            ? baseline - selectedPrice
            : 0;

    const percentSaved =
        amountSaved > 0
            ? Math.round((amountSaved / baseline) * 100)
            : 0;

    const savingsHtml = amountSaved > 0
        ? `
            <div class="qz-book-discount">
                ✓ Save ${formatPrice(amountSaved)}
                (${percentSaved}%)
                compared with renewing every 3 months
            </div>
        `
        : '';

    const durationButtons = [3, 6, 12].map(months => {
        const enabled = availableMonths.includes(months);

        return `
            <button
                type="button"
                class="qz-book-term
                    ${selectedBookMonths === months ? 'selected' : ''}"
                data-qz-action="book-duration"
                data-months="${months}"
                aria-pressed="${selectedBookMonths === months}"
                ${enabled ? '' : 'disabled'}>
                ${months} Months
            </button>
        `;
    }).join('');


    // Get the actual selected book from the catalog.
    // Uses the same source and cover helper as the plan cards.
    const standaloneBook = bookMap.get(String(currentBookId));

    const standaloneBookTitle =
        standaloneBook?.title || 'Selected Medical Book';

    const standaloneCoverSrc =
        getBookCoverSrc(standaloneBook);

    const standaloneCoverHtml = standaloneCoverSrc
        ? `
            <img
                src="${escapeHtml(standaloneCoverSrc)}"
                alt="${escapeHtml(standaloneBookTitle)}"
                loading="lazy"
                decoding="async"
            >
          `
        : `
            <div class="qz-cover-fallback">
                ${escapeHtml(
                    getBookShortTitle(standaloneBookTitle)
                )}
            </div>
          `;

    standaloneContainer.innerHTML = `
        <div class="qz-standalone">

            <div class="qz-standalone-header">

                <div class="qz-cover-card qz-standalone-cover"
                     title="${escapeHtml(standaloneBookTitle)}">
                    ${standaloneCoverHtml}
                </div>

                <div class="qz-standalone-info">

                    <strong>
                        Purchase this book individually
                    </strong>

                    <div class="qz-standalone-title">
                        ${escapeHtml(standaloneBookTitle)}
                    </div>

                    <div class="qz-standalone-label">
                        Individual Book Access
                    </div>

                    <p class="qz-small" style="margin-top:12px">
                        Buy access to this book without purchasing
                        a Premium or Platinum subscription.
                        Select your preferred access duration.
                    </p>

                </div>

            </div>

            <div class="qz-book-duration-options"
                 aria-label="Individual book duration">
                ${durationButtons}
            </div>

            <div class="qz-price" style="font-size:22px">
                ${formatPrice(selectedPrice)}
            </div>

            ${savingsHtml}

            <p class="qz-small">
                ${selectedBookMonths} months of access.
                Access expires automatically at the
                end of the purchased period.
            </p>

            <button
                type="button"
                class="qz-purchase"
                data-qz-buy-book="${escapeHtml(currentBookId)}"
                data-qz-book-months="${selectedBookMonths}">
                Buy This Book —
                ${formatPrice(selectedPrice)}
            </button>

        </div>
    `;

} else {
    standaloneContainer.innerHTML = '';
}

setMessage(
    'Payments are processed through Qi Sandbox. ' +
    'Purchased access activates after verified payment.'
);

}



async function startCardCheckout(planSlug, button) {
    if (
        !['premium', 'platinum'].includes(planSlug) ||
        !button ||
        button.disabled ||
        planCheckoutBusy
    ) {
        return;
    }

    const months = selectedMonths;
    const subscription = modalData?.subscriptionState;
    const checkoutMode = button.dataset.qzCheckoutMode;

    const isNewPurchase =
        subscription?.mode === 'none' &&
        checkoutMode === 'purchase';

    const isUpgrade =
        subscription?.mode === 'active' &&
        checkoutMode === 'upgrade' &&
        modalData?.upgradeChoices?.[planSlug]?.state ===
            'available';

    if (!isNewPurchase && !isUpgrade) {
        setMessage(
            'This subscription option is not available. ' +
            'Refresh the purchase window and try again.'
        );
        return;
    }

    const bookTier = modalData?.memberships?.find(
        item => String(item.book_id) === String(currentBookId)
    )?.tier || 'none';

    const includesClickedBook =
        bookIncludedInPlan(bookTier, planSlug);

    const warning =
        planOnlyMode || includesClickedBook
            ? ''
            : '\n\nIMPORTANT: The selected book is not ' +
              'included in this plan. This purchase or ' +
              'upgrade will not unlock that book.';

    const originalText = button.textContent;
    let redirecting = false;
    let quote = null;

    planCheckoutBusy = true;
    button.disabled = true;

    try {
        let functionName;
        let requestBody;

        if (isUpgrade) {
            // Get a fresh authoritative quote.
            // Never calculate monetary credit in JavaScript.
            button.textContent = 'Calculating upgrade...';

            const {
                data: freshQuote,
                error: quoteError
            } = await supabase.rpc(
                'qz_plan_change_quote',
                {
                    p_target_plan_slug: planSlug,
                    p_months: months,
                    p_create: false,
                    p_max_amount_iqd: null
                }
            );

            if (quoteError) throw quoteError;

            if (
                !freshQuote ||
                freshQuote.target_plan !== planSlug ||
                Number(freshQuote.target_months) !== months ||
                !Number.isSafeInteger(
                    Number(freshQuote.net_iqd)
                ) ||
                Number(freshQuote.net_iqd) <= 0
            ) {
                throw Error(
                    'Unable to verify a valid upgrade price.'
                );
            }

            quote = freshQuote;

            const proceed = window.confirm(
                'Confirm Subscription Upgrade\n\n' +
                'Current: ' +
                    String(quote.current_plan).toUpperCase() +
                    ' — ' + quote.current_months + ' months\n' +
                'New: ' + planSlug.toUpperCase() +
                    ' — ' + months + ' months\n\n' +
                'Full new price: ' +
                    formatPrice(quote.gross_iqd) + '\n' +
                'Unused subscription credit: -' +
                    formatPrice(quote.credit_iqd) + '\n' +
                'AMOUNT TO PAY: ' +
                    formatPrice(quote.net_iqd) +
                '\n\nThe new full subscription period starts ' +
                'after successful Qi payment verification.' +
                warning
            );

            if (!proceed) return;

            functionName = 'qi-start-plan-upgrade';

            requestBody = {
                target_plan_slug: planSlug,
                months,
                max_amount_iqd: Number(quote.net_iqd)
            };

        } else {
            const proceed = window.confirm(
                `Purchase ${planSlug.toUpperCase()} ` +
                `for ${months} months?` +
                warning +
                '\n\nContinue to secure payment?'
            );

            if (!proceed) return;

            functionName = 'qi-start-checkout';

            requestBody = {
                plan_slug: planSlug,
                months
            };
        }

        button.textContent = 'Opening secure checkout...';

        const { data, error } =
            await supabase.functions.invoke(
                functionName,
                {
                    body: requestBody
                }
            );

        if (error) {
            let message = error.message;

            try {
                const details =
                    await error.context?.json?.();

                if (details?.error) {
                    message = details.error;
                }
            } catch (_) {
                // Preserve the original error message.
            }

            throw Error(message);
        }

        if (!data?.checkout_url) {
            throw Error(
                data?.error || 'Checkout link unavailable.'
            );
        }

        // Verify the upgrade checkout matches the
        // specific plan and duration selected by the user.
        if (isUpgrade) {
            const finalAmount = Number(data.net_iqd);

            if (
                data.target_plan !== planSlug ||
                Number(data.target_months) !== months ||
                !Number.isSafeInteger(finalAmount) ||
                finalAmount <= 0 ||
                finalAmount > Number(quote.net_iqd)
            ) {
                throw Error(
                    'The upgrade checkout does not match ' +
                    'the confirmed amount or duration.'
                );
            }
        }

        // Card details must only be entered at Qi.
        const checkout = new URL(data.checkout_url);
        const host = checkout.hostname.toLowerCase();

        if (
            checkout.protocol !== 'https:' ||
            !(host === 'qi.iq' || host.endsWith('.qi.iq'))
        ) {
            throw Error('Invalid payment gateway URL.');
        }

        window.location.assign(checkout.href);
        redirecting = true;

    } catch (error) {
        console.error('Subscription checkout:', error);

        setMessage(
            'Could not open secure checkout: ' +
            error.message +
            ' If an earlier payment attempt is pending, ' +
            'verify its status before trying again.'
        );

    } finally {
        planCheckoutBusy = false;

        if (!redirecting && button.isConnected) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}


async function submitSubscriptionRequest(kind, slug, button) {

    const description = kind === 'plan'
        ? `${slug.toUpperCase()} for ${selectedMonths} months`
        : 'this individual book';

    if (!confirm(`Submit a purchase request for ${description}?`)) {
        return;
    }

    const oldText = button.textContent.trim();
    button.disabled = true;
    button.textContent = 'Submitting...';

    try {
        
const { error } = await supabase.rpc(
    'qz_request_specialty_purchase',
    {
        p_kind: kind,
        p_plan_slug: kind === 'plan' ? slug : null,
        p_months: kind === 'plan' ? selectedMonths : null,
        p_book_id: kind === 'book' ? currentBookId : null
    }
);


        if (error) throw error;

        setMessage(
            'Request submitted successfully. ' +
            'Your access will activate after payment verification ' +
            'and administrator approval.'
        );

        button.textContent = 'Request Pending';

    } catch (error) {
        setMessage('Request failed: ' + error.message);
        button.disabled = false;
        button.textContent = oldText;
    }
}



async function openSubscriptionModal(
    bookId,
    renewPlanSlug = null,
    preferredMonths = 3
) {
    const requestedPlan = String(
        renewPlanSlug || ''
    ).toLowerCase();

    const planOnly = bookId == null || bookId === '';

    if (
        planOnly &&
        !['premium', 'platinum'].includes(requestedPlan)
    ) {
        return;
    }

    createSubscriptionModal();

    planOnlyMode = planOnly;
    preferredPlanSlug = planOnly ? requestedPlan : null;
    currentBookId = planOnly ? null : String(bookId);

    // The Profile can suggest a relevant upgrade duration.
    // Dashboard's existing book calls still default to 3 months.
    const requestedMonths = Number(preferredMonths);

    selectedMonths = [3, 6, 12].includes(requestedMonths)
        ? requestedMonths
        : 3;

    selectedBookMonths = 3;
    modalData = null;




    const version = ++loadVersion;

    previousFocus = document.activeElement;

    if (overlay.hidden) {
        previousOverflow = document.body.style.overflow;
    }

    overlay.hidden = false;
    document.body.style.overflow = 'hidden';

    overlay.querySelector('.qz-close').focus();

    document.getElementById('qz-sub-heading').textContent =
        'Unlock Medical Question Bank';

    document.getElementById('qz-sub-cards').innerHTML = '';
    document.getElementById('qz-sub-standalone').innerHTML = '';

    setMessage('Loading subscriptions and current prices...');

    try {
       
const { data: auth, error: authError } =
    await supabase.auth.getUser();

if (authError || !auth?.user) {
    throw Error('Please sign in again.');
}

const profile = await supabase.from('users')
    .select('speciality')
    .eq('id', auth.user.id)
    .single();

if (profile.error) throw profile.error;

const speciality = String(
    profile.data?.speciality || ''
).trim();

if (!speciality) {
    throw Error('Your account has no specialty selected.');
}

const [
    bookResult,
    plansResult,
    pricesResult,
    membershipsResult,
    rulesResult,
    catalogResult
] = await Promise.all([
   
planOnlyMode
    ? Promise.resolve({ data: null, error: null })
    : supabase.from('books')
        .select('id,title')
        .eq('id', currentBookId)
        .maybeSingle(),


    supabase.from('qz_specialty_plans')
        .select('plan_slug,title,description,enabled')
        .eq('speciality', speciality),

    supabase.from('qz_specialty_plan_prices')
        .select('plan_slug,months,amount_iqd,enabled')
        .eq('speciality', speciality),

    supabase.from('qz_specialty_plan_books')
        .select('book_id,tier')
        .eq('speciality', speciality),

    supabase.from('qz_book_rules')
       

.select(
    'book_id,access_mode,standalone_enabled,' +
    'standalone_price_iqd,standalone_price_6m_iqd,' +
    'standalone_price_12m_iqd'
),



    supabase.from('books')
        .select('*')
        .order('title')
]);

for (const result of [
    bookResult,
    plansResult,
    pricesResult,
    membershipsResult,
    rulesResult,
    catalogResult
]) {
    if (result.error) throw result.error;
}


        if (version !== loadVersion || overlay.hidden) return;

        // This is the same authenticated subscription
        // summary already used by Personal Profile.
        const {
            data: librarySummary,
            error: libraryError
        } = await supabase.rpc(
            'qz_my_library_summary'
        );

        if (
            libraryError ||
            !librarySummary ||
            !Array.isArray(librarySummary.plans)
        ) {
            throw Error(
                libraryError?.message ||
                'Unable to verify your current membership.'
            );
        }

        if (version !== loadVersion || overlay.hidden) return;

        const subscriptionState =
            getPurchaseSubscriptionState(
                librarySummary,
                speciality
            );

const bookTitle =
    bookResult.data?.title || 'Medical Question Bank';



document.getElementById('qz-sub-heading').textContent =
    planOnlyMode
        ? subscriptionState.mode === 'active'
            ? 'Manage My Subscription'
            : 'Choose Your Subscription'
        : 'Unlock ' + bookTitle;

overlay.querySelector('.qz-description').textContent =
    planOnlyMode
        ? subscriptionState.mode === 'active'
            ? 'Current plan: ' +
              String(
                  subscriptionState.plan_slug || 'Paid'
              ).toUpperCase() +
              (
                  [3, 6, 12].includes(
                      Number(subscriptionState.months)
                  )
                      ? ' — ' +
                        subscriptionState.months +
                        ' months.'
                      : '.'
              ) +
              ' Choose an available upgrade below. ' +
              'Unused paid subscription value will be ' +
              'deducted automatically at checkout. ' +
              'Specialty: ' + speciality + '.'
            : 'Choose Premium or Platinum and your ' +
              'preferred access duration. ' +
              'Prices and included books are shown below. ' +
              'Specialty: ' + speciality + '.'
        : 'Choose a subscription or purchase this book ' +
          'individually if available.';



       

modalData = {
    speciality,
    plans: plansResult.data || [],
    prices: pricesResult.data || [],
    memberships: membershipsResult.data || [],
    rules: rulesResult.data || [],
    catalog: catalogResult.data || [],

    // Current customer's effective subscription.
    subscriptionState,

    // Server-verified upgrade options for the
    // currently selected plan duration.
    upgradeChoices: {}
};




        renderSubscriptionModal();

        // Check upgrade eligibility and net pricing
        // without modifying subscriptions or payments.
        if (subscriptionState.mode === 'active') {
            refreshUpgradeChoices();
        }

    } catch (error) {

        if (version !== loadVersion || overlay.hidden) return;

        console.error('Subscription modal error:', error);

        setMessage(
            'Unable to load subscription plans: ' +
            error.message
        );
    }
}

// Available to existing dashboard click handlers.
window.openSubscriptionModal = openSubscriptionModal;

// Handle the shopping-cart links before the book-card click handler.
document.addEventListener('click', event => {
    const link = event.target.closest?.('[data-qz-plan-book]');

    if (!link) return;

    event.preventDefault();
    event.stopPropagation();

    openSubscriptionModal(link.dataset.qzPlanBook);
}, true);


