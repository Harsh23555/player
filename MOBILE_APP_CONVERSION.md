# 📱 Converting NOVA Player to a Mobile App (Android/iOS)

I have initialized a **Capacitor** project for you. This allows you to wrap your Django-powered player into a native mobile application shell that can be published to the Play Store or App Store.

## 🛠️ Prerequisites
Before building, ensure you have the following installed on your machine:
*   **Node.js & NPM** (Done, verified on your system)
*   **Android Studio** (For Android builds)
*   **Xcode** (For iOS builds - *macOS only*)

---

## 🏗️ Step 1: Initialize the Platforms
Open your terminal in the project root and run:
```powershell
# 1. Install dependencies
npm install

# 2. Add the Android platform
npx cap add android
```

## 🌐 Step 2: Configure your Local Server
Since NOVA Player uses a Django backend, the mobile app needs to connect to your computer.
1. Find your computer's **Local IP address** (Run `ipconfig` in CMD and look for `IPv4 Address`, e.g., `192.168.1.15`).
2. Open `capacitor.config.json` and update the `server.url` field:
   ```json
   "server": {
     "url": "http://192.168.1.15:8000",
     "cleartext": true
   }
   ```
3. Ensure your Django server is running and accessible on the network:
   ```powershell
   python manage.py runserver 0.0.0.0:8000
   ```

## 🎨 Step 3: Icons & Splash Screens
I have already generated the following premium assets for you:
*   **App Icon**: `/static/icons/icon.png`
*   **Splash Screen**: `/static/splash_screen.png`

You can use a tool like `@capacitor/assets` to automatically format these for Android/iOS:
```powershell
npx @capacitor/assets generate --icon ./static/icons/icon.png --splash ./static/splash_screen.png
```

## 🚀 Step 4: Run it!
To open the project in Android Studio and compile your APK:
```powershell
npx cap open android
```
Once Android Studio opens:
1. Wait for Gradle to sync.
2. Click the **"Run"** button (Green play icon) to test on a physical device or emulator.
3. To generate a shareable APK, go to **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

---

### 🔔 Push Notifications
To enable push notifications in your APK:
1.  **Firebase Setup**: Create a project on [Firebase Console](https://console.firebase.google.com/).
2.  **Add Android App**: Download the `google-services.json` file and place it in `android/app/`.
3.  **Add Plugin**: Run `npm install @capacitor/push-notifications`.

### 📦 Play Store Checklist
1.  **App Signing**: In Android Studio, go to **Build > Generate Signed Bundle / APK**.
2.  **Privacy Policy**: Ensure you have a simple privacy policy URL (as required by Google for media apps).
3.  **Permissions**: I have pre-configured common permissions for you, but ensure you include `MANAGE_EXTERNAL_STORAGE` if you want to scan all system folders on Android 11+.

### ✨ Native Features Included
*   **Offline Detection**: Users see a clean error page if they lose internet access.
*   **Bottom Navigation**: Modern Home/About/Contact bar for easy thumb navigation.
*   **Safe-Area Support**: The header automatically adjusts for phone notches.
*   **Native Back Handling**: Pressing the hardware "Back" button closes your modals smoothly instead of exiting the app.
*   **Styled Status Bar**: The top bar is themed to match the dark player UI.
*   **Smooth Splash**: Custom 3D-styled splash screen on launch.
