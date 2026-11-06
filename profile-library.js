

import { supabase } from './supabaseClient.js';

import { openPlanChangeModal } from './plan-change-modal.js';



// Quizard Personal Profile — My Library
// Read-only customer data. Never changes entitlements.

const $ = id => document.getElementById(id);

const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function formatDate(value) {
    if (!value) return 'No expiry';

    const date = new Date(value);

    return Number.isFinite(date.getTime())
        ? date.toLocaleString()
        : 'Unknown date';
}

function remainingDays(value) {
    if (!value) return 'Lifetime access';

    const milliseconds = new Date(value).getTime() - Date.now();

    if (!Number.isFinite(milliseconds)) return 'Unknown';

    if (milliseconds <= 0) return 'Expired';

    const days = Math.ceil(milliseconds / 86400000);

    return `${days} day${days === 1 ? '' : 's'} remaining`;
}

function activeAt(start, expiry) {
    const now = Date.now();

    return new Date(start).getTime() <= now &&
        new Date(expiry).getTime() > now;
}

function badge(text, active) {
    const classes = active
        ? 'bg-green-100 text-green-800'
        : 'bg-gray-100 text-gray-600';

    return `
        <span class="${classes} text-xs font-semibold
                     px-2 py-1 rounded-full">
            ${escapeHtml(text)}
        </span>
    `;
}

