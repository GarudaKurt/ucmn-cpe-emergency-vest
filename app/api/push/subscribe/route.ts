import { NextRequest, NextResponse } from 'next/server';
import { firestore } from '@/config/firebase';
import { doc, setDoc } from 'firebase/firestore';

// ✅ Add this line
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // ✅ Add this too

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { subscription, deviceId } = body;

  if (!subscription || !deviceId) {
    return NextResponse.json({ success: false, message: 'Missing fields' }, { status: 400 });
  }

  await setDoc(doc(firestore, 'pushSubscriptions', deviceId), {
    subscription,
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({ success: true });
}