import { supabase } from './supabaseClient.js';

let notificationsInitialized = false;

async function getCurrentSessionUser() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user || null;
}

function buildNotificationDropdown(notificationButton) {
    if (!notificationButton || notificationsInitialized) return null;

    const parent = notificationButton.parentElement;

        const wrapper = document.createElement('div');
    wrapper.className = 'relative inline-flex items-center justify-center';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.width = '40px';
    wrapper.style.height = '40px';

    parent.insertBefore(wrapper, notificationButton);
    wrapper.appendChild(notificationButton);

    const badge = document.createElement('span');
    badge.id = 'notificationBadge';
    badge.className = 'hidden';
    badge.textContent = '';
    badge.style.position = 'absolute';
        badge.style.top = '2px';
    badge.style.right = '2px';
    badge.style.width = '12px';
    badge.style.height = '12px';
    badge.style.backgroundColor = '#ef4444';
    badge.style.borderRadius = '9999px';
    badge.style.border = '2px solid white';
    badge.style.zIndex = '10';
    wrapper.appendChild(badge);

    const dropdown = document.createElement('div');
    dropdown.id = 'notificationDropdown';
    dropdown.className = 'hidden absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-xl z-50 overflow-hidden';

    dropdown.innerHTML = `
        <div class="p-3 border-b border-gray-100">
            <h3 class="text-sm font-bold text-sky-500">Notifications</h3>
        </div>
        <div id="notificationList" class="max-h-96 overflow-y-auto"></div>
    `;

    wrapper.appendChild(dropdown);

    return {
        notificationButton,
        notificationBadge: badge,
        notificationDropdown: dropdown,
        notificationList: dropdown.querySelector('#notificationList')
    };
}

async function fetchAndDisplayNotifications(elements) {
    const user = await getCurrentSessionUser();
    if (!user) return;

    const { notificationBadge, notificationList } = elements;

    const { data: userNotifications, error } = await supabase
        .from('user_notifications')
        .select(`id, is_read, notifications (content, type, link_url, created_at)`)
        .eq('recipient_id', user.id)
        .order('created_at', { foreignTable: 'notifications', ascending: false })
        .limit(100);

    if (error) {
        console.error('Error fetching notifications:', error);
        return;
    }

    const notifications = userNotifications || [];
    const unreadCount = notifications.filter(item => item.is_read === false).length;

        if (unreadCount > 0) {
        notificationBadge.textContent = '';
        notificationBadge.classList.remove('hidden');
    } else {
        notificationBadge.classList.add('hidden');
    }

    notificationList.innerHTML = '';

    if (notifications.length === 0) {
        notificationList.innerHTML = `
            <p class="p-4 text-sm text-gray-500 text-center">You have no notifications.</p>
        `;
        return;
    }

    notifications.sort((a, b) => {
        const dateA = a.notifications ? new Date(a.notifications.created_at).getTime() : 0;
        const dateB = b.notifications ? new Date(b.notifications.created_at).getTime() : 0;
        return dateB - dateA;
    });

    notifications.forEach(item => {
        const notification = item.notifications;
        if (!notification) return;

        const isUnread = item.is_read === false;

        const notifElement = document.createElement('a');
        notifElement.href = notification.link_url || '#';
        notifElement.dataset.userNotificationId = item.id;
        notifElement.dataset.isRead = String(!isUnread);

        notifElement.className = isUnread
            ? 'block p-4 bg-blue-50 hover:bg-blue-100 border-b border-gray-100 transition'
            : 'block p-4 bg-white hover:bg-gray-50 border-b border-gray-100 transition';

        notifElement.innerHTML = `
            <div class="min-w-0">
                <p class="${isUnread ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}">${notification.content}</p>
                <p class="text-xs text-gray-500 mt-1">${new Date(notification.created_at).toLocaleString()}</p>
            </div>
        `;

        notificationList.appendChild(notifElement);
    });
}

function setupNotificationClickHandler(elements) {
    const { notificationList } = elements;

    notificationList.addEventListener('click', async (e) => {
        const link = e.target.closest('a');
        if (!link || !link.dataset.userNotificationId) return;

        e.preventDefault();

        const userNotificationId = link.dataset.userNotificationId;
        const alreadyRead = link.dataset.isRead === 'true';

        if (!alreadyRead) {
            const { error } = await supabase
                .from('user_notifications')
                .update({
                    is_read: true,
                    read_at: new Date().toISOString()
                })
                .eq('id', userNotificationId);

            if (error) {
                console.error('Error marking notification as read:', error);
                alert('Could not update notification status.');
                return;
            }

            link.dataset.isRead = 'true';
            link.className = 'block p-4 bg-white hover:bg-gray-50 border-b border-gray-100 transition';

            const message = link.querySelector('p');
            if (message) {
                message.className = 'font-medium text-gray-700';
            }

            await fetchAndDisplayNotifications(elements);
        }

        const href = link.getAttribute('href');
        if (href && href !== '#') {
            window.location.href = href;
        }
    });
}

export function initNotifications() {
    const notificationButton = document.getElementById('notificationButton');
    if (!notificationButton || notificationsInitialized) return;

    const elements = buildNotificationDropdown(notificationButton);
    if (!elements) return;

    notificationsInitialized = true;

    elements.notificationButton.addEventListener('click', async (event) => {
        event.stopPropagation();

        elements.notificationDropdown.classList.toggle('hidden');

        if (!elements.notificationDropdown.classList.contains('hidden')) {
            await fetchAndDisplayNotifications(elements);
        }
    });

    document.addEventListener('click', () => {
        if (!elements.notificationDropdown.classList.contains('hidden')) {
            elements.notificationDropdown.classList.add('hidden');
        }
    });

    elements.notificationDropdown.addEventListener('click', (event) => {
        event.stopPropagation();
    });

    setupNotificationClickHandler(elements);

    // Load badge count once when page opens
    fetchAndDisplayNotifications(elements);
}