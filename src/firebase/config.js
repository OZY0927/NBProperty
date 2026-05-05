// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBf0hSJGyB55oU__Kg_7jLpAFJCFYy6I-o",
  authDomain: "nbproperty-33b66.firebaseapp.com",
  projectId: "nbproperty-33b66",
  storageBucket: "nbproperty-33b66.firebasestorage.app",
  messagingSenderId: "384123870822",
  appId: "1:384123870822:web:9ed39f9498174e51ee17a7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export default app;
