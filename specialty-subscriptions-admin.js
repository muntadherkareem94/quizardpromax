
import { supabase } from './supabaseClient.js';

// Specialty-scoped membership administration.
// Does not overwrite legacy global book access rules.

const el = id => document.getElementById(id);

const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[c]);

let catalog = [];
let specialtyList = [];
let selectedSpecialty = '';
let assignments = new Map();
let savedSnapshot = '';
let busy = false;

const planSlugNames = ['premium', 'platinum'];
const durations = [3, 6, 12];

function message(text) {
    el('qzsNotice').textContent = text;
}

function getPlans() {
    return planSlugNames.map(slug => ({
        slug,
        title: el(`qzsTitle-${slug}`).value.trim(),
        description: el(`qzsDesc-${slug}`).value.trim(),
        enabled: el(`qzsEnabled-${slug}`).checked
    }));
}

function getPrices() {
    return planSlugNames.flatMap(plan_slug =>
        durations.map(months => ({
            plan_slug,
            months,
            amount_iqd: Number(
                el(`qzsPrice-${plan_slug}-${months}`).value || 0
            ),
            enabled:
                el(`qzsPriceEnabled-${plan_slug}-${months}`).checked
        }))
    );
}

function getBookItems() {
    return [...assignments.entries()]
        .filter(([, tier]) => tier !== 'none')
        .map(([book_id, tier]) => ({ book_id, tier }));
}

function valuesSnapshot() {
    return JSON.stringify({
        plans: getPlans(),
        prices: getPrices(),
        books: [...assignments.entries()].sort()
    });
}

function updateCounts() {
    let premium = 0;
    let exclusive = 0;

    for (const tier of assignments.values()) {
        if (tier === 'premium') premium++;
        if (tier === 'platinum') exclusive++;
    }

    el('qzsPremiumCount').textContent = String(premium);
    el('qzsPlatinumCount').textContent =
        String(premium + exclusive);
    el('qzsExclusiveCount').textContent = String(exclusive);

    const dirty = savedSnapshot &&
        valuesSnapshot() !== savedSnapshot;

    el('qzsDirty').textContent =
        dirty ? 'Unsaved changes' : 'All changes saved';

    el('qzsSave').disabled = !dirty || busy;
}

function renderBooks() {
    const query =
        el('qzsBookSearch').value.trim().toLowerCase();

    const filter = el('qzsBookFilter').value;

    const filtered = catalog.filter(book => {
        const tier =
            assignments.get(String(book.id)) || 'none';

        return (
            filter === 'all' || filter === tier
        ) && (
            `${book.title} ${book.speciality || ''}`
                .toLowerCase()
                .includes(query)
        );
    });

    el('qzsVisible').textContent =
        `Showing ${filtered.length} of ${catalog.length} ` +
        'books from all specialties';

    el('qzsBooksBody').innerHTML = filtered.map(book => {
        const id = String(book.id);
        const tier = assignments.get(id) || 'none';

        return `
        <tr data-id="${escapeHtml(id)}">
            <td>
                <input
                    class="qzsPick"
                    type="checkbox"
                    aria-label="Select ${escapeHtml(book.title)}">
            </td>

            <td>
                <strong>${escapeHtml(book.title)}</strong>
                <div class="small">
                    Original:
                    ${escapeHtml(book.speciality || 'Unspecified')}
                </div>
            </td>

            <td>
                <select class="qzsTier"
                    aria-label="Plan for ${escapeHtml(book.title)}">

                    <option value="none"
                        ${tier === 'none' ? 'selected' : ''}>
                        Not included
                    </option>

                    <option value="premium"
                        ${tier === 'premium' ? 'selected' : ''}>
                        Premium + Platinum
                    </option>

                    <option value="platinum"
                        ${tier === 'platinum' ? 'selected' : ''}>
                        Platinum only
                    </option>
                </select>
            </td>
        </tr>`;
    }).join('') ||
        '<tr><td colspan="3">No matching books.</td></tr>';

    updateCounts();
}

function updateSpecialtyDropdown() {
    const select = el('qzsSpecialty');

    select.innerHTML = specialtyList.map(s => `
        <option value="${escapeHtml(s.speciality)}">
            ${escapeHtml(s.speciality)}
        </option>
    `).join('');

    select.value = selectedSpecialty;
}

