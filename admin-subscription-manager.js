

import { supabase } from './supabaseClient.js';
import { installBookLicenseManager } from './admin-book-licenses.js';


// Quizard Super Admin — Manual Subscription Management

const dialog = document.createElement('dialog');
dialog.id = 'qza-plan-dialog';

dialog.innerHTML = `
    <style>
        #qza-plan-dialog {
            width: min(94vw, 560px);
            max-height: 88vh;
            padding: 0;
            border: none;
            border-radius: 18px;
            background: white;
            box-shadow: 0 24px 75px #102a4655;
            color: #17344a;
            font-family: Inter, Arial, sans-serif;
        }

        #qza-plan-dialog::backdrop {
            background: rgba(12, 29, 45, .68);
            backdrop-filter: blur(4px);
        }

        #qza-plan-dialog .qza-body {
            padding: 26px;
            overflow-y: auto;
            max-height: 88vh;
        }

        #qza-plan-dialog .qza-heading {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 15px;
            margin-bottom: 15px;
        }

        #qza-plan-dialog h2 {
            margin: 0;
            font-size: 22px;
            font-weight: 800;
        }

        #qza-plan-dialog .qza-close {
            border: none;
            background: #edf3f7;
            color: #536a7a;
            border-radius: 50%;
            width: 34px;
            height: 34px;
            cursor: pointer;
            font-size: 24px;
        }

        #qza-plan-dialog .qza-card {
            border: 1px solid #dbe8ef;
            background: #f5f9fb;
            border-radius: 12px;
            padding: 15px;
            margin: 14px 0;
        }

        #qza-plan-dialog .qza-card p {
            margin: 7px 0;
            font-size: 13px;
            line-height: 1.6;
            color: #435e70;
            overflow-wrap: anywhere;
        }

        #qza-plan-dialog .qza-label {
            display: block;
            font-size: 13px;
            font-weight: 700;
            margin: 18px 0 7px;
        }

        #qza-plan-dialog select,
        #qza-plan-dialog textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid #cfdee7;
            border-radius: 9px;
            font: inherit;
            background: white;
        }

        #qza-plan-dialog .qza-info {
            font-size: 12px;
            color: #697f8e;
            line-height: 1.6;
            margin-top: 8px;
        }

        #qza-plan-dialog .qza-warning {
            font-size: 12px;
            line-height: 1.6;
            padding: 12px;
            background: #fff8e8;
            border-left: 4px solid #d9a43a;
            border-radius: 7px;
            margin-top: 15px;
        }

        #qza-plan-dialog .qza-actions {
            display: flex;
            gap: 10px;
            margin-top: 22px;
        }

        #qza-plan-dialog .qza-btn {
            padding: 12px 16px;
            flex: 1;
            border: none;
            border-radius: 9px;
            background: #238ab0;
            color: white;
            font-weight: 700;
            cursor: pointer;
        }


#qza-plan-dialog .qza-secondary {
    background: #e8eff4;
    color: #294e66;
}

#qza-plan-dialog .qza-cancel-panel {
    margin-top: 18px;
    padding: 15px;
    border: 1px solid #f0c7c7;
    border-radius: 12px;
    background: #fff8f8;
}

#qza-plan-dialog .qza-cancel-panel strong {
    font-size: 14px;
    color: #a82e35;
}

#qza-plan-dialog .qza-cancel-panel p {
    font-size: 12px;
    color: #77555a;
    line-height: 1.5;
    margin: 8px 0 12px;
}

#qza-plan-dialog .qza-danger {
    width: 100%;
    background: #bd343e;
    color: white;
}

#qza-plan-dialog .qza-danger:hover:not(:disabled) {
    background: #9f2932;
}


        #qza-plan-dialog .qza-btn:disabled {
            opacity: .5;
            cursor: not-allowed;
        }

        #qza-plan-dialog .qza-status {
            padding: 12px;
            border-radius: 9px;
            background: #e8f3f9;
            font-size: 13px;
            line-height: 1.5;
            margin-top: 15px;
        }

        #qza-plan-dialog .qza-paid-row {
            border-top: 1px solid #dde8ef;
            padding: 9px 0;
            font-size: 12px;
            line-height: 1.5;
        }
    </style>

    <div class="qza-body">
        <div class="qza-heading">
            <h2>Manage User Plan</h2>
            <button
                type="button"
                class="qza-close"
                id="qzaClose"
                aria-label="Close">
                &times;
            </button>
        </div>

        <div class="qza-card">
            <strong id="qzaUsername">Loading...</strong>
            <p id="qzaEmail"></p>
            <p id="qzaSpeciality"></p>
            <p id="qzaCurrent"></p>
        </div>

        <div class="qza-card">
            <strong>Active paid subscriptions</strong>
            <div id="qzaPaidPlans"></div>
        </div>

        <form id="qzaForm">
            <label class="qza-label" for="qzaPlan">
                Select membership
            </label>

            <select id="qzaPlan" required>
                <option value="automatic">
                    Restore Automatic (payment-based access)
                </option>
                <option value="free">Free</option>
                <option value="premium">Premium</option>
                <option value="platinum">Platinum</option>
            </select>

            <div id="qzaDurationBox" hidden>
                <label class="qza-label" for="qzaDuration">
                    Subscription duration
                </label>

                <select id="qzaDuration">
                    <option value="3">3 Months</option>
                    <option value="6">6 Months</option>
                    <option value="12">12 Months</option>
                </select>
            </div>

            <label class="qza-label" for="qzaReason">
                Reason for adjustment
            </label>

            <textarea id="qzaReason"
                rows="2"
                minlength="3"
                maxlength="300"
                required
                placeholder="E.g. Free trial, manual upgrade, sandbox reset"></textarea>

            <p class="qza-info">
                Manual Premium/Platinum grants apply to the
                user's assigned specialty. They are not purchases
                and do not create a payment transaction.
            </p>

            <div class="qza-warning">
                Changing a user to Free suspends subscription
                access but does not refund or cancel payments.
                Individually purchased books remain accessible.
                Restore Automatic uses existing paid
                subscriptions again.
            </div>

        
<div class="qza-cancel-panel">
 
<strong>Cancel Active & Scheduled Subscriptions</strong>

<p>
    Reset this user to Free by expiring all currently
    active subscriptions and future scheduled renewals,
    including Premium and Platinum.

    Manual plan overrides will also be cleared.
    Qi payment transactions will be preserved.

    This action does not issue refunds or cancel
    payment gateway recurring billing agreements.
    Use it for sandbox testing or authorized cancellations.
</p>


    <button
        type="button"
        id="qzaCancelSubscriptions"
        class="qza-btn qza-danger"
        disabled>
        Cancel Subscriptions & Reset to Free
    </button>
</div>

<div id="qzaStatus"
     class="qza-status"
     role="status"
     aria-live="polite">
    Loading user...
</div>


            <div class="qza-actions">
                <button type="button"
                    id="qzaCancel"
                    class="qza-btn qza-secondary">
                    Cancel
                </button>

                <button type="submit"
                    id="qzaSave"
                    class="qza-btn">
                    Save Plan
                </button>
            </div>
        </form>
    </div>
`;


