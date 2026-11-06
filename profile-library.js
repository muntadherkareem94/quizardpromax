
import { supabase } from './supabaseClient.js';

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

function renderBooks(books) {
    const container = $('qzLibraryBooks');
    const now = Date.now();

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

   
const action = active
    ? `
        <a href="dashboard.html"
           class="inline-block text-blue-700 font-semibold text-sm">
            Open in Dashboard
        </a>

        <p class="text-xs text-gray-500 mt-1">
            Renewal becomes available when this
            individual book license expires.
        </p>
      `
    : `
        <button
            type="button"
            data-qz-plan-book="${escapeHtml(book.book_id)}"
            class="inline-flex items-center justify-center
                   bg-blue-600 hover:bg-blue-700
                   text-white font-semibold
                   text-sm px-4 py-2 rounded-lg">
            Renew Book Access
        </button>
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
                            active ? 'Active' : 'Expired / Cancelled',
                            active
                        )}
                    </div>

                    <p class="text-sm text-gray-600">
                        Granted: ${formatDate(book.granted_at)}
                    </p>

                    <p class="text-sm text-gray-600">
                        Expires: ${formatDate(book.expires_at)}
                    </p>

                    <p class="text-sm font-semibold
                              ${active ? 'text-green-700' : 'text-gray-500'}">
                        ${remainingDays(book.expires_at)}
                    </p>

                    ${action}
                </div>
            </article>
        `;
    }).join('');
}


function renderPlans(plans, override) {
    const container = $('qzLibraryPlans');
    const items = [];

    // One renewal action per plan tier and specialty.
    const renewalShown = new Set();


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

const canRenew =
    ['premium', 'platinum'].includes(plan.plan_slug) &&
    !renewalShown.has(renewalKey);

if (canRenew) {
    renewalShown.add(renewalKey);
}

const renewButton = canRenew
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

        const { data, error } = await supabase.rpc(
            'qz_my_library_summary'
        );

        if (error) throw error;

        const books = Array.isArray(data?.books)
            ? data.books : [];

        const plans = Array.isArray(data?.plans)
            ? data.plans : [];

        const payments = Array.isArray(data?.payments)
            ? data.payments : [];

        const override = data?.override || null;

        renderBooks(books);
        renderPlans(plans, override);
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

// Renew a Premium or Platinum plan from Personal Profile.
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
