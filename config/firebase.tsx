import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyB0uV3eUPE4g39vfG6CZJ3m9OVTT9ivqXU",
  authDomain: "savest-94b43.firebaseapp.com",
  databaseURL: "https://savest-94b43-default-rtdb.firebaseio.com",
  projectId: "savest-94b43",
  storageBucket: "savest-94b43.firebasestorage.app",
  messagingSenderId: "809130674523",
  appId: "1:809130674523:web:068bb43136900dc43f727e"
};


// Prevent re-initialization (VERY IMPORTANT for Next.js)
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Exports
export const auth = getAuth(app);
export const firestore = getFirestore(app);
export const database = getDatabase(app);