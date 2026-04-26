'use client';

import { useEffect, useRef } from 'react';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;

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
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    async function setup() {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const reg = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });

        await navigator.serviceWorker.ready;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: VAPID_PUBLIC_KEY,
        });

        const deviceId = getDeviceId();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), deviceId }),
        });

        subscribed.current = true;
        console.log('[SaVest] Push notifications registered.');
      } catch (err) {
        console.error('[SaVest] Push setup failed:', err);
      }
    }

    setup();
  }, []);
}

export async function sendPushAlert(title: string, body: string, tag?: string) {
  try {
    await fetch('/api/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tag, url: '/' }),
    });
  } catch (err) {
    console.error('[SaVest] Failed to send push alert:', err);
  }
}