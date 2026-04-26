'use client';

import { useEffect, useRef } from 'react';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function getDeviceId(): string {
  let id = localStorage.getItem('savest-device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('savest-device-id', id);
  }
  return id;
}

export function usePushNotifications() {
  const subscribed = useRef(false);

  useEffect(() => {
    if (subscribed.current) return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[SaVest] Push not supported in this browser.');
      return;
    }

    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) {
      console.error('[SaVest] NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing!');
      return;
    }

    async function setup() {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          console.warn('[SaVest] Notification permission denied.');
          return;
        }

        const reg = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });

        await navigator.serviceWorker.ready;

        // Check for existing subscription first
        const existingSub = await reg.pushManager.getSubscription();
        if (existingSub) {
          const deviceId = getDeviceId();
          await fetch('/api/push/subscribe', { // ✅ fixed path
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: existingSub.toJSON(), deviceId }),
          });
          subscribed.current = true;
          console.log('[SaVest] Re-used existing push subscription.');
          return;
        }

        const applicationServerKey = urlBase64ToUint8Array(vapidKey!);

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
        });

        const deviceId = getDeviceId();
        const res = await fetch('/api/push/subscribe', { // ✅ fixed path
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), deviceId }),
        });

        if (res.ok) {
          subscribed.current = true;
          console.log('[SaVest] Push notifications registered successfully.');
        } else {
          console.error('[SaVest] Failed to save subscription to server.');
        }
      } catch (err) {
        console.error('[SaVest] Push setup failed:', err);
      }
    }

    setup();
  }, []);
}

export async function sendPushAlert(title: string, body: string, tag?: string) {
  try {
    const res = await fetch('/api/push/send', { // ✅ fixed path
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tag, url: '/' }),
    });
    console.log('[SaVest] Push send status:', res.status);
  } catch (err) {
    console.error('[SaVest] Failed to send push alert:', err);
  }
}