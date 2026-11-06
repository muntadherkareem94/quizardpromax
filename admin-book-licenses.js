
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

    return { load };
}
