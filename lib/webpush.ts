// lib/webpush.ts
export async function sendWebPush(subscription: any, payload: string) {
  const webpush = (await import('web-push')).default;
  
  webpush.setVapidDetails(
    'mailto:garudakurt@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  return webpush.sendNotification(subscription, payload);
}