document.body.appendChild(dialog);

// Add individual-book controls to the same Super Admin window.
const bookLicenseManager = installBookLicenseManager(dialog);

const $ = id => dialog.querySelector('#' + id);


let selectedUserId = null;
let currentInfo = null;
let saving = false;

function setStatus(message) {
    $('qzaStatus').textContent = message;
}

function displayDate(value) {
    if (!value) return 'No expiration';

    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? 'Unknown'
        : date.toLocaleString();
}

function updateDurationVisibility() {
    const plan = $('qzaPlan').value;

    $('qzaDurationBox').hidden =
        plan !== 'premium' && plan !== 'platinum';
}

function renderUser(info) {
    currentInfo = info;

    $('qzaUsername').textContent =
        info.username || 'Unnamed user';

    $('qzaEmail').textContent =
        info.email || 'No email available';

    $('qzaSpeciality').textContent =
        'Specialty: ' + (info.speciality || 'Not assigned');

    const override = info.override;

    if (override) {
        const label = override.plan.toUpperCase();

        $('qzaCurrent').textContent =
            'Manual plan: ' + label +
            ' — ' + displayDate(override.expires_at);

        $('qzaPlan').value = override.plan;
    } else {
        $('qzaCurrent').textContent =
            'Manual plan: None (automatic access rules)';

        $('qzaPlan').value = 'automatic';
    }

    updateDurationVisibility();

    const container = $('qzaPaidPlans');
    container.replaceChildren();

    const paid = Array.isArray(info.active_paid)
        ? info.active_paid
        : [];

    if (!paid.length) {
        const p = document.createElement('p');
        p.textContent = 'No active paid subscriptions.';
        container.appendChild(p);

    } else {
        for (const item of paid) {
            const row = document.createElement('div');
            row.className = 'qza-paid-row';

            row.textContent =
                String(item.plan || '').toUpperCase() +
                ' — ' +
                (item.speciality || 'Legacy Global') +
                ' — Expires: ' +
                displayDate(item.expires_at);

            container.appendChild(row);
        }
    }
}

