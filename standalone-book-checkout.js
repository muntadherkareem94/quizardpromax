
import { supabase } from './supabaseClient.js';

// Shared standalone purchase launcher.
// Used by Store and the subscription popup.
// Actual card details are entered only on Qi's hosted page.

let checkoutBusy = false;

function showCheckoutError(message) {
    const popupNotice =
        document.getElementById('qz-sub-message');

    const popupVisible =
        document.getElementById('qz-sub-overlay') &&
        !document.getElementById('qz-sub-overlay').hidden;

    if (popupVisible && popupNotice) {
        popupNotice.textContent = message;
    } else {
        window.alert(message);
    }
}


export async function startStandaloneCheckout(bookId, button) {
    if (checkoutBusy) return;

    if (!bookId) {
        showCheckoutError('Book ID is missing.');
        return;
    }

    const months = Number(button?.dataset.qzBookMonths);

    if (![3, 6, 12].includes(months)) {
        showCheckoutError('Choose a valid book duration.');
        return;
    }


    const { data: auth, error: authError } =
        await supabase.auth.getUser();

    if (authError || !auth?.user) {
        showCheckoutError('Please sign in before purchasing.');
        return;
    }

const proceed = window.confirm(
    `Purchase this book for ${months} months?\n\n` +
    'Only this book will be unlocked. ' +
    'Premium and Platinum are not included.\n\n' +
    'You will be redirected to Qi Sandbox checkout.'
);


    if (!proceed) return;

    checkoutBusy = true;

    const originalText = button?.textContent || '';

    if (button) {
        button.disabled = true;
        button.textContent = 'Opening secure checkout...';
    }

    try {
        const { data, error } = await supabase.functions.invoke(
            'qi-start-book-checkout',
            {
       
body: {
    book_id: String(bookId),
    months
}

            }
        );

        if (error) {
            let message = error.message;

            // Where supported, include the backend's
            // explanatory error response.
            try {
                const details =
                    await error.context?.json?.();

                if (details?.error) {
                    message = details.error;
                }
            } catch (_) {
                // Keep the original error message.
            }

            throw Error(message);
        }

        if (!data?.checkout_url) {
            throw Error(
                data?.error || 'Secure checkout URL not available.'
            );
        }

        const checkout = new URL(data.checkout_url);

        const host = checkout.hostname.toLowerCase();

        if (
            checkout.protocol !== 'https:' ||
            !(host === 'qi.iq' || host.endsWith('.qi.iq'))
        ) {
            throw Error('Invalid payment destination.');
        }

        window.location.assign(checkout.href);

    } catch (error) {
        console.error('Standalone checkout:', error);

        showCheckoutError(
            'Could not start individual book purchase: ' +
            error.message
        );

        checkoutBusy = false;

        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

// Handles buttons created dynamically in both
// the Store and the Dashboard subscription modal.
document.addEventListener('click', event => {
    const button = event.target.closest(
        '[data-qz-buy-book]'
    );

    if (!button) return;

    event.preventDefault();

    startStandaloneCheckout(
        button.dataset.qzBuyBook,
        button
    );
});
