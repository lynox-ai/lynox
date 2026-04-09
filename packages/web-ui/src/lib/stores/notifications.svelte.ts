/**
 * Push notification permission & subscription store.
 * Manages service worker registration, push subscription, and permission state.
 */

import { getApiBase } from '../config.svelte.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let permission = $state<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'default',
);
let subscribed = $state(false);
let loading = $state(false);
let supported = $state(false);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** Whether this is an iOS device without PWA homescreen installation. */
let iosWithoutPwa = $state(false);

export function initNotifications(): void {
  if (typeof window === 'undefined') return;

  const hasSw = 'serviceWorker' in navigator;
  const hasPush = 'PushManager' in window;
  const hasNotif = 'Notification' in window;

  // iOS check: PushManager only available when installed to homescreen
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone);

  if (isIos && !isStandalone) {
    iosWithoutPwa = true;
    supported = false;
    return;
  }

  supported = hasSw && hasPush && hasNotif;
  if (!supported) return;

  permission = Notification.permission;

  // Check existing subscription
  navigator.serviceWorker.ready.then(async (reg) => {
    const sub = await reg.pushManager.getSubscription();
    subscribed = sub !== null;
  });
}

export function isIosWithoutPwa(): boolean {
  return iosWithoutPwa;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function enablePushNotifications(): Promise<boolean> {
  if (!supported || loading) return false;
  loading = true;

  try {
    // 1. Register service worker
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const reg = await navigator.serviceWorker.ready;

    // 2. Get VAPID public key from server
    const vapidRes = await fetch(`${getApiBase()}/push/vapid-key`);
    if (!vapidRes.ok) {
      loading = false;
      return false;
    }
    const { publicKey } = (await vapidRes.json()) as { publicKey: string };

    // 3. Subscribe to push (triggers browser permission prompt)
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });

    permission = Notification.permission;
    if (permission !== 'granted') {
      loading = false;
      return false;
    }

    // 4. Send subscription to server
    const subJson = sub.toJSON();
    const res = await fetch(`${getApiBase()}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: sub.endpoint,
          keys: {
            p256dh: subJson.keys?.['p256dh'] ?? '',
            auth: subJson.keys?.['auth'] ?? '',
          },
        },
      }),
    });

    if (res.ok) {
      subscribed = true;
      loading = false;
      return true;
    }

    loading = false;
    return false;
  } catch (err) {
    console.error('[notifications] enable failed:', err);
    permission = Notification.permission;
    loading = false;
    return false;
  }
}

export async function disablePushNotifications(): Promise<void> {
  if (!supported) return;
  loading = true;

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();

    if (sub) {
      // Notify server
      await fetch(`${getApiBase()}/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }

    subscribed = false;
  } catch (err) {
    console.error('[notifications] disable failed:', err);
  } finally {
    loading = false;
  }
}

export async function testPushNotification(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/push/test`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getNotificationPermission(): NotificationPermission {
  return permission;
}

export function isSubscribed(): boolean {
  return subscribed;
}

export function isLoading(): boolean {
  return loading;
}

export function isSupported(): boolean {
  return supported;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}