async function loadSpecialty() {
    if (!selectedSpecialty || busy) return;

    busy = true;
    el('qzsSave').disabled = true;
    message('Loading ' + selectedSpecialty + '...');

    try {
        const [p, pr, b] = await Promise.all([
            supabase.from('qz_specialty_plans')
                .select('*')
                .eq('speciality', selectedSpecialty),

            supabase.from('qz_specialty_plan_prices')
                .select('*')
                .eq('speciality', selectedSpecialty),

            supabase.from('qz_specialty_plan_books')
                .select('*')
                .eq('speciality', selectedSpecialty)
        ]);

        for (const response of [p, pr, b]) {
            if (response.error) throw response.error;
        }

        for (const slug of planSlugNames) {
            const plan = (p.data || []).find(
                x => x.plan_slug === slug
            );

            el(`qzsTitle-${slug}`).value =
                plan?.title ||
                (slug === 'premium' ? 'Premium' : 'Platinum');

            el(`qzsDesc-${slug}`).value =
                plan?.description || '';

            el(`qzsEnabled-${slug}`).checked =
                plan?.enabled === true;

            for (const months of durations) {
                const price = (pr.data || []).find(
                    x => x.plan_slug === slug &&
                         x.months === months
                );

                el(`qzsPrice-${slug}-${months}`).value =
                    price?.amount_iqd || '';

                el(`qzsPriceEnabled-${slug}-${months}`).checked =
                    price?.enabled === true;
            }
        }

        assignments = new Map(
            (b.data || []).map(x => [
                String(x.book_id),
                x.tier
            ])
        );

        savedSnapshot = valuesSnapshot();
        renderBooks();

        message(
            'Editing ' + selectedSpecialty + '. ' +
            'Book assignments are independent of their original specialty.'
        );

    } catch (error) {
        message('Unable to load specialty: ' + error.message);

    } finally {
        busy = false;
        updateCounts();
    }
}

async function addSpecialty() {
    if (
        savedSnapshot &&
        valuesSnapshot() !== savedSnapshot &&
        !confirm('Discard unsaved changes and add a specialty?')
    ) return;

    const name = prompt(
        'Enter the EXACT specialty name used in users.speciality ' +
        '(e.g. Clinical Pharmacy):'
    );

    const specialty = name?.trim();
    if (!specialty) return;

    if (specialtyList.some(
        x => x.speciality.toLowerCase() ===
             specialty.toLowerCase()
    )) {
        message('That specialty already exists. Select it instead.');
        return;
    }

    const { error } = await supabase
        .from('qz_subscription_specialties')
        .insert({ speciality: specialty });

    if (error) {
        message(error.message);
        return;
    }

    specialtyList.push({
        speciality: specialty,
        enabled: true
    });

    specialtyList.sort(
        (a, b) => a.speciality.localeCompare(b.speciality)
    );

    selectedSpecialty = specialty;
    updateSpecialtyDropdown();
    await loadSpecialty();
}

async function save() {
    if (!selectedSpecialty || busy) return;

    const plans = getPlans();
    const prices = getPrices();
    const books = getBookItems();

    if (plans.some(p => !p.title)) {
        message('Enter both plan titles.');
        return;
    }

    if (prices.some(p =>
        !Number.isSafeInteger(p.amount_iqd) ||
        p.amount_iqd < 0 ||
        (p.enabled && p.amount_iqd <= 0)
    )) {
        message(
            'Every enabled duration needs a valid positive IQD price.'
        );
        return;
    }

    if (plans.some(p => p.enabled) && !books.length) {
        message('Assign at least one book before activating a plan.');
        return;
    }

    if (!confirm(
        `Save ${selectedSpecialty} plans and ` +
        `${books.length} book assignments?\n` +
        'Changes become active immediately.'
    )) return;

    busy = true;
    el('qzsSave').disabled = true;

    try {
        const { error } = await supabase.rpc(
            'qz_save_specialty_configuration',
            {
                p_speciality: selectedSpecialty,
                p_plans: plans,
                p_prices: prices,
                p_books: books
            }
        );

        if (error) throw error;

        savedSnapshot = valuesSnapshot();

        message(
            selectedSpecialty + ' saved successfully. ' +
            'Reopen the subscription popup to verify.'
        );

    } catch (error) {
        message('Save failed: ' + error.message);

    } finally {
        busy = false;
        updateCounts();
    }
}