async function loadUserPlan(userId) {
    const { data, error } = await supabase.rpc(
        'qz_admin_get_user_plan',
        {
            p_user_id: userId
        }
    );

    if (error) throw error;

    renderUser(data);

    setStatus('Choose a plan and save your changes.');
}

async function openPlanManager(userId) {
    if (!userId) return;

    if (dialog.open) dialog.close();

    selectedUserId = userId;
    currentInfo = null;

    $('qzaForm').reset();
    $('qzaUsername').textContent = 'Loading user...';
    $('qzaEmail').textContent = '';
    $('qzaSpeciality').textContent = '';
    $('qzaCurrent').textContent = '';
    $('qzaPaidPlans').replaceChildren();


$('qzaSave').disabled = true;
$('qzaCancelSubscriptions').disabled = true;

setStatus('Loading subscription information...');


    dialog.showModal();

    try {
        const { data, error } =
            await supabase.rpc('qz_is_super_admin');

        if (error || data !== true) {
            throw Error('Super Admin permission required.');
        }



await loadUserPlan(userId);

// Independently load Qi standalone-book licenses.
await bookLicenseManager.load(userId);

$('qzaSave').disabled = false;
$('qzaCancelSubscriptions').disabled = false;



    } catch (error) {
        setStatus('Unable to load user: ' + error.message);
    }
}

async function savePlan(event) {
    event.preventDefault();

    if (saving || !selectedUserId || !currentInfo) return;

    const plan = $('qzaPlan').value;

    const months =
        plan === 'premium' || plan === 'platinum'
            ? Number($('qzaDuration').value)
            : null;

    const reason = $('qzaReason').value.trim();

    if (reason.length < 3 || reason.length > 300) {
        setStatus('Please enter a valid reason.');
        return;
    }

    const label = plan === 'automatic'
        ? 'RESTORE AUTOMATIC ACCESS'
        : plan.toUpperCase();

    let message =
        `Apply ${label} to ${currentInfo.username}?\n\n` +
        `Specialty: ${currentInfo.speciality || 'None'}\n`;

    if (months) {
        message += `Duration: ${months} months\n`;
    }

    if (plan === 'free') {
        message +=
            '\nWARNING: This suspends subscription access, ' +
            'including any existing unexpired paid plan. ' +
            'It does NOT cancel billing or issue a refund.\n';
    }

    if (!confirm(message)) return;

    saving = true;
    $('qzaSave').disabled = true;
    setStatus('Saving administrative subscription change...');

    try {
        const { data, error } = await supabase.rpc(
            'qz_admin_set_user_plan',
            {
                p_user_id: selectedUserId,
                p_plan: plan,
                p_months: months,
                p_reason: reason
            }
        );

        if (error) throw error;

        renderUser(data);

        $('qzaReason').value = '';

        setStatus(
            'Saved successfully. The user can refresh ' +
            'the Dashboard to see updated access.'
        );

    } catch (error) {
        setStatus('Save failed: ' + error.message);

   
    } finally {
        saving = false;
        $('qzaSave').disabled = false;
        $('qzaCancelSubscriptions').disabled = false;
    }
}