function safeCover(url) {
    const src = String(url || '').trim();

    if (
        /^https:\/\/[^\s"'<>]+$/i.test(src) ||
        /^images\/[a-z0-9_./%-]+$/i.test(src)
    ) {
        return src;
    }

    return '';
}


function renderBooks(books, accessRows = []) {
    const container = $('qzLibraryBooks');
    const now = Date.now();

    // Use the same book-access result as Dashboard.
    // This includes subscriptions, individual licenses,
    // and other access entitlements.
    const accessibleBookIds = new Set(
        accessRows
            .filter(row => row.has_access === true)
            .map(row => String(row.book_id))
    );


    if (!books.length) {
        container.innerHTML = `
            <div class="bg-gray-50 rounded-xl p-6 text-center">
                <p class="font-semibold text-gray-700">
                    No individually purchased books yet.
                </p>
                <p class="text-sm text-gray-500 mt-2">
                    Free books remain available on Dashboard.
                </p>
                <a href="store.html"
                   class="inline-block mt-4 text-blue-700 font-semibold">
                    Explore Store
                </a>
            </div>
        `;
        return;
    }

    container.innerHTML = books.map(book => {
        const expires = book.expires_at
            ? new Date(book.expires_at).getTime()
            : null;

        const active =
            expires === null || expires > now;

        const cover = safeCover(book.cover);

        const coverHtml = cover
            ? `<img src="${escapeHtml(cover)}"
                    alt="${escapeHtml(book.title)}"
                    loading="lazy"
                    class="w-16 h-24 object-contain rounded">`
            : `<div class="w-16 h-24 bg-blue-50 rounded
                           flex items-center justify-center
                           text-blue-700 font-bold">
                    Book
               </div>`;

   

// Does the user currently have this book through
// Premium, Platinum, Free, or another entitlement?
const hasCurrentAccess = accessibleBookIds.has(
    String(book.book_id)
);

// Only offer renewal if BOTH conditions are true:
// 1. The individual license has expired.
// 2. There is no other active entitlement.
const canRenew = !active && !hasCurrentAccess;

const action = canRenew
    ? `
        <button
            type="button"
            data-qz-plan-book="${escapeHtml(book.book_id)}"
            class="inline-flex items-center justify-center
                   bg-blue-600 hover:bg-blue-700
                   text-white font-semibold
                   text-sm px-4 py-2 rounded-lg">
            Renew Book Access
        </button>
      `
    : `
        <a href="dashboard.html"
           class="inline-flex items-center justify-center
                  bg-green-50 hover:bg-green-100
                  text-green-800 font-semibold
                  text-sm px-4 py-2 rounded-lg">
            Open in Dashboard
        </a>

        ${!active && hasCurrentAccess
            ? `
                <p class="text-xs text-green-700 mt-2">
                    This book is already available through
                    your current membership or another
                    active entitlement.
                    No additional purchase is needed.
                </p>
              `
            : ''}
      `;



        return `
            <article class="border border-gray-200 rounded-xl
                            p-4 flex gap-4 items-start">
                <div class="flex-shrink-0">
                    ${coverHtml}
                </div>

                <div class="min-w-0 flex-1 space-y-2">
                    <div class="flex flex-wrap gap-2 items-center">
                        <h3 class="font-bold text-gray-800">
                            ${escapeHtml(book.title)}
                        </h3>

${badge(
    hasCurrentAccess
        ? 'Accessible Now'
        : active
            ? 'Individual License Active'
            : 'Expired / Cancelled',
    hasCurrentAccess || active
)}

                    </div>

                    <p class="text-sm text-gray-600">
                        Granted: ${formatDate(book.granted_at)}
                    </p>

                    <p class="text-sm text-gray-600">
                        Expires: ${formatDate(book.expires_at)}
                    </p>


<p class="text-sm font-semibold
          ${hasCurrentAccess || active
              ? 'text-green-700'
              : 'text-gray-500'}">

    ${!active && hasCurrentAccess
        ? 'Individual license expired, but book access is active.'
        : remainingDays(book.expires_at)}
</p>


                    ${action}
                </div>
            </article>
        `;
    }).join('');
}




function purchasedTermMonths(plan, payments = []) {
    // Prefer the exact paid checkout corresponding
    // to the current subscription activation.
    const matchingPayment = payments.find(payment =>
        payment.status === 'paid' &&
        payment.kind === 'plan' &&
        payment.plan_slug === plan.plan_slug &&
        payment.speciality === plan.speciality &&
        payment.paid_at &&
        Math.abs(
            new Date(payment.paid_at).getTime() -
            new Date(plan.starts_at).getTime()
        ) < 1000
    );

    const recordedMonths = Number(matchingPayment?.months);

    if ([3, 6, 12].includes(recordedMonths)) {
        return recordedMonths;
    }

    // Fallback for older purchases outside
    // the recent payment-history window.
    const start = new Date(plan.starts_at);
    const end = new Date(plan.expires_at);

    if (
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime())
    ) {
        return null;
    }

    for (const months of [3, 6, 12]) {
        const candidate = new Date(start);

        // Match PostgreSQL calendar-month behavior,
        // including months with fewer days.
        candidate.setUTCDate(1);
        candidate.setUTCMonth(start.getUTCMonth() + months);

        const lastDay = new Date(Date.UTC(
            candidate.getUTCFullYear(),
            candidate.getUTCMonth() + 1,
            0
        )).getUTCDate();

        candidate.setUTCDate(
            Math.min(start.getUTCDate(), lastDay)
        );

        if (Math.abs(candidate - end) <= 1000) {
            return months;
        }
    }

    return null;
}