function setupMarkup() {
    const container = el('adminContent');
    if (!container) return;

    const section = document.createElement('section');
    section.className = 'panel';

    section.innerHTML = `
    <style>
        #qzsManager select,
        #qzsManager input:not([type=checkbox]),
        #qzsManager textarea {
            width: 100%;
        }

        #qzsManager .qzs-choices {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            margin: 12px 0 20px;
        }

        #qzsManager .qzs-choices select {
            width: auto;
            max-width: 380px;
        }

        #qzsManager .qzs-plans {
            display: grid;
            grid-template-columns: repeat(2, minmax(0,1fr));
            gap: 16px;
        }

        #qzsManager .qzs-card {
            border: 1px solid #d8e4ec;
            border-radius: 13px;
            padding: 20px;
        }

        #qzsManager .qzs-stats {
            background: #eff7fb;
            border-radius: 10px;
            padding: 13px;
            margin: 17px 0;
        }

        #qzsManager .qzs-controls {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
            margin: 12px 0;
        }

        #qzsManager .qzs-controls input[type=search] {
            flex: 1 1 220px;
        }

        #qzsManager .qzs-controls select {
            width: auto;
            min-width: 175px;
        }

        #qzsManager table select {
            min-width: 160px;
        }

        #qzsManager .qzs-scroll {
            max-height: 450px;
            overflow: auto;
        }

        #qzsManager .qzs-note {
            color: #546b7c;
            font-size: 13px;
            line-height: 1.5;
        }

        #qzsManager #qzsNotice {
            background: #e6f4fa;
            padding: 12px;
            border-radius: 9px;
            margin: 12px 0;
        }

        #qzsManager button:disabled {
            opacity: .45;
        }

        @media(max-width:700px) {
            #qzsManager .qzs-plans {
                grid-template-columns: 1fr;
            }
        }
    </style>

    <div id="qzsManager">

        <h2>Specialty-Specific Premium & Platinum Plans</h2>

        <p class="qzs-note">
            Each specialty has independent pricing and book membership.
            Choose any book from the full catalog, including books
            originally assigned to another specialty.
        </p>

        <div class="qzs-choices">
            <label for="qzsSpecialty">Configure specialty:</label>
            <select id="qzsSpecialty"></select>

            <button id="qzsAdd" type="button">
                + Add Specialty
            </button>

            <span id="qzsDirty" class="small"></span>
        </div>

        <div class="qzs-plans">
            ${planSlugNames.map(slug => `
                <div class="qzs-card">

                    <h3>
                        ${slug === 'premium' ? 'Premium' : 'Platinum'}
                    </h3>

                    <label>Title</label>
                    <input id="qzsTitle-${slug}" type="text">

                    <label>Description</label>
                    <textarea id="qzsDesc-${slug}" rows="2"></textarea>

                    <label class="checkbox">
                        <input type="checkbox" id="qzsEnabled-${slug}">
                        Enable this plan for this specialty
                    </label>

                    ${durations.map(months => `
                        <label>
                            ${months} months — price (IQD)
                        </label>

                        <input type="number"
                            id="qzsPrice-${slug}-${months}"
                            min="0"
                            step="1"
                            placeholder="Price in IQD">

                        <label class="checkbox">
                            <input type="checkbox"
                                id="qzsPriceEnabled-${slug}-${months}">
                            Enable ${months}-month duration
                        </label>
                    `).join('')}
                </div>
            `).join('')}
        </div>

        <div class="qzs-stats">
            Premium:
            <strong id="qzsPremiumCount">0</strong> books ·

            Platinum total:
            <strong id="qzsPlatinumCount">0</strong> books ·

            Platinum exclusive:
            <strong id="qzsExclusiveCount">0</strong> books
        </div>

        <h3>Assign Books to This Specialty</h3>

        <div class="qzs-controls">
            <input
                id="qzsBookSearch"
                type="search"
                placeholder="Search all books or original specialties...">

            <select id="qzsBookFilter">
                <option value="all">All books</option>
                <option value="premium">Premium</option>
                <option value="platinum">Platinum exclusive</option>
                <option value="none">Not included</option>
            </select>

            <select id="qzsBulk">
                <option value="">Bulk assign...</option>
                <option value="premium">Premium + Platinum</option>
                <option value="platinum">Platinum only</option>
                <option value="none">Not included</option>
            </select>

            <button id="qzsBulkApply" type="button">
                Apply to Selected
            </button>
        </div>

        <p id="qzsVisible" class="small"></p>

        <div class="table-wrap qzs-scroll">
            <table>
                <thead>
                    <tr>
                        <th>Select</th>
                        <th>Book / Original specialty</th>
                        <th>Included in</th>
                    </tr>
                </thead>

                <tbody id="qzsBooksBody"></tbody>
            </table>
        </div>

        <p class="qzs-note">
            Changes to book membership affect active specialty
            subscriptions too. Legacy global Premium book rules
            are not modified.
        </p>

        <button type="button" id="qzsSave" disabled>
            Save This Specialty's Plans & Books
        </button>

        <div id="qzsNotice" role="status">
            Loading specialties...
        </div>

    </div>`;

    container.insertBefore(section, container.firstElementChild);

    // Keep legacy global pricing / individual-sale controls available.
    const oldPlan = section.nextElementSibling;
    const oldBooks = oldPlan?.nextElementSibling;

    if (oldPlan && oldBooks) {
        const advanced = document.createElement('details');
        advanced.className = 'panel';

        const summary = document.createElement('summary');
        summary.textContent =
            'Advanced: legacy global pricing and individual book sale rules';

        summary.style.cssText =
            'cursor:pointer;font-weight:700';

        advanced.appendChild(summary);
        container.insertBefore(advanced, oldPlan);
        advanced.appendChild(oldPlan);
        advanced.appendChild(oldBooks);
    }
}