// ------------------------------------------
// Cancel subscriptions and reset user to Free
// ------------------------------------------

async function cancelUserSubscriptions() {
    if (saving || !selectedUserId || !currentInfo) {
        return;
    }

    const username = String(
        currentInfo.username || ''
    ).trim();

    if (!username) {
        setStatus('Unable to identify this user.');
        return;
    }

    const reason =
        $('qzaReason').value.trim() ||
        'Sandbox subscription reset';

    if (reason.length < 3 || reason.length > 300) {
        setStatus(
            'Enter a reason between 3 and 300 characters.'
        );
        return;
    }

    const confirmation = window.prompt(
        'Cancel ALL active subscriptions for:\n\n' +
        username + '\n\n' +
        'This will:\n' +
        '- Expire active Premium/Platinum subscriptions\n' +
        '- Remove manual subscription overrides\n' +
        '- Reset legacy Premium access\n' +
        '- Preserve Qi payment history\n\n' +
        'Type the EXACT username to confirm:'
    );

    if (confirmation === null) return;

    if (confirmation !== username) {
        setStatus(
            'Cancellation aborted: username does not match.'
        );
        return;
    }

    const finalConfirmation = window.confirm(
        'FINAL CONFIRMATION\n\n' +
        'Reset ' + username + ' to Free access?\n\n' +
        'This does not refund or reverse transactions. ' +
        'It does not cancel recurring gateway charges.'
    );

    if (!finalConfirmation) return;

    saving = true;

    $('qzaSave').disabled = true;
    $('qzaCancelSubscriptions').disabled = true;

    setStatus('Cancelling active subscriptions...');

    try {
        const { data, error } = await supabase.rpc(
            'qz_admin_cancel_user_subscriptions',
            {
                p_user_id: selectedUserId,
                p_confirm_username: confirmation,
                p_reason: reason
            }
        );

        if (error) throw error;

        if (!data?.plan_info) {
            throw Error('Server did not return updated user data.');
        }

        renderUser(data.plan_info);

        $('qzaReason').value = '';

        setStatus(
            'Reset completed successfully. ' +
            
`${data.expired_count} active or scheduled subscription(s) expired. ` +

            `${data.overrides_removed} manual override(s) removed. ` +
            'The user can now refresh Dashboard and ' +
            'make a new sandbox purchase.'
        );

    } catch (error) {
        console.error('Subscription cancellation:', error);

        setStatus(
            'Cancellation failed: ' + error.message
        );

    } finally {
        saving = false;

        $('qzaSave').disabled = false;
        $('qzaCancelSubscriptions').disabled = false;
    }
}

// Delegated click listener works with dynamically loaded user rows.

document.addEventListener('click', event => {
    const button = event.target.closest('.manage-plan-btn');

    if (!button) return;

    openPlanManager(button.dataset.userId);
});

$('qzaPlan').addEventListener(
    'change',
    updateDurationVisibility
);

$('qzaForm').addEventListener('submit', savePlan);

$('qzaClose').addEventListener('click', () => {
    if (!saving) dialog.close();
});


$('qzaCancel').addEventListener('click', () => {
    if (!saving) dialog.close();
});

// Dedicated cancellation action
$('qzaCancelSubscriptions').addEventListener(
    'click',
    cancelUserSubscriptions
);