function renderPlans(plans, override, payments = []) {

    const container = $('qzLibraryPlans');
    const items = [];

    const renewalShown = new Set();
    let upgradeShown = false;

    // Detect active and scheduled paid memberships.
    const activePlans = plans.filter(plan =>
        activeAt(plan.starts_at, plan.expires_at)
    );

    const scheduledPlans = plans.filter(plan =>
        new Date(plan.starts_at).getTime() > Date.now() &&
        new Date(plan.expires_at).getTime() > Date.now()
    );

    // Historical expired plans should not offer renewal
    // while another active membership is providing access.
    const canOfferRenewal =
        !override &&
        activePlans.length === 0 &&
        scheduledPlans.length === 0;



    if (override) {
        const manualActive = override.plan_slug !== 'free';

        items.push(`
            <article class="border border-blue-200 bg-blue-50
                            rounded-xl p-4 space-y-2">
                <div class="flex flex-wrap gap-2 items-center">
                    <strong class="text-gray-800">
                        Administrative Plan:
                        ${escapeHtml(override.plan_slug.toUpperCase())}
                    </strong>

                    ${badge(
                        manualActive ? 'Active override' : 'Free override',
                        manualActive
                    )}
                </div>

                <p class="text-sm text-gray-600">
                    Specialty:
                    ${escapeHtml(override.speciality || 'Not assigned')}
                </p>

                <p class="text-sm text-gray-600">
                    Expires: ${formatDate(override.expires_at)}
                </p>

                <p class="text-xs text-gray-600">
                    Administrative access rules take priority over
                    subscription-based book access.
                </p>
            </article>
        `);
    }

    for (const plan of plans) {
        const valid = activeAt(
            plan.starts_at,
            plan.expires_at
        );

        const upcoming =
            new Date(plan.starts_at).getTime() > Date.now();

        const status = upcoming
            ? 'Scheduled'
            : !valid
                ? 'Expired / Cancelled'
                : override
                    ? 'Administrative override applies'
                    : 'Active';

const effective = valid && !override;


const renewalKey =
    String(plan.speciality || '') + ':' +
    String(plan.plan_slug || '');


const currentMonths = purchasedTermMonths(plan, payments);

const isMaximumPlan =
    valid &&
    plan.plan_slug === 'platinum' &&
    currentMonths === 12;

const canUpgrade =
    !override &&
    !upgradeShown &&
    scheduledPlans.length === 0 &&
    activePlans.length === 1 &&
    valid &&
    ['premium', 'platinum'].includes(plan.plan_slug) &&
    [3, 6, 12].includes(currentMonths) &&
    !isMaximumPlan;


if (canUpgrade) {
    upgradeShown = true;
}

const canRenew =
    canOfferRenewal &&
    !upcoming &&
    !valid &&
    ['premium', 'platinum'].includes(plan.plan_slug) &&
    !renewalShown.has(renewalKey);

if (canRenew) {
    renewalShown.add(renewalKey);
}


const renewButton = canUpgrade
    ? `
        <button
            type="button"
            data-qz-upgrade-plan="${escapeHtml(plan.plan_slug)}"
            data-qz-current-months="${currentMonths}"
            class="inline-flex items-center justify-center
                   mt-3 px-4 py-2 rounded-lg
                   bg-purple-600 hover:bg-purple-700
                   text-white font-semibold text-sm">
            ${plan.plan_slug === 'platinum'
                ? 'Upgrade Platinum Duration'
                : 'Upgrade Plan or Duration'}
        </button>

        <p class="text-xs text-gray-500 mt-2">
            Your unused subscription value will be
            deducted from the new plan price.
        </p>
      `
    : canRenew
        ? `
            <button
                type="button"
                data-qz-renew-plan="${escapeHtml(plan.plan_slug)}"
                data-qz-renew-speciality="${escapeHtml(plan.speciality || '')}"
                class="inline-flex items-center justify-center
                       mt-3 px-4 py-2 rounded-lg
                       bg-blue-600 hover:bg-blue-700
                       text-white font-semibold text-sm">
                Renew ${escapeHtml(
                    String(plan.plan_slug).toUpperCase()
                )} Plan
            </button>
          `
        : isMaximumPlan
            ? `
                <button type="button" disabled
                    class="mt-3 px-4 py-2 rounded-lg
                           bg-gray-200 text-gray-500
                           text-sm font-semibold cursor-not-allowed">
                    Maximum Plan — No Upgrade Available
                </button>

                <p class="text-xs text-green-700 mt-2">
                    Your 12-month Platinum membership is
                    the highest available subscription.
                </p>
              `
            : valid && !currentMonths
                ? `
                    <p class="text-xs text-gray-500 mt-2">
                        Contact support to manage this
                        subscription's duration.
                    </p>
                  `
                : '';


items.push(`

            <article class="border border-gray-200
                            rounded-xl p-4 space-y-2">

                <div class="flex flex-wrap gap-2 items-center">
                    <strong class="text-gray-800">
                        ${escapeHtml(
                            String(plan.plan_slug).toUpperCase()
                        )}
                    </strong>

                    ${badge(status, effective)}
                </div>

                <p class="text-sm text-gray-600">
                    Specialty:
                    ${escapeHtml(
                        plan.speciality || 'General membership'
                    )}
                </p>

                <p class="text-sm text-gray-600">
                    Starts: ${formatDate(plan.starts_at)}
                </p>

                <p class="text-sm text-gray-600">
                    Expires: ${formatDate(plan.expires_at)}
                </p>


<p class="text-sm font-semibold
          ${effective ? 'text-green-700' : 'text-gray-500'}">
    ${remainingDays(plan.expires_at)}
</p>

${renewButton}

</article>

        `);
    }

    if (!items.length) {
        items.push(`
            <div class="bg-gray-50 rounded-xl p-6 text-center">
                <strong>No subscription plans found.</strong>

                <p class="text-sm text-gray-500 mt-2">
                    You're welcome to continue with Free books.
                </p>
            </div>
        `);
    }

    items.push(`
        <a href="dashboard.html"
           class="inline-block px-4 py-2 rounded-lg
                  bg-blue-600 text-white font-semibold text-sm">
            Explore Subscription Plans
        </a>
    `);

    container.innerHTML = items.join('');
}

