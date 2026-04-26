import { NextRequest, NextResponse } from 'next/server';
import { sendWebPush } from '@/lib/webpush';   // ✅ use new function
import { firestore } from '@/config/firebase';
import { collection, getDocs } from 'firebase/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { title, body, tag, url } = await req.json();

  const snap = await getDocs(collection(firestore, 'pushSubscriptions'));
  const subscriptions = snap.docs.map((d) => d.data().subscription);

  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      sendWebPush(
        sub,
        JSON.stringify({ title, body, tag, url: url || '/', icon: '/icon.png' })
      )
    )
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  return NextResponse.json({ success: true, sent: subscriptions.length - failed, failed });
}