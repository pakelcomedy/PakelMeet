# PakelMeet

**PakelMeet** is a lightweight, browser-based video meeting application designed for small groups (3–4 participants).  
It uses **WebRTC** for peer-to-peer audio/video communication and **Firebase Firestore** (or any signaling backend) for room signaling.  

This project is frontend-only and can be hosted directly on **GitHub Pages**.

---

## ✨ Features

- 🔗 **Room system** – create or join a meeting with a simple Room ID.
- 🎥 **Video grid** – responsive, adaptive video tiles for each participant.
- 🎙️ **Controls** – toggle microphone, camera, and screen sharing.
- 💬 **Chat sidebar** – send and receive text messages alongside video.
- 👤 **Display name** – choose a name displayed on your video tile.
- 📱 **Responsive design** – works on desktop and mobile browsers.
- ⚡ **No backend hosting** – frontend runs entirely on GitHub Pages.

---

## 🛠 Project Structure

```

pakelmeet/
│
├── index.html                # Main entry point
├── assets/
│   ├── css/
│   │   └── style.css         # Stylesheet (responsive UI)
│   ├── js/
│   │   └── app.js            # Core logic: WebRTC + Firebase signaling
│   └── favicon.ico           # App favicon
└── README.md                 # Documentation

````

---

## 🚀 Getting Started

### 1. Clone the repository
```bash
git clone https://github.com/pakelcomedy/pakelmeet.git
cd pakelmeet
````

### 2. Configure Firebase

1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Firestore Database**.
3. Copy your Firebase config object.
4. Paste it into `assets/js/app.js` inside the Firebase initialization block.

### 3. Run locally

Open `index.html` in your browser (no server required).
For local dev with live reload:

```bash
npx serve
```

### 4. Deploy to GitHub Pages

1. Push your repo to GitHub.
2. Go to **Settings → Pages**.
3. Set branch to `main` (or `gh-pages`) and root to `/`.
4. Your app will be available at:

   ```
   https://yourusername.github.io/pakelmeet/
   ```

---

## 📖 Usage

1. Open PakelMeet in your browser.
2. Enter a **Room ID** (e.g., `team-sync`).
3. Click **Create / Join**.
4. Share the URL with others.
   They will join the same room automatically.
5. Use the bottom controls to mute/unmute, toggle camera, or share your screen.
6. Use the sidebar to set your display name or chat.

---

## ⚠️ Limitations

* Designed for **3–4 participants** (mesh P2P does not scale well beyond that).
* Relies on Firebase/Firestore as a signaling service (can be swapped).
* No TURN server configured → works best when peers are not behind restrictive NATs.
* Experimental demo – **not production-ready** for sensitive meetings.

---

## 📦 Technologies Used

* [WebRTC](https://webrtc.org/) – real-time peer-to-peer media.
* [Firebase Firestore](https://firebase.google.com/docs/firestore) – signaling layer.
* HTML5, CSS3, JavaScript (ES Modules).

---

## 🔮 Roadmap

* [ ] Add TURN/STUN server configuration for better NAT traversal.
* [ ] Add mute/video indicators on tiles.
* [ ] Add dark/light theme toggle.
* [ ] Add chat message persistence.
* [ ] Optimize for mobile landscape mode.

---

## 📝 License

MIT License © 2025 – Built for learning/demo purposes.
You are free to use, modify, and distribute this project with attribution.