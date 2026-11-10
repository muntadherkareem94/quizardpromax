
import { supabase } from './supabaseClient.js';

// Manages Qi standalone-book licenses.
// All database changes go through Super Admin RPCs.

export function installBookLicenseManager(dialog) {
    const panel = document.createElement('section');
    panel.className = 'qza-card';

    panel.innerHTML = `
        <style>
            #qza-plan-dialog .qza-license-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
                margin-top: 12px;
            }

            #qza-plan-dialog .qza-license-item {
                padding: 14px;
                background: white;
                border: 1px solid #dce8ef;
                border-radius: 10px;
            }

            #qza-plan-dialog .qza-license-title {
                font-size: 14px;
                font-weight: 800;
                overflow-wrap: anywhere;
            }

            #qza-plan-dialog .qza-license-meta {
                font-size: 12px;
                color: #60798b;
                margin: 7px 0;
                line-height: 1.6;
            }

            #qza-plan-dialog .qza-license-date {
                display: block;
                width: 100%;
                padding: 10px;
                margin: 9px 0;
                border: 1px solid #cddde7;
                border-radius: 8px;
                font: inherit;
                font-size: 13px;
            }

            #qza-plan-dialog .qza-license-buttons {
                display: flex;
                gap: 8px;
                margin-top: 10px;
            }

            #qza-plan-dialog .qza-license-buttons button {
                flex: 1;
                border: none;
                border-radius: 8px;
                padding: 10px;
                font-weight: 700;
                font-size: 12px;
                cursor: pointer;
            }

            #qza-plan-dialog .qza-license-save {
                background: #218cad;
                color: white;
            }

            #qza-plan-dialog .qza-license-cancel {
                background: #fff0f0;
                color: #ab343b;
            }

            #qza-plan-dialog .qza-license-buttons button:disabled {
                opacity: .45;
                cursor: not-allowed;
            }

            #qza-plan-dialog .qza-license-status {
                font-size: 12px;
                color: #4b687a;
                margin-top: 10px;
                line-height: 1.5;
            }
        </style>

        <strong>Individual Book Licenses</strong>

        <p>
            View standalone books purchased through Qi.
            Modify each license's exact expiry date or
            cancel its access separately from Premium
            and Platinum subscriptions.
        </p>

        <div id="qzaLicenseList"
             class="qza-license-list"></div>

        <div id="qzaLicenseStatus"
             class="qza-license-status"
             role="status"
             aria-live="polite">
            Select a user to load book licenses.
        </div>
    `;

    // Insert directly before the existing Plan form.
    dialog.querySelector('#qzaForm').before(panel);

    const list = panel.querySelector('#qzaLicenseList');
    const status = panel.querySelector('#qzaLicenseStatus');

    let currentUserId = null;
    let loadSequence = 0;
    let busy = false;

    function say(message) {
        status.textContent = message;
    }

    function formatDate(value) {
        if (!value) return 'Lifetime (no expiry)';
        return new Date(value).toLocaleString();
    }

    // Format a timestamp for datetime-local using
    // the administrator's local time zone.
    function toLocalInput(value) {
        if (!value) return '';

        const d = new Date(value);
        if (!Number.isFinite(d.getTime())) return '';

        const pad = n => String(n).padStart(2, '0');

        return (
            d.getFullYear() + '-' +
            pad(d.getMonth() + 1) + '-' +
            pad(d.getDate()) + 'T' +
            pad(d.getHours()) + ':' +
            pad(d.getMinutes())
        );
    }

    async function performAction(
        userId,
        book,
        action,
        dateInput
    ) {
        if (busy || userId !== currentUserId) return;

        let expiry = null;

        if (action === 'set_expiry') {
            const value = dateInput.value;

            if (!value) {
                say('Select an expiry date and time.');
                return;
            }

            const date = new Date(value);

            if (
                !Number.isFinite(date.getTime()) ||
                date.getTime() <= Date.now()
            ) {
                say('Choose a valid future expiry date.');
                return;
            }

            expiry = date.toISOString();
        }

        const actionDescription = action === 'cancel'
            ? 'CANCEL access to'
            : 'CHANGE the expiry of';

        if (!window.confirm(
            `${actionDescription} "${book.title}"?\n\n` +
            'Only this standalone license will change. ' +
            'Payment history will be preserved.'
        )) {
            return;
        }

        const reason = window.prompt(
            'Reason for this administrative change:',
            action === 'cancel'
                ? 'Sandbox book license cancellation'
                : 'Manual book expiry adjustment'
        );

        if (reason === null) return;

        const cleanReason = reason.trim();

        if (
            cleanReason.length < 3 ||
            cleanReason.length > 300
        ) {
            say('Reason must contain 3 to 300 characters.');
            return;
        }

        busy = true;
        say('Saving book license change...');

        try {
            const { error } = await supabase.rpc(
                'qz_admin_manage_book_license',
                {
                    p_user_id: userId,
                    p_book_id: book.book_id,
                    p_action: action,
                    p_expires_at: expiry,
                    p_reason: cleanReason
                }
            );

            if (error) throw error;

            await load(userId);

            say(
                action === 'cancel'
                    ? 'Book license cancelled successfully.'
                    : 'Book expiry date updated successfully.'
            );

        } catch (error) {
            say('Failed: ' + error.message);

        } finally {
            busy = false;
        }
    }

    function renderLicenses(userId, licenses) {
        list.replaceChildren();

        if (!licenses.length) {
            const empty = document.createElement('p');
            empty.textContent =
                'This user has no standalone book licenses.';
            list.appendChild(empty);
            return;
        }

        for (const book of licenses) {
            const item = document.createElement('div');
            item.className = 'qza-license-item';

            const title = document.createElement('div');
            title.className = 'qza-license-title';
            title.textContent = book.title;

            const meta = document.createElement('div');
            meta.className = 'qza-license-meta';

            const expires = book.expires_at
                ? new Date(book.expires_at).getTime()
                : null;

            const active =
                expires === null || expires > Date.now();

            meta.textContent =
                'Granted: ' + formatDate(book.granted_at) +
                '\nExpiry: ' + formatDate(book.expires_at) +
                '\nStatus: ' + (active ? 'Active' : 'Expired');

            meta.style.whiteSpace = 'pre-line';

            const label = document.createElement('label');
            label.className = 'qza-info';
            label.textContent =
                'Set exact expiry (your local time):';

            const dateInput = document.createElement('input');
            dateInput.type = 'datetime-local';
            dateInput.className = 'qza-license-date';
            dateInput.value = toLocalInput(book.expires_at);
            dateInput.setAttribute(
                'aria-label',
                'Expiry for ' + book.title
            );

            const buttons = document.createElement('div');
            buttons.className = 'qza-license-buttons';

            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'qza-license-save';
            save.textContent = 'Save Expiry';

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'qza-license-cancel';
            cancel.textContent = 'Cancel Book Access';

            save.addEventListener('click', () => {
                performAction(
                    userId,
                    book,
                    'set_expiry',
                    dateInput
                );
            });

            cancel.addEventListener('click', () => {
                performAction(
                    userId,
                    book,
                    'cancel',
                    dateInput
                );
            });

            buttons.append(save, cancel);
            item.append(title, meta, label, dateInput, buttons);
            list.appendChild(item);
        }
    }

    async function load(userId) {
        currentUserId = userId;
        const sequence = ++loadSequence;

        list.replaceChildren();
        say('Loading individual book licenses...');

        try {
            const { data, error } = await supabase.rpc(
                'qz_admin_list_book_licenses',
                { p_user_id: userId }
            );

            if (error) throw error;
            if (sequence !== loadSequence) return;

            renderLicenses(
                userId,
                Array.isArray(data) ? data : []
            );

            say(
                'Choose a book to modify its expiry or cancel access.'
            );

        } catch (error) {
            if (sequence !== loadSequence) return;
            say('Unable to load licenses: ' + error.message);
        }
    }


    // ------------------------------------------------
    // Super Admin — Independent Manual Book Grants
    // ------------------------------------------------

    const grantPanel = document.createElement('section');
    grantPanel.className = 'qza-card';

    grantPanel.innerHTML = `
        <strong>Grant Individual Book</strong>

        <p>
            Give any user access to one book without
            creating a payment or changing their plan.
        </p>

        <form id="qzaManualGrantForm">
            <label class="qza-label" for="qzaGrantBook">
                Select book
            </label>

            <select id="qzaGrantBook" required>
                <option value="">Loading books...</option>
            </select>

            <label class="qza-label" for="qzaGrantDuration">
                Access duration
            </label>

            <select id="qzaGrantDuration">
                <option value="3">3 Months</option>
                <option value="6">6 Months</option>
                <option value="9">9 Months</option>
                <option value="12">12 Months</option>
                <option value="0">Lifetime</option>
            </select>

            <label class="qza-label" for="qzaGrantReason">
                Reason for manual grant
            </label>

            <textarea
                id="qzaGrantReason"
                rows="2"
                minlength="3"
                maxlength="300"
                required
                placeholder="E.g. Alternative payment arrangement"
            ></textarea>

            <button
                type="submit"
                class="qza-btn"
                id="qzaGrantSubmit"
                style="width:100%;margin-top:15px"
            >
                Grant Book Access
            </button>
        </form>

        <div class="qza-info" style="margin-top:12px">
            No payment transaction will be created.
            Existing purchased licenses are unaffected.
        </div>

        <h3 style="margin-top:22px;font-size:15px">
            Active Manual Grants
        </h3>

        <div id="qzaManualGrantList"></div>

        <div
            id="qzaManualGrantStatus"
            class="qza-status"
            role="status"
            aria-live="polite"
            style="margin-top:15px"
        ></div>
    `;

    panel.after(grantPanel);

    const grantForm =
        grantPanel.querySelector('#qzaManualGrantForm');

    const grantBook =
        grantPanel.querySelector('#qzaGrantBook');

    const grantDuration =
        grantPanel.querySelector('#qzaGrantDuration');

    const grantReason =
        grantPanel.querySelector('#qzaGrantReason');

    const grantList =
        grantPanel.querySelector('#qzaManualGrantList');

    const grantStatus =
        grantPanel.querySelector('#qzaManualGrantStatus');

    const grantSubmit =
        grantPanel.querySelector('#qzaGrantSubmit');

    let grantUserId = null;
    let grantBusy = false;
    let grantLoadSequence = 0;

    function grantSay(message) {
        grantStatus.textContent = message;
    }

    async function loadManualGrants(userId) {
        grantUserId = userId;

        const sequence = ++grantLoadSequence;

        grantBook.disabled = true;
        grantList.replaceChildren();
        grantSay('Loading available books and grants...');

        try {
            const [booksResult, grantsResult] =
                await Promise.all([
                    supabase.rpc('qz_admin_grantable_books'),
                    supabase.rpc(
                        'qz_admin_list_manual_book_grants',
                        { p_user_id: userId }
                    )
                ]);

            if (sequence !== grantLoadSequence) return;

            if (booksResult.error) {
                throw booksResult.error;
            }

            if (grantsResult.error) {
                throw grantsResult.error;
            }

            grantBook.replaceChildren();

            const placeholder = new Option(
                'Choose a book...',
                ''
            );

            grantBook.appendChild(placeholder);

            for (const book of booksResult.data || []) {
                const option = new Option(
                    `${book.book_title} — ${book.book_speciality || 'General'}`,
                    book.book_id
                );

                grantBook.appendChild(option);
            }

            grantBook.disabled = false;

            const grants = grantsResult.data || [];

            if (!grants.length) {
                const empty = document.createElement('p');
                empty.textContent = 'No active manual grants.';
                grantList.appendChild(empty);
            }

            for (const item of grants) {
                const row = document.createElement('div');

                row.style.cssText = `
                    padding:12px;
                    margin-top:10px;
                    border:1px solid #dbe8ef;
                    border-radius:10px;
                    background:white;
                `;

                const title = document.createElement('strong');
                title.textContent = item.book_title;

                const details = document.createElement('p');

                details.textContent =
                    'Expires: ' +
                    (
                        item.expires_at
                            ? new Date(item.expires_at)
                                .toLocaleString()
                            : 'Lifetime'
                    ) +
                    '\nReason: ' +
                    (item.reason || '');

                details.style.whiteSpace = 'pre-line';

                const revoke = document.createElement('button');

                revoke.type = 'button';
                revoke.className =
                    'qza-btn qza-danger';

                revoke.style.cssText = `
                    width:100%;
                    margin-top:9px;
                    padding:9px;
                `;

                revoke.textContent = 'Revoke Manual Grant';

                revoke.addEventListener('click', async () => {
                    if (grantBusy) return;

                    const targetUserId = grantUserId;

                    if (!window.confirm(
                        `Revoke manual access to "${item.book_title}"?`
                    )) {
                        return;
                    }

                    const reason = window.prompt(
                        'Reason for revocation:',
                        'Manual grant revoked'
                    );

                    if (reason === null) return;

                    if (reason.trim().length < 3) {
                        grantSay('A valid reason is required.');
                        return;
                    }

                    grantBusy = true;
                    revoke.disabled = true;

                    try {
                        const { error } = await supabase.rpc(
                            'qz_admin_revoke_book_grant',
                            {
                                p_user_id: targetUserId,
                                p_book_id: item.book_id,
                                p_reason: reason.trim()
                            }
                        );

                        if (error) throw error;

                        if (grantUserId === targetUserId) {
                            await loadManualGrants(targetUserId);
                            grantSay('Manual grant revoked.');
                        }
                    } catch (error) {
                        grantSay('Revoke failed: ' + error.message);
                    } finally {
                        grantBusy = false;
                        revoke.disabled = false;
                    }
                });

                row.append(title, details, revoke);
                grantList.appendChild(row);
            }

            grantSay('Manual book access is ready.');

        } catch (error) {
            grantSay('Unable to load grants: ' + error.message);
        }
    }

    grantForm.addEventListener('submit', async event => {
        event.preventDefault();

        if (grantBusy || !grantUserId) return;

        const targetUserId = grantUserId;
        const bookId = grantBook.value;
        const months = Number(grantDuration.value);
        const reason = grantReason.value.trim();

        if (!bookId || reason.length < 3) {
            grantSay('Select a book and enter a valid reason.');
            return;
        }

        const selectedBookName =
            grantBook.options[grantBook.selectedIndex].text;

        if (!window.confirm(
            `Grant "${selectedBookName}" to this user?\n` +
            `Duration: ${months === 0 ? 'Lifetime' : months + ' months'}\n\n` +
            'No payment will be charged.'
        )) {
            return;
        }

        grantBusy = true;
        grantSubmit.disabled = true;
        grantSay('Creating manual book grant...');

        try {
            const { error } = await supabase.rpc(
                'qz_admin_grant_book',
                {
                    p_user_id: targetUserId,
                    p_book_id: bookId,
                    p_months: months,
                    p_reason: reason
                }
            );

            if (error) throw error;

            if (grantUserId === targetUserId) {
                grantReason.value = '';
                await loadManualGrants(targetUserId);
                grantSay('Book access granted successfully.');
            }

        } catch (error) {
            grantSay('Grant failed: ' + error.message);

        } finally {
            grantBusy = false;
            grantSubmit.disabled = false;
        }
    });

    // Load both existing licenses and new manual grants.
    return {
        load: async userId => {
            await Promise.all([
                load(userId),
                loadManualGrants(userId)
            ]);
        }
    };
}

