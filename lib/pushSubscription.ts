import { firestore } from '@/config/firebase';
import { doc, setDoc, getDoc, collection, getDocs } from 'firebase/firestore';

export async function saveSubscription(
  subscription: PushSubscriptionJSON,
  deviceId: string
): Promise<void> {
  await setDoc(doc(firestore, 'pushSubscriptions', deviceId), {
    subscription,
    createdAt: new Date().toISOString(),
  });
}

export async function getAllSubscriptions(): Promise<PushSubscriptionJSON[]> {
  const snap = await getDocs(collection(firestore, 'pushSubscriptions'));
  return snap.docs.map((d) => d.data().subscription as PushSubscriptionJSON);
}