function renderPayments(payments) {
    const container = $('qzLibraryPayments');

    if (!payments.length) {
        container.innerHTML = `
            <p class="text-gray-500 text-sm">
                No checkout transactions found.
            </p>
        `;
        return;
    }

    container.innerHTML = `
        <p class="text-xs text-gray-500 mb-3">
            Showing up to 50 recent Qi checkout records.
            A paid transaction remains in the history even
            when its book license has expired or been cancelled.
        </p>

        ${payments.map(payment => {
            const isBook = payment.kind === 'book';

            const name = isBook
                ? payment.book_title || 'Individual Book'
                : `${String(
                    payment.plan_slug || 'Plan'
                ).toUpperCase()} Subscription`;

            const duration = isBook
                ? payment.book_duration_months
                : payment.months;

            const paid = payment.status === 'paid';

            const amount = Number(
                payment.amount_iqd || 0
            ).toLocaleString('en-IQ');

            return `
                <article class="border border-gray-200
                                rounded-xl p-4 space-y-2">

                    <div class="flex flex-wrap gap-2
                                justify-between items-center">
                        <strong class="text-gray-800">
                            ${escapeHtml(name)}
                        </strong>

                        ${badge(
                            String(payment.status).toUpperCase(),
                            paid
                        )}
                    </div>

                    <p class="text-sm text-gray-600">
                        ${amount}
                        ${escapeHtml(payment.currency || 'IQD')}
                        ${duration ? ` · ${duration} months` : ''}
                    </p>

                    <p class="text-xs text-gray-500">
                        ${paid
                            ? 'Paid: ' + formatDate(payment.paid_at)
                            : 'Created: ' + formatDate(payment.created_at)}
                    </p>

                    <p class="text-xs text-gray-500 break-all">
                        Reference:
                        ${escapeHtml(payment.request_id)}
                    </p>
                </article>
            `;
        }).join('')}
    `;
}

function setTab(tab) {
    const ids = {
        books: 'qzLibraryBooks',
        plans: 'qzLibraryPlans',
        payments: 'qzLibraryPayments'
    };

    for (const [name, id] of Object.entries(ids)) {
        $(id).classList.toggle('hidden', name !== tab);
    }

    document.querySelectorAll(
        '[data-qz-library-tab]'
    ).forEach(button => {
        const selected =
            button.dataset.qzLibraryTab === tab;

        button.classList.toggle('bg-blue-600', selected);
        button.classList.toggle('text-white', selected);

        button.classList.toggle('bg-gray-100', !selected);
        button.classList.toggle('text-gray-700', !selected);

        button.setAttribute(
            'aria-selected',
            String(selected)
        );
    });
}

