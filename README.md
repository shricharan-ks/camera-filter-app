# Campaign Photo App 📸

A progressive web app for capturing photos and videos with a custom campaign frame overlay. Built for mobile and desktop browsers with Firebase Hosting and Google Analytics integration.

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://dmk-kumarapalayam.web.app)
[![Firebase](https://img.shields.io/badge/hosted-firebase-orange)](https://firebase.google.com)

## 🌟 Features

### Camera & Capture
- **Live Camera Preview** - Real-time camera feed with overlay preview
- **Front/Back Camera Toggle** - Switch between device cameras
- **Photo Capture** - Take high-quality photos with custom frame overlay
- **Video Recording** - Record framed videos (MP4/WebM format)
- **Gallery Upload** - Import existing photos or videos and apply the frame

### Frame Compositing
- **Custom Overlay** - Campaign frame overlay with transparent cutout for camera feed
- **Smart Framing** - Automatic cover-fit for different aspect ratios
- **High Quality Output** - 1080×1920 composite images (JPEG 92% quality)
- **Framed Video Export** - Apply overlay to gallery videos with one-click export

### Mobile-First Design
- **Responsive UI** - Optimized layouts for mobile and desktop
- **Touch-Friendly Controls** - Large tap targets and gesture support
- **iOS/Android Compatible** - Works on modern mobile browsers
- **Share Integration** - Native share sheet support on mobile devices

### Performance & Security
- **HTTPS Dev Server** - Self-signed certificates for local camera access
- **Privacy-First** - No data collection beyond analytics events
- **Offline Ready** - Core functionality works without network
- **Optimized Loading** - Deferred script loading, preconnected fonts

## 🚀 Live Demo

Visit the live app: **[https://dmk-kumarapalayam.web.app](https://dmk-kumarapalayam.web.app)**

## 🛠️ Tech Stack

- **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3
- **APIs:** MediaStream API, MediaRecorder API, Canvas API
- **Hosting:** Firebase Hosting
- **Analytics:** Google Analytics (Firebase Analytics)
- **Dev Server:** Node.js with HTTPS support
- **CI/CD:** GitHub Actions

## 📋 Prerequisites

- Node.js 14+ and npm
- Modern browser with camera support
- Firebase project (for deployment)
- HTTPS connection (required for camera access on non-localhost)

## 🔧 Setup & Installation

### 1. Clone the Repository

```bash
git clone https://github.com/shricharan-ks/camera-filter-app.git
cd camera-filter-app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Development Server

Start the HTTPS development server:

```bash
npm start
```

The app will be available at:
- **Local:** `https://localhost:8443`
- **Network:** `https://YOUR_IP:8443` (for mobile testing)

> **Note:** You'll see a certificate warning on first visit. Click "Advanced" → "Proceed" to continue. HTTPS is required for camera access.

### 4. Access from Mobile Device

1. Find your computer's IP address
2. On your mobile device, visit `https://YOUR_IP:8443`
3. Accept the security warning (self-signed certificate)
4. Grant camera permissions when prompted

## 🎨 Customization

### Replace the Overlay Frame

1. Replace `overlay-frame.png` with your custom frame (recommended: 1080×1920 PNG with transparency)
2. Update cache-bust version in `app.js`:
   ```javascript
   const OVERLAY_CACHE_BUST = "4"; // Increment this
   ```

### Adjust Output Dimensions

Edit the constants in `app.js`:

```javascript
const OUT_W = 1080;  // Output width
const OUT_H = 1920;  // Output height
const JPEG_QUALITY = 0.92; // JPEG quality (0-1)
```

### Configure Firebase Analytics

Update `firebase-analytics-init.js` with your Firebase config:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  // ... other config
};
```

## 🔥 Firebase Setup

### Initial Setup

1. Install Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```

2. Login to Firebase:
   ```bash
   firebase login
   ```

3. Initialize Firebase (already configured):
   ```bash
   firebase init hosting
   ```

### Manual Deployment

```bash
firebase deploy --only hosting
```

### Automated Deployment

This project uses GitHub Actions for automated deployment. See [CI/CD section](#cicd-with-github-actions).

## 📊 Analytics Events

The app tracks the following events:

| Event Name | Description | Parameters |
|------------|-------------|------------|
| `campaign_app_open` | App is opened | `layout` (mobile/desktop) |
| `camera_photo_capture` | Photo captured from camera | `layout` (mobile/desktop) |
| `photo_download` | Photo downloaded | `layout` (mobile/desktop) |
| `video_download` | Video downloaded | `method` (share/download), `format` (mp4/webm) |

View analytics in the [Firebase Console](https://console.firebase.google.com/project/dmk-kumarapalayam/analytics).

## 🤖 CI/CD with GitHub Actions

This project automatically deploys to Firebase Hosting on every push to the `main` branch.

### Setup GitHub Actions

The workflow is already configured in `.github/workflows/firebase-deploy.yml`. You need to add the Firebase token as a GitHub secret:

1. Generate Firebase CI token:
   ```bash
   firebase login:ci
   ```

2. Copy the token and add it to GitHub:
   - Go to your repository settings
   - Navigate to **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Name: `FIREBASE_TOKEN`
   - Value: Paste the token from step 1

3. Push to `main` branch to trigger deployment

## 📁 Project Structure

```
camera-filter-app/
├── index.html                  # Main HTML file
├── app.js                      # Camera app logic
├── styles.css                  # App styling
├── firebase-analytics-init.js  # Analytics configuration
├── overlay-frame.png           # Campaign frame overlay
├── server.mjs                  # HTTPS dev server
├── firebase.json               # Firebase Hosting config
├── .firebaserc                 # Firebase project config
├── package.json                # Dependencies
├── .gitignore                  # Git ignore rules
└── README.md                   # This file
```

## 🌐 Browser Support

- **Chrome/Edge:** 90+ ✅
- **Safari:** 14+ ✅ (iOS 14.3+)
- **Firefox:** 88+ ✅
- **Opera:** 76+ ✅

> **Camera API Requirements:** HTTPS or localhost only. HTTP on LAN IPs will block camera access on most browsers.

## 🔒 Security & Privacy

- **Camera Access:** Only requested when user taps "Start camera"
- **No Server Processing:** All image/video processing happens client-side
- **No Data Upload:** Photos and videos never leave the device
- **Analytics Only:** Only anonymized event data sent to Google Analytics
- **HTTPS Only:** Enforced for all production deployments

## 🐛 Troubleshooting

### Camera Not Working

**Problem:** "Camera is blocked" or "Camera API unavailable"

**Solutions:**
- Ensure you're using HTTPS (not HTTP)
- Check browser permissions for camera access
- Try `https://localhost:8443` instead of `http://localhost:8080`
- On mobile, use `https://YOUR_IP:8443` (accept security warning)

### Video Export Not Working

**Problem:** Video export fails or produces empty file

**Solutions:**
- Check browser supports MediaRecorder API
- Try a shorter video clip (< 2 minutes)
- Clear browser cache and reload
- Use Chrome/Edge for best MP4 codec support

### Firebase Deployment Fails

**Problem:** `firebase deploy` errors

**Solutions:**
- Run `firebase login` to re-authenticate
- Check `.firebaserc` has correct project ID
- Verify Firebase Hosting is enabled in console
- Check `firebase.json` configuration

## 📝 License

This project is open source and available under the [MIT License](LICENSE).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📧 Contact

For questions or support, please open an issue on GitHub.

---

Built with ❤️ for campaign photography