async function init() {
    setupMarkup();

    const auth = await supabase.auth.getUser();

    if (!auth.data?.user) {
        message('Please log in as Super Admin.');
        return;
    }

    const admin = await supabase.rpc('qz_is_super_admin');

    if (admin.error || admin.data !== true) {
        message('Super Admin access required.');
        return;
    }

    const [s, b] = await Promise.all([
        supabase.from('qz_subscription_specialties')
            .select('*')
            .order('speciality'),

        supabase.from('books')
            .select('id,title,speciality')
            .order('title')
    ]);

    if (s.error || b.error) {
        message(s.error?.message || b.error?.message);
        return;
    }

    specialtyList = s.data || [];
    catalog = b.data || [];

    selectedSpecialty =
        specialtyList.find(
            x => x.speciality === 'Internal Medicine - General'
        )?.speciality ||
        specialtyList[0]?.speciality ||
        '';

    updateSpecialtyDropdown();

    if (selectedSpecialty) {
        await loadSpecialty();
    } else {
        message('No specialty found. Use + Add Specialty.');
    }

    el('qzsSpecialty').addEventListener('change', async event => {
        if (
            savedSnapshot &&
            valuesSnapshot() !== savedSnapshot &&
            !confirm(
                'Discard unsaved changes and switch specialty?'
            )
        ) {
            event.target.value = selectedSpecialty;
            return;
        }

        selectedSpecialty = event.target.value;
        await loadSpecialty();
    });

    el('qzsAdd').addEventListener('click', addSpecialty);
    el('qzsSave').addEventListener('click', save);

    for (const id of ['qzsBookSearch', 'qzsBookFilter']) {
        el(id).addEventListener(
            id === 'qzsBookSearch' ? 'input' : 'change',
            renderBooks
        );
    }

    for (const input of el('qzsManager').querySelectorAll(
        'input,textarea'
    )) {
        if (input.id === 'qzsBookSearch') continue;

        input.addEventListener('input', updateCounts);
        input.addEventListener('change', updateCounts);
    }

    el('qzsBooksBody').addEventListener('change', event => {
        const select = event.target.closest('select.qzsTier');
        if (!select) return;

        const id = select.closest('tr').dataset.id;

        if (select.value === 'none') {
            assignments.delete(id);
        } else {
            assignments.set(id, select.value);
        }

        renderBooks();
    });

    el('qzsBulkApply').addEventListener('click', () => {
        const tier = el('qzsBulk').value;

        const selected = [
            ...el('qzsBooksBody').querySelectorAll('tr')
        ]
            .filter(row =>
                row.querySelector('.qzsPick')?.checked
            )
            .map(row => row.dataset.id);

        if (!tier || !selected.length) {
            message('Select books and a bulk tier.');
            return;
        }

        for (const id of selected) {
            if (tier === 'none') {
                assignments.delete(id);
            } else {
                assignments.set(id, tier);
            }
        }

        renderBooks();
    });

    window.addEventListener('beforeunload', event => {
        if (
            savedSnapshot &&
            valuesSnapshot() !== savedSnapshot
        ) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
}

init().catch(error => {
    console.error(error);

    if (el('qzsNotice')) {
        message(error.message);
    }
});