async function loadLibrary() {
    const refresh = $('qzLibraryRefresh');
    const status = $('qzLibraryStatus');

    refresh.disabled = true;
    status.textContent = 'Loading your purchases...';

    try {
        const {
            data: { user },
            error: authError
        } = await supabase.auth.getUser();

        if (authError || !user) {
            throw Error('Please sign in to view your library.');
        }


// Load purchases and current book entitlements together.
// qz_my_book_access is already used by Dashboard.
const [
    { data, error },
    { data: bookAccess, error: accessError }
] = await Promise.all([
    supabase.rpc('qz_my_library_summary'),
    supabase.rpc('qz_my_book_access')
]);

if (error) throw error;
if (accessError) throw accessError;

if (!Array.isArray(bookAccess)) {
    throw Error('Unable to verify current book access.');
}


        const books = Array.isArray(data?.books)
            ? data.books : [];

        const plans = Array.isArray(data?.plans)
            ? data.plans : [];

        const payments = Array.isArray(data?.payments)
            ? data.payments : [];

        const override = data?.override || null;



renderBooks(books, bookAccess);
renderPlans(plans, override, payments);
renderPayments(payments);



        const activeBooks = books.filter(book =>
            !book.expires_at ||
            new Date(book.expires_at).getTime() > Date.now()
        ).length;

        const activePaidPlans = plans.filter(plan =>
            activeAt(plan.starts_at, plan.expires_at)
        ).length;

        const currentPlans = override
            ? (override.plan_slug === 'free' ? 0 : 1)
            : activePaidPlans;

        $('qzLibraryBookCount').textContent = activeBooks;
        $('qzLibraryPlanCount').textContent = currentPlans;
        $('qzLibraryPaymentCount').textContent =
            payments.length;

        status.textContent =
            'Your library is up to date.';

    } catch (error) {
        console.error('My Library:', error);

        status.textContent =
            'Unable to load your library: ' + error.message;

    } finally {
        refresh.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!$('qzLibrarySection')) return;

    document.querySelectorAll(
        '[data-qz-library-tab]'
    ).forEach(button => {
        button.addEventListener('click', () => {
            setTab(button.dataset.qzLibraryTab);
        });
    });



$('qzLibraryRefresh').addEventListener(
    'click',
    loadLibrary
);

// Upgrade an active paid Premium membership to Platinum.
$('qzLibraryPlans').addEventListener('click', event => {
    const button = event.target.closest(
        '[data-qz-upgrade-plan]'
    );

    if (!button || button.disabled) return;

    event.preventDefault();


openPlanChangeModal({
    currentPlan: button.dataset.qzUpgradePlan,
    currentMonths: Number(button.dataset.qzCurrentMonths)
});

});

// Renew an expired Premium or Platinum plan.

$('qzLibraryPlans').addEventListener('click', async event => {
    const button = event.target.closest(
        '[data-qz-renew-plan]'
    );

    if (!button || button.disabled) return;

    event.preventDefault();

    const planSlug = button.dataset.qzRenewPlan;
    const requestedSpeciality =
        button.dataset.qzRenewSpeciality || '';

    if (!['premium', 'platinum'].includes(planSlug)) {
        return;
    }

    button.disabled = true;

    try {
        const {
            data: { user },
            error: authError
        } = await supabase.auth.getUser();

        if (authError || !user) {
            throw Error('Please sign in again.');
        }

        // Current Qi plan checkout uses the account specialty.
        const { data: profile, error: profileError } =
            await supabase
                .from('users')
                .select('speciality')
                .eq('id', user.id)
                .single();

        if (profileError) throw profileError;

        const currentSpeciality =
            String(profile?.speciality || '').trim();

        if (!currentSpeciality) {
            throw Error('Your account has no specialty assigned.');
        }

        if (
            requestedSpeciality &&
            requestedSpeciality !== currentSpeciality
        ) {
            throw Error(
                'This historical plan belongs to ' +
                requestedSpeciality +
                ', but your current specialty is ' +
                currentSpeciality +
                '. Please contact support before renewing.'
            );
        }

        if (typeof window.openSubscriptionModal !== 'function') {
            throw Error('The purchase window is not available.');
        }

        // No book ID: open the plan-only renewal view.
        window.openSubscriptionModal(null, planSlug);

    } catch (error) {
        console.error('Plan renewal:', error);
        window.alert(
            'Unable to open plan renewal: ' + error.message
        );

    } finally {
        button.disabled = false;
    }
});

setTab('books');
loadLibrary();

});
